// 💳 The ad wallet (pay first, like Facebook): the advertiser puts money in once, every ad is paid from it at once.
// Money comes in by ABA PayWay KHQR (any Cambodian bank app can scan it): CamFeed asks PayWay for a QR with the exact amount,
// PayWay tells us when it is paid (callback), and we ALWAYS ask PayWay again (Check Transaction) before adding the money — a callback alone is never trusted.
// The wallet is the same money as the old "ad credit" (leftovers and refunds of ads go back into it). It can not be turned into coins,
// sent to someone else or taken out as cash (only CamFeed can give money back, by hand).
// Render env: PAYWAY_MERCHANT_ID, PAYWAY_API_KEY (the "Public Key" from PayWay), PAYWAY_API_URL (sandbox or production address).
'use strict';
const crypto = require('crypto');

module.exports = function ({ app, pool, adminGate, audit, baseUrl, tgNotify, sendNotice, creditEnsure, balanceOf }) {
  const cfg = { minUsd: 2, maxUsd: 1000 };
  const env = () => ({ mid: String(process.env.PAYWAY_MERCHANT_ID || '').trim(), key: String(process.env.PAYWAY_API_KEY || '').trim(), url: String(process.env.PAYWAY_API_URL || '').trim() });
  const on = () => { const e = env(); return !!(e.mid && e.key && e.url); };
  const origin = () => { try { return new URL(env().url).origin; } catch (e) { return ''; } };
  const sandbox = () => /sandbox/i.test(env().url);
  let lastErr = '';

  let ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await creditEnsure();
      await pool.query(`CREATE TABLE IF NOT EXISTS ad_wallet_topups (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, cents INTEGER NOT NULL, tran_id VARCHAR(20) UNIQUE,
        status VARCHAR(12) NOT NULL DEFAULT 'pending', method VARCHAR(12) NOT NULL DEFAULT 'payway', apv TEXT, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, checked_at TIMESTAMPTZ)`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_ad_wallet_topups_user ON ad_wallet_topups (user_email, id DESC)');
      await pool.query('CREATE TABLE IF NOT EXISTS ad_wallet_cfg (k VARCHAR(20) PRIMARY KEY, v TEXT NOT NULL)');
      (await pool.query('SELECT k, v FROM ad_wallet_cfg')).rows.forEach((x) => { const n = Number(x.v); if (x.k in cfg && n > 0) cfg[x.k] = n; });
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  ensure().catch((e) => console.error('[ad-wallet]', e.message));

  const hmac = (s) => crypto.createHmac('sha512', env().key).update(s, 'utf8').digest('base64');
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const reqTime = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);    // UTC YYYYMMDDHHmmss

  async function payway(path, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(origin() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const d = await r.json().catch(() => null);
      return { http: r.status, d };
    } finally { clearTimeout(t); }
  }

  // a KHQR with the exact amount (USD)
  async function makeQr(tranId, cents, minutes) {
    const e = env();
    const amount = Math.round(cents) / 100;
    const f = {
      req_time: reqTime(), merchant_id: e.mid, tran_id: tranId, amount: String(amount), items: '', first_name: '', last_name: '', email: '', phone: '',
      purchase_type: 'purchase', payment_option: 'abapay_khqr', callback_url: b64(String(baseUrl() || 'https://camfeedkh.com').replace(/\/+$/, '') + '/api/payway/callback'),
      return_deeplink: '', currency: 'USD', custom_fields: '', return_params: '', payout: '', lifetime: String(minutes), qr_image_template: 'template3_color',
    };
    const b4 = f.req_time + f.merchant_id + f.tran_id + f.amount + f.items + f.first_name + f.last_name + f.email + f.phone + f.purchase_type + f.payment_option
      + f.callback_url + f.return_deeplink + f.currency + f.custom_fields + f.return_params + f.payout + f.lifetime + f.qr_image_template;
    const body = { req_time: f.req_time, merchant_id: f.merchant_id, tran_id: f.tran_id, amount, purchase_type: f.purchase_type, payment_option: f.payment_option,
      callback_url: f.callback_url, currency: f.currency, lifetime: minutes, qr_image_template: f.qr_image_template, hash: hmac(b4) };
    const { http, d } = await payway('/api/payment-gateway/v1/payments/generate-qr', body);
    const code = d && d.status && String(d.status.code);
    if (code !== '0' && code !== '00') { lastErr = 'QR ' + http + ' code ' + code + ': ' + ((d && d.status && d.status.message) || ''); console.error('[ad-wallet]', lastErr); return { error: lastErr, code }; }
    return { qrImage: d.qrImage || '', qrString: d.qrString || '', deeplink: d.abapay_deeplink || '', appStore: d.app_store || '', playStore: d.play_store || '' };
  }

  // ask PayWay: is this transaction really paid, and how much?
  async function checkPaid(tranId) {
    const e = env(), t = reqTime();
    const { d } = await payway('/api/payment-gateway/v1/payments/check-transaction-2', { req_time: t, merchant_id: e.mid, tran_id: tranId, hash: hmac(t + e.mid + tranId) });
    if (!d || !d.status) return { state: 'unknown' };
    if (String(d.status.code) !== '00') return { state: String(d.status.code) === '6' ? 'notfound' : 'unknown', why: d.status.message };
    const x = d.data || {};
    if (Number(x.payment_status_code) === 0 && String(x.payment_status || '').toUpperCase() === 'APPROVED') return { state: 'paid', usd: Number(x.original_amount != null ? x.original_amount : (x.total_amount != null ? x.total_amount : x.payment_amount)), cur: x.payment_currency, apv: x.apv };
    return { state: String(x.payment_status || 'pending').toLowerCase() };
  }

  // the money goes in ONCE (the row changes from pending to paid in one step)
  async function settle(row, info) {
    if (info.cur && String(info.cur).toUpperCase() !== 'USD') return false;
    if (!(Math.round(Number(info.usd) * 100) >= row.cents)) { console.error('[ad-wallet] amount differs', row.id, info.usd); return false; }
    const r = await pool.query("UPDATE ad_wallet_topups SET status = 'paid', paid_at = NOW(), apv = $2 WHERE id = $1 AND status = 'pending' RETURNING *", [row.id, String(info.apv || '')]);
    if (!r.rows.length) return false;
    await pool.query("INSERT INTO ad_credit (user_email, cents, kind, ref_id, note) VALUES ($1, $2, 'topup', $3, $4)", [row.user_email, row.cents, row.id, 'W' + row.id + ' ABA PayWay']);
    const u = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [row.user_email])).rows[0] || {};
    tgNotify(['💳 បានទទួល $' + (row.cents / 100).toFixed(2) + ' (W' + row.id + ')' + (sandbox() ? ' · 🧪 sandbox' : ''), '👤 ' + ((u.first_name || '') + ' ' + (u.last_name || '')).trim(), '✅ PayWay បានបញ្ជាក់ ហើយលុយចូលកាបូបពាណិជ្ជកម្មរួច']).catch(() => {});
    sendNotice('CamFeed', row.user_email, '💳 បានបញ្ចូល $' + (row.cents / 100).toFixed(2) + ' ក្នុងកាបូបពាណិជ្ជកម្មរបស់អ្នកហើយ។ អរគុណ!').catch(() => {});
    return true;
  }
  async function recheck(row) {
    if (!on() || row.status !== 'pending' || !row.tran_id) return row.status;
    await pool.query('UPDATE ad_wallet_topups SET checked_at = NOW() WHERE id = $1', [row.id]);
    const info = await checkPaid(row.tran_id).catch(() => ({ state: 'unknown' }));
    if (info.state === 'paid' && await settle(row, info)) return 'paid';
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now() - 10 * 60 * 1000 && info.state !== 'paid') {
      await pool.query("UPDATE ad_wallet_topups SET status = 'expired' WHERE id = $1 AND status = 'pending'", [row.id]);
      return 'expired';
    }
    return 'pending';
  }

  // ---------- the advertiser ----------
  app.get('/api/ad-wallet', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      await ensure();
      const bal = await balanceOf(me);
      const h = (await pool.query(`SELECT cents, kind, ref_id, note, created_at FROM ad_credit WHERE user_email = $1 ORDER BY id DESC LIMIT 50`, [me])).rows;
      res.json({ success: true, balance: bal, payway: on(), sandbox: on() && sandbox(), min: cfg.minUsd, max: cfg.maxUsd, history: h.map((x) => ({ cents: Number(x.cents), kind: x.kind, ref: x.ref_id, at: x.created_at })) });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  const hits = new Map();
  app.post('/api/ad-wallet/topup', async (req, res) => {
    try {
      const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
      if (!on()) return res.status(503).json({ success: false, code: 'off', error: 'Adding money by ABA PayWay is not ready yet.' });
      await ensure();
      const now = Date.now(), h = (hits.get(me) || []).filter((t) => now - t < 3600 * 1000);
      if (h.length >= 15) return res.status(429).json({ success: false, error: 'Please wait a little and try again.' });
      h.push(now); hits.set(me, h); if (hits.size > 5000) hits.clear();
      const usd = Math.round(Number((req.body || {}).amount) * 100) / 100;
      if (!(usd >= cfg.minUsd && usd <= cfg.maxUsd)) return res.status(400).json({ success: false, code: 'amount', min: cfg.minUsd, max: cfg.maxUsd, error: 'The amount must be from $' + cfg.minUsd + ' to $' + cfg.maxUsd + '.' });
      const minutes = 30;
      const r = await pool.query("INSERT INTO ad_wallet_topups (user_email, cents, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes') RETURNING id", [me, Math.round(usd * 100)]);
      const id = r.rows[0].id, tranId = ('CFW' + id + 'T' + Date.now().toString(36)).slice(0, 20);
      await pool.query('UPDATE ad_wallet_topups SET tran_id = $2 WHERE id = $1', [id, tranId]);
      const q = await makeQr(tranId, Math.round(usd * 100), minutes);
      if (q.error) {
        await pool.query("UPDATE ad_wallet_topups SET status = 'failed', note = $2 WHERE id = $1", [id, q.error.slice(0, 300)]);
        return res.status(502).json({ success: false, code: 'payway', why: q.code, error: 'ABA PayWay did not give a QR. Please try again later.' });
      }
      res.status(201).json({ success: true, id, code: 'W' + id, amount: usd, minutes, sandbox: sandbox(), qrImage: q.qrImage, deeplink: q.deeplink, appStore: q.appStore, playStore: q.playStore });
    } catch (e) { console.error('[ad-wallet] topup:', e.message); res.status(500).json({ success: false, error: 'Could not do it.' }); }
  });

  // the page asks every few seconds: paid yet? (asks PayWay itself at most every 5 s)
  app.get('/api/ad-wallet/topup/:id', async (req, res) => {
    try {
      const me = req.authEmail, id = parseInt(req.params.id, 10); if (!me || !(id > 0)) return res.status(400).json({ success: false });
      await ensure();
      const row = (await pool.query('SELECT * FROM ad_wallet_topups WHERE id = $1 AND user_email = $2', [id, me])).rows[0];
      if (!row) return res.status(404).json({ success: false });
      let st = row.status;
      if (st === 'pending' && (!row.checked_at || Date.now() - new Date(row.checked_at).getTime() > 5000)) st = await recheck(row);
      res.json({ success: true, status: st, balance: await balanceOf(me) });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  // PayWay calls this when someone paid. We never trust it alone: PayWay is asked again before the money goes in.
  app.post('/api/payway/callback', async (req, res) => {
    res.json({ ok: true });
    try {
      if (!on()) return;
      await ensure();
      const tranId = String((req.body || {}).tran_id || '').slice(0, 20);
      if (!/^CFW\d+T[a-z0-9]+$/i.test(tranId)) return;
      const row = (await pool.query("SELECT * FROM ad_wallet_topups WHERE tran_id = $1 AND status = 'pending'", [tranId])).rows[0];
      if (row) await recheck(row);
    } catch (e) { console.error('[ad-wallet] callback:', e.message); }
  });

  // in case the callback never came: the open ones are checked every minute (for 40 minutes)
  setInterval(async () => {
    try {
      if (!on()) return; await ensure();
      const rows = (await pool.query("SELECT * FROM ad_wallet_topups WHERE status = 'pending' AND method = 'payway' AND created_at > NOW() - INTERVAL '40 minutes' AND (checked_at IS NULL OR checked_at < NOW() - INTERVAL '50 seconds') ORDER BY id LIMIT 20")).rows;
      for (const r of rows) await recheck(r);
      await pool.query("UPDATE ad_wallet_topups SET status = 'expired' WHERE status = 'pending' AND created_at < NOW() - INTERVAL '40 minutes'");
    } catch (e) {}
  }, 60 * 1000);

  // ---------- Admin ----------
  app.post('/api/admin/ad-wallet', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const b = req.body || {}, act = String(b.action || 'list');
      if (act === 'list') {
        const people = (await pool.query(`SELECT c.user_email AS email, u.first_name, u.last_name, SUM(c.cents)::numeric AS balance, MAX(c.created_at) AS last
          FROM ad_credit c LEFT JOIN users u ON u.email = c.user_email GROUP BY c.user_email, u.first_name, u.last_name HAVING SUM(c.cents) <> 0 ORDER BY MAX(c.created_at) DESC LIMIT 200`)).rows;
        const topups = (await pool.query(`SELECT t.id, t.user_email, t.cents, t.status, t.method, t.note, t.created_at, t.paid_at, u.first_name, u.last_name FROM ad_wallet_topups t
          LEFT JOIN users u ON u.email = t.user_email ORDER BY t.id DESC LIMIT 100`)).rows;
        return res.json({ success: true, people: people.map((p) => Object.assign(p, { balance: Math.floor(Number(p.balance)) })), topups, cfg, payway: on(), sandbox: on() && sandbox(), lastError: lastErr, isSuperAdmin: !!a.isSuperAdmin });
      }
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only the Super Admin can change money.' });
      if (act === 'adjust') {                     // add (+) or take (−) money by hand, always with a reason
        const email = String(b.targetEmail || ''), cents = Math.round(Number(String(b.usd).replace('−', '-')) * 100), note = String(b.note || '').trim().slice(0, 200);
        if (!email || !cents || Math.abs(cents) > 1000000 || !note) return res.status(400).json({ success: false, error: 'Write the amount and the reason.' });
        if (cents < 0 && (await balanceOf(email)) + cents < 0) return res.status(400).json({ success: false, error: 'The wallet does not have that much.' });
        await pool.query("INSERT INTO ad_credit (user_email, cents, kind, note) VALUES ($1, $2, 'admin', $3)", [email, cents, note]);
        audit(a.adminEmail, 'ad_wallet_adjust', email, (cents / 100).toFixed(2) + ' · ' + note);
        sendNotice(a.adminEmail, email, (cents > 0 ? '💳 CamFeed បានបញ្ចូល $' : '💳 CamFeed បានដក $') + Math.abs(cents / 100).toFixed(2) + (cents > 0 ? ' ក្នុង' : ' ពី') + 'កាបូបពាណិជ្ជកម្មរបស់អ្នក។ មូលហេតុ៖ ' + note).catch(() => {});
        return res.json({ success: true });
      }
      if (act === 'settings') {
        for (const k of Object.keys(cfg)) if (b[k] !== undefined) { const n = Math.max(1, Math.min(100000, Math.round(Number(b[k]) || 0))); cfg[k] = n; await pool.query('INSERT INTO ad_wallet_cfg (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, String(n)]); }
        if (cfg.minUsd > cfg.maxUsd) cfg.maxUsd = cfg.minUsd;
        audit(a.adminEmail, 'ad_wallet_settings', '', JSON.stringify(cfg));
        return res.json({ success: true, cfg });
      }
      if (act === 'recheck') {                    // ask PayWay again about one top-up
        const row = (await pool.query('SELECT * FROM ad_wallet_topups WHERE id = $1', [parseInt(b.id, 10)])).rows[0];
        if (!row) return res.status(404).json({ success: false });
        if (row.status === 'expired') await pool.query("UPDATE ad_wallet_topups SET status = 'pending' WHERE id = $1", [row.id]), row.status = 'pending';
        const st = await recheck(Object.assign(row, { expires_at: null }));
        return res.json({ success: true, status: st });
      }
      res.status(400).json({ success: false });
    } catch (e) { console.error('[ad-wallet] admin:', e.message); res.status(500).json({ success: false, error: e.message }); }
  });

  return { on, ensure };
};
