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
// 🎬 the edits of the CamFeed video editor (cut the start / end, text and stickers drawn by the phone as one see-through
//    picture, my voice / music volume) are made into the video file here too, for posts AND for Stories (one at a time).
'use strict';

const { execFile } = require('child_process');

module.exports = function postSounds({ soundCaption, app, pool, pubMedia, r2PutBuffer, thumbsReady, deleteMedia, makeSoundAudio, soundTitleOf, mediaBase, onBecameVideo }) {
  let ready = null;
  const ensure = () => ready || (ready = (async () => {
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS sound_id INTEGER, ADD COLUMN IF NOT EXISTS sound_start INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sound_voice BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS sound_mix VARCHAR(8), ADD COLUMN IF NOT EXISTS sound_share BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query('CREATE INDEX IF NOT EXISTS posts_sound_id ON posts (sound_id) WHERE sound_id IS NOT NULL');
    await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS edit_json JSONB, ADD COLUMN IF NOT EXISTS sound_tries SMALLINT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE stories ADD COLUMN IF NOT EXISTS edit_json JSONB, ADD COLUMN IF NOT EXISTS edit_state VARCHAR(8), ADD COLUMN IF NOT EXISTS edit_tries SMALLINT NOT NULL DEFAULT 0');
  })().catch((e) => { ready = null; throw e; }));
  setTimeout(() => ensure().catch((e) => console.error('[postsound] ensure:', e.message)), 20 * 1000);

  const ownerName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim();

  // the words shown for a sound: a sound made from a video = "original sound" + the name of the person who posted that video
  function label(s) {
    const fromVideo = !!s.post_id;
    return { id: s.id, title: fromVideo ? 'សំឡេងដើម' : s.title, caption: fromVideo && soundCaption ? soundCaption(s.sp_content) : '', owner: fromVideo ? ownerName(s) : (s.artist || ''), original: fromVideo };
  }

  // ✅ the edits a phone sent, checked (anything strange is left out)
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  function cleanEdit(b) {
    const e = (b && typeof b.edit === 'object' && b.edit) || {};
    const out = {
      trimStart: Math.round(num(e.trimStart, 0, 3600000, 0)), trimEnd: Math.round(num(e.trimEnd, 0, 3600000, 0)),
      voiceVol: num(e.voiceVol, 0, 2, 1), musicVol: num(e.musicVol, 0, 2, 1),
      overlay: typeof e.overlay === 'string' && mediaBase && e.overlay.startsWith(mediaBase()) && e.overlay.length < 500 && !/[\s"'<>`\\]/.test(e.overlay) ? e.overlay : '',
      soundId: parseInt(e.soundId || (b && b.soundId), 10) || 0,
      soundStart: Math.round(num(e.soundStart !== undefined ? e.soundStart : (b && b.soundStart), 0, 3600, 0)),
      soundStartMs: e.soundStartMs !== undefined ? Math.round(num(e.soundStartMs, 0, 3600000, 0)) : null,   // 🎵 the exact point of the song when recording began
      soundVoice: e.soundVoice === true || (b && b.soundVoice === true),
      mirror: e.mirror === true,                                       // 🪞 front camera: kept as seen on the screen
      photo: e.photo === true,                                         // 📸 a photo + a sound → a short video
      photoSecs: Math.round(num(e.photoSecs, 3, 30, 10)),
    };
    if (out.trimEnd && out.trimEnd < out.trimStart + 500) out.trimEnd = 0;
    return out;
  }
  const needsWork = (e) => e.photo ? !!e.soundId : !!(e.soundId || e.overlay || e.trimStart || e.trimEnd || e.voiceVol !== 1 || e.mirror);
  async function soundOk(id) {
    if (!id) return null;
    return (await pool.query(`SELECT s.id, s.audio_url FROM sounds s LEFT JOIN posts p ON p.id = s.post_id
                              WHERE s.id = $1 AND s.active = TRUE AND COALESCE(p.sound_share, TRUE) = TRUE`, [id])).rows[0] || null;
  }

  // 📥 a new post made with a sound and / or edits (called by POST /api/posts right after the row is made)
  async function onNewPost(postId, b) {
    try {
      await ensure();
      const e = cleanEdit(b);
      if (e.soundId && !(await soundOk(e.soundId))) e.soundId = 0;
      if (!needsWork(e)) return;
      const p = (await pool.query('SELECT id, media_type, media_url FROM posts WHERE id = $1', [postId])).rows[0];
      if (!p) return;
      if (e.photo) { if (p.media_type !== 'image' || !pubMedia(p).images.length) return; }       // 📸 one photo + a sound (it becomes a short video)
      else if (!pubMedia(p).video || p.media_type !== 'video') return;    // one video only (not a set of pictures)
      // a photo stays seen as a photo until its video is ready; a video waits hidden (as before)
      await pool.query("UPDATE posts SET sound_id = $2, sound_start = $3, sound_voice = $4, edit_json = $5, sound_mix = 'wait', sound_tries = 0, feed_url = CASE WHEN $6 THEN feed_url ELSE '' END WHERE id = $1",
        [postId, e.soundId || null, e.soundStart, e.soundVoice, JSON.stringify(e), e.photo]);
      if (e.soundId) await pool.query('UPDATE sounds SET uses = uses + 1 WHERE id = $1', [e.soundId]).catch(() => {});
      setTimeout(() => tick().catch(() => {}), 1500);
    } catch (err) { console.error('[postsound] new post:', err.message); }
  }
  // 📖 a new Story video made in the CamFeed editor
  async function onNewStory(storyId, b) {
    try {
      await ensure();
      const e = cleanEdit(b);
      if (e.soundId && !(await soundOk(e.soundId))) e.soundId = 0;
      if (!needsWork(e)) return;
      await pool.query("UPDATE stories SET edit_json = $2, edit_state = 'wait', edit_tries = 0, feed_url = '' WHERE id = $1 AND media_type = 'video'", [storyId, JSON.stringify(e)]);
      if (e.soundId) await pool.query('UPDATE sounds SET uses = uses + 1 WHERE id = $1', [e.soundId]).catch(() => {});
      setTimeout(() => tick().catch(() => {}), 1500);
    } catch (err) { console.error('[postsound] new story:', err.message); }
  }

  // 🎛 make the edits into the video file (one at a time)
  let busy = false;
  function ff() { try { return require('ffmpeg-static') || 'ffmpeg'; } catch (e) { return 'ffmpeg'; } }
  function run(args, wantErr) {
    return new Promise((ok, no) => execFile(ff(), args, { timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 }, (e, so, se) => {
      if (wantErr) return ok(String(se || ''));
      return e ? no(Object.assign(e, { log: String(se || '').slice(-600) })) : ok();
    }));
  }
  // what ffmpeg says about a file: has it a sound, how long is it (seconds)
  async function probe(u) {
    const t = await run(['-hide_banner', '-i', u], true).catch(() => '');
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
    return { audio: /Stream #[^\n]*Audio:/.test(t), secs: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0 };
  }

  // the ffmpeg words for one job → a new mp4 file at [out]
  async function make(src, e, musicUrl, out) {
    if (e.photo) return makePhoto(src, e, musicUrl, out);
    const args = ['-y'];
    if (e.trimStart) args.push('-ss', (e.trimStart / 1000).toFixed(3));
    if (e.trimEnd) args.push('-t', ((e.trimEnd - e.trimStart) / 1000).toFixed(3));
    args.push('-i', src);
    let n = 1, mi = -1, oi = -1;
    // 🎵 the song from the exact point it had when the video began (lips in time), + the cut at the start
    //    (a song chosen in the editor, not recorded with, simply starts at its chosen second where the cut video starts)
    const at = e.soundStartMs != null ? e.soundStartMs / 1000 + (e.trimStart || 0) / 1000 : (e.soundStart || 0);
    if (musicUrl) { args.push('-stream_loop', '-1', '-ss', at.toFixed(3), '-i', musicUrl); mi = n++; }
    if (e.overlay) { args.push('-loop', '1', '-i', e.overlay); oi = n++; }
    const info = await probe(src);
    const voice = (e.voiceVol > 0.001) && info.audio;
    // the exact length of the new video (the music and the picture go round forever: they are cut here)
    const len = e.trimEnd ? (e.trimEnd - e.trimStart) / 1000 : Math.max(0.5, info.secs - e.trimStart / 1000);
    const fc = [];
    let vmap = '0:v:0', amap = null, vin = '[0:v]';
    if (e.mirror) {
      // 🪞 front camera: turned left-right so it looks as it did on the screen (the text / stickers are laid on after, so they read normally)
      fc.push(oi >= 0 ? '[0:v]hflip[fl]' : '[0:v]hflip,format=yuv420p[fl]');
      vin = '[fl]'; vmap = '[fl]';
    }
    if (oi >= 0) {
      // the see-through picture of the text / stickers, stretched to the video's size, laid on top
      fc.push(`[${oi}:v]${vin}scale2ref[ov][base]`, `[base][ov]overlay=0:0:shortest=1,format=yuv420p[v]`);
      vmap = '[v]';
    }
    if (mi >= 0 && voice) { fc.push(`[0:a]volume=${e.voiceVol.toFixed(2)}[me]`, `[${mi}:a]volume=${e.musicVol.toFixed(2)}[mu]`, '[me][mu]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]'); amap = '[a]'; }
    else if (mi >= 0) { fc.push(`[${mi}:a]volume=${e.musicVol.toFixed(2)}[a]`); amap = '[a]'; }
    else if (voice && Math.abs(e.voiceVol - 1) > 0.01) { fc.push(`[0:a]volume=${e.voiceVol.toFixed(2)}[a]`); amap = '[a]'; }
    else if (voice) amap = '0:a:0';
    if (fc.length) args.push('-filter_complex', fc.join(';'));
    args.push('-map', vmap);
    if (amap) args.push('-map', amap);
    // the picture is copied as it is (quick) unless text / stickers are drawn on it
    if (oi >= 0 || e.mirror) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'); else args.push('-c:v', 'copy');
    if (amap) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    if (mi >= 0 || oi >= 0 || e.mirror) { if (len > 0) args.push('-t', len.toFixed(3)); else args.push('-shortest'); }
    args.push('-movflags', '+faststart', '-threads', '1', out);
    await run(args);
  }

  // 📸 a photo with a sound → a short video: the photo stands still, the sound plays (from its chosen second)
  async function makePhoto(img, e, musicUrl, out) {
    if (!musicUrl) throw new Error('no sound');
    const secs = Math.max(3, Math.min(30, e.photoSecs || 10));
    const args = ['-y', '-loop', '1', '-framerate', '30', '-i', img, '-stream_loop', '-1', '-ss', String(e.soundStart || 0), '-i', musicUrl,
      '-filter_complex', `[0:v]scale='trunc(min(1080,iw)/2)*2':-2,format=yuv420p[v];[1:a]volume=${(e.musicVol || 1).toFixed(2)}[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '23', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-t', String(secs), '-movflags', '+faststart', '-threads', '1', out];
    await run(args);
  }

  async function tick() {
    if (busy || !thumbsReady()) return;
    busy = true;
    const fs = require('fs'), os = require('os'), path = require('path');
    let out = '', job = null;
    try {
      await ensure();
      const p = (await pool.query(`SELECT p.id, p.media_type, p.media_url, p.sound_id, p.sound_start, p.sound_voice, p.edit_json, s.audio_url FROM posts p LEFT JOIN sounds s ON s.id = p.sound_id
                                   WHERE p.sound_mix = 'wait' ORDER BY p.id LIMIT 1`)).rows[0];
      if (p) {
        const e0 = Object.assign({ trimStart: 0, trimEnd: 0, voiceVol: 1, musicVol: 1, overlay: '', soundStart: p.sound_start || 0, soundVoice: !!p.sound_voice }, p.edit_json || {});
        const m = pubMedia(p);
        job = { kind: 'post', id: p.id, src: e0.photo ? (m.images[0] || '') : m.video, music: p.sound_id ? p.audio_url : '', old: p.media_url, photo: !!e0.photo, e: e0 };
      }
      if (!job) {
        const st = (await pool.query(`SELECT st.id, st.media_url, st.edit_json, s.audio_url FROM stories st LEFT JOIN sounds s ON s.id = (st.edit_json->>'soundId')::int
                                      WHERE st.edit_state = 'wait' AND st.expires_at > NOW() ORDER BY st.id LIMIT 1`)).rows[0];
        if (st) job = { kind: 'story', id: st.id, src: st.media_url, music: st.audio_url || '', old: st.media_url, e: Object.assign({ trimStart: 0, trimEnd: 0, voiceVol: 1, musicVol: 1, overlay: '', soundStart: 0, soundVoice: false }, st.edit_json || {}) };
      }
      if (!job) return;
      if (!job.src) throw new Error('no video');
      // a sound without "my voice too": only the music is heard
      if (job.music && !job.e.soundVoice && job.e.voiceVol === 1) job.e.voiceVol = 0;
      out = path.join(os.tmpdir(), 'camfeed-edit-' + job.kind + job.id + '-' + Date.now() + '.mp4');
      await make(job.src, job.e, job.music, out);
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (size < 10000) throw new Error('empty result');
      const url = await r2PutBuffer((job.kind === 'post' ? 'posts/' : 'stories/') + Date.now() + '-' + require('crypto').randomBytes(4).toString('hex') + '.mp4', fs.readFileSync(out), 'video/mp4');
      // the new file takes the old one's place (the light quick-start copy is made again from it)
      if (job.kind === 'post' && job.photo) {
        // 📸 the post is now a video; the photo stays as its cover picture (it is not deleted)
        await pool.query("UPDATE posts SET media_url = $2, media_type = 'video', thumb_url = COALESCE(NULLIF(thumb_url, ''), $3), sound_mix = 'done', feed_url = NULL, feed_checked = FALSE WHERE id = $1", [job.id, url, job.src]);
        job.old = '';
        if (onBecameVideo) { try { onBecameVideo(job.id); } catch (e) { /* only the rating */ } }
      } else if (job.kind === 'post') await pool.query("UPDATE posts SET media_url = $2, sound_mix = 'done', feed_url = NULL, feed_checked = FALSE WHERE id = $1", [job.id, url]);
      else await pool.query("UPDATE stories SET media_url = $2, edit_state = 'done', feed_url = NULL WHERE id = $1", [job.id, url]);
      if (deleteMedia && job.old && job.old !== url) deleteMedia(job.old).catch(() => {});
      console.log('[postsound] ' + job.kind + ' ' + job.id + ' ready (' + Math.round(size / 1024) + ' KB)');
    } catch (err) {
      console.error('[postsound] ' + (job ? job.kind + ' ' + job.id : '') + ' failed:', String(err.message || err).slice(0, 200), err.log || '');
      // tried 3 times: the video stays as it was (its own sound); before that it waits for the next round
      if (job && job.kind === 'post') await pool.query("UPDATE posts SET sound_tries = sound_tries + 1, sound_mix = CASE WHEN sound_tries >= 2 THEN 'fail' ELSE 'wait' END, feed_url = CASE WHEN sound_tries >= 2 THEN NULL ELSE feed_url END WHERE id = $1", [job.id]).catch(() => {});
      if (job && job.kind === 'story') await pool.query("UPDATE stories SET edit_tries = edit_tries + 1, edit_state = CASE WHEN edit_tries >= 2 THEN 'fail' ELSE 'wait' END, feed_url = CASE WHEN edit_tries >= 2 THEN NULL ELSE feed_url END WHERE id = $1", [job.id]).catch(() => {});
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
      const rows = (await pool.query(`SELECT p.id AS pid, p.sound_id, p.sound_share, s.id, s.title, s.artist, s.post_id, u.first_name, u.last_name, sp.content AS sp_content
          FROM posts p LEFT JOIN sounds s ON s.id = p.sound_id AND s.active = TRUE LEFT JOIN users u ON u.email = s.created_by LEFT JOIN posts sp ON sp.id = s.post_id
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
      const s = (await pool.query(`SELECT s.*, u.first_name, u.last_name, u.profile_pic, u.public_id, COALESCE(sp.sound_share, TRUE) AS share, sp.content AS sp_content, sp.thumb_url AS sp_thumb,
            EXISTS (SELECT 1 FROM saved_sounds ss WHERE ss.sound_id = s.id AND ss.user_email = $2) AS saved
          FROM sounds s LEFT JOIN users u ON u.email = s.created_by LEFT JOIN posts sp ON sp.id = s.post_id WHERE s.id = $1 AND s.active = TRUE`, [id, me])).rows[0];
      if (!s) return res.status(404).json({ success: false, error: 'This sound is not available.' });
      const posts = (await pool.query(`SELECT p.id, p.thumb_url, p.media_type, p.media_url, COALESCE(p.views_count, 0) AS views FROM posts p
          WHERE (p.sound_id = $1 OR p.id = $2) AND p.privacy = 'public' AND p.shared_post_id IS NULL
          ORDER BY (p.id = $2) DESC, p.views_count DESC NULLS LAST, p.id DESC LIMIT 60`, [id, s.post_id || 0])).rows;
      const n = Number((await pool.query("SELECT COUNT(*) AS n FROM posts WHERE (sound_id = $1 OR id = $2) AND privacy = 'public' AND shared_post_id IS NULL", [id, s.post_id || 0])).rows[0].n) || 0;
      const l = label(s);
      res.json({ success: true, sound: { ...l, url: s.audio_url, duration: s.duration, cover: s.post_id ? (s.sp_thumb || s.profile_pic || '') : (s.cover_url || ''), ownerId: s.post_id ? (s.public_id || '') : '',
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

  return { onNewPost, onNewStory, attach, _make: make };
};
