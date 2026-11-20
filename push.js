// Push notifications (Firebase Cloud Messaging, HTTP v1): the phone app gets a notification for a new message,
// a new like / comment / follow, and an incoming call - even when the app is closed.
// No extra npm package: the Google login token is signed with Node's own crypto.
//
// Turn on:  Render > Environment > FIREBASE_SERVICE_ACCOUNT = the whole service-account JSON (one line).  Without it everything here does nothing.
'use strict';

const crypto = require('crypto');

module.exports = function createPush({ app, pool }) {
  let account = null;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const j = JSON.parse(raw);
      if (j.client_email && j.private_key && j.project_id) account = j;
    }
  } catch (e) { console.error('[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message); }
  const enabled = !!account && typeof fetch === 'function';
  const norm = (s) => String(s || '').trim().toLowerCase();
  let ready = null;

  function ensureSchema() {
    if (!ready) {
      ready = pool.query(`CREATE TABLE IF NOT EXISTS push_tokens (
        token TEXT PRIMARY KEY, user_email VARCHAR(255) NOT NULL, platform VARCHAR(20) DEFAULT 'android', updated_at TIMESTAMP DEFAULT NOW())`)
        .then(() => pool.query('CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens (LOWER(user_email))'))
        .then(() => pool.query("ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS caps VARCHAR(40) DEFAULT ''"))
        .catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  // ---- Google access token (valid ~1 hour, cached) ----
  let tokenCache = { v: '', exp: 0 };
  const b64 = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  async function accessToken() {
    if (tokenCache.v && Date.now() < tokenCache.exp - 60000) return tokenCache.v;
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(account.private_key);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + b64(sig),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) throw new Error('Google login for push failed: ' + (j.error_description || j.error || r.status));
    tokenCache = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return tokenCache.v;
  }

  async function sendOne(token, msg) {
    const at = await accessToken();
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, ...msg } }),
    });
    if (r.ok) return true;
    const t = await r.text().catch(() => '');
    if (r.status === 404 || /UNREGISTERED|not a valid FCM registration token/.test(t)) {          // the app was removed: forget this phone
      await pool.query('DELETE FROM push_tokens WHERE token = $1', [token]).catch(() => {});
    } else console.error('[push] FCM error', r.status, t.slice(0, 200));
    return false;
  }

  // title/body: what the person sees. data: small facts for the app (strings only). high: ring now (calls).
  // what the person switched off in Settings > notifications (users.notification_prefs); everything is ON unless switched off
  const GROUP_OF = { reaction: 'reactions', comment_reaction: 'reactions', comment: 'comments', reply: 'comments', follow: 'follows', share: 'shares', tag: 'tags' };
  async function wants(email, channel, ntype) {
    try {
      const r = (await pool.query('SELECT notification_prefs FROM users WHERE LOWER(email) = LOWER($1)', [email])).rows[0];
      const saved = JSON.parse((r && r.notification_prefs) || '{}') || {};
      if (channel === 'messages') return saved.messages !== false;
      if (channel === 'general') { const g = GROUP_OF[ntype]; return !(g && saved[g] === false); }
    } catch (e) { /* unknown: send */ }
    return true;
  }

  // CamFeed's own sounds (Build 73+): the app makes these Android channels, each with its sound in res/raw
  //   general = Khmer roneat, messages = Khmer kong, calls = Khmer khim (the call screen itself rings with the same khim tune)
  const CH = { general: ['general_v2', 'cf_notify'], messages: ['messages_v2', 'cf_message'], calls: ['calls_v2', 'cf_ringtone'] };
  // bubble: a chat message for phones that show 💬 chat bubbles (their own code builds the notification, so it goes as data)
  async function sendToUser(email, { title, body, data = {}, high = false, channel = 'messages', ntype = '', dataOnly = false, tag = '', bubble = null }) {
    if (!enabled || !email) return 0;
    try {
      await ensureSchema();
      if (!(await wants(email, channel, ntype))) return 0;
      const rows = (await pool.query("SELECT token, COALESCE(caps, '') AS caps FROM push_tokens WHERE LOWER(user_email) = LOWER($1)", [email])).rows;
      const strData = {}; for (const k of Object.keys(data)) strData[k] = String(data[k]);
      let ok = 0;
      for (const { token, caps } of rows) {
        if (bubble && /\bbubble\b/.test(caps)) {
          const bd = {}; for (const k of Object.keys(bubble)) bd[k] = String(bubble[k] == null ? '' : bubble[k]).slice(0, 400);
          if (await sendOne(token, { data: bd, android: { priority: 'HIGH', ttl: '86400s' } })) ok++;
          continue;
        }
        // dataOnly (incoming calls): no notification block, so the app's own code runs even when closed and can ring like a phone call
        const msg = dataOnly ? { data: strData, android: { priority: 'HIGH', ttl: '30s' } } : {
          notification: { title: String(title || 'CamFeed').slice(0, 80), body: String(body || '').slice(0, 180) },
          data: strData,
          android: { priority: 'HIGH', ttl: high ? '30s' : '86400s', notification: { channel_id: (CH[channel] || [channel])[0], sound: (CH[channel] || [, 'default'])[1], ...(tag ? { tag } : {}), ...(high ? { notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC', default_vibrate_timings: true } : {}) } },
        };
        if (await sendOne(token, msg)) ok++;
      }
      console.log('[push] ' + (dataOnly ? 'data' : channel) + ' -> ' + String(email).slice(0, 3) + '***: ' + ok + '/' + rows.length + ' phones');
      return ok;
    } catch (e) { console.error('[push] send failed:', e.message); return 0; }
  }

  const fullName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'CamFeed';

  async function notifyCall(calleeEmail, callerEmail, kind, callId, grp) {
    if (!enabled) return;
    try {
      const u = (await pool.query('SELECT first_name, last_name, profile_pic FROM users WHERE LOWER(email) = LOWER($1)', [callerEmail])).rows[0] || {};
      // A call is sent as a notification AND data. The notification is shown by the phone itself (a heads-up banner with the ringtone sound),
      // so it appears even when the app's own code can not start in the background (the same way chat messages already work).
      // When the app's code does start, it also opens the full system call screen.
      await sendToUser(calleeEmail, {
        title: grp ? (grp.groupName || 'CamFeed') : fullName(u),
        body: (kind === 'video' ? '📹 ការហៅវីដេអូចូល' : '📞 ការហៅសំឡេងចូល') + (grp ? ' · ' + fullName(u) : ''), channel: 'calls', tag: 'call_' + callId,
        data: { type: 'call', kind, callId, name: grp ? (grp.groupName || 'CamFeed') : fullName(u), pic: grp ? (grp.groupPic || '') : (u.profile_pic || ''), caller: callerEmail, group: grp ? '1' : '', url: '/feed.html' }, high: true,
        // default: data only, so the app's own code opens the full-screen call screen (lights the screen, rings until answered).
        // Render > Environment CALL_PUSH_MODE=banner switches back to a plain notification banner (it can not light the screen).
        dataOnly: String(process.env.CALL_PUSH_MODE || '').toLowerCase() !== 'banner',
      });
    } catch (e) { console.error('[push] call notify failed:', e.message); }
  }
  // the caller hung up (or nobody answered): stop the ringing on the phone
  async function notifyCallEnd(calleeEmail, callId) {
    if (!enabled) return;
    try { await sendToUser(calleeEmail, { data: { type: 'call_end', callId }, high: true, dataOnly: true }); } catch (e) { /* ignore */ }
  }

  // ---- new messages and new notifications are found by looking at the tables every few seconds (no change to the code that writes them) ----
  let lastMsg = null, lastNote = null, lastGroup = null, busy = false;
  async function tick() {
    if (!enabled || busy) return;
    busy = true;
    try {
      await ensureSchema();
      if (lastMsg === null) {                       // first run after a restart: start from "now", never replay old things
        lastMsg = +((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM messages')).rows[0].m);
        lastNote = +((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM notifications')).rows[0].m);
        lastGroup = +((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM group_messages').catch(() => ({ rows: [{ m: 0 }] }))).rows[0].m);
        return;
      }
      const ms = (await pool.query(
        `SELECT m.id, m.sender_email, m.receiver_email, m.message, m.message_type, u.first_name, u.last_name, u.profile_pic
           FROM messages m LEFT JOIN users u ON LOWER(u.email) = LOWER(m.sender_email)
          WHERE m.id > $1 ORDER BY m.id LIMIT 60`, [lastMsg])).rows;
      for (const m of ms) {
        lastMsg = Math.max(lastMsg, +m.id);
        if (['system', 'call'].includes(m.message_type)) continue;
        if (/^group:/i.test(String(m.receiver_email || '')) || norm(m.sender_email) === norm(m.receiver_email)) continue;
        // muted / restricted chats, and strangers' messages for people who turned on "Message requests", do not ring
        if (msgFilter && !(await msgFilter(m.receiver_email, m.sender_email).catch(() => true))) continue;
        const media = { image: '📷 រូបភាព', video: '🎬 វីដេអូ', audio: '🎙️ សារសំឡេង', location: '📍 ទីតាំង' }[m.message_type];   // a 📎 file keeps its own text ("📎 name")
        let text = media || String(m.message || '').replace(/\s+/g, ' ');
        if (text.startsWith('STICKER_EMOJI:')) text = text.slice(14) || '🙂';
        else if (text.startsWith('BIG_EMOJI:')) text = text.split(':').slice(2).join(':') || '👍';
        else if (text.startsWith('PARTY_ROOM:')) text = '🎉 Party Room: ' + text.split(':').slice(2).join(':');
        else if (text.startsWith('__CAMFEED_EDITED__:')) text = text.slice(19);
        else if (text.startsWith('__CAMFEED_MSG_DELETED__') || text.startsWith('CALL:')) continue;
        sendToUser(m.receiver_email, { title: fullName(m), body: text, data: { type: 'message', url: '/messages.html' }, channel: 'messages',
          bubble: { type: 'chat', peer: m.sender_email, name: fullName(m), pic: m.profile_pic || '', body: text.slice(0, 300), url: '/messages.html' } });
      }
      // group chats: every member except the sender (a muted / restricted group stays quiet for that member)
      if (lastGroup !== null) {
        const gs = (await pool.query(
          `SELECT gm.id, gm.group_id, gm.sender_email, gm.message, gm.message_type, g.name AS group_name, u.first_name, u.last_name
             FROM group_messages gm JOIN chat_groups g ON g.id = gm.group_id LEFT JOIN users u ON LOWER(u.email) = LOWER(gm.sender_email)
            WHERE gm.id > $1 ORDER BY gm.id LIMIT 40`, [lastGroup]).catch(() => ({ rows: [] }))).rows;
        for (const g of gs) {
          lastGroup = Math.max(lastGroup, +g.id);
          if (['system', 'call'].includes(g.message_type)) continue;
          let text = { image: '📷 រូបភាព', video: '🎬 វីដេអូ', audio: '🎙️ សារសំឡេង', location: '📍 ទីតាំង', sticker: 'Sticker' }[g.message_type] || String(g.message || '').replace(/\s+/g, ' ');
          if (text.startsWith('STICKER_EMOJI:')) text = text.slice(14) || '🙂';
          else if (text.startsWith('BIG_EMOJI:')) text = text.split(':').slice(2).join(':') || '👍';
        else if (text.startsWith('PARTY_ROOM:')) text = '🎉 Party Room: ' + text.split(':').slice(2).join(':');
          else if (text.startsWith('__CAMFEED_EDITED__:')) text = text.slice(19);
          else if (text.startsWith('__CAMFEED_MSG_DELETED__') || text.startsWith('CALL:')) continue;
          const members = (await pool.query('SELECT user_email FROM chat_group_members WHERE group_id = $1', [g.group_id]).catch(() => ({ rows: [] }))).rows;
          for (const mb of members) {
            if (norm(mb.user_email) === norm(g.sender_email)) continue;
            if (msgFilter && !(await msgFilter(mb.user_email, g.sender_email, 'group:' + g.group_id).catch(() => true))) continue;
            sendToUser(mb.user_email, { title: g.group_name || 'CamFeed', body: `${fullName(g)}: ${text}`, data: { type: 'message', url: '/messages.html', group: String(g.group_id) }, channel: 'messages' });
          }
        }
      }
      const ns = (await pool.query(
        `SELECT n.id, n.recipient_email, n.sender_email, n.message, n.type FROM notifications n WHERE n.id > $1 ORDER BY n.id LIMIT 60`, [lastNote])).rows;
      for (const n of ns) {
        lastNote = Math.max(lastNote, +n.id);
        if (!n.recipient_email || norm(n.recipient_email) === norm(n.sender_email)) continue;
        sendToUser(n.recipient_email, { title: 'CamFeed', body: n.message || 'មានការជូនដំណឹងថ្មី', data: { type: 'notification', url: '/notifications', ntype: String(n.type || '') }, channel: 'general', ntype: n.type });
      }
    } catch (e) { console.error('[push] tick failed:', e.message); }
    finally { busy = false; }
  }
  if (enabled) {
    const t = setInterval(tick, 6000); if (t.unref) t.unref();
    console.log('[push] Firebase push is ON for project', account.project_id);
  } else console.log('[push] off (set FIREBASE_SERVICE_ACCOUNT to turn it on)');

  // ---- the phone app tells us its Firebase token after login ----
  app.post('/api/push/register', async (req, res) => {
    const me = req.authEmail, token = String((req.body && req.body.token) || '');
    const caps = String((req.body && req.body.caps) || '').replace(/[^a-z,]/g, '').slice(0, 40);   // 'bubble' = this phone shows chat bubbles itself
    if (!me || token.length < 20 || token.length > 4096) return res.status(400).json({ success: false });
    try {
      await ensureSchema();
      await pool.query(`INSERT INTO push_tokens (token, user_email, platform, updated_at, caps) VALUES ($1, $2, 'android', NOW(), $3)
                        ON CONFLICT (token) DO UPDATE SET user_email = EXCLUDED.user_email, updated_at = NOW(), caps = EXCLUDED.caps`, [token, me, caps]);
      res.json({ success: true, push: enabled });
    } catch (e) { res.status(500).json({ success: false }); }
  });
  app.post('/api/push/unregister', async (req, res) => {
    const token = String((req.body && req.body.token) || '');
    try { await ensureSchema(); await pool.query('DELETE FROM push_tokens WHERE token = $1 AND LOWER(user_email) = LOWER($2)', [token, req.authEmail || '']); } catch (e) {}
    res.json({ success: true });
  });

  let msgFilter = null;
  const setMessageFilter = (fn) => { msgFilter = fn; };
  return { enabled, sendToUser, notifyCall, notifyCallEnd, setMessageFilter };
};
