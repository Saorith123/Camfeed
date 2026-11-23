// ✔ CamFeed blue tick = "this is the OFFICIAL account, not a fake". It is hard to get (strict rules, the Super Admin decides),
// is never sold, is checked again every year, pauses when the name changes and is taken away for breaking the rules.
// Three ways to prove who you are (CamFeed never keeps ID cards):
//   business — a shop / company: its registration number (checked on the Ministry of Commerce website)
//   official — a well-known person / organisation: a code from CamFeed put on their official Facebook page / Telegram channel
//   creator  — a big content creator: many followers here, or a big YouTube / TikTok / Facebook channel showing the CamFeed code
// Also here: the account kind (👤 personal / 🏪 business, organisation, public figure) and the name rules (one word only for business accounts).
'use strict';
const crypto = require('crypto');

const DEFAULTS = { minDays: 90, minFollowers: 10000, minPosts30: 3, years: 1 };
const PATHS = ['business', 'official', 'creator'];
const CATEGORIES = ['shop', 'company', 'media', 'organization', 'government', 'public_figure', 'artist', 'creator', 'education', 'health', 'food', 'other'];
// names nobody may take (only CamFeed itself can give them)
const RESERVED = [/camfeed/i, /^admin$/i, /administrator/i, /ក្រសួង/, /រាជរដ្ឋាភិបាល/, /moderator/i, /ក្រុមការងារ\s*camfeed/i];

