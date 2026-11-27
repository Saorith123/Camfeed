// 🛡 CamFeed Admin (the separate phone app for the team): a short home page, the reports waiting, and phone alerts
//   POST /api/admin/app/home      numbers for the first screen + what is waiting
//   POST /api/admin/app/reports   reported posts / people that wait for a decision
//   POST /api/admin/app/push      the Admin app tells us its Firebase token (alerts go ONLY to Admin phones)
// Every route needs the Admin login + PIN (adminGate), like the Admin page.
'use strict';

module.exports = function adminApp({ app, pool, adminGate, push, isAdminEmail }) {
  const KH = "'Asia/Phnom_Penh'";
  const TODAY = `created_at >= (NOW() AT TIME ZONE ${KH})::date::timestamp AT TIME ZONE ${KH}`;
  const num = async (sql, p) => { try { const r = await pool.query(sql, p || []); const v = r.rows[0] && Object.values(r.rows[0])[0]; return Number(v) || 0; } catch (e) { return null; } };

  app.post('/api/admin/app/home', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      const [users, usersToday, activeNow, active24, posts24, wdN, wdUsd, reports, chatReports, verify, ads, topups, creators, names, viewSpend, soldTopup, soldPlay] = await Promise.all([
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
        waiting: { withdrawals: wdN, withdrawalsUsd: wdUsd, reports, chatReports, verify, ads, topups, creators, names },
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

  async function sendToAdmins(title, body, data) {
    if (!push || !push.enabled || !push.sendToToken) return 0;
    await ensure();
    const rows = (await pool.query('SELECT token, admin_email FROM admin_push_tokens')).rows;
    let ok = 0;
    for (const r of rows) {
      if (!(await isAdminEmail(r.admin_email))) { await pool.query('DELETE FROM admin_push_tokens WHERE token = $1', [r.token]).catch(() => {}); continue; }   // no longer an Admin: no more alerts
      if (await push.sendToToken(r.token, { title, body, data, channel: 'cf_admin' })) ok++;
    }
    return ok;
  }

  // every minute: anything new that waits for the team? one alert per kind
  const KINDS = [
    ['withdrawals', "SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending' AND created_at > $1", '💵 សំណើដកប្រាក់ថ្មី', 'withdrawals'],
    ['reports', "SELECT COUNT(*) FROM reports WHERE status = 'pending' AND created_at > $1::timestamptz AT TIME ZONE 'UTC'", '🚩 របាយការណ៍ថ្មី', 'reports'],
    ['chatReports', "SELECT COUNT(*) FROM chat_reports WHERE status = 'pending' AND created_at > $1", '💬 របាយការណ៍ឆាតថ្មី', 'web'],
    ['verify', "SELECT COUNT(*) FROM verify_requests WHERE status = 'pending' AND created_at > $1", '✔️ ស្នើសញ្ញាផ្ទៀងផ្ទាត់ថ្មី', 'web'],
    ['ads', "SELECT COUNT(*) FROM ad_requests WHERE status = 'pending' AND created_at > $1", '📢 ស្នើផ្សាយពាណិជ្ជកម្មថ្មី', 'web'],
    ['topups', "SELECT COUNT(*) FROM coin_topups WHERE status = 'pending' AND created_at > $1", '💎 ការទិញពេជ្ររង់ចាំពិនិត្យ', 'web'],
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
      for (const [, sql, title, open] of KINDS) {
        const n = await num(sql, [since.toISOString()]);
        if (n > 0) await sendToAdmins(title, n === 1 ? 'មាន ១ ថ្មី កំពុងរង់ចាំ' : 'មាន ' + n + ' ថ្មី កំពុងរង់ចាំ', { open });
      }
      since = now;
      await pool.query("INSERT INTO creator_settings (key, value) VALUES ('admin_alert_at', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(now.getTime())]).catch(() => {});
    } catch (e) { console.error('[admin-app] alert tick:', e.message); } finally { busy = false; }
  }
  const t = setInterval(tick, 60 * 1000); if (t.unref) t.unref();
  return { sendToAdmins };
};
