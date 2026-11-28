// 🎬 Video rating: every new video of a person who earns from views waits for CamFeed to rate it (100 % … 0 % of the price per
// 1,000 views). The video stays public and its views are counted; the money for them is added when it is rated (all the
// views since it was posted). The AI looks first (a TikTok / Facebook logo = probably somebody else's video; a blurry or
// small picture) and suggests a %, the team decides. Videos posted before this started keep 100 %.
//   POST /api/admin/video-rating/list  { status: 'pending' | 'rated', limit }
//   POST /api/admin/video-rating/rate  { post_id, pct, reason }
'use strict';

const { execFile } = require('child_process');

module.exports = function videoRating({ app, pool, adminGate, audit, pubMedia, interests, rpmFor, creditNow, notify, alertAdmins }) {
  let ready = null;
  const ensure = () => ready || (ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS post_rating (post_id INT PRIMARY KEY, user_email TEXT NOT NULL, pct INT, reason TEXT,
        ai_flag TEXT, ai_note TEXT, width INT, height INT, ai_at TIMESTAMPTZ, rated_by TEXT, rated_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query('CREATE INDEX IF NOT EXISTS post_rating_wait ON post_rating (created_at) WHERE pct IS NULL');
    // the moment this started: only videos posted after it wait (older ones keep 100 %)
    await pool.query("INSERT INTO creator_settings (key, value) VALUES ('rating_start', $1) ON CONFLICT (key) DO NOTHING", [String(Date.now())]);
  })().catch((e) => { ready = null; throw e; }));
  let startMs = 0;
  async function start() { if (startMs) return startMs; await ensure(); const r = (await pool.query("SELECT value FROM creator_settings WHERE key = 'rating_start'")).rows[0]; startMs = Number(r && r.value) || Date.now(); return startMs; }

  const isVideo = (row) => { try { return !!pubMedia(row).video; } catch (e) { return false; } };
  async function earner(email) {
    const r = await pool.query("SELECT 1 FROM creator_applications WHERE user_email = $1 AND status = 'approved' AND earn_suspended = FALSE", [email]).catch(() => ({ rows: [] }));
    return r.rows.length > 0;
  }

  // 📥 a new post: a video of an earning person waits to be rated (the team is told; the AI looks a minute later)
  async function onNewPost(postId) {
    try {
      await ensure();
      const p = (await pool.query('SELECT id, user_email, content, media_type, media_url, shared_post_id FROM posts WHERE id = $1', [postId])).rows[0];
      if (!p || p.shared_post_id || !isVideo(p) || !(await earner(p.user_email))) return;
      const ins = await pool.query('INSERT INTO post_rating (post_id, user_email) VALUES ($1, $2) ON CONFLICT (post_id) DO NOTHING RETURNING post_id', [p.id, p.user_email]);
      if (!ins.rows.length) return;
      const u = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [p.user_email])).rows[0] || {};
      if (alertAdmins) alertAdmins('🎬 វីដេអូថ្មីរង់ចាំវាយតម្លៃ', `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'អ្នកបង្កើតមាតិកា', { open: 'rate', id: String(p.id) }).catch(() => {});
      setTimeout(() => analyze(p.id).catch(() => {}), 60 * 1000);   // the video file may still be finishing
    } catch (e) { console.error('[rating] new post:', e.message); }
  }

  // 🔎 the picture size (ffmpeg says "Video: h264 …, 720x1280")
  function sizeOf(url) {
    return new Promise((ok) => {
      const bin = (interests && interests.ffbin) ? interests.ffbin() : 'ffmpeg';
      execFile(bin, ['-hide_banner', '-i', url], { timeout: 20000, maxBuffer: 1024 * 1024 }, (e, so, se) => {
        const m = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(String(se || '') + String(so || ''));
        ok(m ? { w: Number(m[1]), h: Number(m[2]) } : null);
      });
    });
  }

  // 🤖 the AI looks at 3 frames: somebody else's video (a logo or @name of TikTok, Facebook, YouTube …), a poor picture
  async function analyze(postId) {
    await ensure();
    const p = (await pool.query('SELECT id, content, media_type, media_url FROM posts WHERE id = $1', [postId])).rows[0];
    if (!p) return;
    const m = pubMedia(p);
    let size = null; try { if (m.video) size = await sizeOf(m.video); } catch (e) {}
    const short = size ? Math.min(size.w, size.h) : 0;     // 720 for a 720×1280 video
    let flag = '', note = '';
    if (short && short < 480) { flag = 'lowq'; note = 'រូបភាពតូច (' + short + 'p)'; }
    try {
      const frames = interests && interests.framesOf ? await interests.framesOf(p) : [];
      if (frames.length && interests.geminiJson) {
        const j = await interests.geminiJson(`You check videos posted on CamFeed (a Cambodian social app) that earn money from views.
Look at the ${frames.length} frame(s) and the caption and answer:
1) "reupload": true when the video is most likely taken from another person or app: a visible logo or watermark of TikTok, Douyin, CapCut, Kwai, Likee, Facebook, Instagram, YouTube, a "@username" of another app, a TV channel logo, or a screen recording of another app. false when it looks made by the person (no other app's marks).
2) "platform": the app or channel seen ("TikTok", "Facebook", …) or "".
3) "quality": "good" or "low" (low = blurry, very dark, pixelated, a photo of a screen).
4) "note": at most 12 words in Khmer saying what you saw (no names of people).
Caption: """${String(p.content || '').slice(0, 600)}"""
Answer only JSON: {"reupload": false, "platform": "", "quality": "good", "note": ""}`, frames);
        if (j && !j.retry) {
          if (j.reupload === true) { flag = 'reupload'; note = (j.platform ? 'សង្ស័យថាយកពី ' + String(j.platform).slice(0, 30) : 'សង្ស័យថាយកពីគេ') + (j.note ? ' · ' + String(j.note).slice(0, 120) : ''); }
          else if (j.quality === 'low' && !flag) { flag = 'lowq'; note = 'រូបភាពមិនសូវច្បាស់' + (j.note ? ' · ' + String(j.note).slice(0, 120) : ''); }
          else if (!flag) { flag = 'ok'; note = j.note ? String(j.note).slice(0, 120) : 'មើលទៅជាវីដេអូផ្ទាល់ខ្លួន'; }
        }
      }
    } catch (e) { console.error('[rating] AI:', e.message); }
    await pool.query('UPDATE post_rating SET ai_flag = $2, ai_note = $3, width = $4, height = $5, ai_at = NOW() WHERE post_id = $1',
      [postId, flag || null, note || null, size ? size.w : null, size ? size.h : null]);
  }
  // a video the AI has not seen yet (a restart, a busy minute): looked at later
  setInterval(async () => {
    try {
      await ensure();
      const r = await pool.query("SELECT post_id FROM post_rating WHERE pct IS NULL AND ai_at IS NULL AND created_at < NOW() - INTERVAL '2 minutes' ORDER BY created_at LIMIT 3");
      for (const x of r.rows) await analyze(x.post_id).catch(() => pool.query('UPDATE post_rating SET ai_at = NOW() WHERE post_id = $1', [x.post_id]).catch(() => {}));
    } catch (e) { /* next time */ }
  }, 3 * 60 * 1000).unref();

  // 💵 for the money: post id → % (null = still waiting). Videos made after the start without a line are put in the waiting list here.
  async function ratesFor(email, posts) {
    const out = new Map();
    if (!posts.length) return out;
    await ensure();
    const s = await start();
    const rows = (await pool.query('SELECT post_id, pct FROM post_rating WHERE post_id = ANY($1::int[])', [posts.map((p) => p.id)])).rows;
    for (const r of rows) out.set(r.post_id, r.pct === null ? null : Number(r.pct));
    for (const p of posts) {
      if (out.has(p.id)) continue;
      if (new Date(p.created_at).getTime() > s && isVideo(p)) {
        await pool.query('INSERT INTO post_rating (post_id, user_email) VALUES ($1, $2) ON CONFLICT (post_id) DO NOTHING', [p.id, email]).catch(() => {});
        out.set(p.id, null);
        setTimeout(() => analyze(p.id).catch(() => {}), 5000);
      }
    }
    return out;
  }

  // the creator's own view (creator dashboard): post id → { waiting } (never the %)
  async function labelsFor(ids) {
    const out = new Map(); if (!ids.length) return out;
    await ensure();
    const rows = (await pool.query('SELECT post_id, pct, reason FROM post_rating WHERE post_id = ANY($1::int[])', [ids])).rows;
    for (const r of rows) if (r.pct === null) out.set(r.post_id, { waiting: true });   // only "⏳ checking": the % stays with CamFeed
    return out;
  }

  // 🏷 the kind of video the AI chose (posts.ai_category): shown so the team can check it, and fix it
  const CAT_KM = { 'Comedy': 'កំប្លែង', 'Music': 'តន្ត្រី', 'Dance': 'រាំ', 'Movies & Drama': 'ភាពយន្ត និងរឿងភាគ', 'Gaming': 'ហ្គេម', 'Food': 'ម្ហូប',
    'Vehicles & Motorcycles': 'ឡាន និងម៉ូតូ', 'Technology': 'បច្ចេកវិទ្យា', 'News': 'ព័ត៌មាន', 'Sports': 'កីឡា', 'Education': 'អប់រំ', 'Travel': 'ដើរលេង',
    'Beauty & Fashion': 'សម្រស់ និងម៉ូដ', 'Business & Selling': 'អាជីវកម្ម និងលក់ទំនិញ', 'Home & DIY': 'ផ្ទះ និងធ្វើដោយខ្លួនឯង', 'Farming & Nature': 'កសិកម្ម និងធម្មជាតិ',
    'Animals & Pets': 'សត្វ', 'Family & Kids': 'គ្រួសារ និងកុមារ', 'Love & Relationships': 'ស្នេហា', 'Health & Fitness': 'សុខភាព និងហាត់ប្រាណ',
    'Religion & Culture': 'សាសនា និងវប្បធម៌', 'Motivation & Stories': 'លើកទឹកចិត្ត និងរឿងពិត', 'Lifestyle': 'ជីវិតប្រចាំថ្ងៃ', 'General': 'ទូទៅ' };
  const CAT_LIST = Object.keys(CAT_KM).map((v) => ({ v, km: CAT_KM[v] }));

  app.post('/api/admin/video-rating/category', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      const id = parseInt(b.post_id, 10) || 0, cat = String(b.cat || '');
      if (!CAT_KM[cat]) return res.status(400).json({ success: false, error: 'Choose a kind.' });
      const r = await pool.query('UPDATE posts SET ai_category = $2 WHERE id = $1 RETURNING id', [id, cat]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Post not found.' });
      if (audit) audit(a.adminEmail, 'video-category', String(id), cat);
      res.json({ success: true, cat, cat_km: CAT_KM[cat] });
    } catch (err) { console.error('[rating] category error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
  });

  app.post('/api/admin/video-rating/list', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const status = b.status === 'rated' ? 'rated' : 'pending';
      const limit = Math.min(Math.max(parseInt(b.limit, 10) || 50, 1), 200);
      const rows = (await pool.query(`SELECT r.*, p.content, p.media_type, p.media_url, p.thumb_url, p.ai_category, p.ai_tags, p.kw_at, p.created_at AS posted_at, COALESCE(p.views_count, 0) AS views,
            u.first_name, u.last_name, u.profile_pic, u.public_id, ca.source
          FROM post_rating r JOIN posts p ON p.id = r.post_id LEFT JOIN users u ON u.email = r.user_email
          LEFT JOIN creator_applications ca ON ca.user_email = r.user_email AND ca.status = 'approved'
          WHERE ${status === 'pending' ? 'r.pct IS NULL' : 'r.pct IS NOT NULL'}
          ORDER BY ${status === 'pending' ? 'r.created_at ASC' : 'r.rated_at DESC'} LIMIT $1`, [limit])).rows;
      const waiting = Number((await pool.query('SELECT COUNT(*) AS n FROM post_rating WHERE pct IS NULL')).rows[0].n) || 0;
      const rpmCache = {};
      const items = [];
      for (const x of rows) {
        const src = x.source || '';
        if (!(src in rpmCache)) rpmCache[src] = rpmFor ? await rpmFor(src).catch(() => 0) : 0;
        const m = pubMedia(x);
        const suggest = x.ai_flag === 'reupload' ? 10 : x.ai_flag === 'lowq' ? 50 : (x.ai_flag === 'ok' ? 100 : null);
        items.push({ post_id: x.post_id, text: String(x.content || '').slice(0, 200), video: m.video || '', thumb: x.thumb_url || '', posted_at: x.posted_at, views: Number(x.views) || 0,
          name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), pic: x.profile_pic || '', public_id: x.public_id || '',
          ai_flag: x.ai_flag || '', ai_note: x.ai_note || '', ai_done: !!x.ai_at, width: x.width, height: x.height, suggest,
          pct: x.pct === null ? null : Number(x.pct), reason: x.reason || '', rated_at: x.rated_at, rpm: rpmCache[src],
          cat: x.ai_category || '', cat_km: CAT_KM[x.ai_category] || '', tags: String(x.ai_tags || '').slice(0, 200), cat_done: !!x.kw_at });
      }
      res.json({ success: true, status, waiting, items, cats: CAT_LIST });
    } catch (err) { console.error('[rating] list error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  app.post('/api/admin/video-rating/rate', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const id = parseInt(b.post_id, 10) || 0;
      const pct = Math.round(Number(b.pct));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ success: false, error: 'Choose 0 to 100 %.' });
      const reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const r = (await pool.query('UPDATE post_rating SET pct = $2, reason = $3, rated_by = $4, rated_at = NOW() WHERE post_id = $1 RETURNING user_email', [id, pct, reason || null, a.adminEmail])).rows[0];
      if (!r) return res.status(404).json({ success: false, error: 'This video is not in the list.' });
      if (audit) audit(a.adminEmail, 'video-rate', String(id), pct + '%' + (reason ? ' ' + reason : ''));
      // the money for all the views since it was posted is added now (not limited by the daily cap: it is money already earned)
      let added = 0; try { if (creditNow) added = await creditNow(r.user_email); } catch (e) { console.error('[rating] credit:', e.message); }
      if (notify) {
        // the creator is NOT told the % (only CamFeed knows it)
        const msg = '✅ CamFeed បានពិនិត្យវីដេអូរបស់អ្នករួចហើយ។ សូមអរគុណ!';
        notify(r.user_email, msg, id).catch(() => {});
      }
      res.json({ success: true, added: added / 100 });
    } catch (err) { console.error('[rating] rate error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
  });

  const pendingCount = async () => { try { await ensure(); return Number((await pool.query('SELECT COUNT(*) AS n FROM post_rating WHERE pct IS NULL')).rows[0].n) || 0; } catch (e) { return 0; } };
  return { onNewPost, ratesFor, labelsFor, pendingCount, analyze };
};
