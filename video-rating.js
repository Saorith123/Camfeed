// 🎬 Video rating: every new video of a person who earns from views gets a % of the price per 1,000 views.
// 🤖 The AI rates it first (about a minute after posting) and the video earns at once at that %:
//    • the logo / @name on the video: none or the person's own name → 100 %, a name that can not be read → 50 %, somebody else's → 10 %
//    • how clear it is (blurry, shaky, too small even when the file is big) → 50 %
//    • how long it is (under 10 s) → 50 %            the lowest of the three is used
//    If the AI can not look, only the size / length checks are used (else 100 %).
// 🛡 The team checks later, when they like: a new % counts only for the views from then on (money already earned stays).
// 🔕 The creator is never told anything (it is CamFeed's inside setting).
//   POST /api/admin/video-rating/list  { status: 'ai' | 'rated', limit }
//   POST /api/admin/video-rating/rate  { post_id, pct, reason }
'use strict';

const { execFile } = require('child_process');

module.exports = function videoRating({ app, pool, adminGate, audit, pubMedia, interests, rpmFor, creditNow, notify, alertAdmins }) {
  let ready = null;
  const ensure = () => ready || (ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS post_rating (post_id INT PRIMARY KEY, user_email TEXT NOT NULL, pct INT, reason TEXT,
        ai_flag TEXT, ai_note TEXT, width INT, height INT, ai_at TIMESTAMPTZ, rated_by TEXT, rated_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query('CREATE INDEX IF NOT EXISTS post_rating_wait ON post_rating (created_at) WHERE pct IS NULL');
    await pool.query('ALTER TABLE post_rating ADD COLUMN IF NOT EXISTS ai_pct INT, ADD COLUMN IF NOT EXISTS secs REAL');
    // videos that waited for the team under the old way: the AI's suggestion becomes their % now (and their money is added)
    const old = await pool.query(`UPDATE post_rating SET pct = CASE ai_flag WHEN 'reupload' THEN 10 WHEN 'lowq' THEN 50 ELSE 100 END,
        ai_pct = CASE ai_flag WHEN 'reupload' THEN 10 WHEN 'lowq' THEN 50 ELSE 100 END, rated_by = 'ai', rated_at = NOW()
      WHERE pct IS NULL AND ai_at IS NOT NULL RETURNING user_email`);
    const who = [...new Set(old.rows.map((x) => x.user_email))];
    if (who.length && creditNow) setTimeout(() => { (async () => { for (const e of who) await creditNow(e).catch(() => {}); })(); }, 5000);
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
      setTimeout(() => analyze(p.id).catch(() => {}), 60 * 1000);   // the video file may still be finishing
    } catch (e) { console.error('[rating] new post:', e.message); }
  }

  // 🔎 the picture size and the length (ffmpeg says "Duration: 00:00:45.12 …" and "Video: h264 …, 720x1280")
  function sizeOf(url) {
    return new Promise((ok) => {
      const bin = (interests && interests.ffbin) ? interests.ffbin() : 'ffmpeg';
      execFile(bin, ['-hide_banner', '-i', url], { timeout: 20000, maxBuffer: 1024 * 1024 }, (e, so, se) => {
        const out = String(se || '') + String(so || '');
        const m = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(out);
        const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
        const secs = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
        ok(m || d ? { w: m ? Number(m[1]) : 0, h: m ? Number(m[2]) : 0, secs } : null);
      });
    });
  }
  const SHORT_SECS = 10;

  // 🤖 the AI looks at 3 frames + the person's name, then the video gets its % at once (only when nobody of the team rated it yet)
  async function analyze(postId) {
    await ensure();
    const p = (await pool.query(`SELECT p.id, p.user_email, p.content, p.media_type, p.media_url, u.first_name, u.last_name, u.public_id
                                 FROM posts p LEFT JOIN users u ON u.email = p.user_email WHERE p.id = $1`, [postId])).rows[0];
    if (!p) return;
    const m = pubMedia(p);
    let size = null; try { if (m.video) size = await sizeOf(m.video); } catch (e) {}
    const short = size && size.w && size.h ? Math.min(size.w, size.h) : 0;     // 720 for a 720×1280 video
    const secs = size && size.secs ? size.secs : null;
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
    let own = 100, clear = 100, len = 100;
    const notes = [];
    let flag = '';
    // ✋ size and length (no AI needed)
    if (short && short < 480) { clear = 50; notes.push('រូបតូច ' + short + 'p'); }
    if (secs !== null && secs < SHORT_SECS) { len = 50; notes.push('ខ្លីពេក ' + Math.round(secs) + ' វិនាទី'); }
    else if (secs !== null) notes.push(Math.round(secs) + ' វិនាទី');
    let aiOk = false;
    try {
      const frames = interests && interests.framesOf ? await interests.framesOf(p) : [];
      if (frames.length && interests.geminiJson) {
        const j = await interests.geminiJson(`You check videos posted on CamFeed (a Cambodian social app) that earn money from views.
The person who posted it is named: "${name.replace(/"/g, '').slice(0, 80)}".
Look at the ${frames.length} frame(s) and the caption and answer:
1) "logo": is there a logo, watermark or "@username" of another app or channel (TikTok, Douyin, CapCut, Kwai, Likee, Facebook, Instagram, YouTube, a TV channel …) on the video?
   "none" = no such mark; "own" = there is one and the name / @username in it is the same as, or clearly made from, the person's name above (they reposted their OWN video);
   "other" = the name in it is somebody else's (taken from another person); "unclear" = there is a mark but its name can not be read. A screen recording of another app counts as "other".
2) "logo_text": the name / @username you read in the mark, or "".
3) "clear": "good" or "poor". poor = blurry, very shaky, very dark, pixelated, a photo of a screen, or hard to understand what is shown — even when the picture size is big.
4) "note": at most 10 words in Khmer saying what you saw (no names of people).
Caption: """${String(p.content || '').slice(0, 600)}"""
Answer only JSON: {"logo": "none", "logo_text": "", "clear": "good", "note": ""}`, frames);
        if (j && !j.retry) {
          aiOk = true;
          const lt = String(j.logo_text || '').slice(0, 40);
          if (j.logo === 'own') { notes.unshift('ឡូហ្គោ ' + (lt || '') + ' ដូចឈ្មោះគណនី'); }
          else if (j.logo === 'other') { own = 10; flag = 'reupload'; notes.unshift('ឡូហ្គោអ្នកផ្សេង ' + lt); }
          else if (j.logo === 'unclear') { own = 50; notes.unshift('មានឡូហ្គោ តែមើលឈ្មោះមិនច្បាស់'); }
          else notes.unshift('គ្មានឡូហ្គោ');
          if (j.clear === 'poor') { clear = 50; notes.push('មិនសូវច្បាស់'); } else if (clear === 100) notes.push('ច្បាស់');
          if (j.note) notes.push(String(j.note).slice(0, 80));
        }
      }
    } catch (e) { console.error('[rating] AI:', e.message); }
    if (!aiOk) notes.unshift('AI មើលមិនបាន (ពិនិត្យតែទំហំ និងរយៈពេល)');
    const pct = Math.min(own, clear, len);
    if (!flag) flag = pct < 100 ? 'lowq' : 'ok';
    const note = (notes.filter(Boolean).join(' · ') + ' → ' + pct + '%').slice(0, 300);
    const r = await pool.query(`UPDATE post_rating SET ai_flag = $2, ai_note = $3, width = $4, height = $5, secs = $6, ai_pct = $7, ai_at = NOW(),
                                  pct = CASE WHEN rated_by IS NULL OR rated_by = 'ai' THEN $7 ELSE pct END,
                                  rated_by = CASE WHEN rated_by IS NULL THEN 'ai' ELSE rated_by END,
                                  rated_at = CASE WHEN rated_by IS NULL THEN NOW() ELSE rated_at END
                                WHERE post_id = $1 RETURNING user_email, rated_by`,
      [postId, flag, note, size ? size.w || null : null, size ? size.h || null : null, secs, pct]);
    const row = r.rows[0];
    if (row && row.rated_by === 'ai') {
      // 💵 the money for the views so far is added now, at the AI's %
      try { if (creditNow) await creditNow(row.user_email); } catch (e) { console.error('[rating] credit:', e.message); }
      if (alertAdmins && pct < 100) alertAdmins('🤖 AI វាយតម្លៃវីដេអូ ' + pct + '%', (name || 'អ្នកបង្កើតមាតិកា') + ' · ' + note.slice(0, 80), { open: 'rate', id: String(postId) }).catch(() => {});
    }
  }
  // a video the AI has not seen yet (a restart, a busy minute): looked at later
  setInterval(async () => {
    try {
      await ensure();
      const r = await pool.query("SELECT post_id FROM post_rating WHERE pct IS NULL AND ai_at IS NULL AND created_at < NOW() - INTERVAL '2 minutes' ORDER BY created_at LIMIT 3");
      // a video that could not be looked at at all: 100 % (nobody loses money because of our problem)
      for (const x of r.rows) await analyze(x.post_id).catch(() => pool.query("UPDATE post_rating SET ai_at = NOW(), ai_pct = 100, pct = 100, rated_by = 'ai', rated_at = NOW(), ai_note = 'AI មើលមិនបាន → 100%' WHERE post_id = $1 AND pct IS NULL", [x.post_id]).catch(() => {}));
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

  // the creator's own view (creator dashboard): 🔕 nothing — the rating is CamFeed's inside setting, never shown to the creator
  async function labelsFor() { return new Map(); }

  // 🏷 the kind of video the AI chose (posts.ai_category): shown so the team can check it, and fix it
  const CAT_KM = { 'Comedy': 'កំប្លែង', 'Music': 'តន្ត្រី', 'Dance': 'រាំ', 'Movies & Drama': 'ភាពយន្ត និងរឿងភាគ', 'Gaming': 'ហ្គេម', 'Food': 'ម្ហូប',
    'Vehicles & Motorcycles': 'ឡាន និងម៉ូតូ', 'Technology': 'បច្ចេកវិទ្យា', 'News': 'ព័ត៌មាន', 'Sports': 'កីឡា', 'Education': 'អប់រំ', 'Travel': 'ដើរលេង',
    'Beauty & Fashion': 'សម្រស់ និងម៉ូដ', 'Business & Selling': 'អាជីវកម្ម និងលក់ទំនិញ', 'Home & DIY': 'ផ្ទះ និងធ្វើដោយខ្លួនឯង', 'Farming & Nature': 'កសិកម្ម និងធម្មជាតិ',
    'Animals & Pets': 'សត្វ', 'Family & Kids': 'គ្រួសារ និងកុមារ', 'Love & Relationships': 'ស្នេហា', 'Health & Fitness': 'សុខភាព និងហាត់ប្រាណ',
    'Religion & Culture': 'សាសនា និងវប្បធម៌', 'Motivation & Stories': 'លើកទឹកចិត្ត និងរឿងពិត', 'Cartoons & Animation': 'តុក្កតា និងគំនូរជីវចល', 'Lifestyle': 'ជីវិតប្រចាំថ្ងៃ', 'General': 'ទូទៅ' };
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
      const status = b.status === 'rated' ? 'rated' : 'ai';   // 🤖 rated by the AI (or the AI is still looking) / ✅ checked by the team
      const limit = Math.min(Math.max(parseInt(b.limit, 10) || 50, 1), 200);
      const rows = (await pool.query(`SELECT r.*, p.content, p.media_type, p.media_url, p.thumb_url, p.ai_category, p.ai_tags, p.kw_at, p.created_at AS posted_at, COALESCE(p.views_count, 0) AS views,
            u.first_name, u.last_name, u.profile_pic, u.public_id, ca.source
          FROM post_rating r JOIN posts p ON p.id = r.post_id LEFT JOIN users u ON u.email = r.user_email
          LEFT JOIN creator_applications ca ON ca.user_email = r.user_email AND ca.status = 'approved'
          WHERE ${status === 'ai' ? "(r.rated_by IS NULL OR r.rated_by = 'ai')" : "r.rated_by IS NOT NULL AND r.rated_by <> 'ai'"}
          ORDER BY ${status === 'ai' ? '(r.pct IS NULL) DESC, COALESCE(r.ai_pct, 100) ASC, r.created_at DESC' : 'r.rated_at DESC'} LIMIT $1`, [limit])).rows;
      const waiting = await pendingCount();
      const rpmCache = {};
      const items = [];
      for (const x of rows) {
        const src = x.source || '';
        if (!(src in rpmCache)) rpmCache[src] = rpmFor ? await rpmFor(src).catch(() => 0) : 0;
        const m = pubMedia(x);
        const suggest = x.ai_pct !== null && x.ai_pct !== undefined ? Number(x.ai_pct) : (x.ai_flag === 'reupload' ? 10 : x.ai_flag === 'lowq' ? 50 : (x.ai_flag === 'ok' ? 100 : null));
        items.push({ post_id: x.post_id, text: String(x.content || '').slice(0, 200), video: m.video || '', thumb: x.thumb_url || '', posted_at: x.posted_at, views: Number(x.views) || 0,
          name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), pic: x.profile_pic || '', public_id: x.public_id || '',
          ai_flag: x.ai_flag || '', ai_note: x.ai_note || '', ai_done: !!x.ai_at, width: x.width, height: x.height, suggest,
          pct: x.pct === null ? null : Number(x.pct), reason: x.reason || '', rated_at: x.rated_at, rpm: rpmCache[src], by_ai: !x.rated_by || x.rated_by === 'ai', secs: x.secs,
          cat: (!x.kw_at && x.ai_category === 'General') ? '' : (x.ai_category || ''), cat_km: (!x.kw_at && x.ai_category === 'General') ? '' : (CAT_KM[x.ai_category] || ''), tags: String(x.ai_tags || '').slice(0, 200), cat_done: !!x.kw_at });
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
      const cur = (await pool.query('SELECT user_email FROM post_rating WHERE post_id = $1', [id])).rows[0];
      if (!cur) return res.status(404).json({ success: false, error: 'This video is not in the list.' });
      // the views so far are paid at the OLD % first (money already earned is never taken back or added to) …
      try { if (creditNow) await creditNow(cur.user_email); } catch (e) { console.error('[rating] credit:', e.message); }
      // … then the new % counts for the views from now on
      const r = (await pool.query('UPDATE post_rating SET pct = $2, reason = $3, rated_by = $4, rated_at = NOW() WHERE post_id = $1 RETURNING user_email', [id, pct, reason || null, a.adminEmail])).rows[0];
      if (audit) audit(a.adminEmail, 'video-rate', String(id), pct + '%' + (reason ? ' ' + reason : ''));
      let added = 0; try { if (creditNow) added = await creditNow(r.user_email); } catch (e) { console.error('[rating] credit:', e.message); }
      // 🔕 the creator is NOT told anything: the rating is CamFeed's own inside setting
      res.json({ success: true, added: added / 100 });
    } catch (err) { console.error('[rating] rate error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
  });

  // 🤖 videos the AI rated that the team has not checked yet
  const pendingCount = async () => { try { await ensure(); return Number((await pool.query("SELECT COUNT(*) AS n FROM post_rating WHERE rated_by IS NULL OR rated_by = 'ai'")).rows[0].n) || 0; } catch (e) { return 0; } };
  return { onNewPost, ratesFor, labelsFor, pendingCount, analyze };
};