module.exports = function ({ app, pool, adminGate, audit, sendNotice }) {
  let cfg = Object.assign({}, DEFAULTS), ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(12) NOT NULL DEFAULT 'personal', ADD COLUMN IF NOT EXISTS category VARCHAR(24) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS verified_paused BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS verified_name TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS verified_path VARCHAR(12) NOT NULL DEFAULT ''`);
      await pool.query(`CREATE TABLE IF NOT EXISTS verify_requests (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, path VARCHAR(12) NOT NULL, code VARCHAR(12) NOT NULL,
        reg_no TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', link2 TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', checks TEXT NOT NULL DEFAULT '',
        status VARCHAR(12) NOT NULL DEFAULT 'pending', admin_note TEXT NOT NULL DEFAULT '', decided_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ)`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_verify_req_user ON verify_requests (LOWER(user_email), id DESC)');
      await pool.query('CREATE TABLE IF NOT EXISTS verify_cfg (k VARCHAR(30) PRIMARY KEY, v TEXT NOT NULL)');
      const r = await pool.query('SELECT k, v FROM verify_cfg');
      r.rows.forEach((x) => { if (x.k in DEFAULTS) { const n = Number(x.v); if (Number.isFinite(n) && n >= 0) cfg[x.k] = n; } });
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  ensure().catch((e) => console.error('[verify]', e.message));

  const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
  const link = (v) => { const s = clean(v, 300); return /^https?:\/\/[^\s]+$/i.test(s) ? s : ''; };
  const nameOf = (u) => ((u.first_name || '') + ' ' + (u.last_name || '')).trim();

  // the checks the person can see (✅ / ❌), counted by the server
  async function checksOf(email) {
    const u = (await pool.query(`SELECT email, first_name, last_name, profile_pic, phone, created_at, COALESCE(is_banned, FALSE) AS banned, account_type, category, verified, verified_paused,
      (SELECT COUNT(*) FROM follows f WHERE f.following_email = users.email)::int AS followers,
      (SELECT COUNT(*) FROM posts p WHERE p.user_email = users.email AND p.created_at > NOW() - INTERVAL '30 days')::int AS posts30
      FROM users WHERE email = $1`, [email])).rows[0];
    if (!u) return null;
    let bad = 0;
    try { bad += Number((await pool.query('SELECT COUNT(*)::int AS n FROM copyright_strikes WHERE LOWER(user_email) = LOWER($1)', [email])).rows[0].n) || 0; } catch (e) {}
    try {
      bad += Number((await pool.query(`SELECT COUNT(*)::int AS n FROM reports r WHERE r.status NOT IN ('pending', 'dismissed', 'rejected')
        AND (LOWER(r.target_user_email) = LOWER($1) OR r.target_post_id IN (SELECT id FROM posts WHERE user_email = $1))`, [email])).rows[0].n) || 0;
    } catch (e) {}
    const days = Math.floor((Date.now() - new Date(u.created_at || Date.now()).getTime()) / 86400000);
    const list = [
      { k: 'days', ok: days >= cfg.minDays, have: days, need: cfg.minDays },
      { k: 'clean', ok: bad === 0 && !u.banned, have: bad },
      { k: 'phone', ok: !!String(u.phone || '').trim() },
      { k: 'pic', ok: !!String(u.profile_pic || '').trim() && !!String(u.first_name || '').trim() },
      { k: 'posts', ok: u.posts30 >= cfg.minPosts30, have: u.posts30, need: cfg.minPosts30 },
      { k: 'followers', ok: u.followers >= cfg.minFollowers, have: u.followers, need: cfg.minFollowers, soft: true },   // not needed when proven another way (business / official / big channel)
    ];
    return { u, list, hard: list.filter((x) => !x.soft).every((x) => x.ok) };
  }

  // ---------- the person ----------
  app.get('/api/verify/me', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      await ensure();
      const c = await checksOf(me); if (!c) return res.status(404).json({ success: false });
      const r = (await pool.query('SELECT id, path, code, status, admin_note, created_at, decided_at FROM verify_requests WHERE LOWER(user_email) = LOWER($1) ORDER BY id DESC LIMIT 1', [me])).rows[0] || null;
      res.json({ success: true, verified: !!c.u.verified, paused: !!c.u.verified_paused, accountType: c.u.account_type, category: c.u.category || '', checks: c.list, canApply: c.hard, request: r, cfg, categories: CATEGORIES });
    } catch (e) { console.error('[verify] me:', e.message); res.status(500).json({ success: false }); }
  });

  // a code to put on the official page / channel (the same code until a new request)
  app.post('/api/verify/code', async (req, res) => {
    const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
    res.json({ success: true, code: 'CF-' + crypto.createHash('sha1').update(String(me).toLowerCase() + ':camfeed-verify').digest('hex').slice(0, 6).toUpperCase() });
  });

  app.post('/api/verify/request', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      await ensure();
      const b = req.body || {}, path = PATHS.includes(b.path) ? b.path : '';
      if (!path) return res.status(400).json({ success: false, error: 'Please choose how you will prove who you are.' });
      const c = await checksOf(me);
      if (!c || !c.hard) return res.status(400).json({ success: false, error: 'Some of the conditions are not met yet.' });
      if (c.u.verified && !c.u.verified_paused) return res.status(400).json({ success: false, error: 'This account already has the blue tick.' });
      const open = (await pool.query("SELECT id FROM verify_requests WHERE LOWER(user_email) = LOWER($1) AND status = 'pending'", [me])).rows[0];
      if (open) return res.status(400).json({ success: false, error: 'Your request is already being checked.' });
      const last = (await pool.query("SELECT decided_at FROM verify_requests WHERE LOWER(user_email) = LOWER($1) AND status = 'rejected' ORDER BY id DESC LIMIT 1", [me])).rows[0];
      if (last && last.decided_at && Date.now() - new Date(last.decided_at).getTime() < 30 * 86400000) return res.status(429).json({ success: false, error: 'You can ask again 30 days after the last answer.' });
      const regNo = clean(b.reg_no, 60), l1 = link(b.link), l2 = link(b.link2), note = clean(b.note, 600);
      if (path === 'business' && !regNo) return res.status(400).json({ success: false, error: 'Please write the business registration number.' });
      if (path === 'official' && !l1) return res.status(400).json({ success: false, error: 'Please add the link of your official page or channel.' });
      const followersOk = (c.list.find((x) => x.k === 'followers') || {}).ok;
      if (path === 'creator' && !followersOk && !l1) return res.status(400).json({ success: false, error: 'Please add the link of your big channel (YouTube, TikTok or Facebook).' });
      const code = 'CF-' + crypto.createHash('sha1').update(String(me).toLowerCase() + ':camfeed-verify').digest('hex').slice(0, 6).toUpperCase();
      const r = await pool.query(`INSERT INTO verify_requests (user_email, path, code, reg_no, link, link2, note, checks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [me, path, code, regNo, l1, l2, note, JSON.stringify(c.list)]);
      res.status(201).json({ success: true, id: r.rows[0].id, code });
    } catch (e) { console.error('[verify] request:', e.message); res.status(500).json({ success: false, error: 'Could not send.' }); }
  });

  // 👤 personal or 🏪 business / organisation / public figure
  app.post('/api/account/type', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      await ensure();
      const b = req.body || {}, t = b.type === 'business' ? 'business' : 'personal', cat = t === 'business' && CATEGORIES.includes(b.category) ? b.category : '';
      if (t === 'personal') {
        const u = (await pool.query('SELECT last_name FROM users WHERE email = $1', [me])).rows[0];
        if (u && !String(u.last_name || '').trim()) return res.status(400).json({ success: false, code: 'need_last', error: 'A personal account needs a first and a last name. Please change the name first.' });
      }
      await pool.query('UPDATE users SET account_type = $1, category = $2 WHERE email = $3', [t, cat, me]);
      res.json({ success: true, type: t, category: cat });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  // ---------- the name rules (called by the name change) ----------
  // returns an error text, or '' when the name is fine. A blue-tick account changing its name: the tick pauses until CamFeed checks again.
  async function checkName(email, first, last) {
    await ensure();
    const u = (await pool.query('SELECT account_type, role FROM users WHERE email = $1', [email])).rows[0] || {};
    const full = (first + ' ' + last).trim();
    const isAdmin = u.role === 'admin' || u.role === 'super_admin';
    if (!isAdmin && RESERVED.some((re) => re.test(full))) return 'This name can not be used.';
    if (!last && u.account_type !== 'business') return 'Please enter the first and the last name. (One word only for a business account.)';
    const taken = (await pool.query(`SELECT 1 FROM users WHERE email <> $1 AND verified = TRUE AND verified_paused = FALSE
      AND LOWER(TRIM(CONCAT(first_name, ' ', last_name))) = LOWER($2) LIMIT 1`, [email, full])).rows[0];
    if (taken) return 'This is the name of an official account. Please choose another name.';
    return '';
  }
  async function afterRename(email) {
    try {
      const r = await pool.query("UPDATE users SET verified_paused = TRUE WHERE email = $1 AND verified = TRUE AND LOWER(TRIM(CONCAT(first_name, ' ', last_name))) <> LOWER(verified_name) RETURNING email", [email]);
      if (r.rows.length) sendNotice('CamFeed', email, '✔ អ្នកបានប្ដូរឈ្មោះ ដូច្នេះសញ្ញា ✔ ផ្អាកសិន។ CamFeed នឹងពិនិត្យម្ដងទៀត។').catch(() => {});
    } catch (e) {}
  }

  // every day: a tick older than N years pauses until it is checked again
  async function yearly() {
    await ensure();
    const r = await pool.query(`UPDATE users SET verified_paused = TRUE WHERE verified = TRUE AND verified_paused = FALSE AND verified_at < NOW() - ($1 || ' years')::interval RETURNING email`, [String(cfg.years || 1)]);
    for (const x of r.rows) sendNotice('CamFeed', x.email, '✔ ដល់ពេលពិនិត្យសញ្ញា ✔ ប្រចាំឆ្នាំ។ សូមដាក់ពាក្យម្ដងទៀតក្នុង ការកំណត់ › ✔ គណនីផ្លូវការ។').catch(() => {});
  }
  setInterval(() => yearly().catch(() => {}), 24 * 3600 * 1000);

  // ---------- Admin (only the Super Admin gives or takes the tick) ----------
  app.post('/api/admin/verify', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const b = req.body || {}, act = String(b.action || 'list');
      if (act === 'list') {
        const st = ['pending', 'approved', 'rejected'].includes(b.status) ? b.status : 'pending';
        const r = await pool.query(`SELECT q.*, u.first_name, u.last_name, u.profile_pic, u.account_type, u.category, u.verified, u.verified_paused,
            (SELECT COUNT(*) FROM follows f WHERE f.following_email = u.email)::int AS followers
          FROM verify_requests q JOIN users u ON u.email = q.user_email WHERE q.status = $1 ORDER BY q.id DESC LIMIT 100`, [st]);
        const paused = (await pool.query(`SELECT email, first_name, last_name, profile_pic, verified_name, verified_at FROM users WHERE verified = TRUE AND verified_paused = TRUE ORDER BY verified_at DESC LIMIT 100`)).rows;
        const have = (await pool.query(`SELECT email, first_name, last_name, profile_pic, verified_path, verified_at FROM users WHERE verified = TRUE AND verified_paused = FALSE ORDER BY verified_at DESC LIMIT 200`)).rows;
        return res.json({ success: true, requests: r.rows, paused, verified: have, cfg, isSuperAdmin: !!a.isSuperAdmin });
      }
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only the Super Admin can give or take the blue tick.' });
      if (act === 'decide') {
        const id = parseInt(b.id, 10), ok = b.ok === true, note = clean(b.note, 400);
        const q = (await pool.query("UPDATE verify_requests SET status = $2, admin_note = $3, decided_by = $4, decided_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *", [id, ok ? 'approved' : 'rejected', note, a.adminEmail])).rows[0];
        if (!q) return res.status(404).json({ success: false, error: 'Already answered.' });
        if (ok) {
          await pool.query("UPDATE users SET verified = TRUE, verified_paused = FALSE, verified_at = NOW(), verified_path = $2, verified_name = TRIM(CONCAT(first_name, ' ', last_name)) WHERE email = $1", [q.user_email, q.path]);
          sendNotice(a.adminEmail, q.user_email, '✔ អបអរសាទរ! គណនីរបស់អ្នកទទួលបានសញ្ញា ✔ គណនីផ្លូវការពី CamFeed ហើយ។').catch(() => {});
        } else sendNotice(a.adminEmail, q.user_email, '✔ CamFeed មិនទាន់អាចផ្ដល់សញ្ញា ✔ ឲ្យគណនីរបស់អ្នកនៅពេលនេះទេ។' + (note ? ' មូលហេតុ៖ ' + note : '') + ' អ្នកអាចដាក់ពាក្យម្ដងទៀតក្រោយ 30 ថ្ងៃ។').catch(() => {});
        audit(a.adminEmail, ok ? 'verify_approve' : 'verify_reject', q.user_email, 'V' + id + ' ' + q.path + (note ? ' · ' + note : ''));
        return res.json({ success: true });
      }
      if (act === 'restore' || act === 'remove') {               // a paused tick: give it back after checking the new name; or take it away
        const email = String(b.targetEmail || ''), note = clean(b.note, 400);   // not "email": auth.js turns a body "email" into the Admin's own
        if (act === 'restore') await pool.query("UPDATE users SET verified_paused = FALSE, verified_at = NOW(), verified_name = TRIM(CONCAT(first_name, ' ', last_name)) WHERE email = $1 AND verified = TRUE", [email]);
        else {
          await pool.query("UPDATE users SET verified = FALSE, verified_paused = FALSE WHERE email = $1", [email]);
          sendNotice(a.adminEmail, email, '✔ សញ្ញា ✔ គណនីផ្លូវការ ត្រូវបានដកចេញ។' + (note ? ' មូលហេតុ៖ ' + note : '')).catch(() => {});
        }
        audit(a.adminEmail, 'verify_' + act, email, note);
        return res.json({ success: true });
      }
      if (act === 'settings') {
        for (const k of Object.keys(DEFAULTS)) {
          if (b[k] === undefined) continue;
          const n = Math.max(0, Math.min(10000000, Math.round(Number(b[k]) || 0)));
          cfg[k] = n;
          await pool.query('INSERT INTO verify_cfg (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, String(n)]);
        }
        audit(a.adminEmail, 'verify_settings', '', JSON.stringify(cfg));
        return res.json({ success: true, cfg });
      }
      res.status(400).json({ success: false });
    } catch (e) { console.error('[verify] admin:', e.message); res.status(500).json({ success: false, error: e.message }); }
  });

  // SQL: TRUE when the author shows ✔ (alias = the users row)
  const tickSql = (alias) => `(COALESCE(${alias}.verified, FALSE) AND NOT COALESCE(${alias}.verified_paused, FALSE))`;
  return { ensure, checkName, afterRename, tickSql, CATEGORIES };
};
