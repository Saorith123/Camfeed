// 🎉 Party Room (phase 1: voice only). Anybody can open a room: public, or friends only. The owner picks 4 / 8 / 12 seats
// (the owner sits on seat 0). People on a seat can talk, everybody else listens. Listeners raise a hand ✋ or, when the
// owner leaves the seats open, simply tap an empty seat. Owner / helpers can mute, take somebody off a seat, or remove them.
//
// The sound itself goes through LiveKit (an SFU), never through this server. The LiveKit address and keys are set by the
// Super Admin in Admin > System > Party Room (saved in creator_settings), or in Render (LIVEKIT_URL / LIVEKIT_API_KEY /
// LIVEKIT_API_SECRET) as a fallback. This file only keeps who is in which room / on which seat, the room chat, and hands out
// LiveKit "tickets" (tokens) that allow talking only to the people who sit on a seat.
const crypto = require('crypto');

module.exports = function installParty({ app, pool, publicIds, adminGate, audit, framesOf }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const SEAT_CHOICES = [4, 8, 12];
  const STALE_SEC = 40;                 // not heard from for this long = gone (the app asks every ~2 s)
  const OWNER_GONE_SEC = 180;           // the owner's phone disappeared for 3 minutes: the room closes
  // the moves the app knows how to draw (the Admin picks one for each action / emote)
  const ACTION_ANIMS = ['fly', 'arc', 'rain', 'burst'];
  const EMOTE_ANIMS = ['pop', 'wave', 'bow', 'shake', 'bounce', 'float', 'sway', 'drip', 'pulse', 'spin'];
  const FX_SEED = [
    ['action', '😘', 'ថើប', 'Kiss', 'arc'], ['action', '❤️', 'ផ្ញើបេះដូង', 'Send a heart', 'rain'], ['action', '🤗', 'ឱប', 'Hug', 'fly'],
    ['action', '👏', 'ទះដៃ', 'Applause', 'burst'], ['action', '🌹', 'បោះផ្កា', 'Throw a rose', 'arc'], ['action', '🥂', 'លើកកែវ', 'Cheers', 'fly'], ['action', '😂', 'សើចដាក់', 'Laugh at', 'burst'],
    ['emote', '👋', 'បាយៗ', 'Bye-bye', 'wave'], ['emote', '🙏', 'សំពះ', 'Sampeah', 'bow'], ['emote', '😂', 'សើច', 'Laugh', 'shake'], ['emote', '😭', 'យំ', 'Cry', 'drip'],
    ['emote', '😍', 'ស្រលាញ់', 'Love', 'float'], ['emote', '😡', 'ខឹង', 'Angry', 'shake'], ['emote', '😴', 'ងងុយ', 'Sleepy', 'float'], ['emote', '💃', 'រាំ', 'Dance', 'sway'],
    ['emote', '🎤', 'ច្រៀង', 'Sing', 'float'], ['emote', '👍', 'ល្អ', 'Nice', 'bounce'], ['emote', '✌️', 'ជ័យជំនះ', 'Victory', 'bounce'], ['emote', '🤔', 'គិត', 'Thinking', 'pulse'],
  ];
  const fxGaps = async () => {
    const m = {};
    try { (await pool.query("SELECT key, value FROM creator_settings WHERE key IN ('party:action_gap', 'party:emote_gap', 'party:seat_sound')")).rows.forEach((r) => { m[r.key] = Number(r.value); }); } catch (e) { /* default */ }
    const ok = (v, d) => (Number.isFinite(v) && v >= 0 && v <= 3600 ? v : d);
    return { actionGap: ok(m['party:action_gap'], 3), emoteGap: ok(m['party:emote_gap'], 2), seatSound: m['party:seat_sound'] !== 0 };
  };
  // the age choices the app shows when opening a room (server side: changing them needs no app update)
  const AGE_CHOICES = { min: [13, 16, 18, 20, 25, 30, 40, 50], max: [17, 20, 25, 30, 35, 40, 50, 60] };
  const ageArg = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 10 && n <= 100 ? n : null; };
  // a person's age from their birthday (null = no birthday saved)
  async function ageOf(email) {
    try {
      const r = await pool.query(`SELECT CASE WHEN CAST(birthdate AS TEXT) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN DATE_PART('year', AGE(CAST(SUBSTRING(CAST(birthdate AS TEXT), 1, 10) AS DATE)))::int END AS a
                                  FROM users WHERE LOWER(email) = $1`, [norm(email)]);
      return r.rows[0] ? r.rows[0].a : null;
    } catch (e) { return null; }
  }
  const ageFits = (room, age) => (room.age_min == null && room.age_max == null) || (age != null && (room.age_min == null || age >= room.age_min) && (room.age_max == null || age <= room.age_max));
  const lastFx = new Map();             // "email|kind" -> time of the last one (spam guard)

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
        // 😘 actions (sent to somebody on a seat) and 😊 emotes (shown on my own seat): all set by the Admin
        await pool.query(`CREATE TABLE IF NOT EXISTS party_fx (
          id SERIAL PRIMARY KEY, kind VARCHAR(10) NOT NULL, emoji VARCHAR(16) NOT NULL, name_km VARCHAR(60) NOT NULL, name_en VARCHAR(60) NOT NULL,
          anim VARCHAR(20) NOT NULL DEFAULT 'pop', coins INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, sort INTEGER NOT NULL DEFAULT 0)`);
        await pool.query('ALTER TABLE party_messages ADD COLUMN IF NOT EXISTS fx_id INTEGER');
        await pool.query('ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS age_min INTEGER');      // who may see the room, by age (empty = everybody)
        await pool.query('ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS age_max INTEGER');
        await pool.query("ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS locked_seats INTEGER[] NOT NULL DEFAULT '{}'");   // 🔒 seats nobody may take
        // ❤️ Follow a room: a person's room is THEIR room (one at a time), so following goes to the owner — it stays when the room
        // closes and opens again (same followers, notified every time it opens)
        await pool.query(`CREATE TABLE IF NOT EXISTS party_follows (owner_email TEXT NOT NULL, user_email TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (owner_email, user_email))`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_party_follows_user ON party_follows (user_email)');
        await pool.query('CREATE TABLE IF NOT EXISTS party_open_notes (owner_email TEXT PRIMARY KEY, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
        // 🎵 music in the room: every phone plays the SAME file itself, in step (the server only says which song and since when);
        // it does not go through the voice line, so it sounds clear and costs nothing more
        for (const col of ['music_id INTEGER', 'music_url TEXT', 'music_title TEXT', 'music_artist TEXT', 'music_at TIMESTAMPTZ', 'music_paused_at TIMESTAMPTZ', 'music_by TEXT'])
          await pool.query(`ALTER TABLE party_rooms ADD COLUMN IF NOT EXISTS ${col}`);
        await pool.query('ALTER TABLE party_members ADD COLUMN IF NOT EXISTS on_phone BOOLEAN NOT NULL DEFAULT FALSE');   // 📞 on a call right now
        // 🤝 people who were in the same room ≥ 10 minutes: "people you met in rooms" (make friends)
        await pool.query(`CREATE TABLE IF NOT EXISTS party_met (user_email TEXT NOT NULL, other_email TEXT NOT NULL, room_id INTEGER, met_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          hidden BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY (user_email, other_email))`);
        const n = await pool.query('SELECT COUNT(*)::int AS n FROM party_fx');
        if (!n.rows[0].n) {
          let i = 0;
          for (const [kind, emoji, km, en, anim] of FX_SEED) await pool.query('INSERT INTO party_fx (kind, emoji, name_km, name_en, anim, sort) VALUES ($1, $2, $3, $4, $5, $6)', [kind, emoji, km, en, anim, i++]);
        }
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
    if (room.privacy === 'friends' && !(await isFriend(room.owner_email, email))) return false;
    if ((room.age_min != null || room.age_max != null) && !ageFits(room, await ageOf(email))) return false;
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
  let sweptAt = 0, metAt = 0;
  async function sweep() {
    if (Date.now() - sweptAt < 10000) return; sweptAt = Date.now();
    try {
      await pool.query(`DELETE FROM party_members m USING party_rooms r WHERE r.id = m.room_id AND m.user_email <> r.owner_email
                        AND m.last_seen < NOW() - ($1 || ' seconds')::interval`, [String(STALE_SEC)]);
      const gone = await pool.query(`SELECT r.id FROM party_rooms r WHERE r.status = 'open' AND NOT EXISTS (
                                       SELECT 1 FROM party_members m WHERE m.room_id = r.id AND m.user_email = r.owner_email AND m.last_seen >= NOW() - ($1 || ' seconds')::interval)`, [String(OWNER_GONE_SEC)]);
      for (const g of gone.rows) await closeRoom(g.id, 'system', 'owner left');
      if (Date.now() - metAt > 60000) {                     // once a minute: who has been together ≥ 10 minutes
        metAt = Date.now();
        await pool.query(`INSERT INTO party_met (user_email, other_email, room_id, met_at)
                          SELECT a.user_email, b.user_email, a.room_id, NOW() FROM party_members a JOIN party_members b ON b.room_id = a.room_id AND b.user_email <> a.user_email
                          WHERE GREATEST(a.joined_at, b.joined_at) < NOW() - INTERVAL '10 minutes'
                            AND a.last_seen >= NOW() - ($1 || ' seconds')::interval AND b.last_seen >= NOW() - ($1 || ' seconds')::interval
                          ON CONFLICT (user_email, other_email) DO UPDATE SET met_at = NOW(), room_id = EXCLUDED.room_id`, [String(STALE_SEC)]);
        await pool.query("DELETE FROM party_met WHERE met_at < NOW() - INTERVAL '30 days'");
      }
      await pool.query("DELETE FROM party_messages WHERE room_id IN (SELECT id FROM party_rooms WHERE status = 'closed' AND closed_at < NOW() - INTERVAL '1 day')");
      await pool.query("DELETE FROM party_bans WHERE room_id IN (SELECT id FROM party_rooms WHERE status = 'closed')");
      await pool.query("DELETE FROM party_rooms WHERE status = 'closed' AND closed_at < NOW() - INTERVAL '30 days' AND id NOT IN (SELECT room_id FROM party_reports WHERE handled = FALSE)");
    } catch (e) { console.error('[party] sweep:', e.message); }
  }

  const userCols = 'u.email, u.first_name, u.last_name, u.profile_pic';
  async function stateOf(room, email, after) {
    const mem = await pool.query(`SELECT m.role, m.seat, m.host_muted, m.hand_at, m.on_phone, ${userCols} FROM party_members m JOIN users u ON LOWER(u.email) = m.user_email
                                  WHERE m.room_id = $1 AND m.last_seen >= NOW() - ($2 || ' seconds')::interval ORDER BY m.seat NULLS LAST, m.joined_at`, [room.id, String(STALE_SEC)]);
    const people = mem.rows.map((x) => ({ email: x.email, first_name: x.first_name, last_name: x.last_name, profile_pic: x.profile_pic || '',
      role: x.role, seat: x.seat, muted: !!x.host_muted, hand: !!x.hand_at, hand_at: x.hand_at, on_phone: !!x.on_phone }));
    const msgs = await pool.query(`SELECT p.id, p.kind, p.text, p.created_at, ${userCols}, p.to_email, t.first_name AS to_first_name, t.last_name AS to_last_name,
                                     g.emoji AS gift_emoji, g.name_km AS gift_km, g.name_en AS gift_en, g.tier AS gift_tier, g.coins AS gift_coins,
                                     f.emoji AS fx_emoji, f.name_km AS fx_km, f.name_en AS fx_en, f.anim AS fx_anim
                                   FROM party_messages p LEFT JOIN users u ON LOWER(u.email) = p.user_email
                                   LEFT JOIN users t ON LOWER(t.email) = p.to_email LEFT JOIN gift_catalog g ON g.id = p.gift_id
                                   LEFT JOIN party_fx f ON f.id = p.fx_id
                                   WHERE p.room_id = $1 AND p.id > $2 ORDER BY p.id DESC LIMIT 60`, [room.id, parseInt(after, 10) || 0]);
    if (people.length) {                                   // ➕ Follow / 💬 message straight from the room (make friends)
      const others = people.map((p) => norm(p.email)).filter((x) => x !== email);
      const f = others.length ? await pool.query(`SELECT LOWER(follower_email) AS a, LOWER(following_email) AS b FROM follows
                                                  WHERE (LOWER(follower_email) = $1 AND LOWER(following_email) = ANY($2)) OR (LOWER(following_email) = $1 AND LOWER(follower_email) = ANY($2))`, [email, others]).catch(() => ({ rows: [] })) : { rows: [] };
      const iF = new Set(f.rows.filter((x) => x.a === email).map((x) => x.b)), fMe = new Set(f.rows.filter((x) => x.b === email).map((x) => x.a));
      for (const p of people) { const k = norm(p.email); p.i_follow = iF.has(k); p.follows_me = fMe.has(k); }
      const fr = framesOf ? await framesOf(people.map((p) => p.email)).catch(() => new Map()) : new Map();   // 🖼️ the frame each one wears
      for (const p of people) { const x = fr.get(norm(p.email)); if (x) p.frame = x; }
    }
    const mine = people.find((p) => norm(p.email) === email) || null;
    const owner = await pool.query(`SELECT ${userCols} FROM users u WHERE LOWER(u.email) = $1`, [room.owner_email]);
    return {
      room: { id: room.id, title: room.title, privacy: room.privacy, seats: room.seats, free_seats: room.free_seats, status: room.status, age_min: room.age_min, age_max: room.age_max, locked_seats: room.locked_seats || [],
        owner: owner.rows[0] || { email: room.owner_email }, created_at: room.created_at,
        followers: await followersOf(room.owner_email), following: await follows(room.owner_email, email),
        music: room.music_url ? { id: room.music_id, url: room.music_url, title: room.music_title || '', artist: room.music_artist || '', at: room.music_at, paused_at: room.music_paused_at || null } : null },
      now: new Date().toISOString(),                         // the server's clock: the phones play the music at the same point
      people,
      me: mine ? { role: mine.role, seat: mine.seat, muted: mine.muted, hand: mine.hand } : null,
      messages: msgs.rows.reverse().map((m) => ({ id: m.id, kind: m.kind, text: m.text, created_at: m.created_at,
        email: m.email || null, first_name: m.first_name || '', last_name: m.last_name || '', profile_pic: m.profile_pic || '',
        ...(m.kind === 'gift' ? { to_email: m.to_email, to_first_name: m.to_first_name || '', to_last_name: m.to_last_name || '',
          gift: { emoji: m.gift_emoji || '🎁', name_km: m.gift_km || '', name_en: m.gift_en || '', tier: m.gift_tier || 1, coins: m.gift_coins || 0 }, count: parseInt(m.text, 10) || 1 } : {}),
        ...((m.kind === 'action' || m.kind === 'emote') ? { to_email: m.to_email || null, to_first_name: m.to_first_name || '', to_last_name: m.to_last_name || '',
          fx: { emoji: m.fx_emoji || '✨', name_km: m.fx_km || '', name_en: m.fx_en || '', anim: m.fx_anim || 'pop' } } : {}) })),
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
  async function followersOf(owner) { const r = await pool.query('SELECT COUNT(*)::int AS n FROM party_follows WHERE owner_email = $1', [norm(owner)]); return r.rows[0] ? r.rows[0].n : 0; }
  async function follows(owner, email) { const r = await pool.query('SELECT 1 FROM party_follows WHERE owner_email = $1 AND user_email = $2', [norm(owner), norm(email)]); return r.rows.length > 0; }

  // the room opened: its followers hear about it (at most once an hour per room, so opening/closing many times never spams)
  async function tellFollowers(room) {
    try {
      const last = await pool.query('SELECT sent_at FROM party_open_notes WHERE owner_email = $1', [room.owner_email]);
      if (last.rows[0] && Date.now() - new Date(last.rows[0].sent_at).getTime() < 60 * 60 * 1000) return;
      await pool.query('INSERT INTO party_open_notes (owner_email, sent_at) VALUES ($1, NOW()) ON CONFLICT (owner_email) DO UPDATE SET sent_at = NOW()', [room.owner_email]);
      const u = await pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email) = $1', [room.owner_email]);
      const name = u.rows[0] ? `${u.rows[0].first_name || ''} ${u.rows[0].last_name || ''}`.trim() : '';
      const title = room.title || name;
      const fs = await pool.query(`SELECT f.user_email FROM party_follows f WHERE f.owner_email = $1
                                    AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (LOWER(b.blocker_email) = f.user_email AND LOWER(b.blocked_email) = $1) OR (LOWER(b.blocker_email) = $1 AND LOWER(b.blocked_email) = f.user_email))
                                    LIMIT 5000`, [room.owner_email]);
      for (const f of fs.rows) {
        if (room.privacy === 'friends' && !(await isFriend(room.owner_email, f.user_email))) continue;
        await pool.query('INSERT INTO notifications (recipient_email, sender_email, type, message, is_read) VALUES ($1, $2, $3, $4, FALSE)',
          [f.user_email, room.owner_email, 'party_open', `🎉 បន្ទប់ "${title}" បើកហើយ — ចូលរួមឥឡូវនេះ!`]).catch(() => {});
      }
    } catch (e) { console.error('[party] tell followers:', e.message); }
  }

  // ---- what the app shows -----------------------------------------------------------------------------------------------
  app.get('/api/party/config', async (req, res) => {
    const c = await lk();
    let myTitle = '', myFollowers = 0;
    if (req.authEmail) {
      try {
        await ensure();
        const t = await pool.query("SELECT title FROM party_rooms WHERE owner_email = $1 AND title <> '' ORDER BY id DESC LIMIT 1", [norm(req.authEmail)]);
        myTitle = t.rows[0] ? t.rows[0].title : '';
        myFollowers = await followersOf(req.authEmail);
      } catch (e) {}
    }
    res.json({ success: true, ready: lkReady(c), seatChoices: SEAT_CHOICES, ageChoices: AGE_CHOICES, myAge: req.authEmail ? await ageOf(req.authEmail) : null, myTitle, myFollowers });
  });

  // the rooms I can enter: friends' rooms first, then the busiest
  app.get('/api/party/rooms', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure(); await sweep();
      const r = await pool.query(`
        SELECT r.id, r.title, r.privacy, r.seats, r.age_min, r.age_max, r.owner_email, r.created_at, ${userCols},
          (SELECT COUNT(*) FROM party_members m WHERE m.room_id = r.id AND m.last_seen >= NOW() - ($2 || ' seconds')::interval) AS people,
          EXISTS (SELECT 1 FROM follows f1 JOIN follows f2 ON f2.follower_email = f1.following_email AND f2.following_email = f1.follower_email
                  WHERE LOWER(f1.follower_email) = $1 AND LOWER(f1.following_email) = r.owner_email) AS friend,
          EXISTS (SELECT 1 FROM follows f WHERE LOWER(f.follower_email) = $1 AND LOWER(f.following_email) = r.owner_email) AS following,
          EXISTS (SELECT 1 FROM party_follows pf WHERE pf.owner_email = r.owner_email AND pf.user_email = $1) AS room_followed,
          (SELECT COUNT(*) FROM party_follows pf WHERE pf.owner_email = r.owner_email) AS followers
        FROM party_rooms r JOIN users u ON LOWER(u.email) = r.owner_email
        WHERE r.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (LOWER(b.blocker_email) = $1 AND LOWER(b.blocked_email) = r.owner_email) OR (LOWER(b.blocker_email) = r.owner_email AND LOWER(b.blocked_email) = $1))
          AND NOT EXISTS (SELECT 1 FROM party_bans pb WHERE pb.room_id = r.id AND pb.user_email = $1)
        ORDER BY (LOWER(r.owner_email) = $1) DESC, 1 DESC LIMIT 300`, [e, String(STALE_SEC)]);
      const myAge = await ageOf(e);
      let rows = r.rows.filter((x) => norm(x.owner_email) === e || ((x.privacy !== 'friends' || x.friend) && ageFits(x, myAge)));
      rows.sort((a, b) => (norm(b.owner_email) === e) - (norm(a.owner_email) === e) || (b.room_followed - a.room_followed) || (b.friend - a.friend) || (b.following - a.following) || (Number(b.people) - Number(a.people)) || (b.id - a.id));
      rows = rows.slice(0, 100);
      // a few faces of the people sitting in each room
      const ids = rows.map((x) => x.id);
      const faces = ids.length ? (await pool.query(`SELECT m.room_id, u.profile_pic FROM party_members m JOIN users u ON LOWER(u.email) = m.user_email
                                                    WHERE m.room_id = ANY($1::int[]) AND m.seat IS NOT NULL AND m.last_seen >= NOW() - ($2 || ' seconds')::interval ORDER BY m.seat`, [ids, String(STALE_SEC)])).rows : [];
      const mineNow = await pool.query(`SELECT m.room_id FROM party_members m JOIN party_rooms r ON r.id = m.room_id WHERE m.user_email = $1 AND r.status = 'open' LIMIT 1`, [e]);
      res.json({ success: true, current: mineNow.rows[0] ? mineNow.rows[0].room_id : null, rooms: rows.map((x) => ({
        id: x.id, title: x.title, privacy: x.privacy, seats: x.seats, people: Number(x.people) || 0, friend: !!x.friend, age_min: x.age_min, age_max: x.age_max,
        followed: !!x.room_followed, followers: Number(x.followers) || 0,
        owner: { email: x.email, first_name: x.first_name, last_name: x.last_name, profile_pic: x.profile_pic || '' },
        faces: faces.filter((f) => f.room_id === x.id).map((f) => f.profile_pic || '').slice(0, 4),
      })) });
    } catch (err) { console.error('[party] rooms:', err.message); res.status(500).json({ success: false, error: 'Could not load the rooms.' }); }
  });

  // 🎵 the owner / a helper plays, pauses, goes on or stops the room's music (a song from the CamFeed library or the sounds they saved)
  app.post('/api/party/rooms/:id/music', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      await ensure();
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true });
      const m = await memberOf(room.id, e);
      if (!canManage(m)) return res.status(403).json({ success: false, error: 'Only the room owner can do this.' });
      const act = String(b.action || '');
      if (act === 'play') {
        const sd = await pool.query(`SELECT s.id, s.title, s.artist, s.audio_url FROM sounds s
                                     WHERE s.id = $1 AND s.active = TRUE AND (s.post_id IS NULL OR EXISTS (SELECT 1 FROM saved_sounds ss WHERE ss.sound_id = s.id AND ss.user_email = $2))`,
                                     [parseInt(b.sound_id, 10) || 0, e]).catch(() => ({ rows: [] }));
        const x = sd.rows[0]; if (!x) return res.status(404).json({ success: false, error: 'This song is not available.' });
        await pool.query('UPDATE party_rooms SET music_id = $2, music_url = $3, music_title = $4, music_artist = $5, music_at = NOW(), music_paused_at = NULL, music_by = $6 WHERE id = $1',
          [room.id, x.id, x.audio_url, x.title || '', x.artist || '', e]);
        pool.query('UPDATE sounds SET uses = uses + 1 WHERE id = $1', [x.id]).catch(() => {});
        sys(room.id, 'music:' + (x.title || ''), e);
      } else if (act === 'pause') {
        await pool.query('UPDATE party_rooms SET music_paused_at = NOW() WHERE id = $1 AND music_url IS NOT NULL AND music_paused_at IS NULL', [room.id]);
      } else if (act === 'resume') {      // the time it was paused does not count
        await pool.query('UPDATE party_rooms SET music_at = music_at + (NOW() - music_paused_at), music_paused_at = NULL WHERE id = $1 AND music_paused_at IS NOT NULL', [room.id]);
      } else if (act === 'stop') {
        await pool.query('UPDATE party_rooms SET music_id = NULL, music_url = NULL, music_title = NULL, music_artist = NULL, music_at = NULL, music_paused_at = NULL WHERE id = $1', [room.id]);
      } else return res.status(400).json({ success: false });
      res.json({ success: true, state: await stateOf(await roomOf(room.id), e, 0) });
    } catch (err) { console.error('[party] music:', err.message); res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // ❤️ follow / unfollow a room (= its owner's room, kept for every time it opens)
  app.post('/api/party/rooms/:id/follow', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const room = await roomOf(req.params.id);
      if (!room) return res.status(404).json({ success: false });
      if (norm(room.owner_email) === e) return res.status(400).json({ success: false, error: 'This is your own room.' });
      const on = (req.body || {}).on !== false;
      if (on) {
        const r = await pool.query('INSERT INTO party_follows (owner_email, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING owner_email', [room.owner_email, e]);
        if (r.rows.length && room.status === 'open') sys(room.id, 'follow', e);           // "X followed the room ❤️" in the room's chat
      } else {
        await pool.query('DELETE FROM party_follows WHERE owner_email = $1 AND user_email = $2', [room.owner_email, e]);
      }
      res.json({ success: true, following: on, followers: await followersOf(room.owner_email) });
    } catch (err) { console.error('[party] follow:', err.message); res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // the rooms I follow: open now (enter) or closed (waiting for the next time)
  // 🤝 people I spent ≥ 10 minutes with in a room (last 30 days), not yet followed by me
  app.get('/api/party/met', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure(); await sweep();
      const r = await pool.query(`
        SELECT ${userCols}, pm.met_at, (SELECT title FROM party_rooms z WHERE z.id = pm.room_id) AS room_title
        FROM party_met pm JOIN users u ON LOWER(u.email) = pm.other_email
        WHERE pm.user_email = $1 AND pm.hidden = FALSE
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE LOWER(f.follower_email) = $1 AND LOWER(f.following_email) = pm.other_email)
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (LOWER(b.blocker_email) = $1 AND LOWER(b.blocked_email) = pm.other_email) OR (LOWER(b.blocker_email) = pm.other_email AND LOWER(b.blocked_email) = $1))
        ORDER BY pm.met_at DESC LIMIT 30`, [e]);
      res.json({ success: true, people: r.rows.map((x) => ({ email: x.email, first_name: x.first_name, last_name: x.last_name, profile_pic: x.profile_pic || '', met_at: x.met_at, room_title: x.room_title || '' })) });
    } catch (err) { console.error('[party] met:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  app.post('/api/party/met/hide', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const who = norm(req.body && (req.body.target_email || ''));
      if (who) await pool.query('UPDATE party_met SET hidden = TRUE WHERE user_email = $1 AND other_email = $2', [e, who]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
  });

  // 📞 I am on a call (CamFeed or phone): the others see 📞 on my seat; my mic is off meanwhile
  app.post('/api/party/rooms/:id/busy', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      await pool.query('UPDATE party_members SET on_phone = $3 WHERE room_id = $1 AND user_email = $2', [parseInt(req.params.id, 10) || 0, e, !!(req.body && req.body.on)]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
  });

  app.get('/api/party/following', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure(); await sweep();
      const r = await pool.query(`
        SELECT pf.owner_email, ${userCols},
          (SELECT COUNT(*) FROM party_follows x WHERE x.owner_email = pf.owner_email) AS followers,
          o.id AS open_id, o.title AS open_title, o.privacy AS open_privacy,
          (SELECT title FROM party_rooms z WHERE z.owner_email = pf.owner_email AND z.title <> '' ORDER BY z.id DESC LIMIT 1) AS last_title,
          (SELECT MAX(COALESCE(z.closed_at, z.created_at)) FROM party_rooms z WHERE z.owner_email = pf.owner_email) AS last_at,
          (SELECT COUNT(*) FROM party_members m WHERE m.room_id = o.id AND m.last_seen >= NOW() - ($2 || ' seconds')::interval) AS people
        FROM party_follows pf JOIN users u ON LOWER(u.email) = pf.owner_email
        LEFT JOIN party_rooms o ON o.owner_email = pf.owner_email AND o.status = 'open'
        WHERE pf.user_email = $1
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (LOWER(b.blocker_email) = $1 AND LOWER(b.blocked_email) = pf.owner_email) OR (LOWER(b.blocker_email) = pf.owner_email AND LOWER(b.blocked_email) = $1))
        ORDER BY (o.id IS NOT NULL) DESC, pf.created_at DESC LIMIT 200`, [e, String(STALE_SEC)]);
      res.json({ success: true, rooms: r.rows.map((x) => ({
        open: !!x.open_id, id: x.open_id || null, title: x.open_title || x.last_title || '', people: Number(x.people) || 0, followers: Number(x.followers) || 0, last_at: x.last_at,
        owner: { email: x.email, first_name: x.first_name, last_name: x.last_name, profile_pic: x.profile_pic || '' } })) });
    } catch (err) { console.error('[party] following:', err.message); res.status(500).json({ success: false, error: 'Could not load the rooms.' }); }
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
      let title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!title) { const lt = await pool.query("SELECT title FROM party_rooms WHERE owner_email = $1 AND title <> '' ORDER BY id DESC LIMIT 1", [e]); if (lt.rows[0]) title = lt.rows[0].title; }   // my room keeps its name
      let amin = ageArg(b.age_min), amax = ageArg(b.age_max);
      if (amin != null && amax != null && amin > amax) [amin, amax] = [amax, amin];
      const old = await pool.query("SELECT id FROM party_rooms WHERE owner_email = $1 AND status = 'open'", [e]);
      for (const o of old.rows) await closeRoom(o.id, e, 'new room');
      await pool.query('DELETE FROM party_members WHERE user_email = $1', [e]);   // I can only be in one room at a time
      const r = await pool.query('INSERT INTO party_rooms (owner_email, title, privacy, seats, age_min, age_max) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [e, title, privacy, seats, amin, amax]);
      const room = r.rows[0];
      await pool.query("INSERT INTO party_members (room_id, user_email, role, seat) VALUES ($1, $2, 'owner', 0)", [room.id, e]);
      res.json({ success: true, id: room.id, live: await ticket(room, e, true, false), state: await stateOf(room, e, 0) });
      tellFollowers(room);                                     // after answering: the owner never waits for this
    } catch (err) { console.error('[party] create:', err.message); res.status(500).json({ success: false, error: 'Could not open the room.' }); }
  });

  app.post('/api/party/rooms/:id/join', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true, error: 'This room has ended.' });
      if (!(await canSee(room, e))) {
        const ageLocked = room.age_min != null || room.age_max != null;
        const noBd = ageLocked && (await ageOf(e)) == null;
        return res.status(403).json({ success: false, code: ageLocked ? 'age' : 'private', noBirthday: noBd, age_min: room.age_min, age_max: room.age_max,
          message: ageLocked ? (noBd ? 'age:nobirthday' : 'age:' + (room.age_min || '') + '-' + (room.age_max || '')) : 'private', error: 'You can not enter this room.' });
      }
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
      if (m.role === 'owner') return res.status(400).json({ success: false, code: 'owner', error: 'The owner stays on the first seat.' });
      if ((room.locked_seats || []).includes(seat)) return res.status(403).json({ success: false, code: 'locked', message: 'locked', error: 'This seat is locked.' });
      const moving = m.seat !== null;          // already on a seat: just moving to another one (the voice keeps going)
      if (!moving && !room.free_seats && !canManage(m)) return res.status(403).json({ success: false, error: 'Raise your hand ✋ and wait for the room owner to invite you.' });
      const taken = await pool.query('SELECT 1 FROM party_members WHERE room_id = $1 AND seat = $2 AND user_email <> $3 AND last_seen >= NOW() - ($4 || \' seconds\')::interval', [room.id, seat, e, String(STALE_SEC)]);
      if (taken.rows.length) return res.status(409).json({ success: false, error: 'Somebody is already on this seat.' });
      await pool.query('UPDATE party_members SET seat = NULL WHERE room_id = $1 AND seat = $2', [room.id, seat]);   // somebody who went away
      await pool.query('UPDATE party_members SET seat = $3, hand_at = NULL WHERE room_id = $1 AND user_email = $2', [room.id, e, seat]);
      setTalk(room.id, e, !m.host_muted);
      res.json({ success: true, live: await ticket(room, e, true, m.host_muted) });
    } catch (err) { console.error('[party] seat:', err.message); res.status(500).json({ success: false, error: 'Network problem.' }); }
  });

  // 🔒 owner / helpers: lock or unlock one seat (a locked seat can not be taken, even by an invitation)
  app.post('/api/party/rooms/:id/lock', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true });
      const m = await memberOf(room.id, e);
      if (!canManage(m)) return res.status(403).json({ success: false, error: 'Only the room owner can do this.' });
      const seat = parseInt(b.seat, 10);
      if (!(seat >= 1 && seat < 12)) return res.status(400).json({ success: false });
      if (b.locked) await pool.query('UPDATE party_rooms SET locked_seats = ARRAY(SELECT DISTINCT UNNEST(array_append(locked_seats, $2))) WHERE id = $1', [room.id, seat]);
      else await pool.query('UPDATE party_rooms SET locked_seats = array_remove(locked_seats, $2) WHERE id = $1', [room.id, seat]);
      res.json({ success: true });
    } catch (err) { console.error('[party] lock:', err.message); res.status(500).json({ success: false }); }
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
      // the person: "target_email" (the id layer turns the public id back into the e-mail). Never "user_email" / "email":
      // the login layer overwrites those with the person who is asking (auth.js BODY_ACTOR_FIELDS).
      let who = norm(b.target_email || b.user);
      if (/^1\d{14}$/.test(who)) { try { const mp = await publicIds.toEmails([who]); who = norm(mp.get(who) || who); } catch (e) { /* keep */ } }
      const t = await memberOf(room.id, who);
      if (!t) return res.status(404).json({ success: false, error: 'This person has left the room.' });
      if (t.role === 'owner' || (t.role === 'helper' && m.role !== 'owner')) return res.status(403).json({ success: false, error: 'You can not do this to this person.' });
      const act = String(b.action || '');
      if (act === 'invite') {
        let seat = parseInt(b.seat, 10);
        const used = new Set((await pool.query('SELECT seat FROM party_members WHERE room_id = $1 AND seat IS NOT NULL AND last_seen >= NOW() - ($2 || \' seconds\')::interval', [room.id, String(STALE_SEC)])).rows.map((x) => x.seat));
        (room.locked_seats || []).forEach((x) => used.add(x));          // a locked seat is never given
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
      let amin = b.age_min === undefined ? room.age_min : ageArg(b.age_min), amax = b.age_max === undefined ? room.age_max : ageArg(b.age_max);
      if (amin != null && amax != null && amin > amax) [amin, amax] = [amax, amin];
      await pool.query('UPDATE party_rooms SET seats = $2, privacy = $3, title = $4, free_seats = $5, age_min = $6, age_max = $7 WHERE id = $1', [room.id, seats, privacy, title, free, amin, amax]);
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

  // the actions / emotes the app shows, and how often one person may send them (all from the Admin panel)
  app.get('/api/party/fx', async (req, res) => {
    try {
      await ensure();
      const r = await pool.query('SELECT id, kind, emoji, name_km, name_en, anim, coins FROM party_fx WHERE active = TRUE ORDER BY sort, id');
      res.json(Object.assign({ success: true, actions: r.rows.filter((x) => x.kind === 'action'), emotes: r.rows.filter((x) => x.kind === 'emote') }, await fxGaps()));
    } catch (err) { res.status(500).json({ success: false }); }
  });

  // 😘 send an action to somebody on a seat, or 😊 show an emote on my own seat
  app.post('/api/party/rooms/:id/fx', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      await ensure();
      const room = await roomOf(req.params.id);
      if (!room || room.status !== 'open') return res.status(404).json({ success: false, closed: true });
      const f = (await pool.query('SELECT * FROM party_fx WHERE id = $1 AND active = TRUE', [parseInt(b.fx_id, 10) || 0])).rows[0];
      if (!f) return res.status(400).json({ success: false, code: 'fx' });
      const m = await memberOf(room.id, e);
      if (!m) return res.status(403).json({ success: false });
      let to = null;
      if (f.kind === 'emote') {
        if (m.seat === null) return res.status(403).json({ success: false, code: 'seat', error: 'Sit on a seat first.' });
      } else {
        to = norm(b.target_email);
        if (/^1\d{14}$/.test(to)) { try { const mp = await publicIds.toEmails([to]); to = norm(mp.get(to) || to); } catch (x) { /* keep */ } }
        const t = to && to !== e ? await memberOf(room.id, to) : null;
        if (!t || t.seat === null) return res.status(404).json({ success: false, code: 'gone' });
      }
      const gaps = await fxGaps();
      const gap = (f.kind === 'emote' ? gaps.emoteGap : gaps.actionGap) * 1000;
      const k = e + '|' + f.kind, now = Date.now();
      if (gap > 0 && now - (lastFx.get(k) || 0) < gap) return res.status(429).json({ success: false, code: 'wait', wait: Math.ceil((gap - (now - lastFx.get(k))) / 1000) });
      if (f.coins > 0) {
        // a paid one: take the coins (all of it stays with CamFeed)
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['coins:' + e]);
          const have = (await c.query('SELECT COALESCE(SUM(coins), 0)::int AS n FROM coin_ledger WHERE user_email = $1', [e])).rows[0].n;
          if (have < f.coins) { await c.query('ROLLBACK'); c.release(); return res.status(402).json({ success: false, code: 'coins' }); }
          await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'fx', $3, $4, $1)", [e, -f.coins, f.kind + ' ' + f.name_en, f.id]);
          await c.query('COMMIT'); c.release();
        } catch (x) { try { await c.query('ROLLBACK'); } catch (y) { /* nothing */ } c.release(); throw x; }
      }
      lastFx.set(k, now);
      if (lastFx.size > 20000) lastFx.clear();
      await pool.query('INSERT INTO party_messages (room_id, user_email, kind, text, to_email, fx_id) VALUES ($1, $2, $3, $4, $5, $6)', [room.id, e, f.kind, f.emoji, to, f.id]);
      res.json({ success: true });
    } catch (err) { console.error('[party] fx:', err.message); res.status(500).json({ success: false }); }
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
      if (b.fx && typeof b.fx === 'object') {
        if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
        const f = b.fx, kind = f.kind === 'emote' ? 'emote' : 'action';
        const emoji = String(f.emoji || '').trim().slice(0, 16), km = String(f.name_km || '').trim().slice(0, 60), en = String(f.name_en || '').trim().slice(0, 60);
        const anims = kind === 'emote' ? EMOTE_ANIMS : ACTION_ANIMS;
        const anim = anims.includes(f.anim) ? f.anim : anims[0];
        const coins = Math.max(0, Math.min(parseInt(f.coins, 10) || 0, 1000000)), sort = parseInt(f.sort, 10) || 0;
        if (!emoji || !km || !en) return res.status(400).json({ success: false, error: 'Fill in the emoji and both names.' });
        if (f.id) await pool.query('UPDATE party_fx SET emoji = $2, name_km = $3, name_en = $4, anim = $5, coins = $6, active = $7, sort = $8 WHERE id = $1', [parseInt(f.id, 10), emoji, km, en, anim, coins, f.active !== false, sort]);
        else await pool.query('INSERT INTO party_fx (kind, emoji, name_km, name_en, anim, coins, sort) VALUES ($1, $2, $3, $4, $5, $6, $7)', [kind, emoji, km, en, anim, coins, sort || 999]);
        if (audit) audit(a.adminEmail, 'party-fx', String(f.id || 'new'), kind + ' ' + en + (f.active === false ? ' (off)' : ''));
      }
      if (b.gaps && typeof b.gaps === 'object') {
        if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
        if (b.gaps.seatSound !== undefined) await pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['party:seat_sound', b.gaps.seatSound ? '1' : '0']);
        for (const [k, key] of [['actionGap', 'party:action_gap'], ['emoteGap', 'party:emote_gap']]) {
          if (b.gaps[k] === undefined) continue;
          const v = Number(b.gaps[k]);
          if (!(v >= 0 && v <= 3600)) return res.status(400).json({ success: false, error: 'Seconds must be 0 to 3600.' });
          await pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, String(v)]);
        }
      }
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
        rooms: rooms.rows, reports: reports.rows,
        fx: (await pool.query('SELECT * FROM party_fx ORDER BY kind, sort, id')).rows, gaps: await fxGaps(), anims: { action: ACTION_ANIMS, emote: EMOTE_ANIMS } });
    } catch (err) { console.error('[party] admin:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  return { closeRoom };
};
