// 🎯 Challenges — CamFeed sets a goal for a time (gift coins received, time in rooms, XP, check-ins, video views…),
// people reach steps (tier 1, 2, 3 …) and/or the best places (Top N), and get a reward: coins, a frame, VIP days, XP,
// a note (e.g. "a chance to become a Star"), or money (money always waits for an Admin to approve it).
// Everything is set in Admin › 🎯 Challenges; the app only shows what the server sends (no app update to change a challenge).
// Joining is always FREE (paying to take part would be gambling).
const appCfg = require('./app-config');
module.exports = function installChallenges({ app, pool, adminGate, audit, sendNotice, xpNowOf, badgesOf }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const me = (req, res) => { const e = norm(req.authEmail); if (!e) res.status(401).json({ success: false, error: 'Please log in.' }); return e; };
  const METRICS = ['gift_recv', 'gift_sent', 'room_minutes', 'seat_minutes', 'xp', 'checkins', 'room_followers', 'video_views', 'posts', 'followers'];
  const REWARDS = ['coins', 'money', 'frame', 'vip', 'xp', 'note'];

  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS challenges (
          id SERIAL PRIMARY KEY, title_km TEXT NOT NULL, title_en TEXT NOT NULL DEFAULT '', body_km TEXT NOT NULL DEFAULT '', body_en TEXT NOT NULL DEFAULT '',
          icon VARCHAR(16) NOT NULL DEFAULT '🎯', area VARCHAR(10) NOT NULL DEFAULT 'party', metric VARCHAR(20) NOT NULL,
          starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL, join_mode VARCHAR(6) NOT NULL DEFAULT 'join', max_people INTEGER NOT NULL DEFAULT 0,
          min_level INTEGER NOT NULL DEFAULT 0, min_days INTEGER NOT NULL DEFAULT 0, tiers JSONB NOT NULL DEFAULT '[]', ranks JSONB NOT NULL DEFAULT '[]',
          status VARCHAR(8) NOT NULL DEFAULT 'live', sort INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS challenge_joins (challenge_id INTEGER NOT NULL, user_email TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          base BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (challenge_id, user_email))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS challenge_rewards (id SERIAL PRIMARY KEY, challenge_id INTEGER NOT NULL, user_email TEXT NOT NULL, kind VARCHAR(4) NOT NULL,
          level INTEGER NOT NULL, value BIGINT NOT NULL DEFAULT 0, reward JSONB NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_by TEXT, decided_at TIMESTAMPTZ, UNIQUE (challenge_id, user_email, kind, level))`);
        // ⏱️ minutes in Party Rooms for everybody (an hour per row): on a seat / listening, only while somebody else is in the room too
        await pool.query(`CREATE TABLE IF NOT EXISTS party_minutes (user_email TEXT NOT NULL, hour TIMESTAMPTZ NOT NULL, seat INTEGER NOT NULL DEFAULT 0, listen INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_email, hour))`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_party_minutes_hour ON party_minutes (hour)');
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  async function minuteTick() {
    try {
      await ensure();
      await pool.query(`
        INSERT INTO party_minutes (user_email, hour, seat, listen)
        SELECT m.user_email, date_trunc('hour', NOW()), CASE WHEN m.seat IS NOT NULL THEN 1 ELSE 0 END, CASE WHEN m.seat IS NULL THEN 1 ELSE 0 END
        FROM party_members m JOIN party_rooms r ON r.id = m.room_id AND r.status = 'open'
        WHERE m.last_seen >= NOW() - INTERVAL '40 seconds'
          AND (SELECT COUNT(*) FROM party_members x WHERE x.room_id = m.room_id AND x.user_email <> m.user_email AND x.last_seen >= NOW() - INTERVAL '40 seconds') >= $1
        ON CONFLICT (user_email, hour) DO UPDATE SET seat = party_minutes.seat + EXCLUDED.seat, listen = party_minutes.listen + EXCLUDED.listen`, [appCfg.cfg().party.challengeMinOthers]);
      await pool.query("DELETE FROM party_minutes WHERE hour < NOW() - INTERVAL '120 days'");
    } catch (e) { /* party tables not there yet */ }
  }
  setTimeout(() => { minuteTick(); setInterval(minuteTick, 60 * 1000); }, 75 * 1000);

  // ---- the numbers: one query per metric, per person, between two times ($1 from, $2 to, $3 = list of people or NULL = everybody) ----
  const WHO = (col) => `($3::text[] IS NULL OR ${col} = ANY($3::text[]))`;
  const SQL = {
    gift_recv: `SELECT to_email AS e, COALESCE(SUM(coins), 0)::bigint AS n FROM gift_events WHERE created_at >= $1 AND created_at < $2 AND ${WHO('to_email')} GROUP BY to_email`,
    gift_sent: `SELECT from_email AS e, COALESCE(SUM(coins), 0)::bigint AS n FROM gift_events WHERE created_at >= $1 AND created_at < $2 AND ${WHO('from_email')} GROUP BY from_email`,
    room_minutes: `SELECT user_email AS e, SUM(seat + listen)::bigint AS n FROM party_minutes WHERE hour >= date_trunc('hour', $1::timestamptz) AND hour < $2 AND ${WHO('user_email')} GROUP BY user_email`,
    seat_minutes: `SELECT user_email AS e, SUM(seat)::bigint AS n FROM party_minutes WHERE hour >= date_trunc('hour', $1::timestamptz) AND hour < $2 AND ${WHO('user_email')} GROUP BY user_email`,
    checkins: `SELECT user_email AS e, COUNT(*)::bigint AS n FROM checkin_log WHERE day >= ($1::timestamptz AT TIME ZONE 'Asia/Phnom_Penh')::date AND day <= ($2::timestamptz AT TIME ZONE 'Asia/Phnom_Penh')::date AND ${WHO('user_email')} GROUP BY user_email`,
    room_followers: `SELECT owner_email AS e, COUNT(*)::bigint AS n FROM party_follows WHERE created_at >= $1 AND created_at < $2 AND ${WHO('owner_email')} GROUP BY owner_email`,
    video_views: `SELECT LOWER(p.user_email) AS e, COUNT(*)::bigint AS n FROM post_views v JOIN posts p ON p.id = v.post_id
                  WHERE v.created_at >= $1 AND v.created_at < $2 AND (v.viewer_email IS NULL OR LOWER(v.viewer_email) <> LOWER(p.user_email)) AND ${WHO('LOWER(p.user_email)')} GROUP BY LOWER(p.user_email)`,
    posts: `SELECT LOWER(user_email) AS e, COUNT(*)::bigint AS n FROM posts WHERE created_at >= $1 AND created_at < $2 AND ${WHO('LOWER(user_email)')} GROUP BY LOWER(user_email)`,
    followers: `SELECT LOWER(following_email) AS e, COUNT(*)::bigint AS n FROM follows WHERE created_at >= $1 AND created_at < $2 AND ${WHO('LOWER(following_email)')} GROUP BY LOWER(following_email)`,
  };
  /// value of the metric for people (null = everybody who has some); returns Map email → number
  async function valuesOf(ch, emails) {
    const to = new Date(Math.min(Date.now(), new Date(ch.ends_at).getTime()));
    const m = new Map();
    if (ch.metric === 'xp') {                                 // XP: what it is now minus what it was when the person joined
      const joins = (await pool.query('SELECT user_email, base FROM challenge_joins WHERE challenge_id = $1' + (emails ? ' AND user_email = ANY($2)' : ''), emails ? [ch.id, emails] : [ch.id])).rows;
      if (!joins.length || !xpNowOf) return m;
      const now = await xpNowOf(joins.map((j) => j.user_email));
      joins.forEach((j) => m.set(j.user_email, Math.max(0, ((now.get(j.user_email) || {}).xp || 0) - Number(j.base || 0))));
      return m;
    }
    if (ch.join_mode === 'join') {                            // only the people who joined, each from the moment they joined
      const joins = (await pool.query('SELECT user_email, joined_at FROM challenge_joins WHERE challenge_id = $1' + (emails ? ' AND user_email = ANY($2)' : ''), emails ? [ch.id, emails] : [ch.id])).rows;
      if (!joins.length) return m;
      const groups = new Map();                               // people who joined in the same hour share one query
      for (const j of joins) {
        const from = new Date(Math.max(new Date(ch.starts_at).getTime(), new Date(j.joined_at).getTime()));
        const k = Math.floor(from.getTime() / 3600000);
        if (!groups.has(k)) groups.set(k, { from, list: [] });
        groups.get(k).list.push(j.user_email);
      }
      for (const g of groups.values()) {
        const r = await pool.query(SQL[ch.metric], [g.from, to, g.list]).catch(() => ({ rows: [] }));
        r.rows.forEach((x) => m.set(norm(x.e), Number(x.n) || 0));
        g.list.forEach((e) => { if (!m.has(e)) m.set(e, 0); });
      }
      return m;
    }
    const r = await pool.query(SQL[ch.metric], [new Date(ch.starts_at), to, emails || null]).catch(() => ({ rows: [] }));
    r.rows.forEach((x) => m.set(norm(x.e), Number(x.n) || 0));
    if (emails) emails.forEach((e) => { if (!m.has(e)) m.set(e, 0); });
    return m;
  }

  // ---- rewards: things are given at once; money waits for an Admin ----
  const rewardText = (rw) => {
    const n = Number(rw.amount) || 0;
    switch (rw.type) {
      case 'coins': return '🪙 ' + n + ' កាក់';
      case 'money': return '💵 $' + (n / 100).toFixed(2);
      case 'frame': return '🖼️ ស៊ុមរូប ' + (Number(rw.days) || 7) + ' ថ្ងៃ';
      case 'vip': return '👑 VIP ' + n + ' ថ្ងៃ';
      case 'xp': return '⚡ ' + n + ' XP';
      default: return String(rw.label || '🎁');
    }
  };
  async function give(row, by) {
    const rw = row.reward || {}, e = row.user_email, n = Math.max(0, Number(rw.amount) || 0);
    if (rw.type === 'coins' && n) await pool.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'challenge', $3, $4, $5)", [e, n, 'Challenge #' + row.challenge_id, row.id, by || 'system']);
    else if (rw.type === 'money' && n) await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, ref_id, created_by) VALUES ($1, $2, 'challenge', $3, $4, $5)", [e, n, 'Challenge #' + row.challenge_id + ' reward', row.id, by || 'system']);
    else if (rw.type === 'frame' && rw.frame_id) await pool.query(`INSERT INTO user_frames (user_email, frame_id, expires_at) VALUES ($1, $2, NOW() + ($3::text || ' days')::interval)
      ON CONFLICT (user_email, frame_id) DO UPDATE SET expires_at = GREATEST(user_frames.expires_at, NOW()) + ($3::text || ' days')::interval`, [e, parseInt(rw.frame_id, 10), String(Number(rw.days) || 7)]);
    else if (rw.type === 'vip' && n) await pool.query(`INSERT INTO user_vip (user_email, expires_at) VALUES ($1, NOW() + ($2::text || ' days')::interval)
      ON CONFLICT (user_email) DO UPDATE SET expires_at = GREATEST(user_vip.expires_at, NOW()) + ($2::text || ' days')::interval`, [e, String(n)]);
    else if (rw.type === 'xp' && n) await pool.query('INSERT INTO user_xp (user_email, xp) VALUES ($1, $2) ON CONFLICT (user_email) DO UPDATE SET xp = user_xp.xp + $2', [e, n]);
  }
  // a step reached / a place won: write it down once; give it now unless it is money
  async function award(ch, e, kind, level, value, rw) {
    if (!rw || !REWARDS.includes(rw.type)) return;
    const money = rw.type === 'money';
    const ins = await pool.query(`INSERT INTO challenge_rewards (challenge_id, user_email, kind, level, value, reward, status) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (challenge_id, user_email, kind, level) DO NOTHING RETURNING *`, [ch.id, e, kind, level, value, JSON.stringify(rw), money ? 'pending' : 'paid']);
    const row = ins.rows[0]; if (!row) return;
    if (!money) await give(row).catch((x) => console.error('[challenges] give:', x.message));
    const what = kind === 'rank' ? 'អ្នកបានលេខ ' + level : 'អ្នកបានដល់ជាន់ទី ' + level;
    await sendNotice('system', e, '🎯 ' + ch.title_km + ' — ' + what + '! រង្វាន់៖ ' + rewardText(rw) + (money ? ' (CamFeed កំពុងពិនិត្យ មុនដាក់ចូលកាបូប)' : '')).catch(() => {});
  }
  const tiersOf = (ch) => (Array.isArray(ch.tiers) ? ch.tiers : []).filter((t) => Number(t.need) > 0).sort((a, b) => Number(a.need) - Number(b.need));
  const ranksOf = (ch) => (Array.isArray(ch.ranks) ? ch.ranks : []).filter((r) => Number(r.from) >= 1);

  // every 10 minutes: steps reached in live challenges; challenges that ended get their final places
  async function sweep() {
    try {
      await ensure();
      const live = (await pool.query("SELECT * FROM challenges WHERE status = 'live' AND starts_at <= NOW()")).rows;
      for (const ch of live) {
        const tiers = tiersOf(ch);
        const vals = await valuesOf(ch, null);
        if (tiers.length) for (const [e, v] of vals) tiers.forEach((t, i) => { if (v >= Number(t.need)) award(ch, e, 'tier', i + 1, v, t.reward).catch(() => {}); });
        if (new Date(ch.ends_at) <= new Date()) {
          const ranks = ranksOf(ch);
          if (ranks.length) {
            const order = [...vals.entries()].filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
            for (let i = 0; i < order.length; i++) {
              const place = i + 1, r = ranks.find((x) => place >= Number(x.from) && place <= Number(x.to || x.from));
              if (r) await award(ch, order[i][0], 'rank', place, order[i][1], r.reward).catch(() => {});
            }
          }
          await pool.query("UPDATE challenges SET status = 'ended', finished_at = NOW() WHERE id = $1", [ch.id]);
          audit && audit('system', 'challenge-ended', String(ch.id), ch.title_en || ch.title_km);
        }
      }
    } catch (e) { console.error('[challenges] sweep:', e.message); }
  }
  setTimeout(() => { sweep(); setInterval(sweep, 10 * 60 * 1000); }, 100 * 1000);

  // can this person take part? (level / account age)
  async function canJoin(ch, e) {
    if (ch.min_level > 0 && badgesOf) { const b = (await badgesOf([e]).catch(() => new Map())).get(e) || {}; if ((b.level || 1) < ch.min_level) return 'level'; }
    if (ch.min_days > 0) {
      const u = (await pool.query('SELECT created_at FROM users WHERE LOWER(email) = $1', [e])).rows[0];
      if (u && u.created_at && (Date.now() - new Date(u.created_at).getTime()) < ch.min_days * 86400000) return 'days';
    }
    return '';
  }

  // what a person sees: the challenges for one place (party / monetize), with their own progress
  async function view(ch, e, withTop) {
    const tiers = tiersOf(ch), ranks = ranksOf(ch);
    const joined = ch.join_mode === 'auto' || (await pool.query('SELECT 1 FROM challenge_joins WHERE challenge_id = $1 AND user_email = $2', [ch.id, e])).rows.length > 0;
    const people = ch.join_mode === 'join' ? Number((await pool.query('SELECT COUNT(*)::int AS n FROM challenge_joins WHERE challenge_id = $1', [ch.id])).rows[0].n) : 0;
    let mine = 0, place = null, top = [];
    const started = new Date(ch.starts_at) <= new Date();
    if (joined && started) mine = (await valuesOf(ch, [e])).get(e) || 0;
    if (withTop && started && ranks.length) {
      const all = await valuesOf(ch, null);
      const order = [...all.entries()].filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
      const i = order.findIndex((x) => x[0] === e); place = i >= 0 ? i + 1 : null;
      const ten = order.slice(0, 10);
      if (ten.length) {
        const u = new Map((await pool.query('SELECT LOWER(email) AS e, first_name, last_name, profile_pic FROM users WHERE LOWER(email) = ANY($1)', [ten.map((x) => x[0])])).rows.map((x) => [x.e, x]));
        top = ten.map((x, k) => { const p = u.get(x[0]) || {}; return { place: k + 1, user_email: x[0], first_name: p.first_name || '', last_name: p.last_name || '', profile_pic: p.profile_pic || '', value: x[1] }; });
      }
    }
    const got = (await pool.query('SELECT kind, level, status FROM challenge_rewards WHERE challenge_id = $1 AND user_email = $2', [ch.id, e])).rows;
    // a step reached right now gets written at once (the sweep also does it)
    if (joined && started && ch.status === 'live') tiers.forEach((t, k) => { if (mine >= Number(t.need) && !got.some((g) => g.kind === 'tier' && g.level === k + 1)) award(ch, e, 'tier', k + 1, mine, t.reward).catch(() => {}); });
    return {
      id: ch.id, icon: ch.icon, title_km: ch.title_km, title_en: ch.title_en, body_km: ch.body_km, body_en: ch.body_en, area: ch.area, metric: ch.metric,
      starts_at: ch.starts_at, ends_at: ch.ends_at, status: ch.status, join_mode: ch.join_mode, max_people: ch.max_people, people, joined, min_level: ch.min_level, min_days: ch.min_days,
      tiers: tiers.map((t, k) => ({ need: Number(t.need), reward: t.reward, text: rewardText(t.reward || {}), done: mine >= Number(t.need), got: got.some((g) => g.kind === 'tier' && g.level === k + 1) })),
      ranks: ranks.map((r) => ({ from: Number(r.from), to: Number(r.to || r.from), reward: r.reward, text: rewardText(r.reward || {}) })),
      mine, place, top,
    };
  }
  app.get('/api/challenges', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const area = String(req.query.area || 'party') === 'monetize' ? 'monetize' : 'party';
      const list = (await pool.query(`SELECT * FROM challenges WHERE (area = $1 OR area = 'both') AND status <> 'draft' AND status <> 'paused'
        AND (status = 'live' OR finished_at > NOW() - INTERVAL '7 days') ORDER BY (status = 'live') DESC, sort, ends_at LIMIT 30`, [area])).rows;
      const out = [];
      for (const ch of list) out.push(await view(ch, e, false));
      res.json({ success: true, challenges: out, now: new Date().toISOString() });
    } catch (err) { console.error('[challenges] list:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  app.get('/api/challenges/:id', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const ch = (await pool.query("SELECT * FROM challenges WHERE id = $1 AND status <> 'draft'", [parseInt(req.params.id, 10) || 0])).rows[0];
      if (!ch) return res.status(404).json({ success: false, error: 'Not found.' });
      res.json({ success: true, challenge: await view(ch, e, true), now: new Date().toISOString() });
    } catch (err) { console.error('[challenges] one:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  // join (free) — the first N people, when CamFeed limited the places
  app.post('/api/challenges/:id/join', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const c = await pool.connect();
    try {
      await ensure();
      await c.query('BEGIN');
      const ch = (await c.query("SELECT * FROM challenges WHERE id = $1 AND status = 'live' FOR UPDATE", [parseInt(req.params.id, 10) || 0])).rows[0];
      if (!ch || new Date(ch.ends_at) <= new Date()) { await c.query('ROLLBACK'); return res.status(404).json({ success: false, code: 'ended', error: 'This challenge has ended.' }); }
      if (ch.join_mode !== 'join') { await c.query('ROLLBACK'); return res.json({ success: true }); }
      const why = await canJoin(ch, e);
      if (why) { await c.query('ROLLBACK'); return res.status(403).json({ success: false, code: why, message: why, error: 'You can not join this challenge yet.' }); }
      const n = Number((await c.query('SELECT COUNT(*)::int AS n FROM challenge_joins WHERE challenge_id = $1', [ch.id])).rows[0].n);
      if (ch.max_people > 0 && n >= ch.max_people) { await c.query('ROLLBACK'); return res.status(409).json({ success: false, code: 'full', message: 'full', error: 'All places are taken.' }); }
      let base = 0;
      if (ch.metric === 'xp' && xpNowOf) base = ((await xpNowOf([e])).get(e) || {}).xp || 0;
      await c.query('INSERT INTO challenge_joins (challenge_id, user_email, base) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ch.id, e, base]);
      await c.query('COMMIT');
      res.json({ success: true });
    } catch (err) { try { await c.query('ROLLBACK'); } catch (x) { /* none */ } console.error('[challenges] join:', err.message); res.status(500).json({ success: false, error: 'Could not join.' }); }
    finally { c.release(); }
  });

  // ---- Admin › 🎯 Challenges ----
  function clean(b) {
    const s = (v, n) => String(v || '').trim().slice(0, n);
    const rw = (r) => {
      r = r || {}; const type = REWARDS.includes(r.type) ? r.type : 'coins';
      const o = { type, amount: Math.max(0, Math.min(Number(r.amount) || 0, type === 'money' ? 10000000 : 100000000)) };
      if (type === 'frame') { o.frame_id = parseInt(r.frame_id, 10) || 0; o.days = Math.max(1, Math.min(parseInt(r.days, 10) || 7, 3650)); }
      if (type === 'note' || r.label) o.label = s(r.label, 120);
      return o;
    };
    const out = {
      title_km: s(b.title_km, 120), title_en: s(b.title_en, 120), body_km: s(b.body_km, 2000), body_en: s(b.body_en, 2000), icon: s(b.icon, 16) || '🎯',
      area: ['party', 'monetize', 'both'].includes(b.area) ? b.area : 'party', metric: METRICS.includes(b.metric) ? b.metric : '',
      starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at), join_mode: b.join_mode === 'auto' ? 'auto' : 'join',
      max_people: Math.max(0, Math.min(parseInt(b.max_people, 10) || 0, 1000000)), min_level: Math.max(0, parseInt(b.min_level, 10) || 0), min_days: Math.max(0, parseInt(b.min_days, 10) || 0),
      tiers: (Array.isArray(b.tiers) ? b.tiers : []).filter((t) => Number(t.need) > 0).slice(0, 10).map((t) => ({ need: Number(t.need), reward: rw(t.reward) })),
      ranks: (Array.isArray(b.ranks) ? b.ranks : []).filter((r) => parseInt(r.from, 10) >= 1).slice(0, 20).map((r) => ({ from: parseInt(r.from, 10), to: Math.max(parseInt(r.from, 10), parseInt(r.to, 10) || parseInt(r.from, 10)), reward: rw(r.reward) })),
      status: ['draft', 'live', 'paused'].includes(b.status) ? b.status : 'live', sort: parseInt(b.sort, 10) || 0,
    };
    if (!out.title_km) return 'Write the Khmer title.';
    if (!out.metric) return 'Choose what is counted.';
    if (isNaN(out.starts_at) || isNaN(out.ends_at) || out.ends_at <= out.starts_at) return 'Check the start and end time.';
    if (out.metric === 'xp' && out.join_mode !== 'join') return 'An XP challenge needs "people press Join" (XP is counted from the moment they join).';
    if (!out.tiers.length && !out.ranks.length) return 'Add at least one step or one place (Top N).';
    return out;
  }
  app.post('/api/admin/challenges', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const act = String(b.action || '');
      const superOnly = () => { if (!a.isSuperAdmin) { res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' }); return false; } return true; };
      if (act === 'save') {
        if (!superOnly()) return;
        const c = clean(b.challenge || {});
        if (typeof c === 'string') return res.status(400).json({ success: false, error: c });
        const id = parseInt((b.challenge || {}).id, 10) || 0;
        const vals = [c.title_km, c.title_en, c.body_km, c.body_en, c.icon, c.area, c.metric, c.starts_at, c.ends_at, c.join_mode, c.max_people, c.min_level, c.min_days, JSON.stringify(c.tiers), JSON.stringify(c.ranks), c.status, c.sort];
        if (id) await pool.query(`UPDATE challenges SET title_km = $1, title_en = $2, body_km = $3, body_en = $4, icon = $5, area = $6, metric = $7, starts_at = $8, ends_at = $9, join_mode = $10,
          max_people = $11, min_level = $12, min_days = $13, tiers = $14, ranks = $15, status = CASE WHEN status = 'ended' THEN status ELSE $16 END, sort = $17 WHERE id = $18`, [...vals, id]);
        else {
          const r = await pool.query(`INSERT INTO challenges (title_km, title_en, body_km, body_en, icon, area, metric, starts_at, ends_at, join_mode, max_people, min_level, min_days, tiers, ranks, status, sort, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`, [...vals, a.adminEmail]);
          // tell people a new challenge is open (only when it is live)
          if (c.status === 'live' && b.notify === true) pool.query(`INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read)
            SELECT email, 'system', NULL, 'admin_notice', $1, FALSE FROM users WHERE COALESCE(is_banned, FALSE) = FALSE AND last_active > NOW() - INTERVAL '30 days' LIMIT 20000`,
            ['🎯 Challenge ថ្មី៖ ' + c.icon + ' ' + c.title_km + ' — ចូលរួមដើម្បីទទួលរង្វាន់!']).catch(() => {});
          b.challenge.id = r.rows[0].id;
        }
        audit(a.adminEmail, 'challenge-save', String(id || b.challenge.id), c.title_km);
      } else if (act === 'status') {
        if (!superOnly()) return;
        const to = String(b.status || '');
        if (to === 'end') await pool.query("UPDATE challenges SET ends_at = LEAST(ends_at, NOW()) WHERE id = $1 AND status = 'live'", [parseInt(b.id, 10) || 0]);
        else if (['live', 'paused', 'draft'].includes(to)) await pool.query("UPDATE challenges SET status = $2 WHERE id = $1 AND status <> 'ended'", [parseInt(b.id, 10) || 0, to]);
        else if (to === 'delete') { await pool.query('DELETE FROM challenge_joins WHERE challenge_id = $1', [parseInt(b.id, 10) || 0]); await pool.query("DELETE FROM challenges WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM challenge_rewards WHERE challenge_id = $1)", [parseInt(b.id, 10) || 0]); }
        audit(a.adminEmail, 'challenge-' + to, String(b.id), '');
        if (to === 'end') await sweep();
      } else if (act === 'pay') {                                // money rewards: pay into the wallet / cancel
        if (!superOnly()) return;
        const pay = b.pay === true;
        const r = (await pool.query("UPDATE challenge_rewards SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *", [parseInt(b.id, 10) || 0, pay ? 'paid' : 'cancelled', a.adminEmail])).rows[0];
        if (!r) return res.status(409).json({ success: false, error: 'Already decided.' });
        if (pay) { await give(r, a.adminEmail); await sendNotice(a.adminEmail, r.user_email, '🎯 រង្វាន់ Challenge ' + rewardText(r.reward) + ' បានចូលកាបូបរបស់អ្នកហើយ។ អរគុណ!').catch(() => {}); }
        audit(a.adminEmail, 'challenge-reward-' + (pay ? 'paid' : 'cancelled'), r.user_email, rewardText(r.reward));
      } else if (act === 'people') {                             // one challenge: everybody's numbers
        const ch = (await pool.query('SELECT * FROM challenges WHERE id = $1', [parseInt(b.id, 10) || 0])).rows[0];
        if (!ch) return res.status(404).json({ success: false, error: 'Not found.' });
        const vals = await valuesOf(ch, null);
        const order = [...vals.entries()].sort((x, y) => y[1] - x[1]).slice(0, 300);
        const u = new Map((await pool.query('SELECT LOWER(email) AS e, first_name, last_name FROM users WHERE LOWER(email) = ANY($1)', [order.map((x) => x[0])])).rows.map((x) => [x.e, x]));
        return res.json({ success: true, people: order.map((x, i) => Object.assign({ place: i + 1, user_email: x[0], value: x[1] }, u.get(x[0]) || {})) });
      }
      const list = (await pool.query(`SELECT c.*, (SELECT COUNT(*)::int FROM challenge_joins j WHERE j.challenge_id = c.id) AS joined,
        (SELECT COUNT(*)::int FROM challenge_rewards r WHERE r.challenge_id = c.id) AS rewards FROM challenges c ORDER BY (c.status = 'live') DESC, c.created_at DESC LIMIT 100`)).rows;
      const pending = (await pool.query(`SELECT r.*, c.title_km, u.first_name, u.last_name FROM challenge_rewards r JOIN challenges c ON c.id = r.challenge_id LEFT JOIN users u ON LOWER(u.email) = r.user_email
        WHERE r.status = 'pending' OR r.decided_at > NOW() - INTERVAL '30 days' ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`)).rows;
      const frames = (await pool.query('SELECT id, name_en, emoji FROM party_frames ORDER BY id').catch(() => ({ rows: [] }))).rows;
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, challenges: list, rewards: pending, frames, metrics: METRICS, rewardTypes: REWARDS });
    } catch (err) { console.error('[challenges] admin:', err.message); if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  return { pendingMoney: async () => { try { await ensure(); return Number((await pool.query("SELECT COUNT(*)::int AS n FROM challenge_rewards WHERE status = 'pending'")).rows[0].n); } catch (e) { return 0; } } };
};
