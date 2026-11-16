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

  async function sendToUser(email, { title, body, data = {}, high = false, channel = 'messages', ntype = '', dataOnly = false, tag = '' }) {
    if (!enabled || !email) return 0;
    try {
      await ensureSchema();
      if (!(await wants(email, channel, ntype))) return 0;
      const rows = (await pool.query('SELECT token FROM push_tokens WHERE LOWER(user_email) = LOWER($1)', [email])).rows;
      const strData = {}; for (const k of Object.keys(data)) strData[k] = String(data[k]);
      let ok = 0;
      for (const { token } of rows) {
        // dataOnly (incoming calls): no notification block, so the app's own code runs even when closed and can ring like a phone call
        const msg = dataOnly ? { data: strData, android: { priority: 'HIGH', ttl: '30s' } } : {
          notification: { title: String(title || 'CamFeed').slice(0, 80), body: String(body || '').slice(0, 180) },
          data: strData,
          android: { priority: 'HIGH', ttl: high ? '30s' : '86400s', notification: { channel_id: channel, sound: 'default', ...(tag ? { tag } : {}), ...(high ? { notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC', default_vibrate_timings: true } : {}) } },
        };
        if (await sendOne(token, msg)) ok++;
      }
      console.log('[push] ' + (dataOnly ? 'data' : channel) + ' -> ' + String(email).slice(0, 3) + '***: ' + ok + '/' + rows.length + ' phones');
      return ok;
    } catch (e) { console.error('[push] send failed:', e.message); return 0; }
  }

  const fullName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'CamFeed';

  async function notifyCall(calleeEmail, callerEmail, kind, callId) {
    if (!enabled) return;
    try {
      const u = (await pool.query('SELECT first_name, last_name, profile_pic FROM users WHERE LOWER(email) = LOWER($1)', [callerEmail])).rows[0] || {};
      // A call is sent as a notification AND data. The notification is shown by the phone itself (a heads-up banner with the ringtone sound),
      // so it appears even when the app's own code can not start in the background (the same way chat messages already work).
      // When the app's code does start, it also opens the full system call screen.
      await sendToUser(calleeEmail, {
        title: fullName(u), body: kind === 'video' ? '📹 ការហៅវីដេអូចូល' : '📞 ការហៅសំឡេងចូល', channel: 'calls', tag: 'call_' + callId,
        data: { type: 'call', kind, callId, name: fullName(u), pic: u.profile_pic || '', caller: callerEmail, url: '/feed.html' }, high: true,
      });
    } catch (e) { console.error('[push] call notify failed:', e.message); }
  }
  // the caller hung up (or nobody answered): stop the ringing on the phone
  async function notifyCallEnd(calleeEmail, callId) {
    if (!enabled) return;
    try { await sendToUser(calleeEmail, { data: { type: 'call_end', callId }, high: true, dataOnly: true }); } catch (e) { /* ignore */ }
  }

  // ---- new messages and new notifications are found by looking at the tables every few seconds (no change to the code that writes them) ----
  let lastMsg = null, lastNote = null, busy = false;
  async function tick() {
    if (!enabled || busy) return;
    busy = true;
    try {
      await ensureSchema();
      if (lastMsg === null) {                       // first run after a restart: start from "now", never replay old things
        lastMsg = +((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM messages')).rows[0].m);
        lastNote = +((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM notifications')).rows[0].m);
        return;
      }
      const ms = (await pool.query(
        `SELECT m.id, m.sender_email, m.receiver_email, m.message, m.message_type, u.first_name, u.last_name
           FROM messages m LEFT JOIN users u ON LOWER(u.email) = LOWER(m.sender_email)
          WHERE m.id > $1 ORDER BY m.id LIMIT 60`, [lastMsg])).rows;
      for (const m of ms) {
        lastMsg = Math.max(lastMsg, +m.id);
        if (['system', 'call'].includes(m.message_type)) continue;
        if (/^group:/i.test(String(m.receiver_email || '')) || norm(m.sender_email) === norm(m.receiver_email)) continue;
        const media = { image: '📷 រូបភាព', video: '🎬 វីដេអូ', audio: '🎙️ សារសំឡេង', location: '📍 ទីតាំង' }[m.message_type];
        const text = media || String(m.message || '').replace(/\s+/g, ' ');
        sendToUser(m.receiver_email, { title: fullName(m), body: text, data: { type: 'message', url: '/messages.html' }, channel: 'messages' });
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
    if (!me || token.length < 20 || token.length > 4096) return res.status(400).json({ success: false });
    try {
      await ensureSchema();
      await pool.query(`INSERT INTO push_tokens (token, user_email, platform, updated_at) VALUES ($1, $2, 'android', NOW())
                        ON CONFLICT (token) DO UPDATE SET user_email = EXCLUDED.user_email, updated_at = NOW()`, [token, me]);
      res.json({ success: true, push: enabled });
    } catch (e) { res.status(500).json({ success: false }); }
  });
  // Settings > "test the notification": the phone asks for a test push that arrives after 15 s, so the person can leave the app first
  app.post('/api/push/test', async (req, res) => {
    const me = req.authEmail;
    if (!me) return res.status(401).json({ success: false });
    try {
      await ensureSchema();
      const n = +(await pool.query('SELECT COUNT(*) AS n FROM push_tokens WHERE LOWER(user_email) = LOWER($1)', [me])).rows[0].n;
      if (n > 0) setTimeout(() => { sendToUser(me, { title: 'CamFeed', body: '✅ ការជូនដំណឹងដំណើរការ', data: { type: 'message', url: '/messages.html' }, channel: 'messages' }); }, 15000);
      res.json({ success: true, push: enabled, tokens: n });
    } catch (e) { res.status(500).json({ success: false }); }
  });
  app.post('/api/push/unregister', async (req, res) => {
    const token = String((req.body && req.body.token) || '');
    try { await ensureSchema(); await pool.query('DELETE FROM push_tokens WHERE token = $1 AND LOWER(user_email) = LOWER($2)', [token, req.authEmail || '']); } catch (e) {}
    res.json({ success: true });
  });

  return { enabled, sendToUser, notifyCall, notifyCallEnd };
};
