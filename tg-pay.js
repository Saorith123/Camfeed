// 💰 Payments, step 1: a person pays to CamFeed's QR, presses "I paid", and CamFeed's own Telegram bot asks the owner:
// "✅ received / ❌ not received". Nothing starts before the owner presses ✅ (from Telegram, or in Admin as before).
// Render › Environment: TG_PAY_BOT_TOKEN = the token @BotFather gave (a NEW bot only for this). The owner links his Telegram in
// Admin › 📢 Ads › 💰 Telegram for payments (a one-time code), so only the linked Telegram accounts can press the buttons.
'use strict';
const crypto = require('crypto');

module.exports = function ({ app, pool, adminGate, audit, baseUrl, onDecide }) {
  const token = () => String(process.env.TG_PAY_BOT_TOKEN || '').trim();
  const on = () => /^\d{5,}:\S{20,}$/.test(token());
  const secret = () => crypto.createHash('sha256').update('camfeed-pay:' + token()).digest('hex').slice(0, 40);
  let ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS tg_pay_chats (chat_id BIGINT PRIMARY KEY, user_id BIGINT, name TEXT, linked_by TEXT, linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE TABLE IF NOT EXISTS tg_pay_state (k TEXT PRIMARY KEY, v TEXT, at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  let lastErr = '';
  // plain https over IPv4 (some servers can not reach Telegram over IPv6: Node's fetch then says only "fetch failed"); tried twice
  function post(method, body) {
    const https = require('https');
    const data = Buffer.from(JSON.stringify(body || {}));
    return new Promise((ok, no) => {
      const rq = https.request({ hostname: 'api.telegram.org', path: `/bot${token()}/${method}`, method: 'POST', family: 4, timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (rs) => {
        const parts = []; rs.on('data', (c) => parts.push(c));
        rs.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { ok({ ok: false, error_code: rs.statusCode, description: 'bad answer' }); } });
      });
      rq.on('timeout', () => rq.destroy(new Error('no answer from Telegram (timeout)')));
      rq.on('error', no);
      rq.end(data);
    });
  }
  async function api(method, body) {
    if (!on()) return null;
    for (let i = 0; i < 2; i++) {
      try {
        const j = await post(method, body);
        if (!j || !j.ok) lastErr = method + ': ' + (j ? (j.error_code + ' ' + (j.description || '')) : 'no answer');
        return j;
      } catch (e) { lastErr = method + ': ' + (e.code || '') + ' ' + e.message; }
    }
    return null;
  }
  // the bot is told where to send what happens (once after every start)
  async function hook() {
    if (!on()) return;
    const url = String(baseUrl() || 'https://camfeedkh.com').replace(/\/+$/, '') + '/api/tg-pay/hook';
    const r = await api('setWebhook', { url, secret_token: secret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
    if (!r || !r.ok) console.error('[tg-pay] webhook not set:', r && r.description);
  }
  setTimeout(() => { ensure().then(hook).catch(() => {}); }, 20 * 1000);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  // to every linked Telegram: the payment to check, with the two buttons
  async function ask(kind, id, lines) {
    if (!on()) return false;
    try {
      await ensure();
      const chats = (await pool.query('SELECT chat_id FROM tg_pay_chats')).rows;
      const text = lines.map(esc).join('\n');
      for (const c of chats) {
        await api('sendMessage', { chat_id: c.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: '✅ បានទទួលប្រាក់', callback_data: `${kind}:ok:${id}` }, { text: '❌ មិនទាន់ទទួល', callback_data: `${kind}:no:${id}` }]] } });
      }
      return chats.length > 0;
    } catch (e) { console.error('[tg-pay] ask:', e.message); return false; }
  }

  app.post('/api/tg-pay/hook', async (req, res) => {
    if (!on() || req.get('X-Telegram-Bot-Api-Secret-Token') !== secret()) return res.status(403).end();
    res.json({ ok: true });                                                    // Telegram is answered at once; the work goes on
    try {
      await ensure();
      const u = req.body || {};
      if (u.message && u.message.chat && u.message.chat.type === 'private') {                  // "/start link-xxxx" from the owner
        const m = /^\/start\s+(link-[a-f0-9]{16})$/.exec(String(u.message.text || '').trim());
        if (!m) { await api('sendMessage', { chat_id: u.message.chat.id, text: 'CamFeed 💰 bot. This bot only tells the CamFeed team about payments.' }); return; }
        const st = (await pool.query("DELETE FROM tg_pay_state WHERE k = 'link' AND split_part(v, '|', 1) = $1 AND at > NOW() - INTERVAL '15 minutes' RETURNING v", [m[1]])).rows[0];
        if (!st) { await api('sendMessage', { chat_id: u.message.chat.id, text: '❌ This code is old or wrong. Make a new one in CamFeed Admin.' }); return; }
        const who = [u.message.from.first_name, u.message.from.last_name].filter(Boolean).join(' ') || ('@' + (u.message.from.username || ''));
        await pool.query(`INSERT INTO tg_pay_chats (chat_id, user_id, name, linked_by) VALUES ($1, $2, $3, $4)
          ON CONFLICT (chat_id) DO UPDATE SET user_id = $2, name = $3, linked_by = $4, linked_at = NOW()`, [u.message.chat.id, u.message.from.id, who.slice(0, 80), String(st.v).split('|')[1] || '']);
        try { audit(String(st.v).split('|')[1] || 'telegram', 'tg-pay.link', who, String(u.message.chat.id)); } catch (e) {}
        await api('sendMessage', { chat_id: u.message.chat.id, text: '✅ Linked. Payments to check will come here with ✅ / ❌ buttons.' });
        return;
      }
      const q = u.callback_query;
      if (q && q.data && q.message) {
        const linked = (await pool.query('SELECT linked_by FROM tg_pay_chats WHERE chat_id = $1 AND user_id = $2', [q.message.chat.id, q.from.id])).rows[0];
        if (!linked) { await api('answerCallbackQuery', { callback_query_id: q.id, text: 'Not allowed.', show_alert: true }); return; }
        const m = /^(ad|coin):(ok|no):(\d{1,9})$/.exec(String(q.data));
        if (!m) { await api('answerCallbackQuery', { callback_query_id: q.id }); return; }
        const tgName = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') || String(q.from.id);
        const who = linked.linked_by || 'telegram';                            // the admin who linked this Telegram decides
        if (!(parseInt(m[3], 10) > 0)) { await api('answerCallbackQuery', { callback_query_id: q.id, text: 'Test OK ✅' }); return; }
        let out;
        try { out = await onDecide(m[1], parseInt(m[3], 10), m[2] === 'ok', who); } catch (e) { out = { ok: false, text: e.message }; }
        await api('answerCallbackQuery', { callback_query_id: q.id, text: (out && out.text) || 'Done', show_alert: !(out && out.ok) });
        if (out && out.ok) {
          const mark = m[2] === 'ok' ? '\n\n✅ បានទទួល · ' : '\n\n❌ មិនទាន់ទទួល · ';
          await api('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: String(q.message.text || '') + mark + tgName + '\n' + (out.text || '') });
        }
      }
    } catch (e) { console.error('[tg-pay] hook:', e.message); }
  });

  // Admin › 💰 Telegram for payments: see, link (one-time code), unlink, test
  app.post('/api/admin/tg-pay', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const b = req.body || {}, act = String(b.action || 'list');
      if (act !== 'list' && !a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
      if (act === 'link') {
        const code = 'link-' + crypto.randomBytes(8).toString('hex');
        await pool.query("DELETE FROM tg_pay_state WHERE k = 'link'");
        await pool.query("INSERT INTO tg_pay_state (k, v) VALUES ('link', $1) ON CONFLICT (k) DO UPDATE SET v = $1, at = NOW()", [code + '|' + a.adminEmail]);
        const me = await api('getMe', {});
        const user = me && me.ok ? me.result.username : '';
        return res.json({ success: true, code, bot: user, link: user ? `https://t.me/${user}?start=${code}` : '' });
      }
      if (act === 'unlink') { await pool.query('DELETE FROM tg_pay_chats WHERE chat_id = $1', [String(b.chat_id || '0')]); try { audit(a.adminEmail, 'tg-pay.unlink', String(b.chat_id), ''); } catch (e) {} return res.json({ success: true }); }
      if (act === 'test') { const sent = await ask('ad', 0, ['🧪 Test from CamFeed Admin. (The buttons do nothing for this test.)']); return res.json({ success: sent, error: sent ? '' : 'Nothing was sent. Is a Telegram linked?' }); }
      if (act === 'rehook') { await hook(); return res.json({ success: true }); }
      const chats = (await pool.query('SELECT chat_id::text, name, linked_by, linked_at FROM tg_pay_chats ORDER BY linked_at')).rows;
      const me = on() ? await api('getMe', {}) : null;
      // why the bot can not be reached (never the token itself): 401 Unauthorized = the token is wrong
      const raw = String(process.env.TG_PAY_BOT_TOKEN || '');
      const shape = raw ? ('length ' + raw.length + (raw !== raw.trim() ? ', has spaces at the ends' : '') + (/\s/.test(raw.trim()) ? ', has spaces inside' : '') + (/^\d{5,}:/.test(raw.trim()) ? '' : ', does not start with numbers and ":"')) : 'empty';
      let hookInfo = null;
      if (me && me.ok) {                                                     // is Telegram really sending here? (set it again when not)
        const w = await api('getWebhookInfo', {});
        if (w && w.ok) {
          if (!String(w.result.url || '').endsWith('/api/tg-pay/hook')) { await hook(); }
          hookInfo = { url: w.result.url || '', pending: w.result.pending_update_count || 0, lastError: w.result.last_error_message || '' };
        }
      }
      res.json({ success: true, on: on(), hook: hookInfo, bot: me && me.ok ? me.result.username : '', botError: me && me.ok ? '' : lastErr, tokenShape: me && me.ok ? '' : shape, chats });
    } catch (e) { console.error('[tg-pay] admin:', e.message); res.status(500).json({ success: false, error: 'Could not do it.' }); }
  });

  // a message without buttons (e.g. "💳 received $10 by PayWay")
  async function notify(lines) {
    if (!on()) return false;
    try { await ensure(); for (const c of (await pool.query('SELECT chat_id FROM tg_pay_chats')).rows) await api('sendMessage', { chat_id: c.chat_id, text: lines.map(esc).join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }); return true; }
    catch (e) { console.error('[tg-pay] notify:', e.message); return false; }
  }
  return { ask, on, notify };
};
