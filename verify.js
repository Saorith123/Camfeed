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

// ☑️ the conditions the Admin can turn on / off (and set the number) — one list for ✔ and one for a one-word name of a personal account
const COND_KEYS = ['days', 'followers', 'posts', 'phone', 'pic', 'clean', 'rename', 'tick', 'idproof', 'bank'];
const COND_DEFAULTS = {
  tick: { days: { on: true, n: 90 }, followers: { on: true, n: 10000 }, posts: { on: true, n: 3 }, phone: { on: true }, pic: { on: true }, clean: { on: true },
    rename: { on: false, n: 30 }, tick: { on: false }, idproof: { on: false }, bank: { on: false } },
  name: { days: { on: true, n: 30 }, followers: { on: false, n: 100 }, posts: { on: false, n: 1 }, phone: { on: true }, pic: { on: true }, clean: { on: true },
    rename: { on: true, n: 15 }, tick: { on: false }, idproof: { on: false }, bank: { on: false } },
};
// 🪪 ID + selfie (taken with the camera) or 💳 a monthly fee · 🏦 a small transfer from the person's own bank account (the receipt shows the account name)
const PROOF_DEFAULTS = { monthCents: 200, bankCents: 3, note_km: 'ការផ្ទេរនេះ ដើម្បីផ្ទៀងផ្ទាត់ថា ឈ្មោះគណនីធនាគាររបស់អ្នក ដូចឈ្មោះក្នុង CamFeed ប៉ុណ្ណោះ — មិនមែនជាការបង់ថ្លៃទេ។', note_en: 'This transfer only checks that the name of your bank account is the same as your CamFeed name — it is not a fee.',
  // 🪪 what CamFeed needs to see on the ID card — the Admin writes it (e.g. only the photo and the name: the ID number may be covered)
  id_note_km: 'CamFeed ត្រូវការមើលតែរូបថត និងឈ្មោះលើអត្តសញ្ញាណប័ណ្ណប៉ុណ្ណោះ។ អ្នកអាចយកក្រដាស ឬម្រាមដៃ បិទលេខអត្តសញ្ញាណប័ណ្ណ និងព័ត៌មានផ្សេងទៀតបាន។',
  id_note_en: 'CamFeed only needs to see the photo and the name on the ID card. You may cover the ID number and the other details with paper or a finger.' };

