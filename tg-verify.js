// 📱 Phone number check by CamFeed's own Telegram bot (free; no Telegram Gateway credits).
// The person types the number in CamFeed -> taps "Verify in Telegram" -> the bot opens with a "📱 Share my phone number" button ->
// Telegram itself sends the number of THAT Telegram account (it can not be typed or faked) -> it must be the same number.
// Render › Environment: TG_VERIFY_BOT_TOKEN = the token @BotFather gave for a NEW bot (only for this; not the payments bot).
'use strict';
const crypto = require('crypto');

const WAIT_MINUTES = 10;

module.exports = function ({ app, pool, baseUrl }) {
  const token = () => String(process.env.TG_VERIFY_BOT_TOKEN || '').trim();
  const on = () => /^\d{5,}:\S{20,}$/.test(token());
  const secret = () => crypto.createHash('sha256').update('camfeed-verify:' + token()).digest('hex').slice(0, 40);

  let ready = null;
  function ensure() {
    if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS phone_tg_requests (
        token VARCHAR(40) PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        purpose VARCHAR(20) NOT NULL,
        chat_id BIGINT,
        status VARCHAR(12) NOT NULL DEFAULT 'wait',
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
      .then(() => pool.query('CREATE INDEX IF NOT EXISTS phone_tg_requests_chat ON phone_tg_requests (chat_id, created_at DESC)'))
      .catch((e) => { ready = null; throw e; });
    return ready;
  }

  // plain https over IPv4, tried twice (same as the payments bot)
  function post(method, body) {
    const https = require('https');
    const data = Buffer.from(JSON.stringify(body || {}));
    return new Promise((ok, no) => {
      const rq = https.request({ hostname: 'api.telegram.org', path: `/bot${token()}/${method}`, method: 'POST', family: 4, timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (rs) => {
        const parts = []; rs.on('data', (c) => parts.push(c));
        rs.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { ok({ ok: false, description: 'bad answer' }); } });
      });
      rq.on('timeout', () => rq.destroy(new Error('timeout')));
      rq.on('error', no);
      rq.end(data);
    });
  }
  async function api(method, body) {
    if (!on()) return null;
    for (let i = 0; i < 2; i++) { try { return await post(method, body); } catch (e) { if (i) console.error('[tg-verify]', method, e.message); } }
    return null;
  }

  let botName = '';
  async function username() {
    if (botName || !on()) return botName;
    const me = await api('getMe', {});
    if (me && me.ok) botName = me.result.username || '';
    return botName;
  }
  async function hook() {
    if (!on()) return;
    const url = String(baseUrl() || 'https://camfeedkh.com').replace(/\/+$/, '') + '/api/tg-verify/hook';
    const r = await api('setWebhook', { url, secret_token: secret(), allowed_updates: ['message'], drop_pending_updates: true });
    if (!r || !r.ok) console.error('[tg-verify] webhook not set:', r && r.description);
    else console.log('[tg-verify] bot ready: @' + (await username()));
  }
  setTimeout(() => { ensure().then(hook).catch((e) => console.error('[tg-verify] start:', e.message)); }, 25 * 1000);

  const send = (chat_id, text, extra) => api('sendMessage', Object.assign({ chat_id, text, disable_web_page_preview: true }, extra || {}));
  const shareKb = { keyboard: [[{ text: '📱 ចែករំលែកលេខទូរស័ព្ទ / Share my phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
  const noKb = { remove_keyboard: true };
  const digits = (s) => String(s || '').replace(/\D/g, '');

  app.post('/api/tg-verify/hook', async (req, res) => {
    if (!on() || req.get('X-Telegram-Bot-Api-Secret-Token') !== secret()) return res.status(403).end();
    res.json({ ok: true });
    try {
      await ensure();
      const m = req.body && req.body.message;
      if (!m || !m.chat || m.chat.type !== 'private' || !m.from) return;
      const chat = m.chat.id;

      // 1) "/start pv_<token>": the person came from CamFeed -> ask for the number
      const st = /^\/start\s+pv_([a-f0-9]{32})$/.exec(String(m.text || '').trim());
      if (st) {
        const r = (await pool.query(`UPDATE phone_tg_requests SET chat_id = $2 WHERE token = $1 AND status = 'wait'
          AND created_at > NOW() - INTERVAL '${WAIT_MINUTES} minutes' RETURNING phone`, [st[1], chat])).rows[0];
        if (!r) { await send(chat, '❌ តំណនេះផុតកំណត់ហើយ។ សូមត្រឡប់ទៅ CamFeed ហើយចុច "បញ្ជាក់តាម Telegram" ម្ដងទៀត។\n\nThis link has expired. Please go back to CamFeed and try again.', { reply_markup: noKb }); return; }
        await send(chat, '👋 សូមស្វាគមន៍មកកាន់ CamFeed!\n\nដើម្បីបញ្ជាក់លេខទូរស័ព្ទរបស់អ្នក សូមចុចប៊ូតុង 📱 ខាងក្រោម។\n\nTo confirm your phone number, tap the 📱 button below.', { reply_markup: shareKb });
        return;
      }

      // 2) the shared contact: it must be the person's OWN Telegram number
      if (m.contact) {
        if (!m.contact.user_id || m.contact.user_id !== m.from.id) {
          await send(chat, '❌ សូមចុចប៊ូតុង 📱 ខាងក្រោម ដើម្បីចែករំលែកលេខរបស់អ្នកផ្ទាល់ (មិនមែនលេខរបស់អ្នកផ្សេងទេ)។\n\nPlease tap the 📱 button to share YOUR OWN number.', { reply_markup: shareKb });
          return;
        }
        const r = (await pool.query(`SELECT token, phone FROM phone_tg_requests WHERE chat_id = $1 AND status = 'wait'
          AND created_at > NOW() - INTERVAL '${WAIT_MINUTES} minutes' ORDER BY created_at DESC LIMIT 1`, [chat])).rows[0];
        if (!r) { await send(chat, '❌ មិនមានការស្នើសុំពី CamFeed ទេ ឬវាផុតកំណត់ហើយ។ សូមចាប់ផ្ដើមម្ដងទៀតពី CamFeed។\n\nNo request from CamFeed (or it expired). Please start again in CamFeed.', { reply_markup: noKb }); return; }
        if (digits(m.contact.phone_number) !== digits(r.phone)) {
          await pool.query("UPDATE phone_tg_requests SET status = 'mismatch' WHERE token = $1", [r.token]);
          await send(chat, '❌ លេខ Telegram របស់អ្នក មិនដូចលេខដែលអ្នកបានវាយក្នុង CamFeed ទេ។\nសូមត្រឡប់ទៅ CamFeed វាយលេខដែលប្រើជាមួយ Telegram នេះ ហើយសាកម្ដងទៀត។\n\nYour Telegram number is not the number you typed in CamFeed. Please go back and use the number of this Telegram account.', { reply_markup: noKb });
          return;
        }
        await pool.query("UPDATE phone_tg_requests SET status = 'ok' WHERE token = $1", [r.token]);
        await send(chat, '✅ បានបញ្ជាក់លេខទូរស័ព្ទរួចរាល់!\nសូមត្រឡប់ទៅ CamFeed វិញ ដើម្បីបន្ត។\n\nYour phone number is confirmed. Please go back to CamFeed.', { reply_markup: noKb });
        return;
      }

      // anything else
      await send(chat, '📱 Bot នេះប្រើសម្រាប់តែបញ្ជាក់លេខទូរស័ព្ទ ពេលចុះឈ្មោះ CamFeed ប៉ុណ្ណោះ។ សូមចាប់ផ្ដើមពី camfeedkh.com ឬកម្មវិធី CamFeed។\n\nThis bot only confirms phone numbers for CamFeed sign-up. Please start in CamFeed.');
    } catch (e) { console.error('[tg-verify] hook:', e.message); }
  });

  // a new request -> the link that opens the bot
  async function start(phone, purpose, ip) {
    await ensure();
    const name = await username();
    if (!name) return null;
    const t = crypto.randomBytes(16).toString('hex');
    await pool.query("DELETE FROM phone_tg_requests WHERE created_at < NOW() - INTERVAL '1 day'");
    await pool.query('INSERT INTO phone_tg_requests (token, phone, purpose, ip) VALUES ($1, $2, $3, $4)', [t, phone, purpose, String(ip || '').slice(0, 60)]);
    return { token: t, link: `https://t.me/${name}?start=pv_${t}`, expiresInSec: WAIT_MINUTES * 60 };
  }
  // 'wait' | 'ok' | 'mismatch' | 'expired'  (+ the phone of that request); an 'ok' request can be used only once
  async function status(t, purpose) {
    await ensure();
    if (!/^[a-f0-9]{32}$/.test(String(t || ''))) return { status: 'expired' };
    const r = (await pool.query(`SELECT phone, status, created_at > NOW() - INTERVAL '${WAIT_MINUTES + 5} minutes' AS fresh FROM phone_tg_requests WHERE token = $1 AND purpose = $2`, [t, purpose])).rows[0];
    if (!r || !r.fresh) return { status: 'expired' };
    if (r.status === 'ok') {
      const used = (await pool.query("DELETE FROM phone_tg_requests WHERE token = $1 AND status = 'ok' RETURNING phone", [t])).rows[0];
      return used ? { status: 'ok', phone: used.phone } : { status: 'expired' };
    }
    return { status: r.status, phone: r.phone };
  }

  return { on, start, status, username };
};
