// 🎉🔐 Who may OPEN a Party Room, and who may make it PRIVATE (Admin › System › 🎉 Party Room › Opening rooms).
//
// Opening a room (Admin chooses):
//   mode 'all'   = anybody
//   mode 'rules' = Level ≥ N, account at least X days old, a phone number on the account (each 0 / off = not needed)
//   mode 'list'  = only the people CamFeed allowed
//   + CamFeed can allow one person without any rule (for ever or N days), and take it back.
//
// 🔐 Private (one of the room's "who can enter" choices: public / friends / private). The owner may choose it when:
//   CamFeed allowed it (for ever or N days, e.g. a trial) · Level ≥ N (0 = off) · VIP (on / off) ·
//   or bought days with coins (packs the Admin sets: 100 coins = 3 days …; buying again adds the days on).
// When the right runs out, a room that is open as private STAYS private until it closes; the next room can not be private.
// Who can enter a private room is decided in party.js (invited / the link / a card sent by the owner in a chat).
const norm = (e) => String(e || '').trim().toLowerCase();

const DEFAULTS = {
  open: { mode: 'rules', minLevel: 0, minDays: 0, needPhone: false },
  private: { on: true, minLevel: 10, vip: true, roomPrice: 50, switchPrice: 10, packs: [{ coins: 100, days: 3 }, { coins: 200, days: 7 }, { coins: 600, days: 30 }] },
};
const KEY = 'party:access';