module.exports = function ({ app, pool, adminGate, audit, sendNotice, tgAsk, safeUrl, deleteMedia, payInfo }) {
  let cfg = Object.assign({}, DEFAULTS), ready = null;
  let conds = JSON.parse(JSON.stringify(COND_DEFAULTS)), proofCfg = Object.assign({}, PROOF_DEFAULTS);
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
      const cr = r.rows.find((x) => x.k === 'conds'), pr = r.rows.find((x) => x.k === 'proof');
      if (cr) { try { conds = cleanConds(JSON.parse(cr.v)); } catch (e) {} }
      else { conds.tick.days.n = cfg.minDays; conds.tick.followers.n = cfg.minFollowers; conds.tick.posts.n = cfg.minPosts30; }   // the numbers saved before
      if (pr) { try { proofCfg = cleanProof(JSON.parse(pr.v)); } catch (e) {} }
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS one_word_name TEXT');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS name_swapped BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS name_ok BOOLEAN NOT NULL DEFAULT FALSE');   // an Admin fixed the order by hand
      // 🇰🇭 names typed before this day had the surname last: only those can be swapped (Admin › ✔ › 🔁)
      await pool.query("INSERT INTO verify_cfg (k, v) VALUES ('name_cutoff', NOW()::text) ON CONFLICT (k) DO NOTHING");
      await pool.query(`CREATE TABLE IF NOT EXISTS verify_invites (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'pending', invited_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), answered_at TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS verify_proofs (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, kind VARCHAR(8) NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'pending',
        id_url TEXT, selfie_url TEXT, receipt_url TEXT, ref TEXT, amount_cents INTEGER NOT NULL DEFAULT 0, note TEXT, decided_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, expires_at TIMESTAMPTZ)`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_verify_proofs_user ON verify_proofs (LOWER(user_email), id DESC)');
      await pool.query(`CREATE TABLE IF NOT EXISTS name_requests (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, name TEXT NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'pending',
        checks TEXT, note TEXT, decided_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ)`);
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  ensure().catch((e) => console.error('[verify]', e.message));

  function cleanConds(raw) {
    const out = JSON.parse(JSON.stringify(COND_DEFAULTS));
    for (const p of ['tick', 'name']) {
      const src = raw && raw[p]; if (!src || typeof src !== 'object') continue;
      for (const k of COND_KEYS) {
        const x = src[k]; if (!x || typeof x !== 'object') continue;
        out[p][k].on = !!x.on;
        if ('n' in out[p][k] && x.n !== undefined) out[p][k].n = Math.max(0, Math.min(10000000, Math.round(Number(x.n) || 0)));
      }
      if (p === 'name') out.name.tick.on = out.name.tick.on;   // "must already have ✔" makes sense for a name only
      if (p === 'tick') out.tick.tick.on = false;
    }
    return out;
  }
  function cleanProof(raw) {
    const o = Object.assign({}, PROOF_DEFAULTS), r = raw || {};
    if (r.monthCents !== undefined) o.monthCents = Math.max(0, Math.min(1000000, Math.round(Number(r.monthCents) || 0)));
    if (r.bankCents !== undefined) o.bankCents = Math.max(1, Math.min(100000, Math.round(Number(r.bankCents) || 1)));
    for (const k of ['note_km', 'note_en', 'id_note_km', 'id_note_en']) if (r[k] !== undefined) o[k] = String(r[k] || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 400) || PROOF_DEFAULTS[k];
    return o;
  }
  const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
  const link = (v) => { const s = clean(v, 300); return /^https?:\/\/[^\s]+$/i.test(s) ? s : ''; };
  const nameOf = (u) => ((u.first_name || '') + ' ' + (u.last_name || '')).trim();

  // the checks the person can see (✅ / ❌), counted by the server
  // 🪪 🏦 the person's proofs that count now: ID + selfie approved, a monthly fee paid (until it ends), a bank name check approved
  async function proofsOf(email) {
    const r = (await pool.query(`SELECT kind, status, expires_at FROM verify_proofs WHERE LOWER(user_email) = LOWER($1) ORDER BY id DESC LIMIT 30`, [email])).rows;
    const ok = (k) => r.some((x) => x.kind === k && x.status === 'approved' && (!x.expires_at || new Date(x.expires_at) > new Date()));
    return { id: ok('id'), pay: ok('pay'), bank: ok('bank') || ok('pay') };   // a monthly fee paid from the bank also shows the account name
  }
  async function checksOf(email, purpose) {
    const P = purpose === 'name' ? 'name' : 'tick', C = conds[P];
    const u = (await pool.query(`SELECT email, first_name, last_name, profile_pic, phone, created_at, name_changed_at, one_word_name, COALESCE(is_banned, FALSE) AS banned, account_type, category, verified, verified_paused,
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
    const sinceRename = u.name_changed_at ? Math.floor((Date.now() - new Date(u.name_changed_at).getTime()) / 86400000) : 99999;
    const pf = (C.idproof.on || C.bank.on) ? await proofsOf(email) : { id: false, pay: false, bank: false };
    const all = {
      days: { k: 'days', ok: days >= C.days.n, have: days, need: C.days.n },
      clean: { k: 'clean', ok: bad === 0 && !u.banned, have: bad },
      phone: { k: 'phone', ok: !!String(u.phone || '').trim() },
      pic: { k: 'pic', ok: !!String(u.profile_pic || '').trim() && !!String(u.first_name || '').trim() },
      posts: { k: 'posts', ok: u.posts30 >= C.posts.n, have: u.posts30, need: C.posts.n },
      followers: { k: 'followers', ok: u.followers >= C.followers.n, have: u.followers, need: C.followers.n, soft: P === 'tick' },   // ✔: not needed when proven another way
      rename: { k: 'rename', ok: sinceRename >= C.rename.n, have: Math.min(sinceRename, 99999), need: C.rename.n },
      tick: { k: 'tick', ok: !!u.verified && !u.verified_paused },
      idproof: { k: 'idproof', ok: pf.id || pf.pay },
      bank: { k: 'bank', ok: pf.bank },
    };
    const list = COND_KEYS.filter((k) => C[k] && C[k].on).map((k) => all[k]);
    return { u, list, hard: list.filter((x) => !x.soft).every((x) => x.ok) };
  }

  // ---------- the person ----------
  app.get('/api/verify/me', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      await ensure();
      const c = await checksOf(me); if (!c) return res.status(404).json({ success: false });
      const r = (await pool.query('SELECT id, path, code, status, admin_note, created_at, decided_at FROM verify_requests WHERE LOWER(user_email) = LOWER($1) ORDER BY id DESC LIMIT 1', [me])).rows[0] || null;
      const nc = await checksOf(me, 'name');
      const proofs = (await pool.query('SELECT DISTINCT ON (kind) id, kind, status, note, created_at, decided_at, expires_at FROM verify_proofs WHERE LOWER(user_email) = LOWER($1) ORDER BY kind, id DESC', [me])).rows;
      const nreq = (await pool.query('SELECT id, name, status, note, created_at FROM name_requests WHERE LOWER(user_email) = LOWER($1) ORDER BY id DESC LIMIT 1', [me])).rows[0] || null;
      const invite = (await pool.query("SELECT id, created_at FROM verify_invites WHERE LOWER(user_email) = LOWER($1) AND status = 'pending' ORDER BY id DESC LIMIT 1", [me])).rows[0] || null;
      const needProof = ['tick', 'name'].some((p) => conds[p].idproof.on || conds[p].bank.on);
      const pay = needProof && payInfo ? await payInfo() : {};
      res.json({ success: true, verified: !!c.u.verified, paused: !!c.u.verified_paused, accountType: c.u.account_type, category: c.u.category || '', checks: c.list, canApply: c.hard, request: r, cfg, categories: CATEGORIES,
        invite: c.u.verified && !c.u.verified_paused ? null : invite,
        nameChecks: nc.list, nameCanAsk: nc.hard, nameRequest: nreq, oneWordName: c.u.one_word_name || '', proofs, proofCfg: needProof ? { ...proofCfg, qr: pay.qr || '', link: pay.link || '' } : null,
        proofOn: { idproof: conds.tick.idproof.on || conds.name.idproof.on, bank: conds.tick.bank.on || conds.name.bank.on } });
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
    const u = (await pool.query('SELECT account_type, role, one_word_name FROM users WHERE email = $1', [email])).rows[0] || {};
    const full = (first + ' ' + last).trim();
    const isAdmin = u.role === 'admin' || u.role === 'super_admin';
    if (!isAdmin && RESERVED.some((re) => re.test(full))) return 'This name can not be used.';
    if (!last && u.account_type !== 'business' && String(u.one_word_name || '').toLowerCase() !== first.toLowerCase()) return 'NEED_REQUEST';   // 👤 one word for a personal account: CamFeed approves it first
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

  // ---------- 🏷️ a one-word name for a personal account: a request, CamFeed approves ----------
  const NAMES_KM = { days: 'ប្រើ CamFeed យ៉ាងតិច {n} ថ្ងៃ', followers: 'អ្នកតាមដានយ៉ាងតិច {n} នាក់', posts: 'បង្ហោះយ៉ាងតិច {n} ក្នុង 30 ថ្ងៃ', phone: 'បញ្ជាក់លេខទូរស័ព្ទ', pic: 'មានរូបប្រូហ្វាល',
    clean: 'មិនដែលបំពានច្បាប់', rename: 'មិនបានប្ដូរឈ្មោះក្នុង {n} ថ្ងៃចុងក្រោយ', tick: 'មានសញ្ញា ✔ រួចហើយ', idproof: 'បញ្ជាក់អត្តសញ្ញាណ (ID + Selfie) ឬបង់ថ្លៃប្រចាំខែ', bank: 'បញ្ជាក់ឈ្មោះតាមគណនីធនាគារ' };
  async function nameRequest(email, name) {
    await ensure();
    const nm = clean(name, 40);
    if (!nm || /\s/.test(nm)) return { ok: false, code: 'bad', error: 'សូមវាយឈ្មោះតែមួយពាក្យ។' };
    const c = await checksOf(email, 'name');
    if (!c) return { ok: false, code: 'bad', error: 'Not found.' };
    if (!c.hard) {
      const miss = c.list.filter((x) => !x.ok).map((x) => NAMES_KM[x.k].replace('{n}', x.need));
      return { ok: false, code: 'conds', missing: miss, error: 'ដើម្បីប្រើឈ្មោះមួយពាក្យ អ្នកនៅខ្វះ៖ ' + miss.join(' · ') + '។ (ការកំណត់ › ✔ គណនីផ្លូវការ)' };
    }
    const open = (await pool.query("SELECT id FROM name_requests WHERE LOWER(user_email) = LOWER($1) AND status = 'pending'", [email])).rows[0];
    if (open) return { ok: false, code: 'open', error: 'សំណើឈ្មោះរបស់អ្នក កំពុងត្រូវបាន CamFeed ពិនិត្យ។' };
    const id = (await pool.query('INSERT INTO name_requests (user_email, name, checks) VALUES ($1, $2, $3) RETURNING id', [email, nm, JSON.stringify(c.list)])).rows[0].id;
    const now = ((c.u.first_name || '') + ' ' + (c.u.last_name || '')).trim();
    if (tgAsk) tgAsk('nr', id, ['🏷️ ស្នើឈ្មោះមួយពាក្យ N' + id, '👤 ឥឡូវ៖ ' + now, '➡️ ចង់ប្ដូរជា៖ ' + nm, '✅ លក្ខខណ្ឌគ្រប់ (' + c.list.length + ')'], ['✅ អនុម័ត', '❌ បដិសេធ']).catch(() => {});
    return { ok: true, id };
  }
  async function decideName(id, ok, by, note) {
    await ensure();
    const q = (await pool.query("UPDATE name_requests SET status = $2, note = $3, decided_by = $4, decided_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *", [id, ok ? 'approved' : 'rejected', clean(note, 300), by])).rows[0];
    if (!q) return { ok: false, text: 'Already answered.' };
    if (ok) {
      await pool.query("UPDATE users SET first_name = $2, last_name = '', one_word_name = $2, name_changed_at = NOW() WHERE email = $1", [q.user_email, q.name]);
      await afterRename(q.user_email);
      sendNotice('CamFeed', q.user_email, '🏷️ CamFeed បានអនុម័តឈ្មោះ «' + q.name + '» ហើយ។').catch(() => {});
    } else sendNotice('CamFeed', q.user_email, '🏷️ CamFeed មិនទាន់អនុម័តឈ្មោះ «' + q.name + '» ទេ។' + (note ? ' មូលហេតុ៖ ' + note : '')).catch(() => {});
    audit(by, ok ? 'name_approve' : 'name_reject', q.user_email, 'N' + id + ' ' + q.name);
    return { ok: true, text: ok ? '✅ ឈ្មោះត្រូវបានប្ដូរ' : '❌ បានប្រាប់អ្នកស្នើ' };
  }

  // ---------- ✔ CamFeed invites a person: they press "Accept" and get the ✔ at once (no conditions, no proof) ----------
  app.post('/api/verify/invite-reply', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      await ensure();
      const yes = !!(req.body && req.body.accept === true);
      const q = (await pool.query("UPDATE verify_invites SET status = $2, answered_at = NOW() WHERE id = (SELECT id FROM verify_invites WHERE LOWER(user_email) = LOWER($1) AND status = 'pending' ORDER BY id DESC LIMIT 1) RETURNING *", [me, yes ? 'accepted' : 'declined'])).rows[0];
      if (!q) return res.status(404).json({ success: false, error: 'No invitation.' });
      if (yes) await pool.query("UPDATE users SET verified = TRUE, verified_paused = FALSE, verified_at = NOW(), verified_path = 'invited', verified_name = TRIM(CONCAT(first_name, ' ', last_name)) WHERE email = $1", [me]);
      audit(me, yes ? 'verify_invite_yes' : 'verify_invite_no', me, 'I' + q.id);
      res.json({ success: true, verified: yes });
    } catch (e) { console.error('[verify] invite reply:', e.message); res.status(500).json({ success: false }); }
  });

  // ---------- 🪪 ID + selfie (camera only) · 💳 monthly fee · 🏦 bank name check ----------
  app.post('/api/verify/proof', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      await ensure();
      const b = req.body || {}, kind = ['id', 'pay', 'bank'].includes(b.kind) ? b.kind : '';
      if (!kind) return res.status(400).json({ success: false });
      const on = { id: conds.tick.idproof.on || conds.name.idproof.on, pay: conds.tick.idproof.on || conds.name.idproof.on, bank: conds.tick.bank.on || conds.name.bank.on };
      if (!on[kind]) return res.status(400).json({ success: false, error: 'This is not open now.' });
      const open = (await pool.query("SELECT id FROM verify_proofs WHERE LOWER(user_email) = LOWER($1) AND kind = $2 AND status = 'pending'", [me, kind])).rows[0];
      if (open) return res.status(409).json({ success: false, code: 'open', error: 'Already being checked.' });
      const sf = (u) => (safeUrl ? safeUrl(String(u || '')) : null) || '';
      const ref = clean(b.ref, 80);
      const u = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [me])).rows[0] || {};
      const name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim();
      let id;
      if (kind === 'id') {
        const a = sf(b.id_url), s2 = sf(b.selfie_url);
        if (!a || !s2) return res.status(400).json({ success: false, code: 'photos', error: 'Please take both photos with the camera.' });
        id = (await pool.query("INSERT INTO verify_proofs (user_email, kind, id_url, selfie_url) VALUES ($1, 'id', $2, $3) RETURNING id", [me, a, s2])).rows[0].id;
        // the ID photos never go to Telegram: only a note to look in Admin
        if (tgAsk) tgAsk('vp', id, ['🪪 បញ្ជាក់អត្តសញ្ញាណ P' + id, '👤 ' + name, '🔒 មើលរូប ID និង Selfie ក្នុង Admin › ✔ (Super Admin)', 'ឈ្មោះលើ ID ដូច CamFeed និងមុខដូច Selfie ទើបចុច ✅'], ['✅ អនុម័ត', '❌ បដិសេធ']).catch(() => {});
      } else {
        const rc = sf(b.receipt);
        if (!rc && !ref) return res.status(400).json({ success: false, code: 'receipt', error: 'Please add the photo of the receipt.' });
        const cents = kind === 'pay' ? proofCfg.monthCents : proofCfg.bankCents;
        id = (await pool.query('INSERT INTO verify_proofs (user_email, kind, receipt_url, ref, amount_cents) VALUES ($1, $2, $3, $4, $5) RETURNING id', [me, kind, rc || null, ref || null, cents])).rows[0].id;
        if (tgAsk) tgAsk('vp', id, [(kind === 'pay' ? '💳 ថ្លៃប្រចាំខែ P' : '🏦 បញ្ជាក់ឈ្មោះធនាគារ P') + id + ' · $' + (cents / 100).toFixed(2), '👤 ឈ្មោះក្នុង CamFeed៖ ' + name, ref ? '🧾 ' + ref : '',
          '⚠️ ប្រៀបឈ្មោះលើវិក្កយបត្រ ជាមួយឈ្មោះខាងលើ — ដូចគ្នា ទើបចុច ✅'].filter(Boolean), ['✅ ឈ្មោះដូច / បានទទួល', '❌ មិនត្រូវ'], rc || undefined).catch(() => {});
      }
      res.status(201).json({ success: true, id });
    } catch (e) { console.error('[verify] proof:', e.message); res.status(500).json({ success: false, error: 'Could not send.' }); }
  });
  async function decideProof(id, ok, by, note) {
    await ensure();
    const q = (await pool.query(`UPDATE verify_proofs SET status = $2, note = $3, decided_by = $4, decided_at = NOW(), expires_at = CASE WHEN kind = 'pay' AND $2 = 'approved' THEN NOW() + INTERVAL '30 days' ELSE NULL END
      WHERE id = $1 AND status = 'pending' RETURNING *`, [id, ok ? 'approved' : 'rejected', clean(note, 300), by])).rows[0];
    if (!q) return { ok: false, text: 'Already answered.' };
    if (q.kind === 'id') {                                   // 🔒 the ID and the selfie are deleted once checked (only the answer is kept)
      for (const u of [q.id_url, q.selfie_url]) if (u && deleteMedia) await Promise.resolve(deleteMedia(u)).catch(() => {});
      await pool.query('UPDATE verify_proofs SET id_url = NULL, selfie_url = NULL WHERE id = $1', [id]);
    }
    const what = q.kind === 'id' ? 'អត្តសញ្ញាណ' : q.kind === 'pay' ? 'ថ្លៃប្រចាំខែ' : 'ឈ្មោះគណនីធនាគារ';
    sendNotice('CamFeed', q.user_email, ok ? '✅ CamFeed បានបញ្ជាក់' + what + 'របស់អ្នកហើយ។' + (q.kind === 'pay' ? ' (មានសុពលភាព 30 ថ្ងៃ)' : '') : '❌ CamFeed មិនអាចបញ្ជាក់' + what + 'របស់អ្នកបានទេ។' + (note ? ' មូលហេតុ៖ ' + note : '') + ' សូមសាកម្ដងទៀត។').catch(() => {});
    audit(by, 'proof_' + (ok ? 'ok' : 'no'), q.user_email, 'P' + id + ' ' + q.kind);
    return { ok: true, text: ok ? '✅ បានបញ្ជាក់' : '❌ បានប្រាប់អ្នកស្នើ' };
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
        const proofs = (await pool.query(`SELECT p.id, p.user_email, p.kind, p.status, p.receipt_url, p.ref, p.amount_cents, p.created_at, ${a.isSuperAdmin ? 'p.id_url, p.selfie_url,' : ''} u.first_name, u.last_name
          FROM verify_proofs p JOIN users u ON u.email = p.user_email WHERE p.status = 'pending' ORDER BY p.id LIMIT 100`)).rows;
        const names = (await pool.query(`SELECT n.id, n.user_email, n.name, n.created_at, u.first_name, u.last_name FROM name_requests n JOIN users u ON u.email = n.user_email WHERE n.status = 'pending' ORDER BY n.id LIMIT 100`)).rows;
        return res.json({ success: true, requests: r.rows, paused, verified: have, cfg, conds, proofCfg, proofs, names, isSuperAdmin: !!a.isSuperAdmin });
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
      if (act === 'invite') {                                 // ✔ Admin › Users › Manage › "Invite to Blue Verify"
        const email = String(b.targetEmail || '');
        const u = (await pool.query('SELECT email, verified, verified_paused FROM users WHERE email = $1', [email])).rows[0];
        if (!u) return res.status(404).json({ success: false, error: 'Not found.' });
        if (u.verified && !u.verified_paused) return res.status(409).json({ success: false, error: 'This account already has the ✔.' });
        const open = (await pool.query("SELECT id FROM verify_invites WHERE user_email = $1 AND status = 'pending'", [email])).rows[0];
        if (open) return res.json({ success: true, already: true });
        const id = (await pool.query('INSERT INTO verify_invites (user_email, invited_by) VALUES ($1, $2) RETURNING id', [email, a.adminEmail])).rows[0].id;
        sendNotice('CamFeed', email, '✔ CamFeed អញ្ជើញគណនីរបស់អ្នកឲ្យមានសញ្ញា ✔ គណនីផ្លូវការ។ សូមចូល ការកំណត់ › ✔ គណនីផ្លូវការ ហើយចុច «ទទួល»។').catch(() => {});
        audit(a.adminEmail, 'verify_invite', email, 'I' + id);
        return res.json({ success: true, id });
      }
      if (act === 'nameorder') {                              // 🇰🇭 old names: put the surname first (preview / swap / undo)
        const cut = ((await pool.query("SELECT v FROM verify_cfg WHERE k = 'name_cutoff'")).rows[0] || {}).v || new Date().toISOString();
        const WHERE = `name_ok = FALSE AND COALESCE(TRIM(first_name), '') <> '' AND COALESCE(TRIM(last_name), '') <> '' AND created_at < $1::timestamptz AND (name_changed_at IS NULL OR name_changed_at < $1::timestamptz)`;
        const step = String(b.step || 'preview');
        if (step === 'swap') {
          // only the names the Admin left ticked (a name already put right by hand is unticked)
          const pick = Array.isArray(b.emails) ? b.emails.map(String).slice(0, 5000) : [];
          if (!pick.length) return res.status(400).json({ success: false, error: 'Nothing ticked.' });
          const r = await pool.query(`UPDATE users SET first_name = last_name, last_name = first_name, name_swapped = TRUE,
            verified_name = CASE WHEN verified THEN TRIM(CONCAT(last_name, ' ', first_name)) ELSE verified_name END WHERE name_swapped = FALSE AND ${WHERE} AND email = ANY($2::text[])`, [cut, pick]);
          audit(a.adminEmail, 'name_order_swap', '', String(r.rowCount));
          return res.json({ success: true, done: r.rowCount });
        }
        if (step === 'undo') {
          const r = await pool.query(`UPDATE users SET first_name = last_name, last_name = first_name, name_swapped = FALSE,
            verified_name = CASE WHEN verified THEN TRIM(CONCAT(last_name, ' ', first_name)) ELSE verified_name END WHERE name_swapped = TRUE`);
          audit(a.adminEmail, 'name_order_undo', '', String(r.rowCount));
          return res.json({ success: true, done: r.rowCount });
        }
        const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE name_swapped = FALSE AND ${WHERE}`, [cut])).rows[0].n;
        const sw = (await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE name_swapped = TRUE')).rows[0].n;
        const sample = (await pool.query(`SELECT email, first_name, last_name FROM users WHERE name_swapped = FALSE AND ${WHERE} ORDER BY created_at DESC LIMIT 2000`, [cut])).rows;
        return res.json({ success: true, waiting: n, swapped: sw, sample });
      }
      if (act === 'conds') {                                  // ☑️ which conditions count (✔ and one-word name), and their numbers
        if (b.conds) conds = cleanConds(b.conds);
        if (b.proof) proofCfg = cleanProof(b.proof);
        cfg.minDays = conds.tick.days.n; cfg.minFollowers = conds.tick.followers.n; cfg.minPosts30 = conds.tick.posts.n;
        await pool.query("INSERT INTO verify_cfg (k, v) VALUES ('conds', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(conds)]);
        await pool.query("INSERT INTO verify_cfg (k, v) VALUES ('proof', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(proofCfg)]);
        audit(a.adminEmail, 'verify_conds', '', JSON.stringify(conds));
        return res.json({ success: true, conds, proofCfg });
      }
      if (act === 'proof') { const r = await decideProof(parseInt(b.id, 10), b.ok === true, a.adminEmail, b.note); return res.status(r.ok ? 200 : 409).json({ success: r.ok, error: r.ok ? undefined : r.text }); }
      if (act === 'name') { const r = await decideName(parseInt(b.id, 10), b.ok === true, a.adminEmail, b.note); return res.status(r.ok ? 200 : 409).json({ success: r.ok, error: r.ok ? undefined : r.text }); }
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
  return { ensure, checkName, afterRename, tickSql, CATEGORIES, nameRequest, decideName, decideProof };
};
