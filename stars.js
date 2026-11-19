// ⭐ CamFeed Stars (hosts of Party Rooms)
//  • a person applies (18+, ID card photo + selfie) → CamFeed checks → 1-month trial → star (Admin can pause / remove)
//  • the ID pictures are kept in the database only until CamFeed decides, then deleted (never in public storage)
//  • time is counted by the minute while a star sits on a seat in an open room with at least N listeners
//    (a day counts when it has ≥ the minimum session; at most N minutes a day count)
//  • stars get a bigger share of their gifts (coins.js asks starShare()), a ⭐ badge, their rooms first in the list
//  • at the start of a month the bonus of the month before is worked out (tiers: hours + gift coins received) and waits
//    for an Admin to pay it into the wallet (so tricks — gifts from own second accounts — can be checked first)
module.exports = function installStars({ app, pool, adminGate, audit, sendNotice }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const KH_DAY = "(NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date";
  const ACTIVE = ['trial', 'star'];

  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query('CREATE TABLE IF NOT EXISTS creator_settings (key VARCHAR(40) PRIMARY KEY, value TEXT)');
        await pool.query(`CREATE TABLE IF NOT EXISTS party_stars (user_email TEXT PRIMARY KEY, status VARCHAR(12) NOT NULL DEFAULT 'pending',
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, decided_by TEXT, note TEXT, warnings INTEGER NOT NULL DEFAULT 0,
          trial_until TIMESTAMPTZ, real_name TEXT)`);
        await pool.query('CREATE TABLE IF NOT EXISTS star_docs (user_email TEXT PRIMARY KEY, id_photo BYTEA, selfie BYTEA, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
        await pool.query('CREATE TABLE IF NOT EXISTS star_minutes (user_email TEXT NOT NULL, day DATE NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_email, day))');
        await pool.query(`CREATE TABLE IF NOT EXISTS star_bonus (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, month VARCHAR(7) NOT NULL, hours NUMERIC(8,1) NOT NULL, days INTEGER NOT NULL,
          coins INTEGER NOT NULL, tier INTEGER NOT NULL, half BOOLEAN NOT NULL DEFAULT FALSE, amount_cents INTEGER NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'pending',
          decided_by TEXT, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_email, month))`);
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  setTimeout(() => ensure().catch((e) => console.error('[stars] schema:', e.message)), 6000);

  // ---- settings (Admin › ⭐ Stars) ----
  const DEFAULT_TIERS = [{ hours: 20, coins: 5000, cents: 500 }, { hours: 30, coins: 20000, cents: 1500 }, { hours: 40, coins: 50000, cents: 4000 }];
  async function settings() {
    const m = {};
    try { (await pool.query("SELECT key, value FROM creator_settings WHERE key LIKE 'star:%'")).rows.forEach((r) => { m[r.key.slice(5)] = r.value; }); } catch (e) { /* not yet */ }
    const num = (v, d, lo, hi) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
    let tiers = DEFAULT_TIERS;
    try { const t = JSON.parse(m.tiers || 'null'); if (Array.isArray(t) && t.length) tiers = t; } catch (e) { /* default */ }
    return {
      on: m.on !== '0', share: num(m.share, 60, 0, 100), minDays: num(m.days, 12, 0, 31), minSession: num(m.session, 30, 1, 600),
      maxDay: num(m.maxday, 180, 10, 1440), minListeners: num(m.listeners, 3, 0, 100), half: num(m.half, 50, 0, 100), trialDays: num(m.trial, 30, 0, 365), tiers,
    };
  }
  const setSetting = (k, v) => pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['star:' + k, String(v)]);
  const me = (req, res) => { const e = norm(req.authEmail); if (!e) res.status(401).json({ success: false, error: 'Please log in.' }); return e; };

  /// coins.js: the share of a gift's value for this receiver (null = the normal share)
  async function starShare(email) {
    try {
      await ensure();
      const r = (await pool.query('SELECT status FROM party_stars WHERE user_email = $1', [norm(email)])).rows[0];
      if (!r || !ACTIVE.includes(r.status)) return null;
      const s = await settings();
      return s.on ? s.share : null;
    } catch (e) { return null; }
  }
  /// party.js / coins.js: which of these people are stars now
  async function starsOf(emails) {
    try {
      await ensure();
      const r = await pool.query('SELECT user_email FROM party_stars WHERE user_email = ANY($1) AND status = ANY($2)', [emails.map(norm), ACTIVE]);
      return new Set(r.rows.map((x) => x.user_email));
    } catch (e) { return new Set(); }
  }

  // ---- counting the minutes (once a minute) ----
  async function tick() {
    try {
      await ensure();
      const s = await settings(); if (!s.on) return;
      await pool.query(`
        INSERT INTO star_minutes (user_email, day, minutes)
        SELECT m.user_email, ${KH_DAY}, 1 FROM party_members m JOIN party_rooms r ON r.id = m.room_id AND r.status = 'open'
        JOIN party_stars st ON st.user_email = m.user_email AND st.status = ANY($1)
        WHERE m.seat IS NOT NULL AND m.last_seen >= NOW() - INTERVAL '40 seconds'
          AND (SELECT COUNT(*) FROM party_members x WHERE x.room_id = m.room_id AND x.user_email <> m.user_email AND x.last_seen >= NOW() - INTERVAL '40 seconds') >= $2
        ON CONFLICT (user_email, day) DO UPDATE SET minutes = LEAST(star_minutes.minutes + 1, $3)`, [ACTIVE, s.minListeners, s.maxDay]);
      // a trial that went well becomes a star by itself; old minute rows are removed
      await pool.query("UPDATE party_stars SET status = 'star' WHERE status = 'trial' AND trial_until IS NOT NULL AND trial_until < NOW()");
      await pool.query("DELETE FROM star_minutes WHERE day < (NOW() - INTERVAL '120 days')::date");
    } catch (e) { console.error('[stars] tick:', e.message); }
  }
  setTimeout(() => { tick(); setInterval(tick, 60 * 1000); }, 70 * 1000);

  // a month's numbers for one star: hours (only days with the minimum session), active days, gift coins received
  async function monthOf(email, monthStart, s) {
    const mins = (await pool.query(`SELECT minutes FROM star_minutes WHERE user_email = $1 AND day >= $2::date AND day < ($2::date + INTERVAL '1 month')::date`, [email, monthStart])).rows;
    const good = mins.filter((x) => x.minutes >= s.minSession);
    const hours = Math.round(good.reduce((a, x) => a + x.minutes, 0) / 6) / 10;
    const coins = Number((await pool.query(`SELECT COALESCE(SUM(coins), 0)::int AS n FROM gift_events WHERE to_email = $1
      AND created_at >= ($2::date AT TIME ZONE 'Asia/Phnom_Penh') AND created_at < (($2::date + INTERVAL '1 month') AT TIME ZONE 'Asia/Phnom_Penh')`, [email, monthStart]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
    return { hours, days: good.length, coins };
  }
  function tierOf(x, s) {
    let full = 0, half = 0;
    s.tiers.forEach((t, i) => {
      if (x.coins >= t.coins && x.hours >= t.hours && x.days >= s.minDays) full = i + 1;
      else if (x.coins >= t.coins) half = i + 1;
    });
    if (full >= half && full > 0) return { tier: full, half: false, cents: s.tiers[full - 1].cents };
    if (half > 0 && s.half > 0) return { tier: half, half: true, cents: Math.round(s.tiers[half - 1].cents * s.half / 100) };
    return { tier: 0, half: false, cents: 0 };
  }

  // the bonus of last month (made once, in the first days of the month; an Admin pays it)
  async function makeBonuses() {
    try {
      await ensure();
      const s = await settings(); if (!s.on) return;
      const prev = (await pool.query(`SELECT to_char(date_trunc('month', NOW() AT TIME ZONE 'Asia/Phnom_Penh') - INTERVAL '1 month', 'YYYY-MM-DD') AS d,
                                       to_char(date_trunc('month', NOW() AT TIME ZONE 'Asia/Phnom_Penh') - INTERVAL '1 month', 'YYYY-MM') AS m`)).rows[0];
      const stars = (await pool.query(`SELECT user_email FROM party_stars WHERE status = ANY($1)
                                        AND NOT EXISTS (SELECT 1 FROM star_bonus b WHERE b.user_email = party_stars.user_email AND b.month = $2)`, [ACTIVE, prev.m])).rows;
      for (const st of stars) {
        const x = await monthOf(st.user_email, prev.d, s);
        const t = tierOf(x, s);
        await pool.query(`INSERT INTO star_bonus (user_email, month, hours, days, coins, tier, half, amount_cents, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                          ON CONFLICT (user_email, month) DO NOTHING`, [st.user_email, prev.m, x.hours, x.days, x.coins, t.tier, t.half, t.cents, t.cents > 0 ? 'pending' : 'none']);
      }
    } catch (e) { console.error('[stars] bonus:', e.message); }
  }
  setTimeout(() => { makeBonuses(); setInterval(makeBonuses, 3 * 3600 * 1000); }, 90 * 1000);

  // ---- what the person sees ----
  async function myInfo(e) {
    const s = await settings();
    const st = (await pool.query('SELECT status, note, warnings, trial_until, applied_at, decided_at FROM party_stars WHERE user_email = $1', [e])).rows[0] || null;
    const out = { success: true, on: s.on, settings: { share: s.share, minDays: s.minDays, minSession: s.minSession, maxDay: s.maxDay, minListeners: s.minListeners, half: s.half, trialDays: s.trialDays,
      tiers: s.tiers.map((t) => ({ hours: t.hours, coins: t.coins, usd: (t.cents / 100).toFixed(2) })) }, star: st };
    if (st && ACTIVE.includes(st.status)) {
      const cur = (await pool.query(`SELECT to_char(date_trunc('month', NOW() AT TIME ZONE 'Asia/Phnom_Penh'), 'YYYY-MM-DD') AS d`)).rows[0].d;
      const x = await monthOf(e, cur, s);
      const today = (await pool.query(`SELECT minutes FROM star_minutes WHERE user_email = $1 AND day = ${KH_DAY}`, [e])).rows[0];
      out.month = { ...x, todayMinutes: today ? today.minutes : 0, tier: tierOf(x, s) };
      out.bonuses = (await pool.query("SELECT month, hours, days, coins, tier, half, amount_cents, status FROM star_bonus WHERE user_email = $1 AND status <> 'none' ORDER BY month DESC LIMIT 6", [e])).rows;
    }
    return out;
  }
  // 📊 day by day: the minutes counted each day (from → to, Cambodia days), today's live state, the months' totals
  async function daysOf(email, from, to) {
    const s = await settings();
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    const today = (await pool.query(`SELECT to_char(${KH_DAY}, 'YYYY-MM-DD') AS d, to_char(date_trunc('month', NOW() AT TIME ZONE 'Asia/Phnom_Penh'), 'YYYY-MM-DD') AS m,
      to_char((date_trunc('month', NOW() AT TIME ZONE 'Asia/Phnom_Penh') - INTERVAL '1 month'), 'YYYY-MM-DD') AS pm,
      to_char(date_trunc('week', NOW() AT TIME ZONE 'Asia/Phnom_Penh'), 'YYYY-MM-DD') AS w`)).rows[0];
    const f = ok(from) ? from : today.pm, t = ok(to) ? to : today.d;
    const rows = (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, minutes FROM star_minutes WHERE user_email = $1 AND day >= $2::date AND day <= $3::date AND day >= ($3::date - INTERVAL '120 days') ORDER BY day`, [email, f, t])).rows;
    // is it counting right now? (sitting on a seat in an open room with enough other people)
    let live = { seated: false, others: 0 };
    try {
      const l = (await pool.query(`SELECT m.seat, (SELECT COUNT(*)::int FROM party_members x WHERE x.room_id = m.room_id AND x.user_email <> m.user_email AND x.last_seen >= NOW() - INTERVAL '40 seconds') AS others
        FROM party_members m JOIN party_rooms r ON r.id = m.room_id AND r.status = 'open' WHERE m.user_email = $1 AND m.last_seen >= NOW() - INTERVAL '40 seconds' LIMIT 1`, [email])).rows[0];
      if (l) live = { inRoom: true, seated: l.seat !== null, others: l.others };
    } catch (e) { /* not in a room */ }
    const todayMin = (rows.find((x) => x.day === today.d) || {}).minutes || 0;
    live.counting = !!(live.inRoom && live.seated && live.others >= s.minListeners && todayMin < s.maxDay && s.on);
    const cur = await monthOf(email, today.m, s), prev = await monthOf(email, today.pm, s);
    return { success: true, today: today.d, weekStart: today.w, monthStart: today.m, prevMonthStart: today.pm, days: rows, live,
      rules: { minSession: s.minSession, maxDay: s.maxDay, minListeners: s.minListeners, minDays: s.minDays },
      tiers: s.tiers.map((x) => ({ hours: x.hours, coins: x.coins, usd: (x.cents / 100).toFixed(2) })),
      month: { ...cur, tier: tierOf(cur, s) }, prevMonth: { ...prev, tier: tierOf(prev, s) } };
  }
  app.get('/api/stars/days', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try { await ensure(); res.json(await daysOf(e, req.query.from, req.query.to)); } catch (err) { console.error('[stars] days:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  app.get('/api/stars/me', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try { await ensure(); res.json(await myInfo(e)); } catch (err) { console.error('[stars] me:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  const pic = (v) => { const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(String(v || '')); if (!m) return null; const b = Buffer.from(m[2], 'base64'); return b.length > 1000 && b.length < 3 * 1024 * 1024 ? b : null; };
  app.post('/api/stars/apply', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const s = await settings();
      if (!s.on) return res.status(400).json({ success: false, error: 'Applications are closed now.' });
      const b = req.body || {};
      const idp = pic(b.id_photo), self = pic(b.selfie), name = String(b.real_name || '').trim().slice(0, 80);
      if (!idp || !self || !name) return res.status(400).json({ success: false, error: 'Add your real name, a photo of your ID card and a selfie.' });
      if (b.agree !== true) return res.status(400).json({ success: false, error: 'Please agree to the Star rules.' });
      const u = (await pool.query('SELECT birthdate FROM users WHERE LOWER(email) = $1', [e])).rows[0];
      if (u && u.birthdate) { const age = (Date.now() - new Date(u.birthdate).getTime()) / (365.25 * 86400000); if (age < 18) return res.status(403).json({ success: false, code: 'age', error: 'Stars must be 18 or older.' }); }
      const st = (await pool.query('SELECT status FROM party_stars WHERE user_email = $1', [e])).rows[0];
      if (st && ['pending', 'trial', 'star', 'paused'].includes(st.status)) return res.status(409).json({ success: false, error: 'You already applied.' });
      if (st && st.status === 'removed') return res.status(403).json({ success: false, error: 'You can not apply again. Please contact CamFeed.' });
      await pool.query(`INSERT INTO party_stars (user_email, status, applied_at, real_name, note) VALUES ($1, 'pending', NOW(), $2, NULL)
                        ON CONFLICT (user_email) DO UPDATE SET status = 'pending', applied_at = NOW(), real_name = $2, note = NULL, decided_at = NULL, decided_by = NULL`, [e, name]);
      await pool.query(`INSERT INTO star_docs (user_email, id_photo, selfie) VALUES ($1, $2, $3) ON CONFLICT (user_email) DO UPDATE SET id_photo = $2, selfie = $3, created_at = NOW()`, [e, idp, self]);
      // 🔔 tell the administrators (bell + the Inbox / ⭐ Stars red number)
      try {
        const admins = await pool.query("SELECT email FROM users WHERE role IN ('admin', 'super_admin') AND COALESCE(is_banned, FALSE) = FALSE LIMIT 50");
        const who = (await pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email) = $1', [e])).rows[0] || {};
        const nm = ((who.first_name || '') + ' ' + (who.last_name || '')).trim() || 'a member';
        for (const a of admins.rows) await pool.query("INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, NULL, 'admin_notice', $3, FALSE)", [a.email, e, '⭐ New Star application from ' + nm + (name ? ' (real name: ' + name + ')' : '') + '. Open Admin → ⭐ Stars to check it.']).catch(() => {});
      } catch (x) { /* best effort */ }
      res.json(await myInfo(e));
    } catch (err) { console.error('[stars] apply:', err.message); res.status(500).json({ success: false, error: 'Could not send.' }); }
  });

  // ---- Admin › ⭐ Stars ----
  app.post('/api/admin/stars', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const superOnly = () => { if (!a.isSuperAdmin) { res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' }); return false; } return true; };
      const act = String(b.action || '');
      const who = norm(b.user);
      if (act === 'doc') {                                       // the ID pictures of one application (only while waiting)
        const d = (await pool.query('SELECT id_photo, selfie FROM star_docs WHERE user_email = $1', [who])).rows[0];
        return res.json({ success: true, id_photo: d && d.id_photo ? 'data:image/jpeg;base64,' + d.id_photo.toString('base64') : '', selfie: d && d.selfie ? 'data:image/jpeg;base64,' + d.selfie.toString('base64') : '' });
      }
      if (act === 'days') return res.json(await daysOf(who, b.from, b.to));   // 📊 one star's minutes day by day
      if (act === 'settings') {
        if (!superOnly()) return;
        const n = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi; };
        if (b.on !== undefined) await setSetting('on', b.on ? '1' : '0');
        for (const [k, key, lo, hi] of [['share', 'share', 0, 100], ['minDays', 'days', 0, 31], ['minSession', 'session', 1, 600], ['maxDay', 'maxday', 10, 1440], ['minListeners', 'listeners', 0, 100], ['half', 'half', 0, 100], ['trialDays', 'trial', 0, 365]]) {
          if (b[k] !== undefined) { if (!n(b[k], lo, hi)) return res.status(400).json({ success: false, error: k + ' must be ' + lo + '–' + hi + '.' }); await setSetting(key, Number(b[k])); }
        }
        if (Array.isArray(b.tiers)) {
          const t = b.tiers.map((x) => ({ hours: Number(x.hours), coins: parseInt(x.coins, 10), cents: Math.round(Number(x.usd) * 100) }))
            .filter((x) => x.hours >= 0 && x.hours <= 744 && x.coins >= 0 && x.cents >= 0 && x.cents <= 10000000).slice(0, 8);
          if (!t.length) return res.status(400).json({ success: false, error: 'Add at least one tier.' });
          await setSetting('tiers', JSON.stringify(t));
        }
        audit(a.adminEmail, 'star-settings', 'settings', 'Star settings changed');
      } else if (act === 'decide') {                            // an application: approve (trial) / reject
        if (!superOnly()) return;
        const s = await settings();
        const ok = b.ok === true, note = String(b.note || '').trim().slice(0, 300);
        if (!ok && !note) return res.status(400).json({ success: false, error: 'Please write the reason.' });
        // the new status goes in twice as two values ($2 for the column, $6 for the check): one value used as VARCHAR and as text made Postgres refuse ("inconsistent types")
        const to = ok ? (s.trialDays > 0 ? 'trial' : 'star') : 'rejected';
        const r = await pool.query(`UPDATE party_stars SET status = $2, note = $3, decided_at = NOW(), decided_by = $4, trial_until = CASE WHEN $6::text = 'trial' THEN NOW() + ($5::text || ' days')::interval ELSE NULL END
                                    WHERE user_email = $1 AND status = 'pending' RETURNING user_email`, [who, to, note || null, a.adminEmail, String(s.trialDays), to]);
        if (!r.rows.length) return res.status(409).json({ success: false, error: 'Already decided.' });
        await pool.query('DELETE FROM star_docs WHERE user_email = $1', [who]);       // the ID pictures are not kept
        await sendNotice(a.adminEmail, who, ok ? '⭐ អបអរសាទរ! អ្នកបានក្លាយជាតារា CamFeed (សាកល្បង ' + s.trialDays + ' ថ្ងៃ)។ បើកបន្ទប់ Party Room ហើយអង្គុយលើកៅអីជាមួយអ្នកស្ដាប់ ដើម្បីរាប់ម៉ោង។'
          : 'សំណើចូលជាតារា CamFeed របស់អ្នកមិនត្រូវបានអនុម័តទេ។ មូលហេតុ៖ ' + note).catch(() => {});
        audit(a.adminEmail, 'star-' + (ok ? 'approve' : 'reject'), who, note);
      } else if (act === 'status') {                            // a star: star / paused / removed / warn
        if (!superOnly()) return;
        const to = String(b.status || '');
        if (to === 'warn') await pool.query('UPDATE party_stars SET warnings = warnings + 1, note = $2 WHERE user_email = $1', [who, String(b.note || '').slice(0, 300) || null]);
        else if (['star', 'paused', 'removed'].includes(to)) await pool.query('UPDATE party_stars SET status = $2, note = $3, decided_at = NOW(), decided_by = $4 WHERE user_email = $1', [who, to, String(b.note || '').slice(0, 300) || null, a.adminEmail]);
        else return res.status(400).json({ success: false });
        if (to === 'warn' || to === 'paused' || to === 'removed') {
          await sendNotice(a.adminEmail, who, (to === 'warn' ? '⚠️ ការព្រមានពី CamFeed (តារា)៖ ' : to === 'paused' ? '⏸️ សិទ្ធិតារា CamFeed របស់អ្នកត្រូវបានផ្អាក។ ' : 'សិទ្ធិតារា CamFeed របស់អ្នកត្រូវបានដកចេញ។ ') + String(b.note || '')).catch(() => {});
        }
        audit(a.adminEmail, 'star-' + to, who, String(b.note || ''));
      } else if (act === 'bonus') {                             // pay / cancel a month's bonus
        if (!superOnly()) return;
        const id = parseInt(b.id, 10) || 0, pay = b.pay === true;
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = (await c.query("UPDATE star_bonus SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *", [id, pay ? 'paid' : 'cancelled', a.adminEmail])).rows[0];
          if (!r) { await c.query('ROLLBACK'); c.release(); return res.status(409).json({ success: false, error: 'Already decided.' }); }
          if (pay && r.amount_cents > 0) await c.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, ref_id, created_by) VALUES ($1, $2, 'gift', $3, $4, $5)", [r.user_email, r.amount_cents, 'Star bonus ' + r.month, r.id, a.adminEmail]);
          await c.query('COMMIT');
          c.release();
          if (pay) await sendNotice(a.adminEmail, r.user_email, '⭐ ប្រាក់រង្វាន់តារា ខែ ' + r.month + ' $' + (r.amount_cents / 100).toFixed(2) + ' បានចូលកាបូបរបស់អ្នកហើយ។ អរគុណ!').catch(() => {});
          audit(a.adminEmail, 'star-bonus-' + (pay ? 'paid' : 'cancelled'), r.user_email, r.month + ' $' + (r.amount_cents / 100).toFixed(2));
        } catch (x) { try { await c.query('ROLLBACK'); } catch (y) { /* none */ } c.release(); throw x; }
      }
      const s = await settings();
      const cur = (await pool.query(`SELECT to_char(date_trunc('month', NOW() AT TIME ZONE 'Asia/Phnom_Penh'), 'YYYY-MM-DD') AS d`)).rows[0].d;
      const list = (await pool.query(`SELECT st.*, u.first_name, u.last_name, u.profile_pic FROM party_stars st LEFT JOIN users u ON LOWER(u.email) = st.user_email
                                      WHERE st.status <> 'rejected' OR st.decided_at > NOW() - INTERVAL '30 days' ORDER BY (st.status = 'pending') DESC, st.applied_at DESC LIMIT 300`)).rows;
      for (const x of list) { if (ACTIVE.includes(x.status)) x.month = await monthOf(x.user_email, cur, s); }
      const bonuses = (await pool.query(`SELECT b.*, u.first_name, u.last_name FROM star_bonus b LEFT JOIN users u ON LOWER(u.email) = b.user_email
                                         WHERE b.status = 'pending' OR b.decided_at > NOW() - INTERVAL '60 days' ORDER BY (b.status = 'pending') DESC, b.month DESC LIMIT 200`)).rows;
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, settings: s, list, bonuses });
    } catch (err) { console.error('[stars] admin:', err.message); if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  return { starShare, starsOf };
};
