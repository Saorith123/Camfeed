// 🎉 Party Room (phase 1: voice only). Anybody can open a room: public, or friends only. The owner picks 4 / 8 / 12 seats
// (the owner sits on seat 0). People on a seat can talk, everybody else listens. Listeners raise a hand ✋ or, when the
// owner leaves the seats open, simply tap an empty seat. Owner / helpers can mute, take somebody off a seat, or remove them.
//
// The sound itself goes through LiveKit (an SFU), never through this server. The LiveKit address and keys are set by the
// Super Admin in Admin > System > Party Room (saved in creator_settings), or in Render (LIVEKIT_URL / LIVEKIT_API_KEY /
// LIVEKIT_API_SECRET) as a fallback. This file only keeps who is in which room / on which seat, the room chat, and hands out
// LiveKit "tickets" (tokens) that allow talking only to the people who sit on a seat.
const crypto = require('crypto');

module.exports = function installParty({ app, pool, publicIds, adminGate, audit }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const SEAT_CHOICES = [4, 8, 12];
  const STALE_SEC = 40;                 // not heard from for this long = gone (the app asks every ~2 s)
  const OWNER_GONE_SEC = 180;           // the owner's phone disappeared for 3 minutes: the room closes

  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS party_rooms (
          id SERIAL PRIMARY KEY, owner_email TEXT NOT NULL, title VARCHAR(80) NOT NULL DEFAULT '',
          privacy VARCHAR(10) NOT NULL DEFAULT 'public', seats INTEGER NOT NULL DEFAULT 8, free_seats BOOLEAN NOT NULL DEFAULT TRUE,
          status VARCHAR(10) NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), closed_at TIMESTAMPTZ,
          closed_by TEXT, closed_reason TEXT)`);
        await pool.query("CREATE INDEX IF NOT EXISTS idx_party_rooms_open ON party_rooms (status) WHERE status = 'open'");
        await pool.query(`CREATE TABLE IF NOT EXISTS party_members (
          room_id INTEGER NOT NULL, user_email TEXT NOT NULL, role VARCHAR(10) NOT NULL DEFAULT 'member',
          seat INTEGER, host_muted BOOLEAN NOT NULL DEFAULT FALSE, hand_at TIMESTAMPTZ,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (room_id, user_email))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS party_bans (room_id INTEGER NOT NULL, user_email TEXT NOT NULL, PRIMARY KEY (room_id, user_email))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS party_messages (
          id SERIAL PRIMARY KEY, room_id INTEGER NOT NULL, user_email TEXT, kind VARCHAR(10) NOT NULL DEFAULT 'text',
          text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_party_messages_room ON party_messages (room_id, id)');
        await pool.query(`CREATE TABLE IF NOT EXISTS party_reports (
          id SERIAL PRIMARY KEY, room_id INTEGER NOT NULL, reporter_email TEXT NOT NULL, reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), handled BOOLEAN NOT NULL DEFAULT FALSE)`);
        await pool.query('CREATE TABLE IF NOT EXISTS creator_settings (key VARCHAR(40) PRIMARY KEY, value TEXT)');
        // used by gifts (coins.js fills the catalog)
        await pool.query('ALTER TABLE party_messages ADD COLUMN IF NOT EXISTS to_email TEXT');
        await pool.query('ALTER TABLE party_messages ADD COLUMN IF NOT EXISTS gift_id INTEGER');
        await pool.query(`CREATE TABLE IF NOT EXISTS gift_catalog (
          id SERIAL PRIMARY KEY, code VARCHAR(30) UNIQUE, emoji VARCHAR(16) NOT NULL, name_km VARCHAR(60) NOT NULL, name_en VARCHAR(60) NOT NULL,
          coins INTEGER NOT NULL, tier INTEGER NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT TRUE, sort INTEGER NOT NULL DEFAULT 0)`);
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  setTimeout(() => ensure().catch((e) => console.error('[party] schema:', e.message)), 3500);

  // ---- LiveKit settings (Admin panel first, Render second) --------------------------------------------------------------
  let lkCache = null, lkAt = 0;
  async function lk() {
    if (lkCache && Date.now() - lkAt < 30000) return lkCache;
    const m = {};
    try { (await pool.query("SELECT key, value FROM creator_settings WHERE key LIKE 'party:%'")).rows.forEach((r) => { m[r.key.slice(6)] = r.value || ''; }); } catch (e) { /* not yet */ }
    lkCache = {
      url: (m.url || process.env.LIVEKIT_URL || '').trim(),
      key: (m.key || process.env.LIVEKIT_API_KEY || '').trim(),
      secret: (m.secret || process.env.LIVEKIT_API_SECRET || '').trim(),
    };
    lkAt = Date.now();
    return lkCache;
  }
  const lkReady = (c) => !!(c.url && c.key && c.secret);

  const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  function lkToken(c, claims, ttlSec) {
    const now = Math.floor(Date.now() / 1000);
    const body = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u(Object.assign({ iss: c.key, nbf: now - 10, exp: now + ttlSec }, claims));
    const sig = crypto.createHmac('sha256', c.secret).update(body).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return body + '.' + sig;
  }
  const lkRoom = (id) => 'party-' + id;
  // ask LiveKit to change what one person may do right now (talk or not) / to remove them (best effort)
  async function lkCall(method, payload) {
    try {
      const c = await lk(); if (!lkReady(c)) return;
      const base = c.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
      const tok = lkToken(c, { video: { roomAdmin: true, room: payload.room } }, 120);
      await fetch(base + '/twirp/livekit.RoomService/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(payload),
      });
    } catch (e) { console.error('[party] livekit', method, e.message); }
  }
  async function idOf(email) { try { const m = await publicIds.toIds([email]); return m.get(norm(email)) || norm(email); } catch (e) { return norm(email); } }
  async function setTalk(roomId, email, canTalk) {
    await lkCall('UpdateParticipant', { room: lkRoom(roomId), identity: await idOf(email),
      permission: { can_subscribe: true, can_publish: !!canTalk, can_publish_data: false, can_publish_sources: canTalk ? [2] : [] } });   // 2 = microphone
  }
  async function kickFromLk(roomId, email) { await lkCall('RemoveParticipant', { room: lkRoom(roomId), identity: await idOf(email) }); }
  async function endLkRoom(roomId) { await lkCall('DeleteRoom', { room: lkRoom(roomId) }); }

  // ---- helpers ----------------------------------------------------------------------------------------------------------
  const me = (req, res) => { const e = norm(req.authEmail); if (!e) res.status(401).json({ success: false, error: 'Please log in.' }); return e; };
  async function roomOf(id) { const r = await pool.query('SELECT * FROM party_rooms WHERE id = $1', [parseInt(id, 10) || 0]); return r.rows[0] || null; }
  async function memberOf(roomId, email) { const r = await pool.query('SELECT * FROM party_members WHERE room_id = $1 AND user_email = $2', [roomId, email]); return r.rows[0] || null; }
  async function isFriend(a, b) {
    const r = await pool.query(`SELECT 1 FROM follows f1 JOIN follows f2 ON f2.follower_email = f1.following_email AND f2.following_email = f1.follower_email
                                WHERE LOWER(f1.follower_email) = $1 AND LOWER(f1.following_email) = $2 LIMIT 1`, [norm(a), norm(b)]);
    return r.rows.length > 0;
  }
  async function blockedEither(a, b) {
    const r = await pool.query('SELECT 1 FROM blocked_users WHERE (LOWER(blocker_email) = $1 AND LOWER(blocked_email) = $2) OR (LOWER(blocker_email) = $2 AND LOWER(blocked_email) = $1) LIMIT 1', [norm(a), norm(b)]).catch(() => ({ rows: [] }));
    return r.rows.length > 0;
  }
  async function canSee(room, email) {
    if (!room || room.status !== 'open') return false;
    if (norm(room.owner_email) === email) return true;
    if (await blockedEither(room.owner_email, email)) return false;
    if (room.privacy === 'friends') return isFriend(room.owner_email, email);
    return true;
  }
  const sys = (roomId, text, who) => pool.query("INSERT INTO party_messages (room_id, user_email, kind, text) VALUES ($1, $2, 'system', $3)", [roomId, who || null, text]).catch(() => {});

  async function closeRoom(roomId, by, reason) {
    const r = await pool.query("UPDATE party_rooms SET status = 'closed', closed_at = NOW(), closed_by = $2, closed_reason = $3 WHERE id = $1 AND status = 'open' RETURNING id", [roomId, by || null, reason || null]);
    if (!r.rows.length) return;
    await pool.query('DELETE FROM party_members WHERE room_id = $1', [roomId]).catch(() => {});
    endLkRoom(roomId);
  }

  // forget people who went away, close rooms whose owner is gone; old chat is removed after a day
  let sweptAt = 0;
  async function sweep() {
    if (Date.now() - sweptAt < 10000) return; sweptAt = Date.now();
    try {
      await pool.query(`DELETE FROM party_members m USING party_rooms r WHERE r.id = m.room_id AND m.user_email <> r.owner_email
                        AND m.last_seen < NOW() - ($1 || ' seconds')::interval`, [String(STALE_SEC)]);
      const gone = await pool.query(`SELECT r.id FROM party_rooms r WHERE r.status = 'open' AND NOT EXISTS (
                                       SELECT 1 FROM party_members m WHERE m.room_id = r.id AND m.user_email = r.owner_email AND m.last_seen >= NOW() - ($1 || ' seconds')::interval)`, [String(OWNER_GONE_SEC)]);
      for (const g of gone.rows) await closeRoom(g.id, 'system', 'owner left');
      await pool.query("DELETE FROM party_messages WHERE room_id IN (SELECT id FROM party_rooms WHERE status = 'closed' AND closed_at < NOW() - INTERVAL '1 day')");
      await pool.query("DELETE FROM party_bans WHERE room_id IN (SELECT id FROM party_rooms WHERE status = 'closed')");
      await pool.query("DELETE FROM party_rooms WHERE status = 'closed' AND closed_at < NOW() - INTERVAL '30 days' AND id NOT IN (SELECT room_id FROM party_reports WHERE handled = FALSE)");
    } catch (e) { console.error('[party] sweep:', e.message); }
  }

  const userCols = 'u.email, u.first_name, u.last_name, u.profile_pic';
  async function stateOf(room, email, after) {
    const mem = await pool.query(`SELECT m.role, m.seat, m.host_muted, m.hand_at, ${userCols} FROM party_members m JOIN users u ON LOWER(u.email) = m.user_email
                                  WHERE m.room_id = $1 AND m.last_seen >= NOW() - ($2 || ' seconds')::interval ORDER BY m.seat NULLS LAST, m.joined_at`, [room.id, String(STALE_SEC)]);
    const people = mem.rows.map((x) => ({ email: x.email, first_name: x.first_name, last_name: x.last_name, profile_pic: x.profile_pic || '',
      role: x.role, seat: x.seat, muted: !!x.host_muted, hand: !!x.hand_at, hand_at: x.hand_at }));
    const msgs = await pool.query(`SELECT p.id, p.kind, p.text, p.created_at, ${userCols}, p.to_email, t.first_name AS to_first_name, t.last_name AS to_last_name,
                                     g.emoji AS gift_emoji, g.name_km AS gift_km, g.name_en AS gift_en, g.tier AS gift_tier, g.coins AS gift_coins
                                   FROM party_messages p LEFT JOIN users u ON LOWER(u.email) = p.user_email
                                   LEFT JOIN users t ON LOWER(t.email) = p.to_email LEFT JOIN gift_catalog g ON g.id = p.gift_id
                                   WHERE p.room_id = $1 AND p.id > $2 ORDER BY p.id DESC LIMIT 60`, [room.id, parseInt(after, 10) || 0]);
    const mine = people.find((p) => norm(p.email) === email) || null;
    const owner = await pool.query(`SELECT ${userCols} FROM users u WHERE LOWER(u.email) = $1`, [room.owner_email]);
    return {
      room: { id: room.id, title: room.title, privacy: room.privacy, seats: room.seats, free_seats: room.free_seats, status: room.status,
        owner: owner.rows[0] || { email: room.owner_email }, created_at: room.created_at },
      people,
      me: mine ? { role: mine.role, seat: mine.seat, muted: mine.muted, hand: mine.hand } : null,
      messages: msgs.rows.reverse().map((m) => ({ id: m.id, kind: m.kind, text: m.text, created_at: m.created_at,
        email: m.email || null, first_name: m.first_name || '', last_name: m.last_name || '', profile_pic: m.profile_pic || '',
        ...(m.kind === 'gift' ? { to_email: m.to_email, to_first_name: m.to_first_name || '', to_last_name: m.to_last_name || '',
          gift: { emoji: m.gift_emoji || '🎁', name_km: m.gift_km || '', name_en: m.gift_en || '', tier: m.gift_tier || 1, coins: m.gift_coins || 0 }, count: parseInt(m.text, 10) || 1 } : {}) })),
    };
  }

  async function ticket(room, email, seated, muted) {
    const c = await lk(); if (!lkReady(c)) return null;
    const u = await pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email) = $1', [email]);
    const name = u.rows[0] ? (u.rows[0].first_name + ' ' + u.rows[0].last_name).trim() : '';
    const talk = !!seated && !muted;
    return { url: c.url, token: lkToken(c, { sub: await idOf(email), name, video: { room: lkRoom(room.id), roomJoin: true, canSubscribe: true, canPublish: talk,
      canPublishData: false, canPublishSources: talk ? ['microphone'] : [] } }, 6 * 3600) };
  }
  const canManage = (m) => m && (m.role === 'owner' || m.role === 'helper');

  // ---- what the app shows -----------------------------------------------------------------------------------------------
  app.get('/api/party/config', async (req, res) => {
    const c = await lk();
    res.json({ success: true, ready: lkReady(c), seatChoices: SEAT_CHOICES });
  });

  // the rooms I can enter: friends' rooms first, then the busiest
  app.get('/api/party/rooms', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure(); await sweep();
      const r = await pool.query(`
        SELECT r.id, r.title, r.privacy, r.seats, r.owner_email, r.created_at, ${userCols},
          (SELECT COUNT(*) FROM party_members m WHERE m.room_id = r.id AND m.last_seen >= NOW() - ($2 || ' seconds')::interval) AS people,
          EXISTS (SELECT 1 FROM follows f1 JOIN follows f2 ON f2.follower_email = f1.following_email AND f2.following_email = f1.follower_email
                  WHERE LOWER(f1.follower_email) = $1 AND LOWER(f1.following_email) = r.owner_email) AS friend,
          EXISTS (SELECT 1 FROM follows f WHERE LOWER(f.follower_email) = $1 AND LOWER(f.following_email) = r.owner_email) AS following
        FROM party_rooms r JOIN users u ON LOWER(u.email) = r.owner_email
        WHERE r.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (LOWER(b.blocker_email) = $1 AND LOWER(b.blocked_email) = r.owner_email) OR (LOWER(b.blocker_email) = r.owner_email AND LOWER(b.blocked_email) = $1))
          AND NOT EXISTS (SELECT 1 FROM party_bans pb WHERE pb.room_id = r.id AND pb.user_email = $1)
        ORDER BY (LOWER(r.owner_email) = $1) DESC, 1 DESC LIMIT 300`, [e, String(STALE_SEC)]);
      let rows = r.rows.filter((x) => x.privacy !== 'friends' || x.friend || norm(x.owner_email) === e);
      rows.sort((a, b) => (norm(b.owner_email) === e) - (norm(a.owner_email) === e) || (b.friend - a.friend) || (b.following - a.following) || (Number(b.people) - Number(a.people)) || (b.id - a.id));
      rows = rows.slice(0, 100);
      // a few faces of the people sitting in each room
      const ids = rows.map((x) => x.id);
      const faces = ids.length ? (await pool.query(`SELECT m.room_id, u.profile_pic FROM party_members m JOIN users u ON LOWER(u.email) = m.user_email
                                                    WHERE m.room_id = ANY($1::int[]) AND m.seat IS NOT NULL AND m.last_seen >= NOW() - ($2 || ' seconds')::interval ORDER BY m.seat`, [ids, String(STALE_SEC)])).rows : [];
      const mineNow = await pool.query(`SELECT m.room_id FROM party_members m JOIN party_rooms r ON r.id = m.room_id WHERE m.user_email = $1 AND r.status = 'open' LIMIT 1`, [e]);
      res.json({ success: true, current: mineNow.rows[0] ? mineNow.rows[0].room_id : null, rooms: rows.map((x) => ({
        id: x.id, title: x.title, privacy: x.privacy, seats: x.seats, people: Number(x.people) || 0, friend: !!x.friend,
        owner: { email: x.email, first_name: x.first_name, last_name: x.last_name, profile_pic: x.profile_pic || '' },
        faces: faces.filter((f) => f.room_id === x.id).map((f) => f.profile_pic || '').slice(0, 4),
      })) });
    } catch (err) { console.error('[party] rooms:', err.message); res.status(500).json({ success: false, error: 'Could not load the rooms.' }); }
  });

  // open a new room (one open room per person: an older one of mine is closed)
  app.post('/api/party/rooms', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      await ensure();
      if (!lkReady(await lk())) return res.status(503).json({ success: false, error: 'Party Room is not ready yet. Please try again later.' });
      const seats = SEAT_CHOICES.includes(parseInt(b.seats, 10)) ? parseInt(b.seats, 10) : 8;
      const privacy = b.privacy === 'friends' ? 'friends' : 'public';
      const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const old = await pool.query("SELECT id FROM party_rooms WHERE owner_email = $1 AND status = 'open'", [e]);
      for (const o of old.rows) await closeRoom(o.id, e, 'new room');
      await pool.query('DELETE FROM party_members WHERE user_email = $1', [e]);   // I can only be in one room at a time
      const r = await pool.query('INSERT INTO party_rooms (owner_email, title, privacy, seats) VALUES ($1, $2, $3, $4) RETURNING *', [e, title, privacy, seats]);
      const room = r.rows[0];
      await pool.query("INSERT INTO party_members (room_id, user_email, role, seat) VALUES ($1, $2, 'owner', 0)", [room.id, e]);
      res.json({ success: true, id: room.id, live: await ticket(room, e, true, false), state: await stateOf(room, e, 0) });
    } catch (err) { console.error('[party] create:', err.message); res.status(500).json({ success: false, error: 'Could not open the room.' }); }
  });

  app.post('/api/party/rooms/:id/join', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true, error: 'This room has ended.' });
      if (!(await canSee(room, e))) return res.status(403).json({ success: false, error: 'You can not enter this room.' });
      const ban = await pool.query('SELECT 1 FROM party_bans WHERE room_id = $1 AND user_email = $2', [room.id, e]);
      if (ban.rows.length) return res.status(403).json({ success: false, error: 'You were removed from this room.' });
      // leaving any other room first (one room at a time)
      const other = await pool.query('SELECT room_id, role FROM party_members WHERE user_email = $1 AND room_id <> $2', [e, room.id]);
      for (const o of other.rows) { if (o.role === 'owner') await closeRoom(o.room_id, e, 'owner left'); }
      await pool.query('DELETE FROM party_members WHERE user_email = $1 AND room_id <> $2', [e, room.id]);
      const isOwner = norm(room.owner_email) === e;
      const ins = await pool.query(`INSERT INTO party_members (room_id, user_email, role, seat) VALUES ($1, $2, $3, $4)
                        ON CONFLICT (room_id, user_email) DO UPDATE SET last_seen = NOW() RETURNING (xmax = 0) AS fresh`, [room.id, e, isOwner ? 'owner' : 'member', isOwner ? 0 : null]);
      // somebody new came in: a "welcome" line in the chat (the app writes it in the reader's language; '👋' for older apps)
      if (!isOwner && ins.rows[0] && ins.rows[0].fresh) await pool.query("INSERT INTO party_messages (room_id, user_email, kind, text) VALUES ($1, $2, 'join', '👋')", [room.id, e]).catch(() => {});
      const m = await memberOf(room.id, e);
      res.json({ success: true, live: await ticket(room, e, m && m.seat !== null, m && m.host_muted), state: await stateOf(room, e, 0) });
    } catch (err) { console.error('[party] join:', err.message); res.status(500).json({ success: false, error: 'Could not enter the room.' }); }
  });

  // asked every ~2 seconds while the room is open: who sits where, new chat lines, and "I am still here"
  app.get('/api/party/rooms/:id/state', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure(); sweep();
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.json({ success: true, closed: true, reason: room ? room.closed_reason : '' });
      const u = await pool.query('UPDATE party_members SET last_seen = NOW() WHERE room_id = $1 AND user_email = $2 RETURNING room_id', [room.id, e]);
      if (!u.rows.length) {
        const ban = await pool.query('SELECT 1 FROM party_bans WHERE room_id = $1 AND user_email = $2', [room.id, e]);
        return res.json({ success: true, out: true, removed: ban.rows.length > 0 });
      }
      res.json(Object.assign({ success: true }, await stateOf(room, e, req.query.after)));
    } catch (err) { res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  app.post('/api/party/rooms/:id/leave', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const room = await roomOf(req.params.id);
      if (room && norm(room.owner_email) === e && room.status === 'open') { await closeRoom(room.id, e, 'owner ended'); return res.json({ success: true, closed: true }); }
      await pool.query('DELETE FROM party_members WHERE room_id = $1 AND user_email = $2', [parseInt(req.params.id, 10) || 0, e]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // ✋ raise / lower my hand
  app.post('/api/party/rooms/:id/hand', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      const up = !!(req.body || {}).up;
      await pool.query('UPDATE party_members SET hand_at = $3 WHERE room_id = $1 AND user_email = $2 AND seat IS NULL', [parseInt(req.params.id, 10) || 0, e, up ? new Date() : null]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // sit down on a seat myself (when the seats are open, or I am owner / helper), or stand up
  app.post('/api/party/rooms/:id/seat', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true });
      const m = await memberOf(room.id, e); if (!m) return res.status(403).json({ success: false });
      if (b.action === 'leave') {
        if (m.role === 'owner') return res.status(400).json({ success: false, error: 'The owner stays on the first seat.' });
        await pool.query('UPDATE party_members SET seat = NULL, host_muted = FALSE WHERE room_id = $1 AND user_email = $2', [room.id, e]);
        setTalk(room.id, e, false);
        return res.json({ success: true, live: await ticket(room, e, false, false) });
      }
      const seat = parseInt(b.seat, 10);
      if (!(seat >= 1 && seat < room.seats)) return res.status(400).json({ success: false, error: 'This seat does not exist.' });
      if (!room.free_seats && !canManage(m)) return res.status(403).json({ success: false, error: 'Raise your hand ✋ and wait for the room owner to invite you.' });
      const taken = await pool.query('SELECT 1 FROM party_members WHERE room_id = $1 AND seat = $2 AND user_email <> $3 AND last_seen >= NOW() - ($4 || \' seconds\')::interval', [room.id, seat, e, String(STALE_SEC)]);
      if (taken.rows.length) return res.status(409).json({ success: false, error: 'Somebody is already on this seat.' });
      await pool.query('UPDATE party_members SET seat = NULL WHERE room_id = $1 AND seat = $2', [room.id, seat]);   // somebody who went away
      await pool.query('UPDATE party_members SET seat = $3, hand_at = NULL WHERE room_id = $1 AND user_email = $2', [room.id, e, seat]);
      setTalk(room.id, e, !m.host_muted);
      res.json({ success: true, live: await ticket(room, e, true, m.host_muted) });
    } catch (err) { console.error('[party] seat:', err.message); res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // my ticket again (after my seat or mute changed: the app reconnects with it)
  app.get('/api/party/rooms/:id/ticket', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true });
      const m = await memberOf(room.id, e); if (!m) return res.status(403).json({ success: false });
      res.json({ success: true, live: await ticket(room, e, m.seat !== null, m.host_muted) });
    } catch (err) { res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // owner / helpers: invite to a seat, take off a seat, mute / unmute, remove from the room, make / unmake a helper
  app.post('/api/party/rooms/:id/manage', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true });
      const m = await memberOf(room.id, e);
      if (!canManage(m)) return res.status(403).json({ success: false, error: 'Only the room owner can do this.' });
      // the person is sent as their public id: turn it back into the e-mail ("user" is not one of the keys the id layer reads)
      let who = norm(b.user_email || b.user);
      if (/^1\d{14}$/.test(who)) { try { const mp = await publicIds.toEmails([who]); who = norm(mp.get(who) || who); } catch (e) { /* keep */ } }
      const t = await memberOf(room.id, who);
      if (!t) return res.status(404).json({ success: false, error: 'This person has left the room.' });
      if (t.role === 'owner' || (t.role === 'helper' && m.role !== 'owner')) return res.status(403).json({ success: false, error: 'You can not do this to this person.' });
      const act = String(b.action || '');
      if (act === 'invite') {
        let seat = parseInt(b.seat, 10);
        const used = new Set((await pool.query('SELECT seat FROM party_members WHERE room_id = $1 AND seat IS NOT NULL AND last_seen >= NOW() - ($2 || \' seconds\')::interval', [room.id, String(STALE_SEC)])).rows.map((x) => x.seat));
        if (!(seat >= 1 && seat < room.seats) || used.has(seat)) { seat = -1; for (let i = 1; i < room.seats; i++) if (!used.has(i)) { seat = i; break; } }
        if (seat < 0) return res.status(409).json({ success: false, error: 'All seats are taken.' });
        await pool.query('UPDATE party_members SET seat = NULL WHERE room_id = $1 AND seat = $2', [room.id, seat]);
        await pool.query('UPDATE party_members SET seat = $3, hand_at = NULL WHERE room_id = $1 AND user_email = $2', [room.id, who, seat]);
        setTalk(room.id, who, !t.host_muted);
      } else if (act === 'unseat') {
        await pool.query('UPDATE party_members SET seat = NULL, host_muted = FALSE WHERE room_id = $1 AND user_email = $2', [room.id, who]);
        setTalk(room.id, who, false);
      } else if (act === 'mute' || act === 'unmute') {
        await pool.query('UPDATE party_members SET host_muted = $3 WHERE room_id = $1 AND user_email = $2', [room.id, who, act === 'mute']);
        setTalk(room.id, who, act === 'unmute' && t.seat !== null);
      } else if (act === 'kick') {
        await pool.query('DELETE FROM party_members WHERE room_id = $1 AND user_email = $2', [room.id, who]);
        await pool.query('INSERT INTO party_bans (room_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room.id, who]);
        kickFromLk(room.id, who);
      } else if (act === 'helper' || act === 'unhelper') {
        if (m.role !== 'owner') return res.status(403).json({ success: false, error: 'Only the room owner can do this.' });
        await pool.query('UPDATE party_members SET role = $3 WHERE room_id = $1 AND user_email = $2', [room.id, who, act === 'helper' ? 'helper' : 'member']);
      } else return res.status(400).json({ success: false });
      res.json({ success: true });
    } catch (err) { console.error('[party] manage:', err.message); res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // owner: change the name, who can enter, the number of seats, open / closed seats
  app.post('/api/party/rooms/:id/settings', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open' || norm(room.owner_email) !== e) return res.status(403).json({ success: false, error: 'Only the room owner can do this.' });
      const seats = SEAT_CHOICES.includes(parseInt(b.seats, 10)) ? parseInt(b.seats, 10) : room.seats;
      const privacy = b.privacy === 'friends' ? 'friends' : (b.privacy === 'public' ? 'public' : room.privacy);
      const title = b.title === undefined ? room.title : String(b.title).replace(/\s+/g, ' ').trim().slice(0, 60);
      const free = b.free_seats === undefined ? room.free_seats : !!b.free_seats;
      await pool.query('UPDATE party_rooms SET seats = $2, privacy = $3, title = $4, free_seats = $5 WHERE id = $1', [room.id, seats, privacy, title, free]);
      if (seats < room.seats) {
        const off = await pool.query('UPDATE party_members SET seat = NULL WHERE room_id = $1 AND seat >= $2 RETURNING user_email', [room.id, seats]);
        off.rows.forEach((x) => setTalk(room.id, x.user_email, false));
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  app.post('/api/party/rooms/:id/message', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      const text = String((req.body || {}).text || '').replace(/[​-‍⁠﻿]/g, '').trim().slice(0, 300);
      if (!text) return res.status(400).json({ success: false });
      const m = await memberOf(parseInt(req.params.id, 10) || 0, e);
      if (!m) return res.status(403).json({ success: false, error: 'You are not in this room.' });
      await pool.query("INSERT INTO party_messages (room_id, user_email, kind, text) VALUES ($1, $2, 'text', $3)", [m.room_id, e, text]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  app.post('/api/party/rooms/:id/report', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      await pool.query('INSERT INTO party_reports (room_id, reporter_email, reason) VALUES ($1, $2, $3)', [parseInt(req.params.id, 10) || 0, e, reason]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // ---- Admin › System › 🎉 Party Room ---------------------------------------------------------------------------------
  app.post('/api/admin/party', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      if (b.set && typeof b.set === 'object') {
        if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
        for (const k of ['url', 'key', 'secret']) {
          if (!Object.prototype.hasOwnProperty.call(b.set, k)) continue;
          const v = String(b.set[k] || '').trim().slice(0, 300);
          if (k === 'secret' && v === '') continue;                 // an empty secret box = keep the saved one
          if (k === 'url' && v && !/^wss?:\/\//.test(v)) return res.status(400).json({ success: false, error: 'The LiveKit URL starts with wss://' });
          await pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['party:' + k, v]);
        }
        lkCache = null;
        if (audit) audit(a.adminEmail, 'party-settings', 'settings', 'LiveKit settings changed');
      }
      if (b.close) {
        await closeRoom(parseInt(b.close, 10) || 0, a.adminEmail, 'closed by CamFeed');
        await pool.query('UPDATE party_reports SET handled = TRUE WHERE room_id = $1', [parseInt(b.close, 10) || 0]);
        if (audit) audit(a.adminEmail, 'party-close', String(b.close), String(b.reason || '').slice(0, 200));
      }
      if (b.handled) await pool.query('UPDATE party_reports SET handled = TRUE WHERE room_id = $1', [parseInt(b.handled, 10) || 0]);
      await sweep();
      const c = await lk();
      const rooms = await pool.query(`SELECT r.id, r.title, r.privacy, r.seats, r.created_at, r.owner_email, u.first_name, u.last_name,
          (SELECT COUNT(*) FROM party_members m WHERE m.room_id = r.id) AS people,
          (SELECT COUNT(*) FROM party_reports p WHERE p.room_id = r.id AND p.handled = FALSE) AS reports
        FROM party_rooms r LEFT JOIN users u ON LOWER(u.email) = r.owner_email WHERE r.status = 'open' ORDER BY reports DESC, people DESC LIMIT 200`);
      const reports = await pool.query(`SELECT p.room_id, p.reason, p.created_at, p.reporter_email, r.title, r.status, r.owner_email FROM party_reports p
        LEFT JOIN party_rooms r ON r.id = p.room_id WHERE p.handled = FALSE ORDER BY p.id DESC LIMIT 100`);
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, ready: lkReady(c),
        settings: { url: c.url, key: c.key, secretSet: !!c.secret },
        rooms: rooms.rows, reports: reports.rows });
    } catch (err) { console.error('[party] admin:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  return { closeRoom };
};
