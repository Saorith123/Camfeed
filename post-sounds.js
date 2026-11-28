// 🎵 Sounds on videos (like "original audio" in short-video apps, CamFeed's own way)
//   • a video made with a sound from the library / another video: the server puts that sound INTO the video file
//     (the picture is copied as it is, only the sound is made again: quick and light), so it plays everywhere and stays
//     in a downloaded copy. The person's own voice can be kept under the music.
//   • under every video: 🎵 the sound's name · its first owner (never removed); tap = the sound's page
//   • the sound's page: listen, 🎥 use it (CamFeed camera), 🔖 save it, all the videos that use it
//   • the owner of a video can say "others may not use my sound"
//   GET  /api/sounds/:id/page                → { sound, posts }
//   POST /api/sounds/original/:postId        → { id }   (the video's own sound as a sound; made the first time)
//   POST /api/posts/:id/sound-share { on }   → the owner allows / stops others using the sound of this video
'use strict';

const { execFile } = require('child_process');

module.exports = function postSounds({ app, pool, pubMedia, r2PutBuffer, thumbsReady, deleteMedia, makeSoundAudio, soundTitleOf }) {
  let ready = null;
  const ensure = () => ready || (ready = (async () => {
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS sound_id INTEGER, ADD COLUMN IF NOT EXISTS sound_start INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sound_voice BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS sound_mix VARCHAR(8), ADD COLUMN IF NOT EXISTS sound_share BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query('CREATE INDEX IF NOT EXISTS posts_sound_id ON posts (sound_id) WHERE sound_id IS NOT NULL');
  })().catch((e) => { ready = null; throw e; }));
  setTimeout(() => ensure().catch((e) => console.error('[postsound] ensure:', e.message)), 20 * 1000);

  const ownerName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim();

  // the words shown for a sound: a sound made from a video = "original sound" + the name of the person who posted that video
  function label(s) {
    const fromVideo = !!s.post_id;
    return { id: s.id, title: fromVideo ? 'សំឡេងដើម' : s.title, owner: fromVideo ? ownerName(s) : (s.artist || ''), original: fromVideo };
  }

  // 📥 a new post with a sound (called by POST /api/posts right after the row is made)
  async function onNewPost(postId, b) {
    try {
      await ensure();
      const sid = parseInt(b && b.soundId, 10) || 0; if (!sid) return;
      const s = (await pool.query(`SELECT s.id, s.audio_url, s.post_id, COALESCE(p.sound_share, TRUE) AS share FROM sounds s LEFT JOIN posts p ON p.id = s.post_id
                                   WHERE s.id = $1 AND s.active = TRUE`, [sid])).rows[0];
      if (!s || !s.audio_url || s.share === false) return;
      const start = Math.max(0, Math.min(parseInt(b.soundStart, 10) || 0, 3600));
      const p = (await pool.query('SELECT id, media_type, media_url FROM posts WHERE id = $1', [postId])).rows[0];
      if (!p || !pubMedia(p).video || p.media_type !== 'video') return;    // one video only (not a set of pictures)
      await pool.query("UPDATE posts SET sound_id = $2, sound_start = $3, sound_voice = $4, sound_mix = 'wait', feed_url = '' WHERE id = $1", [postId, sid, start, b.soundVoice === true]);
      await pool.query('UPDATE sounds SET uses = uses + 1 WHERE id = $1', [sid]).catch(() => {});
      setTimeout(() => tick().catch(() => {}), 1500);
    } catch (e) { console.error('[postsound] new post:', e.message); }
  }

  // 🎛 put the sound into the video file (one at a time; the picture is copied, only the sound is made again)
  let busy = false;
  function ff() { try { return require('ffmpeg-static') || 'ffmpeg'; } catch (e) { return 'ffmpeg'; } }
  function run(args) {
    return new Promise((ok, no) => execFile(ff(), args, { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 }, (e, so, se) => (e ? no(Object.assign(e, { log: String(se || '').slice(-400) })) : ok())));
  }
  async function tick() {
    if (busy || !thumbsReady()) return;
    busy = true;
    const fs = require('fs'), os = require('os'), path = require('path');
    let out = '', curId = 0;
    try {
      await ensure();
      const r = (await pool.query(`SELECT p.id, p.media_type, p.media_url, p.sound_start, p.sound_voice, s.audio_url FROM posts p JOIN sounds s ON s.id = p.sound_id
                                   WHERE p.sound_mix = 'wait' ORDER BY p.id LIMIT 1`)).rows[0];
      if (!r) return;
      curId = r.id;
      const v = pubMedia(r).video;
      if (!v || !r.audio_url) { await pool.query("UPDATE posts SET sound_mix = 'skip', feed_url = NULL WHERE id = $1", [r.id]); return; }
      out = path.join(os.tmpdir(), 'camfeed-mix-' + r.id + '-' + Date.now() + '.mp4');
      const music = ['-stream_loop', '-1', '-ss', String(r.sound_start || 0), '-i', r.audio_url];   // the music goes round if the video is longer
      const tail = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest', '-movflags', '+faststart', '-threads', '1', out];
      const replace = ['-y', '-i', v, ...music, '-map', '0:v:0', '-map', '1:a:0', ...tail];
      const mix = ['-y', '-i', v, ...music, '-filter_complex', '[0:a]volume=1.0[me];[1:a]volume=0.55[mu];[me][mu]amix=inputs=2:duration=first:dropout_transition=0[a]', '-map', '0:v:0', '-map', '[a]', ...tail];
      try { await run(r.sound_voice ? mix : replace); }
      catch (e) { if (!r.sound_voice) throw e; await run(replace); }                // a video with no sound of its own: only the music
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (size < 10000) throw new Error('empty result');
      const url = await r2PutBuffer('posts/' + Date.now() + '-' + require('crypto').randomBytes(4).toString('hex') + '.mp4', fs.readFileSync(out), 'video/mp4');
      // the new file takes the old one's place (the light Feed copy is made again from it)
      await pool.query("UPDATE posts SET media_url = $2, sound_mix = 'done', feed_url = NULL, feed_checked = FALSE WHERE id = $1", [r.id, url]);
      if (deleteMedia) deleteMedia(r.media_url).catch(() => {});
      console.log('[postsound] sound put into post', r.id);
    } catch (e) {
      console.error('[postsound] mix:', String(e.message || e).slice(0, 200), e.log || '');
      // could not: the video stays as it was (its own sound), it is not tried again and again
      if (curId) await pool.query("UPDATE posts SET sound_mix = 'fail', feed_url = NULL WHERE id = $1", [curId]).catch(() => {});
    } finally {
      busy = false;
      if (out) { try { require('fs').unlinkSync(out); } catch (e) { /* gone */ } }
    }
  }
  setInterval(() => tick().catch(() => {}), 20 * 1000).unref();

  // 🏷 the 🎵 line under each video of a list of posts (Reels / Feed / one post): added to the answer, nothing else changes
  async function attach(posts) {
    try {
      await ensure();
      const vids = posts.filter((p) => p && (p.media_type === 'video' || p.orig_media_type === 'video'));
      if (!vids.length) return;
      const idOf = (p) => Number(p.shared_post_id && p.orig_id ? p.orig_id : p.id);
      const ids = [...new Set(vids.map(idOf).filter((x) => x > 0))];
      const rows = (await pool.query(`SELECT p.id AS pid, p.sound_id, p.sound_share, s.id, s.title, s.artist, s.post_id, u.first_name, u.last_name
          FROM posts p LEFT JOIN sounds s ON s.id = p.sound_id AND s.active = TRUE LEFT JOIN users u ON u.email = s.created_by
          WHERE p.id = ANY($1::int[])`, [ids])).rows;
      const m = new Map(rows.map((x) => [Number(x.pid), x]));
      for (const p of vids) {
        const x = m.get(idOf(p)); if (!x) continue;
        p.sound = x.id ? label(x) : null;          // null = the video's own sound ("original sound · the person who posted it")
        p.sound_share = x.sound_share !== false;
      }
    } catch (e) { /* the 🎵 line is extra: the posts still show */ }
  }
  // GET /api/posts and GET /api/posts/:id answers get the 🎵 line (without touching those big routes)
  app.use((req, res, next) => {
    if (req.method !== 'GET' || !/^\/api\/posts(\/\d+)?$/.test(req.path)) return next();
    const send = res.json.bind(res);
    res.json = (body) => {
      const list = body && Array.isArray(body.posts) ? body.posts : (body && body.post ? [body.post] : (Array.isArray(body) ? body : null));
      if (!list || !list.length) return send(body);
      attach(list).then(() => send(body), () => send(body));
      return res;
    };
    next();
  });

  // 📄 the page of one sound
  app.get('/api/sounds/:id/page', async (req, res) => {
    try {
      await ensure();
      const id = parseInt(req.params.id, 10) || 0, me = req.authEmail || '';
      const s = (await pool.query(`SELECT s.*, u.first_name, u.last_name, u.profile_pic, u.public_id, COALESCE(sp.sound_share, TRUE) AS share,
            EXISTS (SELECT 1 FROM saved_sounds ss WHERE ss.sound_id = s.id AND ss.user_email = $2) AS saved
          FROM sounds s LEFT JOIN users u ON u.email = s.created_by LEFT JOIN posts sp ON sp.id = s.post_id WHERE s.id = $1 AND s.active = TRUE`, [id, me])).rows[0];
      if (!s) return res.status(404).json({ success: false, error: 'This sound is not available.' });
      const posts = (await pool.query(`SELECT p.id, p.thumb_url, p.media_type, p.media_url, COALESCE(p.views_count, 0) AS views FROM posts p
          WHERE (p.sound_id = $1 OR p.id = $2) AND p.privacy = 'public' AND p.shared_post_id IS NULL
          ORDER BY (p.id = $2) DESC, p.views_count DESC NULLS LAST, p.id DESC LIMIT 60`, [id, s.post_id || 0])).rows;
      const n = Number((await pool.query("SELECT COUNT(*) AS n FROM posts WHERE (sound_id = $1 OR id = $2) AND privacy = 'public' AND shared_post_id IS NULL", [id, s.post_id || 0])).rows[0].n) || 0;
      const l = label(s);
      res.json({ success: true, sound: { ...l, url: s.audio_url, duration: s.duration, cover: s.post_id ? (s.profile_pic || '') : (s.cover_url || ''), ownerId: s.post_id ? (s.public_id || '') : '',
          saved: !!s.saved, canUse: s.share !== false || (me && me === s.created_by), videos: n },
        posts: posts.map((p) => ({ id: p.id, thumb: p.thumb_url || '', views: Number(p.views) || 0 })) });
    } catch (err) { console.error('[postsound] page:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  // 🎵 a video's own sound as a sound (made the first time somebody opens it); its owner = the person who posted the video
  app.post('/api/sounds/original/:postId', async (req, res) => {
    try {
      await ensure();
      const pid = parseInt(req.params.postId, 10) || 0;
      const p = (await pool.query('SELECT id, user_email, media_type, media_url, privacy, content, sound_id FROM posts WHERE id = $1', [pid])).rows[0];
      if (!p || (p.privacy && p.privacy !== 'public' && p.user_email !== req.authEmail)) return res.status(404).json({ success: false });
      if (p.sound_id) return res.json({ success: true, id: p.sound_id });             // made with a sound: that sound (and its first owner)
      const v = pubMedia(p).video; if (!v) return res.status(400).json({ success: false, error: 'No video.' });
      let sd = (await pool.query('SELECT id FROM sounds WHERE post_id = $1', [pid])).rows[0];
      if (!sd) {
        sd = (await pool.query("INSERT INTO sounds (title, artist, audio_url, duration, created_by, post_id) VALUES ($1, '', $2, 30, $3, $4) ON CONFLICT (post_id) WHERE post_id IS NOT NULL DO UPDATE SET audio_url = sounds.audio_url RETURNING id",
          [soundTitleOf(p.content), v, p.user_email, pid])).rows[0];
        if (makeSoundAudio) makeSoundAudio(sd.id, v);          // the small sound-only file, in the background
      }
      res.json({ success: true, id: sd.id });
    } catch (err) { console.error('[postsound] original:', err.message); res.status(500).json({ success: false }); }
  });

  // 🔒 the owner: others may use the sound of my video, or not
  app.post('/api/posts/:id/sound-share', async (req, res) => {
    try {
      await ensure();
      const id = parseInt(req.params.id, 10) || 0, me = req.authEmail;
      const r = await pool.query('UPDATE posts SET sound_share = $3 WHERE id = $1 AND user_email = $2 RETURNING sound_share', [id, me, (req.body || {}).on !== false]);
      if (!r.rowCount) return res.status(403).json({ success: false, error: 'Only the owner can change this.' });
      res.json({ success: true, on: r.rows[0].sound_share });
    } catch (err) { res.status(500).json({ success: false }); }
  });

  return { onNewPost, attach };
};
