// Chat extras: per-chat settings (background, quick emoji, bubble colour, auto-delete, mute),
// message reactions, auto-delete sweeper, and 1-to-1 voice/video call signalling.
// Calls live in memory only (they last seconds/minutes), so polling costs no database work.
'use strict';

const EMOJI_RE = /^[\p{Extended_Pictographic}‍️⃣\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}]{1,12}$/u;
const THEMES = ['', 'blue', 'green', 'rose', 'orange', 'purple', 'teal', 'dark'];
const TTL_OPTIONS = [0, 24, 168, 720, 4380, 8760];       // hours: off, 24h, 7d, 30d, 6mo, 12mo
const CALL_RING_MS = 35 * 1000;
const CALL_STALE_MS = 25 * 1000;

module.exports = function installChatExtras({ app, pool, cleanup, extractMediaUrls, mediaBase, fetchFn, push }) {
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  const maxMonths = Math.max(1, parseInt(process.env.CHAT_MAX_MONTHS || '12', 10) || 12);
  const maxHours = maxMonths * 730;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const isGroupKey = (k) => /^group:\d+$/.test(norm(k));
  const pairOf = (a, b) => {
    a = norm(a); b = norm(b);
    if (isGroupKey(a) || isGroupKey(b)) { const g = isGroupKey(a) ? a : b; return [g, g]; }
    return a < b ? [a, b] : [b, a];
  };
  const maxMembers = Math.max(3, parseInt(process.env.GROUP_MAX_MEMBERS || '50', 10) || 50);
  let ready = null;

  function ensureSchema() {
    if (ready) return ready;
    ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS chat_settings (
        user_a VARCHAR(255) NOT NULL, user_b VARCHAR(255) NOT NULL,
        bg TEXT DEFAULT '', emoji VARCHAR(40) DEFAULT '', theme VARCHAR(20) DEFAULT '',
        ttl_hours INTEGER DEFAULT 0, ttl_since TIMESTAMP DEFAULT NULL,
        updated_by VARCHAR(255), updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_a, user_b))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS chat_mutes (
        user_email VARCHAR(255) NOT NULL, peer_email VARCHAR(255) NOT NULL, PRIMARY KEY (user_email, peer_email))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER NOT NULL, user_email VARCHAR(255) NOT NULL, emoji VARCHAR(40) NOT NULL,
        PRIMARY KEY (message_id, user_email))`);
      await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to INTEGER DEFAULT NULL');
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_limit VARCHAR(12) DEFAULT ''");
      await pool.query(`CREATE TABLE IF NOT EXISTS chat_groups (
        id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, pic TEXT DEFAULT '', created_by VARCHAR(255), created_at TIMESTAMP DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS chat_group_members (
        group_id INTEGER NOT NULL, user_email VARCHAR(255) NOT NULL, role VARCHAR(10) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT NOW(), last_read_id INTEGER DEFAULT 0, PRIMARY KEY (group_id, user_email))`);
      await pool.query('CREATE INDEX IF NOT EXISTS chat_group_members_user_idx ON chat_group_members (user_email)').catch(() => {});
      await pool.query(`CREATE TABLE IF NOT EXISTS group_messages (
        id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL, sender_email VARCHAR(255) NOT NULL, message TEXT,
        media_url TEXT, message_type VARCHAR(20) DEFAULT 'text', reply_to INTEGER DEFAULT NULL, created_at TIMESTAMP DEFAULT NOW())`);
      await pool.query('CREATE INDEX IF NOT EXISTS group_messages_group_idx ON group_messages (group_id, id)').catch(() => {});
      await pool.query(`CREATE TABLE IF NOT EXISTS group_reactions (
        message_id INTEGER NOT NULL, user_email VARCHAR(255) NOT NULL, emoji VARCHAR(40) NOT NULL, PRIMARY KEY (message_id, user_email))`);
      await pool.query('CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at)').catch(() => {});
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  // Admin can restrict a person: 'reply_only' = may answer people who wrote first but never start a chat / group / call;
  // 'banned' = may not send chat messages or make calls at all.
  const RESTRICT = {
    banned: { code: 'chat_restricted', error: '🚫 គណនីរបស់អ្នកត្រូវបានក្រុមការងារ CamFeed រឹតត្បិតមិនឱ្យជជែក ឬហៅ។ បើមានចម្ងល់ សូមទាក់ទងផ្នែកជំនួយ។' },
    reply: { code: 'chat_restricted', error: '⚠️ អ្នកមិនអាចចាប់ផ្តើមជជែកជាមួយអ្នកផ្សេងមុនបានទេ។ អ្នកអាចឆ្លើយតបបានតែពេលគេផ្ញើសារមកអ្នកមុន។' }
  };
  async function chatAllowed(from, to, opts) {
    try {
      await ensureSchema();
      const r = await pool.query('SELECT chat_limit FROM users WHERE LOWER(email)=LOWER($1)', [from]);
      const lim = (r.rows[0] && r.rows[0].chat_limit) || '';
      if (!lim) return null;
      if (lim === 'banned') return RESTRICT.banned;
      if (lim === 'reply_only' && !(opts && opts.post)) {
        if (!to) return RESTRICT.reply;
        const h = await pool.query("SELECT 1 FROM messages WHERE LOWER(sender_email)=LOWER($1) AND LOWER(receiver_email)=LOWER($2) AND message_type NOT IN ('system','call') LIMIT 1", [to, from]);
        if (!h.rows.length) return RESTRICT.reply;
      }
      return null;
    } catch (e) { return null; }
  }
  const deny = (res, d) => res.status(403).json(Object.assign({ success: false }, d));

  async function settingsFor(me, peer) {
    await ensureSchema();
    const [a, b] = pairOf(me, peer);
    const s = await pool.query('SELECT bg, emoji, theme, ttl_hours, ttl_since FROM chat_settings WHERE user_a=$1 AND user_b=$2', [a, b]);
    const m = await pool.query('SELECT 1 FROM chat_mutes WHERE user_email=$1 AND peer_email=$2', [norm(me), norm(peer)]);
    const r = s.rows[0] || {};
    return { bg: r.bg || '', emoji: r.emoji || '', theme: r.theme || '', ttl_hours: r.ttl_hours || 0, muted: m.rows.length > 0, maxMonths };
  }

  async function reactionsFor(ids) {
    if (!ids.length) return {};
    await ensureSchema();
    const r = await pool.query('SELECT message_id, user_email, emoji FROM message_reactions WHERE message_id = ANY($1::int[])', [ids]);
    const out = {};
    r.rows.forEach((x) => { (out[x.message_id] = out[x.message_id] || []).push({ user_email: x.user_email, e: x.emoji }); });
    return out;
  }

  async function systemNote(by, peer, text) {
    if (isGroupKey(peer)) {
      await pool.query("INSERT INTO group_messages (group_id, sender_email, message, message_type) VALUES ($1,$2,$3,'system')", [parseInt(norm(peer).slice(6), 10), norm(by), text]).catch(() => {});
      return;
    }
    await pool.query("INSERT INTO messages (sender_email, receiver_email, message, message_type, is_read) VALUES ($1,$2,$3,'system',TRUE)", [by, peer, text]).catch(() => {});
  }

  const nameOf = async (email) => {
    const r = await pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email)=LOWER($1)', [email]).catch(() => ({ rows: [] }));
    const u = r.rows[0] || {};
    return `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'មិត្តភក្តិ';
  };

  // ---------- settings ----------
  app.get('/api/chat-settings', async (req, res) => {
    const me = req.authEmail; const peer = String(req.query.peer_email || req.query.peer || '');
    if (!me || !peer) return res.status(400).json({ success: false });
    try {
      if (isGroupKey(peer) && !(await memberOf(parseInt(norm(peer).slice(6), 10), me))) return res.status(403).json({ success: false }); res.json({ success: true, settings: await settingsFor(me, peer) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/chat-settings', async (req, res) => {
    const me = req.authEmail; const body = req.body || {}; const peer = String(body.peer_email || body.peer || '');
    if (!me || !peer || norm(me) === norm(peer)) return res.status(400).json({ success: false });
    try {
      await ensureSchema();
      if (isGroupKey(peer)) {
        if (!(await memberOf(parseInt(norm(peer).slice(6), 10), me))) return res.status(403).json({ success: false, error: 'Not a member' });
      } else {
        const blk = await pool.query('SELECT 1 FROM blocked_users WHERE (blocker_email=$1 AND blocked_email=$2) OR (blocker_email=$2 AND blocked_email=$1)', [me, peer]);
        if (blk.rows.length) return res.status(403).json({ success: false, error: 'Blocked' });
      }
      const [a, b] = pairOf(me, peer);
      const cur = await settingsFor(me, peer);
      const next = { bg: cur.bg, emoji: cur.emoji, theme: cur.theme, ttl_hours: cur.ttl_hours };
      const notes = [];
      const who = await nameOf(me);

      if (body.bg !== undefined) {
        const bg = String(body.bg || '');
        if (bg && !/^g[1-9]$/.test(bg) && !(bg.startsWith(mediaBase()) && bg.length < 500)) return res.status(400).json({ success: false, error: 'bad bg' });
        if (bg !== cur.bg) { next.bg = bg; notes.push(`🖼️ ${who} បានប្តូរផ្ទៃខាងក្រោយឆាត`); }
      }
      if (body.emoji !== undefined) {
        const em = String(body.emoji || '');
        if (em && !EMOJI_RE.test(em)) return res.status(400).json({ success: false, error: 'bad emoji' });
        if (em !== cur.emoji) { next.emoji = em; notes.push(`${em || '👍'} ${who} បានប្តូរអ៊ីម៉ូជីរហ័សទៅជា ${em || '👍'}`); }
      }
      if (body.theme !== undefined) {
        const th = String(body.theme || '');
        if (!THEMES.includes(th)) return res.status(400).json({ success: false, error: 'bad theme' });
        if (th !== cur.theme) { next.theme = th; notes.push(`🎨 ${who} បានប្តូរពណ៌ឆាត`); }
      }
      let setSince = false;
      if (body.ttl_hours !== undefined) {
        const t = parseInt(body.ttl_hours, 10) || 0;
        if (!TTL_OPTIONS.includes(t) || t > maxHours) return res.status(400).json({ success: false, error: 'bad ttl' });
        if (t !== cur.ttl_hours) {
          next.ttl_hours = t; setSince = true;
          const label = { 0: 'បិទ (ប្រើកំណត់របស់ប្រព័ន្ធ)', 24: '២៤ ម៉ោង', 168: '៧ ថ្ងៃ', 720: '១ ខែ', 4380: '៦ ខែ', 8760: '១២ ខែ' }[t];
          notes.push(t ? `⏳ ${who} បានកំណត់លុបសារស្វ័យប្រវត្តិ៖ ${label} (សម្រាប់សារថ្មីចាប់ពីពេលនេះ)` : `⏳ ${who} បានបិទការលុបសារស្វ័យប្រវត្តិរបស់ឆាតនេះ`);
        }
      }
      await pool.query(
        `INSERT INTO chat_settings (user_a,user_b,bg,emoji,theme,ttl_hours,ttl_since,updated_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,${setSince ? 'NOW()' : 'NULL'},$7,NOW())
         ON CONFLICT (user_a,user_b) DO UPDATE SET bg=$3, emoji=$4, theme=$5, ttl_hours=$6,
           ttl_since=${setSince ? 'NOW()' : 'chat_settings.ttl_since'}, updated_by=$7, updated_at=NOW()`,
        [a, b, next.bg, next.emoji, next.theme, next.ttl_hours, norm(me)]);
      if (body.bg !== undefined && cur.bg && cur.bg !== next.bg && cur.bg.startsWith(mediaBase())) cleanup.purgeMediaUrls([cur.bg]).catch(() => {});
      for (const n of notes) await systemNote(me, peer, n);

      if (body.muted !== undefined) {
        if (body.muted) await pool.query('INSERT INTO chat_mutes (user_email, peer_email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [norm(me), norm(peer)]);
        else await pool.query('DELETE FROM chat_mutes WHERE user_email=$1 AND peer_email=$2', [norm(me), norm(peer)]);
      }
      res.json({ success: true, settings: await settingsFor(me, peer) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- reactions ----------
  app.post('/api/messages/:id/react', async (req, res) => {
    const me = req.authEmail; const id = parseInt(req.params.id, 10);
    const emoji = String((req.body || {}).emoji || '');
    if (!me || !id || (emoji && !EMOJI_RE.test(emoji))) return res.status(400).json({ success: false });
    try {
      await ensureSchema();
      const m = await pool.query('SELECT sender_email, receiver_email FROM messages WHERE id=$1', [id]);
      const row = m.rows[0];
      if (!row || (norm(row.sender_email) !== norm(me) && norm(row.receiver_email) !== norm(me))) return res.status(403).json({ success: false });
      const cur = await pool.query('SELECT emoji FROM message_reactions WHERE message_id=$1 AND user_email=$2', [id, norm(me)]);
      if (!emoji || (cur.rows[0] && cur.rows[0].emoji === emoji)) {
        await pool.query('DELETE FROM message_reactions WHERE message_id=$1 AND user_email=$2', [id, norm(me)]);
      } else {
        await pool.query('INSERT INTO message_reactions (message_id,user_email,emoji) VALUES ($1,$2,$3) ON CONFLICT (message_id,user_email) DO UPDATE SET emoji=$3', [id, norm(me), emoji]);
      }
      res.json({ success: true, reactions: (await reactionsFor([id]))[id] || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- auto-delete sweeper ----------
  async function purgeRows(rows) {
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);
    await pool.query('DELETE FROM message_reactions WHERE message_id = ANY($1::int[])', [ids]).catch(() => {});
    const urls = [];
    rows.forEach((r) => { if (r.media_url) urls.push(...extractMediaUrls(r.media_url)); });
    if (urls.length) await cleanup.purgeMediaUrls(urls).catch(() => {});
  }

  async function purgeGroupRows(rows) {
    if (!rows.length) return;
    await pool.query('DELETE FROM group_reactions WHERE message_id = ANY($1::int[])', [rows.map((r) => r.id)]).catch(() => {});
    const urls = [];
    rows.forEach((r) => { if (r.media_url) urls.push(...extractMediaUrls(r.media_url)); });
    if (urls.length) await cleanup.purgeMediaUrls(urls).catch(() => {});
  }

  async function sweepChats() {
    try {
      await ensureSchema();
      let total = 0;
      for (let i = 0; i < 40; i++) {          // small batches so the server never stalls
        const d = await pool.query(
          `DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at < NOW() - make_interval(hours => $1) LIMIT 300) RETURNING id, media_url`, [maxHours]);
        await purgeRows(d.rows); total += d.rows.length;
        if (d.rows.length < 300) break;
      }
      for (let i = 0; i < 40; i++) {
        const d = await pool.query(
          `DELETE FROM messages WHERE id IN (
             SELECT m.id FROM messages m
             JOIN chat_settings s ON s.user_a = LEAST(LOWER(m.sender_email), LOWER(m.receiver_email)) AND s.user_b = GREATEST(LOWER(m.sender_email), LOWER(m.receiver_email))
             WHERE s.ttl_hours > 0 AND s.ttl_since IS NOT NULL AND m.created_at >= s.ttl_since
               AND m.created_at < NOW() - (s.ttl_hours * INTERVAL '1 hour') LIMIT 300) RETURNING id, media_url`);
        await purgeRows(d.rows); total += d.rows.length;
        if (d.rows.length < 300) break;
      }
      for (let i = 0; i < 40; i++) {
        const d = await pool.query(`DELETE FROM group_messages WHERE id IN (SELECT id FROM group_messages WHERE created_at < NOW() - make_interval(hours => $1) LIMIT 300) RETURNING id, media_url`, [maxHours]);
        await purgeGroupRows(d.rows); total += d.rows.length;
        if (d.rows.length < 300) break;
      }
      for (let i = 0; i < 40; i++) {
        const d = await pool.query(
          `DELETE FROM group_messages WHERE id IN (
             SELECT gm.id FROM group_messages gm JOIN chat_settings s ON s.user_a = 'group:' || gm.group_id
             WHERE s.ttl_hours > 0 AND s.ttl_since IS NOT NULL AND gm.created_at >= s.ttl_since
               AND gm.created_at < NOW() - (s.ttl_hours * INTERVAL '1 hour') LIMIT 300) RETURNING id, media_url`);
        await purgeGroupRows(d.rows); total += d.rows.length;
        if (d.rows.length < 300) break;
      }
      if (total) console.log(`[chat] auto-deleted ${total} messages`);
    } catch (e) { console.error('[chat] sweep error:', e.message); }
  }

  // ---------- calls (in memory) ----------
  const calls = new Map();
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const involved = (c, me) => c && (c.caller === norm(me) || c.callee === norm(me));
  const live = (c) => c.status === 'ringing' || c.status === 'accepted';
  const busyWith = (email) => { for (const c of calls.values()) if (live(c) && (c.caller === email || c.callee === email)) return c; return null; };

  async function logCall(c, result) {
    const secs = c.answeredAt ? Math.max(0, Math.round((Date.now() - c.answeredAt) / 1000)) : 0;
    await pool.query("INSERT INTO messages (sender_email, receiver_email, message, message_type, is_read) VALUES ($1,$2,$3,'call',$4)",
      [c.caller, c.callee, `CALL:${result}:${c.kind}:${secs}`, result === 'ended']).catch(() => {});
  }
  function finish(c, status, result) {
    if (!live(c)) return;
    c.status = status; c.endedAt = Date.now();
    logCall(c, result);
  }

  app.get('/api/calls/ice', async (req, res) => {
    if (!req.authEmail) return res.status(401).json({ success: false });
    const servers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
    const keyId = process.env.CF_TURN_KEY_ID, tok = process.env.CF_TURN_API_TOKEN;
    if (keyId && tok && f) {
      try {
        const r = await f(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
          method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 7200 }) });
        const j = await r.json();
        if (j && Array.isArray(j.iceServers)) servers.push(...j.iceServers);
      } catch (e) { console.error('[call] TURN error:', e.message); }
    }
    res.json({ success: true, iceServers: servers, turn: servers.length > 1 });
  });

  app.post('/api/calls/start', async (req, res) => {
    const me = norm(req.authEmail); const b = req.body || {}; const peer = norm(b.peer_email || b.peer);
    const kind = b.kind === 'video' ? 'video' : 'audio';
    if (!me || !peer || me === peer || typeof b.offer !== 'string' || b.offer.length > 20000) return res.status(400).json({ success: false });
    try {
      const blk = await pool.query('SELECT 1 FROM blocked_users WHERE (LOWER(blocker_email)=$1 AND LOWER(blocked_email)=$2) OR (LOWER(blocker_email)=$2 AND LOWER(blocked_email)=$1)', [me, peer]);
      if (blk.rows.length) return res.status(403).json({ success: false, error: 'blocked' });
      const lim = await chatAllowed(me, peer); if (lim) return deny(res, lim);
      const mine = busyWith(me); if (mine) finish(mine, 'ended', mine.status === 'ringing' ? 'cancelled' : 'ended');
      if (busyWith(peer)) return res.json({ success: false, error: 'busy' });
      const c = { id: newId(), caller: me, callee: peer, kind, status: 'ringing', offer: b.offer, answer: null,
        ice: { caller: [], callee: [] }, created: Date.now(), answeredAt: 0, seen: { [me]: Date.now(), [peer]: 0 } };
      calls.set(c.id, c);
      if (push && push.notifyCall) push.notifyCall(peer, me, kind, c.id);   // ring the phone even if the app is closed
      res.json({ success: true, id: c.id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/calls/poll', async (req, res) => {
    const me = norm(req.authEmail); if (!me) return res.json({ success: true });
    for (const c of calls.values()) {
      if (c.callee === me && c.status === 'ringing') {
        const u = await pool.query('SELECT first_name, last_name, profile_pic FROM users WHERE LOWER(email)=LOWER($1)', [c.caller]).catch(() => ({ rows: [] }));
        const p = u.rows[0] || {};
        return res.json({ success: true, incoming: { id: c.id, kind: c.kind, from_email: c.caller, name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), pic: p.profile_pic || '', offer: c.offer } });
      }
    }
    res.json({ success: true });
  });

  app.get('/api/calls/:callId', (req, res) => {
    const me = norm(req.authEmail); const c = calls.get(req.params.callId);
    if (!involved(c, me)) return res.status(404).json({ success: false });
    c.seen[me] = Date.now();
    const role = c.caller === me ? 'caller' : 'callee';
    const other = role === 'caller' ? 'callee' : 'caller';
    const since = Math.max(0, parseInt(req.query.ic, 10) || 0);
    const neg = {};
    if (c.negOffer && c.negBy !== me) neg.offer = c.negOffer;            // the other side wants to renegotiate (adds video)
    if (c.negAns && c.negBy === me) neg.answer = c.negAns;
    const peerCam = c.cam && c.cam[other] !== undefined ? c.cam[other] : null;
    res.json({ success: true, status: c.status, why: c.why || '', kind: c.kind, peerCam,
      v: c.v ? { by: c.v.by === c.caller ? 'caller' : 'callee', mine: c.v.by === me, state: c.v.state } : null, neg: Object.keys(neg).length ? Object.assign(neg, { seq: c.negSeq || 0 }) : null, answer: role === 'caller' ? c.answer : null,
      ice: c.ice[other].slice(since), icTotal: c.ice[other].length, answeredAt: c.answeredAt });
  });

  app.post('/api/calls/:callId/answer', (req, res) => {
    const me = norm(req.authEmail); const c = calls.get(req.params.callId);
    const answer = (req.body || {}).answer;
    if (!c) return res.status(404).json({ success: false, why: 'ans-notfound' });
    if (c.callee !== me) return res.status(400).json({ success: false, why: 'ans-notcallee' });
    if (c.status !== 'ringing') return res.status(400).json({ success: false, why: 'ans-status-' + c.status + (c.why ? '-' + c.why : '') });
    if (typeof answer !== 'string' || answer.length > 60000) return res.status(400).json({ success: false, why: 'ans-bad' });
    c.answer = answer; c.status = 'accepted'; c.answeredAt = Date.now(); c.seen[me] = Date.now(); c.seen[c.caller] = Date.now();
    res.json({ success: true });
  });

  app.post('/api/calls/:callId/ice', (req, res) => {
    const me = norm(req.authEmail); const c = calls.get(req.params.callId);
    const cand = (req.body || {}).candidate;
    if (!involved(c, me) || !live(c) || !cand || typeof cand !== 'object') return res.status(400).json({ success: false });
    const arr = c.ice[c.caller === me ? 'caller' : 'callee'];
    if (arr.length < 80) arr.push(cand);
    res.json({ success: true });
  });

  // switch an audio call to video: ask -> other side accepts -> asker sends a new offer -> other side answers
  app.post('/api/calls/:callId/video', (req, res) => {
    const me = norm(req.authEmail); const c = calls.get(req.params.callId);
    if (!involved(c, me) || c.status !== 'accepted') return res.status(400).json({ success: false, why: 'vid-state' });
    const step = (req.body || {}).step;
    if (step === 'request') { if (c.v && c.v.state === 'asked') return res.status(400).json({ success: false, why: 'vid-pending' }); c.v = { by: me, state: 'asked' }; c.negOffer = null; c.negAns = null; }
    else if (step === 'accept' && c.v && c.v.by !== me && c.v.state === 'asked') { c.v.state = 'ok'; c.kind = 'video'; }
    else if (step === 'decline' && c.v && c.v.by !== me && c.v.state === 'asked') c.v.state = 'no';
    else if (step === 'cancel' && c.v && c.v.by === me) c.v = null;
    else return res.status(400).json({ success: false, why: 'vid-step' });
    res.json({ success: true });
  });
  app.post('/api/calls/:callId/neg', (req, res) => {
    const me = norm(req.authEmail); const c = calls.get(req.params.callId); const b = req.body || {};
    if (!involved(c, me) || c.status !== 'accepted') return res.status(400).json({ success: false });
    if (typeof b.offer === 'string' && b.offer.length < 60000 && c.v && c.v.by === me && c.v.state === 'ok') { c.negOffer = b.offer; c.negAns = null; c.negBy = me; c.negSeq = (c.negSeq || 0) + 1; return res.json({ success: true }); }
    if (typeof b.answer === 'string' && b.answer.length < 60000 && c.negOffer && c.negBy !== me) { c.negAns = b.answer; c.negOffer = null; return res.json({ success: true }); }
    res.status(400).json({ success: false });
  });

  // camera on/off of one side (so the other side shows the profile picture instead of a black screen)
  app.post('/api/calls/:callId/cam', (req, res) => {
    const me = norm(req.authEmail); const c = calls.get(req.params.callId);
    if (!involved(c, me) || !live(c)) return res.status(400).json({ success: false });
    c.cam = c.cam || {}; c.cam[c.caller === me ? 'caller' : 'callee'] = (req.body || {}).on !== false;
    res.json({ success: true });
  });

  app.post('/api/calls/:callId/end', (req, res) => {
    const me = norm(req.authEmail); const c = calls.get(req.params.callId);
    if (!involved(c, me)) return res.status(404).json({ success: false });
    if (live(c)) {
      c.why = (c.caller === me ? 'caller:' : 'callee:') + String((req.body || {}).why || '').slice(0, 60);
      console.log('[call] end', c.id, c.status, c.why);
      if (c.status === 'ringing') finish(c, c.caller === me ? 'cancelled' : 'declined', c.caller === me ? 'cancelled' : 'declined');
      else finish(c, 'ended', 'ended');
    }
    res.json({ success: true });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, c] of calls) {
      if (c.status === 'ringing' && now - c.created > CALL_RING_MS) finish(c, 'missed', 'missed');
      else if (c.status === 'accepted' && (now - (c.seen[c.caller] || 0) > CALL_STALE_MS || now - (c.seen[c.callee] || 0) > CALL_STALE_MS)) finish(c, 'ended', 'ended');
      if (!live(c) && c.endedAt && now - c.endedAt > 60 * 1000) calls.delete(id);
    }
  }, 4000).unref();

  // ---------- group chats ----------
  const GROUP_TYPES = ['text', 'image', 'video', 'audio', 'location', 'sticker'];
  const DELETED_MARKER = '__CAMFEED_MSG_DELETED__';
  async function memberOf(gid, email) {
    if (!gid || !email) return null;
    await ensureSchema();
    const r = await pool.query('SELECT role, joined_at, last_read_id FROM chat_group_members WHERE group_id=$1 AND user_email=$2', [gid, norm(email)]);
    return r.rows[0] || null;
  }
  const gidOf = (req) => parseInt(req.params.id, 10) || 0;
  const bad = (res, code, error) => res.status(code).json({ success: false, error });

  async function deleteGroupAll(gid) {
    const msgs = await pool.query('SELECT id, media_url FROM group_messages WHERE group_id=$1', [gid]);
    await purgeGroupRows(msgs.rows);
    const g = await pool.query('SELECT pic FROM chat_groups WHERE id=$1', [gid]);
    const st = await pool.query('SELECT bg FROM chat_settings WHERE user_a=$1', ['group:' + gid]).catch(() => ({ rows: [] }));
    await pool.query('DELETE FROM group_messages WHERE group_id=$1', [gid]);
    await pool.query('DELETE FROM chat_group_members WHERE group_id=$1', [gid]);
    await pool.query('DELETE FROM chat_groups WHERE id=$1', [gid]);
    await pool.query('DELETE FROM chat_settings WHERE user_a=$1', ['group:' + gid]).catch(() => {});
    await pool.query('DELETE FROM chat_mutes WHERE peer_email=$1', ['group:' + gid]).catch(() => {});
    const urls = [];
    if (g.rows[0] && g.rows[0].pic) urls.push(g.rows[0].pic);
    if (st.rows[0] && st.rows[0].bg && st.rows[0].bg.startsWith(mediaBase())) urls.push(st.rows[0].bg);
    if (urls.length) await cleanup.purgeMediaUrls(urls).catch(() => {});
  }

  app.post('/api/groups', async (req, res) => {
    const me = norm(req.authEmail); const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    if (!me || !name) return bad(res, 400, 'name required');
    try {
      await ensureSchema();
      const lim = await chatAllowed(me, null); if (lim) return deny(res, lim);
      let emails = Array.from(new Set((Array.isArray(b.members) ? b.members : []).map((x) => norm(x && x.email ? x.email : x)).filter((e) => e && e !== me))).slice(0, maxMembers - 1);
      if (!emails.length) return bad(res, 400, 'need members');
      const ok = await pool.query('SELECT LOWER(email) AS email FROM users WHERE LOWER(email) = ANY($1::text[])', [emails]);
      const blocked = await pool.query('SELECT LOWER(blocker_email) AS a, LOWER(blocked_email) AS b FROM blocked_users WHERE LOWER(blocker_email)=$1 OR LOWER(blocked_email)=$1', [me]);
      const bl = new Set(blocked.rows.map((r) => (r.a === me ? r.b : r.a)));
      emails = ok.rows.map((r) => r.email).filter((e) => !bl.has(e));
      if (!emails.length) return bad(res, 400, 'no valid members');
      const g = await pool.query('INSERT INTO chat_groups (name, created_by) VALUES ($1,$2) RETURNING id', [name, me]);
      const gid = g.rows[0].id;
      await pool.query("INSERT INTO chat_group_members (group_id, user_email, role) VALUES ($1,$2,'admin')", [gid, me]);
      for (const e of emails) await pool.query("INSERT INTO chat_group_members (group_id, user_email, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [gid, e]);
      await systemNote(me, 'group:' + gid, `👥 ${await nameOf(me)} បានបង្កើតក្រុម «${name}»`);
      res.json({ success: true, group: { id: gid, name } });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.get('/api/groups', async (req, res) => {
    const me = norm(req.authEmail); if (!me) return bad(res, 401, 'auth');
    try {
      await ensureSchema();
      const r = await pool.query(`
        SELECT g.id, g.name, g.pic,
          (SELECT COUNT(*)::int FROM chat_group_members x WHERE x.group_id = g.id) AS members_count,
          (SELECT gm.message FROM group_messages gm WHERE gm.group_id = g.id AND gm.created_at >= m.joined_at ORDER BY gm.id DESC LIMIT 1) AS last_message,
          (SELECT gm.message_type FROM group_messages gm WHERE gm.group_id = g.id AND gm.created_at >= m.joined_at ORDER BY gm.id DESC LIMIT 1) AS last_type,
          (SELECT u.first_name FROM group_messages gm JOIN users u ON LOWER(u.email) = gm.sender_email WHERE gm.group_id = g.id AND gm.created_at >= m.joined_at ORDER BY gm.id DESC LIMIT 1) AS last_sender_name,
          COALESCE((SELECT gm.created_at FROM group_messages gm WHERE gm.group_id = g.id AND gm.created_at >= m.joined_at ORDER BY gm.id DESC LIMIT 1), g.created_at) AS last_time,
          (SELECT COUNT(*)::int FROM group_messages gm WHERE gm.group_id = g.id AND gm.id > m.last_read_id AND gm.sender_email <> m.user_email AND gm.message_type <> 'system' AND gm.created_at >= m.joined_at) AS unread_count
        FROM chat_groups g JOIN chat_group_members m ON m.group_id = g.id WHERE m.user_email = $1`, [me]);
      res.json({ success: true, groups: r.rows });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.get('/api/groups/:id', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req);
    try {
      const mem = await memberOf(gid, me); if (!mem) return bad(res, 403, 'not a member');
      const g = await pool.query('SELECT id, name, pic FROM chat_groups WHERE id=$1', [gid]);
      const m = await pool.query(`SELECT LOWER(u.email) AS email, u.first_name, u.last_name, u.profile_pic, gm.role FROM chat_group_members gm
        JOIN users u ON LOWER(u.email) = gm.user_email WHERE gm.group_id = $1 ORDER BY (gm.role = 'admin') DESC, gm.joined_at ASC`, [gid]);
      res.json({ success: true, group: g.rows[0], members: m.rows, myRole: mem.role, maxMembers });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/update', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req); const b = req.body || {};
    try {
      const mem = await memberOf(gid, me); if (!mem || mem.role !== 'admin') return bad(res, 403, 'admin only');
      const cur = (await pool.query('SELECT name, pic FROM chat_groups WHERE id=$1', [gid])).rows[0]; if (!cur) return bad(res, 404, 'nf');
      const who = await nameOf(me);
      if (b.name !== undefined) {
        const nm = String(b.name || '').trim().slice(0, 60); if (!nm) return bad(res, 400, 'name');
        if (nm !== cur.name) { await pool.query('UPDATE chat_groups SET name=$1 WHERE id=$2', [nm, gid]); await systemNote(me, 'group:' + gid, `✏️ ${who} បានប្តូរឈ្មោះក្រុមទៅជា «${nm}»`); }
      }
      if (b.pic !== undefined) {
        const pic = String(b.pic || '');
        if (pic && !(pic.startsWith(mediaBase()) && pic.length < 500)) return bad(res, 400, 'bad pic');
        if (pic !== (cur.pic || '')) {
          await pool.query('UPDATE chat_groups SET pic=$1 WHERE id=$2', [pic, gid]);
          if (cur.pic) cleanup.purgeMediaUrls([cur.pic]).catch(() => {});
          await systemNote(me, 'group:' + gid, `🖼️ ${who} បានប្តូររូបក្រុម`);
        }
      }
      res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/members', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req);
    try {
      const mem = await memberOf(gid, me); if (!mem || mem.role !== 'admin') return bad(res, 403, 'admin only');
      const lim = await chatAllowed(me, null); if (lim) return deny(res, lim);
      const cnt = (await pool.query('SELECT COUNT(*)::int AS c FROM chat_group_members WHERE group_id=$1', [gid])).rows[0].c;
      let emails = Array.from(new Set((Array.isArray((req.body || {}).members) ? req.body.members : (Array.isArray((req.body || {}).emails) ? req.body.emails : [])).map((x) => norm(x && x.email ? x.email : x)).filter(Boolean)));
      emails = emails.slice(0, Math.max(0, maxMembers - cnt));
      if (!emails.length) return bad(res, 400, cnt >= maxMembers ? 'group full' : 'no members');
      const ok = await pool.query('SELECT LOWER(email) AS email, first_name, last_name FROM users WHERE LOWER(email) = ANY($1::text[])', [emails]);
      const blocked = await pool.query('SELECT LOWER(blocker_email) AS a, LOWER(blocked_email) AS b FROM blocked_users WHERE LOWER(blocker_email)=$1 OR LOWER(blocked_email)=$1', [me]);
      const bl = new Set(blocked.rows.map((r) => (r.a === me ? r.b : r.a)));
      const maxId = (await pool.query('SELECT COALESCE(MAX(id),0)::int AS m FROM group_messages WHERE group_id=$1', [gid])).rows[0].m;
      const added = [];
      for (const u of ok.rows) {
        if (bl.has(u.email)) continue;
        const ex = await pool.query('SELECT 1 FROM chat_group_members WHERE group_id=$1 AND user_email=$2', [gid, u.email]);
        if (ex.rows.length) continue;
        await pool.query("INSERT INTO chat_group_members (group_id, user_email, role, last_read_id) VALUES ($1,$2,'member',$3)", [gid, u.email, maxId]);
        added.push(`${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email);
      }
      if (added.length) await systemNote(me, 'group:' + gid, `➕ ${await nameOf(me)} បានបន្ថែម ${added.join(', ')}`);
      res.json({ success: true, added: added.length });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/remove', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req); const target = norm((req.body || {}).email);
    try {
      const mem = await memberOf(gid, me); if (!mem || mem.role !== 'admin') return bad(res, 403, 'admin only');
      if (!target || target === me) return bad(res, 400, 'bad target');
      const t = await memberOf(gid, target); if (!t) return bad(res, 404, 'not member');
      await pool.query('DELETE FROM chat_group_members WHERE group_id=$1 AND user_email=$2', [gid, target]);
      await systemNote(me, 'group:' + gid, `🚫 ${await nameOf(me)} បានដក ${await nameOf(target)} ចេញពីក្រុម`);
      res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/leave', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req);
    try {
      const mem = await memberOf(gid, me); if (!mem) return bad(res, 403, 'not member');
      const who = await nameOf(me);
      await pool.query('DELETE FROM chat_group_members WHERE group_id=$1 AND user_email=$2', [gid, me]);
      const left = await pool.query('SELECT user_email, role FROM chat_group_members WHERE group_id=$1 ORDER BY joined_at ASC', [gid]);
      if (!left.rows.length) { await deleteGroupAll(gid); return res.json({ success: true, deleted: true }); }
      if (!left.rows.some((r) => r.role === 'admin')) await pool.query("UPDATE chat_group_members SET role='admin' WHERE group_id=$1 AND user_email=$2", [gid, left.rows[0].user_email]);
      await systemNote(me, 'group:' + gid, `🚪 ${who} បានចាកចេញពីក្រុម`);
      res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/delete', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req);
    try {
      const mem = await memberOf(gid, me); if (!mem || mem.role !== 'admin') return bad(res, 403, 'admin only');
      await deleteGroupAll(gid); res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.get('/api/groups/:id/messages', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req);
    try {
      const mem = await memberOf(gid, me); if (!mem) return bad(res, 403, 'not a member');
      const r = await pool.query(`SELECT * FROM (
          SELECT gm.id, gm.sender_email, gm.message, gm.media_url, gm.message_type, gm.reply_to, gm.created_at,
                 u.first_name AS sender_first, u.last_name AS sender_last, u.profile_pic AS sender_pic
          FROM group_messages gm LEFT JOIN users u ON LOWER(u.email) = gm.sender_email
          WHERE gm.group_id = $1 AND gm.created_at >= $2 ORDER BY gm.id DESC LIMIT 500) t ORDER BY id ASC`, [gid, mem.joined_at]);
      const ids = r.rows.map((x) => x.id);
      const rx = {};
      if (ids.length) {
        const rr = await pool.query('SELECT message_id, user_email, emoji FROM group_reactions WHERE message_id = ANY($1::int[])', [ids]);
        rr.rows.forEach((x) => { (rx[x.message_id] = rx[x.message_id] || []).push({ user_email: x.user_email, e: x.emoji }); });
      }
      r.rows.forEach((x) => { x.reactions = rx[x.id] || []; x.sender_name = `${x.sender_first || ''} ${x.sender_last || ''}`.trim(); x.is_read = false; });
      res.json({ success: true, messages: r.rows, settings: await settingsFor(me, 'group:' + gid) });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/messages', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req); const b = req.body || {};
    try {
      const mem = await memberOf(gid, me); if (!mem) return bad(res, 403, 'not a member');
      const lim = await chatAllowed(me, null, { post: true }); if (lim) return deny(res, lim);
      let type = GROUP_TYPES.includes(b.message_type) ? b.message_type : 'text';
      let media = b.media_url ? String(b.media_url) : null;
      if (media && (!/^https:\/\//.test(media) || media.length > 2000)) return bad(res, 400, 'bad media');
      if (!media && ['image', 'video', 'audio', 'sticker'].includes(type)) type = 'text';
      let text = String(b.message || '').slice(0, 5000);
      if (type === 'location') {
        const loc = /^📍[^\n]{0,60}\nhttps:\/\/www\.google\.com\/maps\/search\/\?api=1&query=(-?\d{1,3}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?)$/.exec(text);
        if (!loc || Math.abs(parseFloat(loc[1])) > 90 || Math.abs(parseFloat(loc[2])) > 180) return bad(res, 400, 'bad location');
        media = null;
      }
      if (!text && !media) return bad(res, 400, 'empty');
      let replyTo = parseInt(b.reply_to, 10) || null;
      if (replyTo) { const rr = await pool.query('SELECT 1 FROM group_messages WHERE id=$1 AND group_id=$2', [replyTo, gid]); if (!rr.rows.length) replyTo = null; }
      const r = await pool.query('INSERT INTO group_messages (group_id, sender_email, message, media_url, message_type, reply_to) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [gid, me, text, media, type, replyTo]);
      await pool.query('UPDATE chat_group_members SET last_read_id = $3 WHERE group_id=$1 AND user_email=$2 AND last_read_id < $3', [gid, me, r.rows[0].id]).catch(() => {});
      res.status(201).json({ success: true, message: r.rows[0] });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.put('/api/groups/:id/messages/:mid', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req); const mid = parseInt(req.params.mid, 10);
    try {
      if (!(await memberOf(gid, me))) return bad(res, 403, 'not a member');
      const text = String((req.body || {}).message || '').slice(0, 5000);
      if (!text) return bad(res, 400, 'empty');
      const r = await pool.query("UPDATE group_messages SET message=$1 WHERE id=$2 AND group_id=$3 AND sender_email=$4 AND message_type='text' RETURNING id", [text, mid, gid, me]);
      if (!r.rows.length) return bad(res, 403, 'not allowed');
      res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.delete('/api/groups/:id/messages/:mid', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req); const mid = parseInt(req.params.mid, 10);
    try {
      const mem = await memberOf(gid, me); if (!mem) return bad(res, 403, 'not a member');
      const cur = await pool.query('SELECT sender_email, media_url FROM group_messages WHERE id=$1 AND group_id=$2', [mid, gid]);
      const row = cur.rows[0]; if (!row || (row.sender_email !== me && mem.role !== 'admin')) return bad(res, 403, 'not allowed');
      await pool.query("UPDATE group_messages SET message=$1, media_url=NULL, message_type='deleted' WHERE id=$2", [DELETED_MARKER, mid]);
      if (row.media_url) cleanup.purgeMediaUrls(extractMediaUrls(row.media_url)).catch(() => {});
      res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/messages/:mid/react', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req); const mid = parseInt(req.params.mid, 10);
    const emoji = String((req.body || {}).emoji || '');
    if (emoji && !EMOJI_RE.test(emoji)) return bad(res, 400, 'bad emoji');
    try {
      if (!(await memberOf(gid, me))) return bad(res, 403, 'not a member');
      const ex = await pool.query('SELECT 1 FROM group_messages WHERE id=$1 AND group_id=$2', [mid, gid]); if (!ex.rows.length) return bad(res, 404, 'nf');
      const cur = await pool.query('SELECT emoji FROM group_reactions WHERE message_id=$1 AND user_email=$2', [mid, me]);
      if (!emoji || (cur.rows[0] && cur.rows[0].emoji === emoji)) await pool.query('DELETE FROM group_reactions WHERE message_id=$1 AND user_email=$2', [mid, me]);
      else await pool.query('INSERT INTO group_reactions (message_id,user_email,emoji) VALUES ($1,$2,$3) ON CONFLICT (message_id,user_email) DO UPDATE SET emoji=$3', [mid, me, emoji]);
      res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  app.post('/api/groups/:id/read', async (req, res) => {
    const me = norm(req.authEmail); const gid = gidOf(req);
    try {
      await pool.query('UPDATE chat_group_members SET last_read_id = COALESCE((SELECT MAX(id) FROM group_messages WHERE group_id=$1),0) WHERE group_id=$1 AND user_email=$2', [gid, me]);
      res.json({ success: true });
    } catch (e) { bad(res, 500, e.message); }
  });

  ensureSchema().catch((e) => console.error('[chat] schema:', e.message));
  setTimeout(sweepChats, 3 * 60 * 1000);
  setInterval(sweepChats, 60 * 60 * 1000).unref();

  return { ensureSchema, settingsFor, reactionsFor, sweepChats, chatAllowed, deny, purgeGroupRows };
};
