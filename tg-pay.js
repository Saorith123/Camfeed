// 💰 Payments, step 1: a person pays to CamFeed's QR, presses "I paid", and CamFeed's own Telegram bot asks the owner:
// "✅ received / ❌ not received". Nothing starts before the owner presses ✅ (from Telegram, or in Admin as before).
// Render › Environment: TG_PAY_BOT_TOKEN = the token @BotFather gave (a NEW bot only for this). The owner links his Telegram in
// Admin › 📢 Ads › 💰 Telegram for payments (a one-time code), so only the linked Telegram accounts can press the buttons.
'use strict';
const crypto = require('crypto');

module.exports = function ({ app, pool, adminGate, audit, baseUrl, onDecide }) {
  const token = () => String(process.env.TG_PAY_BOT_TOKEN || '').trim();
  const on = () => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token());
  const secret = () => crypto.createHash('sha256').update('camfeed-pay:' + token()).digest('hex').slice(0, 40);
  let ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS tg_pay_chats (chat_id BIGINT PRIMARY KEY, user_id BIGINT, name TEXT, linked_by TEXT, linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE TABLE IF NOT EXISTS tg_pay_state (k TEXT PRIMARY KEY, v TEXT, at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  async function api(method, body) {
    if (!on()) return null;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal });
      return await r.json();
    } catch (e) { return null; } finally { clearTimeout(t); }
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
      res.json({ success: true, on: on(), bot: me && me.ok ? me.result.username : '', chats });
    } catch (e) { console.error('[tg-pay] admin:', e.message); res.status(500).json({ success: false, error: 'Could not do it.' }); }
  });

  return { ask, on };
};