module.exports = function installPartyAccess({ app, pool, adminGate, audit, badgesOf }) {
  let ready = null, cache = null, cacheAt = 0;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query('CREATE TABLE IF NOT EXISTS creator_settings (key VARCHAR(40) PRIMARY KEY, value TEXT)');
        // CamFeed's own permission for one person: kind 'open' (open rooms without the rules) or 'private'; until NULL = for ever
        await pool.query(`CREATE TABLE IF NOT EXISTS party_grants (user_email TEXT NOT NULL, kind VARCHAR(10) NOT NULL, until TIMESTAMPTZ,
          note TEXT NOT NULL DEFAULT '', by_email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_email, kind))`);
        // days of "private" bought with coins
        await pool.query(`CREATE TABLE IF NOT EXISTS party_private_passes (user_email TEXT PRIMARY KEY, until TIMESTAMPTZ NOT NULL,
          coins_total INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS party_private_sales (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, coins INTEGER NOT NULL,
          days INTEGER NOT NULL, until TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
  function clean(raw) {
    const r = raw && typeof raw === 'object' ? raw : {}, o = JSON.parse(JSON.stringify(DEFAULTS));
    const op = r.open || {}, pv = r.private || {};
    if (['all', 'rules', 'list'].includes(op.mode)) o.open.mode = op.mode;
    if (op.minLevel !== undefined) o.open.minLevel = num(op.minLevel, 0, 500, 0);
    if (op.minDays !== undefined) o.open.minDays = num(op.minDays, 0, 3650, 0);
    if (op.needPhone !== undefined) o.open.needPhone = !!op.needPhone;
    if (pv.on !== undefined) o.private.on = !!pv.on;
    if (pv.minLevel !== undefined) o.private.minLevel = num(pv.minLevel, 0, 500, 10);
    if (pv.vip !== undefined) o.private.vip = !!pv.vip;
    if (pv.roomPrice !== undefined) o.private.roomPrice = num(pv.roomPrice, 0, 10000000, 50);   // 0 = turned off
    if (pv.switchPrice !== undefined) o.private.switchPrice = num(pv.switchPrice, 0, 10000000, 10);   // people WITH the right, switching an open room (0 = free)
    if (Array.isArray(pv.packs)) {
      const seen = new Set();
      o.private.packs = pv.packs.map((p) => ({ coins: num(p && p.coins, 1, 10000000, 0), days: num(p && p.days, 1, 3650, 0) }))
        .filter((p) => p.coins > 0 && p.days > 0 && !seen.has(p.days + ':' + p.coins) && seen.add(p.days + ':' + p.coins))
        .sort((a, b) => a.days - b.days || a.coins - b.coins).slice(0, 8);
    }
    return o;
  }
  async function settings(fresh) {
    if (!fresh && cache && Date.now() - cacheAt < 30000) return cache;
    await ensure();
    const r = await pool.query('SELECT value FROM creator_settings WHERE key = $1', [KEY]).catch(() => ({ rows: [] }));
    let raw = {}; try { raw = r.rows[0] ? JSON.parse(r.rows[0].value) : {}; } catch (e) { raw = {}; }
    cache = clean(raw); cacheAt = Date.now();
    return cache;
  }
  async function grantOf(email, kind) {
    const r = await pool.query('SELECT until FROM party_grants WHERE user_email = $1 AND kind = $2 AND (until IS NULL OR until > NOW())', [norm(email), kind]);
    return r.rows[0] ? { until: r.rows[0].until } : null;
  }
  async function badge(email) {
    try { const m = badgesOf ? await badgesOf([norm(email)]) : new Map(); return m.get(norm(email)) || { level: 1, vip: false }; }
    catch (e) { return { level: 1, vip: false }; }
  }

  /// may this person open a room? { ok, need: {...} } (need = what is still missing, for the app to explain)
  async function canOpen(email) {
    const s = await settings(); const e = norm(email);
    if (s.open.mode === 'all') return { ok: true };
    if (await grantOf(e, 'open')) return { ok: true, via: 'admin' };
    if (s.open.mode === 'list') return { ok: false, mode: 'list' };
    const need = {};
    const b = await badge(e);
    if (s.open.minLevel > 0 && (b.level || 1) < s.open.minLevel) need.level = s.open.minLevel;
    if (s.open.minDays > 0 || s.open.needPhone) {
      const u = (await pool.query('SELECT created_at, phone FROM users WHERE LOWER(email) = $1', [e]).catch(() => ({ rows: [] }))).rows[0] || {};
      if (s.open.minDays > 0) {
        const days = u.created_at ? Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86400000) : 0;
        if (days < s.open.minDays) { need.days = s.open.minDays; need.daysLeft = s.open.minDays - days; }
      }
      if (s.open.needPhone && !String(u.phone || '').trim()) need.phone = true;
    }
    return Object.keys(need).length ? { ok: false, mode: 'rules', need, level: b.level || 1 } : { ok: true, via: 'rules' };
  }

  /// may this person make a room private? { ok, via, until, … everything the app shows }
  async function privateStatus(email) {
    const s = await settings(); const e = norm(email);
    const b = await badge(e);
    const out = { on: s.private.on, level: b.level || 1, vip: !!b.vip, minLevel: s.private.minLevel, vipAllowed: s.private.vip, packs: s.private.packs, roomPrice: s.private.roomPrice, switchPrice: s.private.switchPrice, ok: false, via: null, until: null };
    if (!s.private.on) return out;
    const g = await grantOf(e, 'private');
    const pass = (await pool.query('SELECT until FROM party_private_passes WHERE user_email = $1 AND until > NOW()', [e])).rows[0];
    if (pass) out.passUntil = pass.until;
    if (g && g.until === null) return Object.assign(out, { ok: true, via: 'admin', until: null });
    if (s.private.minLevel > 0 && out.level >= s.private.minLevel) return Object.assign(out, { ok: true, via: 'level', until: null });
    if (s.private.vip && out.vip) return Object.assign(out, { ok: true, via: 'vip', until: null });
    // a time-limited right: the one that lasts longest
    const ends = [g && g.until ? { via: 'admin', until: g.until } : null, pass ? { via: 'coins', until: pass.until } : null].filter(Boolean)
      .sort((a, b2) => new Date(b2.until) - new Date(a.until));
    if (ends.length) return Object.assign(out, { ok: true, via: ends[0].via, until: ends[0].until });
    return out;
  }

  // ---- the app ------------------------------------------------------------------------------------------------------
  app.get('/api/party/access', async (req, res) => {
    const e = norm(req.authEmail); if (!e) return res.status(401).json({ success: false });
    try {
      await ensure();
      const bal = (await pool.query('SELECT COALESCE(SUM(coins), 0)::int AS n FROM coin_ledger WHERE user_email = $1', [e]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
      res.json({ success: true, open: await canOpen(e), private: await privateStatus(e), balance: bal });
    } catch (err) { console.error('[party-access] status:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  // buy days of "private" with coins (bought again before the end: the days are added on)
  app.post('/api/party/access/buy', async (req, res) => {
    const e = norm(req.authEmail); if (!e) return res.status(401).json({ success: false });
    const s = await settings(true).catch(() => null);
    if (!s || !s.private.on) return res.status(403).json({ success: false, error: 'This is turned off for now.' });
    const p = s.private.packs.find((x) => x.days === parseInt((req.body || {}).days, 10) && x.coins === parseInt((req.body || {}).coins, 10));
    if (!p) return res.status(400).json({ success: false, code: 'pack', error: 'This pack is not available any more.' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['coins:' + e]);          // the same lock as the other coin spending
      const have = (await c.query('SELECT COALESCE(SUM(coins), 0)::int AS n FROM coin_ledger WHERE user_email = $1', [e])).rows[0].n;
      if (have < p.coins) { await c.query('ROLLBACK'); c.release(); return res.status(402).json({ success: false, code: 'coins', balance: have, need: p.coins, error: 'Not enough diamonds.' }); }
      const up = await c.query(`INSERT INTO party_private_passes (user_email, until, coins_total) VALUES ($1, NOW() + ($2 || ' days')::interval, $3)
                                ON CONFLICT (user_email) DO UPDATE SET until = GREATEST(party_private_passes.until, NOW()) + ($2 || ' days')::interval,
                                coins_total = party_private_passes.coins_total + $3, updated_at = NOW() RETURNING until`, [e, String(p.days), p.coins]);
      const sale = await c.query('INSERT INTO party_private_sales (user_email, coins, days, until) VALUES ($1, $2, $3, $4) RETURNING id', [e, p.coins, p.days, up.rows[0].until]);
      await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'room_private', $3, $4, $1)", [e, -p.coins, 'Private room ' + p.days + 'd', sale.rows[0].id]);
      await c.query('COMMIT');
      c.release();
      res.json({ success: true, private: await privateStatus(e), balance: have - p.coins });
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch (x) { /* nothing open */ }
      c.release();
      console.error('[party-access] buy:', err.message);
      res.status(500).json({ success: false, error: 'Could not buy. Please try again.' });
    }
  });

  // 🔐 pay once to make the room that is open NOW private (no days bought): { ok, balance } or { code, … }
  // allowed = the person has the right (pays the small switch price), else the full one-time price
  async function payRoomOnce(email, roomId, apply, allowed) {
    const e = norm(email);
    const s = await settings(true);
    const price = allowed ? s.private.switchPrice : s.private.roomPrice;
    if (!s.private.on || (!allowed && !(price > 0))) return { code: 'off' };
    if (allowed && !(price > 0)) { await apply(pool); return { ok: true, price: 0 }; }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['coins:' + e]);
      const have = (await c.query('SELECT COALESCE(SUM(coins), 0)::int AS n FROM coin_ledger WHERE user_email = $1', [e])).rows[0].n;
      if (have < price) { await c.query('ROLLBACK'); return { code: 'coins', balance: have, need: price }; }
      const sale = await c.query("INSERT INTO party_private_sales (user_email, coins, days, until) VALUES ($1, $2, 0, NOW()) RETURNING id", [e, price]);
      await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'room_private', $3, $4, $1)", [e, -price, 'Private room #' + roomId, sale.rows[0].id]);
      await apply(c);                                   // the room becomes private in the same step (both or neither)
      await c.query('COMMIT');
      return { ok: true, balance: have - price, price };
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch (x) { /* nothing open */ }
      throw err;
    } finally { c.release(); }
  }

  // ---- Admin ------------------------------------------------------------------------------------------------------
  async function findUser(who) {
    let w = norm(who);
    if (!w.includes('@')) {
      const u = await pool.query('SELECT email FROM users WHERE phone = $1 OR phone = $2 LIMIT 1', [w, w.replace(/^0/, '+855')]).catch(() => ({ rows: [] }));
      if (u.rows[0]) w = norm(u.rows[0].email);
    }
    const ex = await pool.query('SELECT email FROM users WHERE LOWER(email) = $1', [w]);
    return ex.rows[0] ? norm(ex.rows[0].email) : null;
  }
  app.post('/api/admin/party-access', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      if (b.set && typeof b.set === 'object') {
        if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
        const v = clean(b.set);
        await pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [KEY, JSON.stringify(v)]);
        cacheAt = 0;
        if (audit) audit(a.adminEmail, 'party-access', 'settings', 'open:' + v.open.mode + ' private:' + (v.private.on ? 'on' : 'off'));
      }
      if (b.grant && typeof b.grant === 'object') {
        const kind = b.grant.kind === 'open' ? 'open' : 'private';
        const who = await findUser(b.grant.target || '');
        if (!who) return res.status(404).json({ success: false, error: 'No account was found.' });
        const days = num(b.grant.days, 0, 3650, 0);                                    // 0 = for ever
        await pool.query(`INSERT INTO party_grants (user_email, kind, until, note, by_email) VALUES ($1, $2, CASE WHEN $3::int = 0 THEN NULL ELSE NOW() + ($3::int || ' days')::interval END, $4, $5)
                          ON CONFLICT (user_email, kind) DO UPDATE SET until = EXCLUDED.until, note = EXCLUDED.note, by_email = EXCLUDED.by_email, created_at = NOW()`,
          [who, kind, days, String(b.grant.note || '').trim().slice(0, 200), a.adminEmail]);
        if (audit) audit(a.adminEmail, 'party-grant', who, kind + ' ' + (days ? days + 'd' : 'for ever'));
      }
      if (b.revoke && typeof b.revoke === 'object') {
        const kind = b.revoke.kind === 'open' ? 'open' : (b.revoke.kind === 'pass' ? 'pass' : 'private');
        const who = norm(b.revoke.target || '');
        if (kind === 'pass') await pool.query('DELETE FROM party_private_passes WHERE user_email = $1', [who]);
        else await pool.query('DELETE FROM party_grants WHERE user_email = $1 AND kind = $2', [who, kind]);
        if (audit) audit(a.adminEmail, 'party-revoke', who, kind);
      }
      const s = await settings(true);
      const grants = (await pool.query(`SELECT g.user_email AS target, g.kind, g.until, g.note, g.by_email, g.created_at, u.first_name, u.last_name, u.profile_pic
        FROM party_grants g LEFT JOIN users u ON LOWER(u.email) = g.user_email WHERE g.until IS NULL OR g.until > NOW() ORDER BY g.created_at DESC LIMIT 300`)).rows;
      const passes = (await pool.query(`SELECT p.user_email AS target, p.until, p.coins_total, u.first_name, u.last_name, u.profile_pic
        FROM party_private_passes p LEFT JOIN users u ON LOWER(u.email) = p.user_email WHERE p.until > NOW() ORDER BY p.until DESC LIMIT 300`)).rows;
      const sales = (await pool.query(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT user_email)::int AS people, COALESCE(SUM(coins), 0)::int AS coins,
        COALESCE(SUM(coins) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS coins30 FROM party_private_sales`)).rows[0];
      const privateRooms = (await pool.query("SELECT COUNT(*)::int AS n FROM party_rooms WHERE status = 'open' AND privacy = 'private'").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, settings: s, defaults: DEFAULTS, grants, passes, sales, privateRooms });
    } catch (err) { console.error('[party-access] admin:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  return { canOpen, privateStatus, settings, ensure, payRoomOnce };
};
