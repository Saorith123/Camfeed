// 🛡 CamFeed Admin (the separate phone app for the team): a short home page, the reports waiting, and phone alerts
//   POST /api/admin/app/home      numbers for the first screen + what is waiting
//   POST /api/admin/app/reports   reported posts / people that wait for a decision
//   POST /api/admin/app/push      the Admin app tells us its Firebase token (alerts go ONLY to Admin phones)
// Every route needs the Admin login + PIN (adminGate), like the Admin page.
'use strict';

const { PENDING_SQL: EARN_MONTHS_SQL } = require('./earn-months');

module.exports = function adminApp({ app, pool, adminGate, push, isAdminEmail }) {
  const KH = "'Asia/Phnom_Penh'";
  const TODAY = `created_at >= (NOW() AT TIME ZONE ${KH})::date::timestamp AT TIME ZONE ${KH}`;
  const num = async (sql, p) => { try { const r = await pool.query(sql, p || []); const v = r.rows[0] && Object.values(r.rows[0])[0]; return Number(v) || 0; } catch (e) { return null; } };

  // 🐞 the phone app tells us why it closed last time (Android: the error text, or "closed inside a Party Room" when Android
  // gave no reason). Only the person's own crash, a few a day; the Admin sees them in ⚙️ System check.
  let crashReady = null;
  const crashTable = () => crashReady || (crashReady = pool.query(`CREATE TABLE IF NOT EXISTS app_crashes (
      id SERIAL PRIMARY KEY, email TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), build INT, device TEXT, place TEXT, text TEXT)`)
    .then(() => pool.query('CREATE INDEX IF NOT EXISTS app_crashes_at ON app_crashes (created_at DESC)')).catch((e) => { crashReady = null; throw e; }));
  app.post('/api/app/crash', async (req, res) => {
    const email = String(req.authEmail || '').toLowerCase();
    if (!email) return res.status(401).json({ success: false });
    const b = req.body || {};
    const cut = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, n);
    try {
      await crashTable();
      const n = await num("SELECT COUNT(*) FROM app_crashes WHERE email = $1 AND created_at > NOW() - INTERVAL '1 day'", [email]);
      if (n !== null && n >= 10) return res.json({ success: true, kept: false });
      await pool.query('INSERT INTO app_crashes (email, build, device, place, text) VALUES ($1, $2, $3, $4, $5)',
        [email, parseInt(b.build, 10) || 0, cut(b.device, 200), cut(b.place, 40), cut(b.log, 6000)]);
      pool.query("DELETE FROM app_crashes WHERE created_at < NOW() - INTERVAL '60 days'").catch(() => {});
      res.json({ success: true, kept: true });
    } catch (e) { res.status(500).json({ success: false }); }
  });
  app.post('/api/admin/app/crashes', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      await crashTable();
      const r = await pool.query(`SELECT c.id, c.created_at, c.build, c.device, c.place, c.text, u.first_name, u.last_name, u.public_id
        FROM app_crashes c LEFT JOIN users u ON LOWER(u.email) = c.email ORDER BY c.created_at DESC LIMIT 100`);
      res.json({ success: true, crashes: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  app.post('/api/admin/app/home', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      const [users, usersToday, activeNow, active24, posts24, wdN, wdUsd, reports, chatReports, verify, ads, topups, creators, names, viewSpend, soldTopup, soldPlay, earnMonths, videoRating] = await Promise.all([
        num('SELECT COUNT(*) FROM users'),
        num(`SELECT COUNT(*) FROM users WHERE ${TODAY}`),
        num("SELECT COUNT(*) FROM users WHERE last_active >= NOW() - INTERVAL '5 minutes'"),
        num("SELECT COUNT(*) FROM users WHERE last_active >= NOW() - INTERVAL '24 hours'"),
        num("SELECT COUNT(*) FROM posts WHERE created_at >= NOW() - INTERVAL '24 hours'"),
        num("SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending'"),
        num("SELECT COALESCE(SUM(amount_cents), 0) / 100.0 FROM withdrawal_requests WHERE status = 'pending'"),
        num("SELECT COUNT(*) FROM reports WHERE status = 'pending'"),
        num("SELECT COUNT(*) FROM chat_reports WHERE status = 'pending'"),
        num("SELECT COUNT(*) FROM verify_requests WHERE status = 'pending'"),
        num("SELECT COUNT(*) FROM ad_requests WHERE status = 'pending'"),
        num("SELECT COUNT(*) FROM coin_topups WHERE status = 'pending'"),
        num("SELECT COUNT(*) FROM creator_applications WHERE status = 'pending'"),
        num("SELECT COUNT(*) FROM name_requests WHERE status = 'pending'"),
        num(`SELECT COALESCE(SUM(amount_cents), 0) / 100.0 FROM wallet_ledger WHERE kind = 'revenue_share' AND ${TODAY}`),
        num(`SELECT COALESCE(SUM(usd), 0) FROM coin_topups WHERE status = 'approved' AND ${TODAY.replace('created_at', 'decided_at')}`),
        num(`SELECT COUNT(*) FROM play_purchases WHERE test = FALSE AND ${TODAY}`),
        num(EARN_MONTHS_SQL),
        num('SELECT COUNT(*) FROM post_rating WHERE pct IS NULL'),
      ]);
      let signups = [];
      try {
        signups = (await pool.query(`SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COUNT(u.email)::int AS n
          FROM generate_series((NOW() AT TIME ZONE ${KH})::date - 6, (NOW() AT TIME ZONE ${KH})::date, INTERVAL '1 day') AS g(d)
          LEFT JOIN users u ON (u.created_at AT TIME ZONE ${KH})::date = g.d::date GROUP BY g.d ORDER BY g.d`)).rows;
      } catch (e) { signups = []; }
      res.json({
        success: true, isSuperAdmin: a.isSuperAdmin, push: !!(push && push.enabled),
        people: { users, usersToday, activeNow, active24, posts24 },
        waiting: { withdrawals: wdN, withdrawalsUsd: wdUsd, reports, chatReports, verify, ads, topups, creators, names, earnMonths, videoRating },
        money: { viewSpendToday: viewSpend, topupsToday: soldTopup, playBuysToday: soldPlay },
        signups,
      });
    } catch (err) { console.error('[admin-app] home error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  app.post('/api/admin/app/reports', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      const r = await pool.query(`
        SELECT r.id, r.target_type, r.target_post_id, r.reason, r.created_at, r.target_user_email,
               ru.first_name AS reporter_first, ru.last_name AS reporter_last,
               tu.first_name AS target_first, tu.last_name AS target_last, tu.profile_pic AS target_pic, tu.public_id AS target_id,
               p.content AS post_content, p.media_type AS post_media_type, p.thumb_url AS post_thumb, p.user_email AS post_owner,
               (SELECT COUNT(*) FROM reports r2 WHERE r2.status = 'pending' AND ((r.target_post_id IS NOT NULL AND r2.target_post_id = r.target_post_id) OR (r.target_post_id IS NULL AND r2.target_user_email = r.target_user_email)))::int AS same
          FROM reports r
          LEFT JOIN users ru ON ru.email = r.reporter_email
          LEFT JOIN users tu ON tu.email = COALESCE(r.target_user_email, (SELECT user_email FROM posts WHERE id = r.target_post_id))
          LEFT JOIN posts p ON p.id = r.target_post_id
         WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 60`);
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, reports: r.rows.map((x) => ({
        id: x.id, type: x.target_type, postId: x.target_post_id, reason: x.reason, at: x.created_at, same: x.same,
        reporter: [x.reporter_first, x.reporter_last].filter(Boolean).join(' '),
        target: { email: x.target_user_email || x.post_owner || '', name: [x.target_first, x.target_last].filter(Boolean).join(' '), pic: x.target_pic || '', id: x.target_id || '' },
        post: x.target_post_id ? { text: String(x.post_content || '').slice(0, 300), media: x.post_media_type || '', thumb: x.post_thumb || '', gone: x.post_media_type === null && x.post_content === null } : null,
      })) });
    } catch (err) { console.error('[admin-app] reports error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  // ---- 🔔 alerts to Admin phones only ----
  let tableReady = null;
  const ensure = () => tableReady || (tableReady = pool.query(`CREATE TABLE IF NOT EXISTS admin_push_tokens (token TEXT PRIMARY KEY, admin_email TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch((e) => { tableReady = null; throw e; }));

  app.post('/api/admin/app/push', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      const token = String((req.body || {}).token || '');
      if (token.length < 20 || token.length > 4096) return res.status(400).json({ success: false, error: 'Bad token.' });
      await ensure();
      if ((req.body || {}).off === true) await pool.query('DELETE FROM admin_push_tokens WHERE token = $1', [token]);
      else await pool.query(`INSERT INTO admin_push_tokens (token, admin_email, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (token) DO UPDATE SET admin_email = EXCLUDED.admin_email, updated_at = NOW()`, [token, a.adminEmail]);
      res.json({ success: true, push: !!(push && push.enabled) });
    } catch (err) { console.error('[admin-app] push register error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
  });

  // opt.urgent = the ringing alert (money waiting); opt.superOnly = only Super Admins (only they can pay)
  async function sendToAdmins(title, body, data, opt) {
    if (!push || !push.enabled || !push.sendToToken) return 0;
    const o = opt || {};
    await ensure();
    const rows = (await pool.query('SELECT token, admin_email FROM admin_push_tokens')).rows;
    let ok = 0;
    for (const r of rows) {
      if (!(await isAdminEmail(r.admin_email))) { await pool.query('DELETE FROM admin_push_tokens WHERE token = $1', [r.token]).catch(() => {}); continue; }   // no longer an Admin: no more alerts
      if (o.superOnly) {
        const role = (await pool.query('SELECT role FROM users WHERE LOWER(email) = LOWER($1)', [r.admin_email]).catch(() => ({ rows: [] }))).rows[0];
        if (!role || role.role !== 'super_admin') continue;
      }
      if (await push.sendToToken(r.token, { title, body, data, channel: o.urgent ? 'cf_admin_urgent' : 'cf_admin', sound: o.urgent ? 'cf_alarm' : 'default' })) ok++;
    }
    return ok;
  }

  const money = (n) => '$' + (Number(n) || 0).toFixed(2);
  const POCKET_KM = { gift: '🎁 ប្រាក់ពីកាដូ', content: '🎬 ប្រាក់ពីការផលិតមាតិកា' };
  const METHOD_KM = { TopUp: '📱 កាតទូរស័ព្ទ', WingCash: 'Wing Cash', ABA: 'ABA', ACLEDA: 'ACLEDA', Wing: 'Wing', KHQR: 'KHQR', Other: 'ផ្សេងៗ' };
  // 💵 a new withdrawal: ring the Super Admins' phones at once (tap = open it)
  async function newWithdrawal(id) {
    try {
      const w = (await pool.query(`SELECT w.id, w.amount_cents, w.method, w.pocket, w.hold_until, u.first_name, u.last_name FROM withdrawal_requests w
          LEFT JOIN users u ON LOWER(u.email) = LOWER(w.user_email) WHERE w.id = $1`, [id])).rows[0];
      if (!w) return;
      const name = `${w.first_name || ''} ${w.last_name || ''}`.trim() || 'អ្នកប្រើ';
      const wait = w.hold_until && new Date(w.hold_until) > new Date() ? ' · ⏳ ព័ត៌មានទទួលប្រាក់ថ្មី' : '';
      await sendToAdmins('💵 ដកប្រាក់ ' + money(w.amount_cents / 100) + ' · ' + (METHOD_KM[w.method] || w.method),
        name + ' · ' + (POCKET_KM[w.pocket] || '') + wait, { open: 'withdrawal', id: String(w.id) }, { urgent: true, superOnly: true });
    } catch (e) { console.error('[admin-app] new withdrawal alert:', e.message); }
  }

  // 🔎 one withdrawal with where its money came from (gifts: who gave them, and how they got those diamonds)
  app.post('/api/admin/app/withdrawal', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      const id = parseInt((req.body || {}).id, 10) || 0;
      const w = (await pool.query(`SELECT w.*, u.first_name, u.last_name, u.profile_pic, u.public_id, u.created_at AS joined, u.phone
          FROM withdrawal_requests w LEFT JOIN users u ON LOWER(u.email) = LOWER(w.user_email) WHERE w.id = $1`, [id])).rows[0];
      if (!w) return res.status(404).json({ success: false, error: 'Not found.' });
      const who = String(w.user_email).toLowerCase(), pocket = w.pocket || 'gift';
      const q = async (sql, p) => { try { return (await pool.query(sql, p)).rows; } catch (e) { console.error('[admin-app] withdrawal detail:', e.message); return []; } };
      // what came into this pocket in the last 60 days, by kind
      const POCKET_OF = "(CASE WHEN pocket IS NOT NULL THEN pocket WHEN kind IN ('gift', 'referral') THEN 'gift' ELSE 'content' END)";
      const sources = await q(`SELECT kind, COUNT(*)::int AS n, SUM(amount_cents)::bigint AS cents FROM wallet_ledger
          WHERE LOWER(user_email) = $1 AND amount_cents > 0 AND ${POCKET_OF} = $2 AND created_at > NOW() - INTERVAL '60 days' GROUP BY kind ORDER BY 3 DESC`, [who, pocket]);
      const lines = await q(`SELECT kind, amount_cents, note, created_at FROM wallet_ledger WHERE LOWER(user_email) = $1 AND ${POCKET_OF} = $2 ORDER BY created_at DESC LIMIT 25`, [who, pocket]);
      // the people who sent gifts (60 days), and where THEIR diamonds came from (bought / given by CamFeed / check-in …)
      const senders = pocket === 'gift' ? await q(`SELECT g.from_email, COUNT(*)::int AS times, SUM(g.coins)::bigint AS coins, SUM(g.receiver_cents)::float AS cents, MAX(g.created_at) AS last,
            u.first_name, u.last_name, u.profile_pic, u.public_id, u.created_at AS joined
          FROM gift_events g LEFT JOIN users u ON LOWER(u.email) = LOWER(g.from_email)
          WHERE LOWER(g.to_email) = $1 AND g.created_at > NOW() - INTERVAL '60 days'
          GROUP BY g.from_email, u.first_name, u.last_name, u.profile_pic, u.public_id, u.created_at ORDER BY 4 DESC LIMIT 20`, [who]) : [];
      for (const s of senders) {
        s.diamondsFrom = await q(`SELECT kind, SUM(coins)::bigint AS coins FROM coin_ledger WHERE LOWER(user_email) = LOWER($1) AND coins > 0 GROUP BY kind ORDER BY 2 DESC`, [s.from_email]);
        s.name = `${s.first_name || ''} ${s.last_name || ''}`.trim();
        s.sameNetwork = false;
        delete s.from_email;
      }
      // earlier withdrawals of this person
      const past = await q(`SELECT id, amount_cents, method, status, created_at FROM withdrawal_requests WHERE LOWER(user_email) = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 5`, [who, id]);
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin,
        w: { id: w.id, email: w.user_email, amount: Number(w.amount_cents) / 100, method: w.method, account_name: w.account_name, account_number: w.account_number, status: w.status, pocket,
             created_at: w.created_at, hold_until: w.hold_until, name_check: w.name_check, new_details: w.new_details, note: w.note || w.admin_note || '' },
        person: { name: `${w.first_name || ''} ${w.last_name || ''}`.trim(), pic: w.profile_pic || '', public_id: w.public_id || '', joined: w.joined },
        sources: sources.map((x) => ({ kind: x.kind, n: x.n, amount: Number(x.cents) / 100 })),
        lines: lines.map((x) => ({ kind: x.kind, amount: Number(x.amount_cents) / 100, note: x.note || '', at: x.created_at })),
        senders: senders.map((s) => ({ name: s.name, pic: s.profile_pic || '', public_id: s.public_id || '', joined: s.joined, times: s.times, coins: Number(s.coins) || 0, amount: Math.round((Number(s.cents) || 0)) / 100, last: s.last,
          diamondsFrom: s.diamondsFrom.map((d) => ({ kind: d.kind, coins: Number(d.coins) || 0 })) })),
        past: past.map((x) => ({ id: x.id, amount: Number(x.amount_cents) / 100, method: x.method, status: x.status, at: x.created_at })) });
    } catch (err) { console.error('[admin-app] withdrawal detail error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  // every minute: anything new that waits for the team? one alert per kind
  const KINDS = [
    ['reports', "SELECT COUNT(*) FROM reports WHERE status = 'pending' AND created_at > $1::timestamptz AT TIME ZONE 'UTC'", '🚩 របាយការណ៍ថ្មី', 'reports'],
    ['chatReports', "SELECT COUNT(*) FROM chat_reports WHERE status = 'pending' AND created_at > $1", '💬 របាយការណ៍ឆាតថ្មី', 'web'],
    ['verify', "SELECT COUNT(*) FROM verify_requests WHERE status = 'pending' AND created_at > $1", '✔️ ស្នើសញ្ញាផ្ទៀងផ្ទាត់ថ្មី', 'web'],
    ['ads', "SELECT COUNT(*) FROM ad_requests WHERE status = 'pending' AND created_at > $1", '📢 ស្នើផ្សាយពាណិជ្ជកម្មថ្មី', 'web'],
    ['topups', "SELECT COUNT(*) FROM coin_topups WHERE status = 'pending' AND created_at > $1", '💎 ការទិញពេជ្ររង់ចាំពិនិត្យ', 'web', true],   // 🔔 rings: somebody paid and waits
    ['creators', "SELECT COUNT(*) FROM creator_applications WHERE status = 'pending' AND requested_at > $1", '🎬 ស្នើចូលកម្មវិធីអ្នកបង្កើតមាតិកា', 'web'],
  ];
  let since = null, busy = false;
  async function tick() {
    if (busy || !push || !push.enabled) return; busy = true;
    try {
      await ensure();
      const has = await num('SELECT COUNT(*) FROM admin_push_tokens'); if (!has) return;
      const now = new Date();
      if (!since) {
        const s = (await pool.query("SELECT value FROM creator_settings WHERE key = 'admin_alert_at'").catch(() => ({ rows: [] }))).rows[0];
        since = s ? new Date(Number(s.value) || now.getTime()) : now;
      }
      for (const [, sql, title, open, urgent] of KINDS) {
        const n = await num(sql, [since.toISOString()]);
        if (n > 0) await sendToAdmins(title, n === 1 ? 'មាន ១ ថ្មី កំពុងរង់ចាំ' : 'មាន ' + n + ' ថ្មី កំពុងរង់ចាំ', { open }, { urgent: !!urgent });
      }
      since = now;
      await pool.query("INSERT INTO creator_settings (key, value) VALUES ('admin_alert_at', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(now.getTime())]).catch(() => {});
    } catch (e) { console.error('[admin-app] alert tick:', e.message); } finally { busy = false; }
  }
  const t = setInterval(tick, 20 * 1000); if (t.unref) t.unref();   // every 20 s (withdrawals ring at once, see newWithdrawal)
  return { sendToAdmins, newWithdrawal };
};
