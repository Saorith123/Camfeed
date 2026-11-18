// 🪙 Coins and 🎁 gifts (Party Room phase 2A).
//  * People buy coins on the website (ABA / ACLEDA / Wing): they pick a pack, pay, send the receipt; CamFeed checks it in
//    Admin > Coins and approves -> the coins arrive. (Google Play purchases inside the app come later, phase 2B.)
//  * In a Party Room a person spends coins on a gift for somebody on a seat. The receiver gets a share of the gift's value
//    (Admin sets the %, start 50%) in the same wallet as the creator money; it can be withdrawn after a few days (Admin sets).
//  * 1 coin = 1 US cent. Packs, the share, the waiting days, the payment details and every gift are set in the Admin panel.
module.exports = function installCoins({ app, pool, adminGate, audit, sendNotice, noticeFrom, publicIds }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const COIN_CENTS = 1;
  const DEFAULT_PACKS = [{ usd: 1, web: 120, app: 100 }, { usd: 5, web: 620, app: 500 }, { usd: 10, web: 1250, app: 1000 }, { usd: 20, web: 2550, app: 2000 }];
  const SEED = [
    // tier 1: small
    ['rose', '🌹', 'ផ្កាកុលាប', 'Rose', 1, 1], ['heart', '❤️', 'បេះដូង', 'Heart', 5, 1], ['clap', '👏', 'ទះដៃ', 'Applause', 10, 1],
    ['candy', '🍭', 'ស្ករគ្រាប់', 'Candy', 20, 1], ['rumdul', '🌸', 'ផ្ការំដួល', 'Rumdul flower', 30, 1],
    // tier 2: medium
    ['lotus', '🪷', 'ផ្កាឈូកមាស', 'Golden lotus', 50, 2], ['bouquet', '💐', 'បាច់ផ្កា', 'Bouquet', 80, 2], ['ring', '💍', 'ចិញ្ចៀនពេជ្រ', 'Diamond ring', 100, 2],
    ['cake', '🎂', 'នំខួបកំណើត', 'Birthday cake', 150, 2], ['teddy', '🧸', 'តុក្កតាខ្លាឃ្មុំ', 'Teddy bear', 200, 2],
    // tier 3: big (animation)
    ['crown', '👑', 'មកុដមាស', 'Golden crown', 500, 3], ['car', '🏎️', 'ឡានស្ព័រ', 'Sports car', 1000, 3], ['peacock', '🦚', 'ក្ងោកលាតស្លាប', 'Peacock', 1500, 3],
    ['dragon', '🐉', 'នាគមាស', 'Golden naga', 2000, 3], ['yacht', '🛥️', 'ទូកកម្សាន្ត', 'Yacht', 3000, 3],
    // tier 4: top (full screen, the sender's name to the whole room)
    ['angkor', '🏯', 'ប្រាសាទអង្គរពេលព្រះអាទិត្យរះ', 'Angkor sunrise', 5000, 4], ['garuda', '🦅', 'គ្រុឌមាស', 'Golden Garuda', 8000, 4],
    ['rocket', '🚀', 'យានអវកាស', 'Rocket', 10000, 4], ['palace', '🏰', 'វិមានមាស', 'Golden palace', 20000, 4],
  ];

  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query('CREATE TABLE IF NOT EXISTS creator_settings (key VARCHAR(40) PRIMARY KEY, value TEXT)');
        await pool.query(`CREATE TABLE IF NOT EXISTS coin_ledger (
          id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, coins INTEGER NOT NULL, kind VARCHAR(20) NOT NULL, note TEXT, ref_id INTEGER,
          created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_coin_ledger_user ON coin_ledger (user_email)');
        await pool.query(`CREATE TABLE IF NOT EXISTS gift_catalog (
          id SERIAL PRIMARY KEY, code VARCHAR(30) UNIQUE, emoji VARCHAR(16) NOT NULL, name_km VARCHAR(60) NOT NULL, name_en VARCHAR(60) NOT NULL,
          coins INTEGER NOT NULL, tier INTEGER NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT TRUE, sort INTEGER NOT NULL DEFAULT 0)`);
        const have = await pool.query('SELECT COUNT(*)::int AS n FROM gift_catalog');
        if (!have.rows[0].n) {
          let i = 0;
          for (const [code, emoji, km, en, coins, tier] of SEED) {
            await pool.query('INSERT INTO gift_catalog (code, emoji, name_km, name_en, coins, tier, sort) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (code) DO NOTHING', [code, emoji, km, en, coins, tier, i++]);
          }
        }
        await pool.query(`CREATE TABLE IF NOT EXISTS gift_events (
          id SERIAL PRIMARY KEY, room_id INTEGER, from_email TEXT NOT NULL, to_email TEXT NOT NULL, gift_id INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1,
          coins INTEGER NOT NULL, receiver_cents NUMERIC(14,4) NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('CREATE TABLE IF NOT EXISTS gift_earn (user_email TEXT PRIMARY KEY, carry_cents NUMERIC(14,6) NOT NULL DEFAULT 0)');
        await pool.query(`CREATE TABLE IF NOT EXISTS coin_topups (
          id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, usd NUMERIC(10,2) NOT NULL, coins INTEGER NOT NULL, method VARCHAR(20) NOT NULL,
          payer_ref TEXT, receipt_url TEXT, status VARCHAR(12) NOT NULL DEFAULT 'pending', note TEXT, decided_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ)`);
        await pool.query('ALTER TABLE party_messages ADD COLUMN IF NOT EXISTS to_email TEXT').catch(() => {});
        await pool.query('ALTER TABLE party_messages ADD COLUMN IF NOT EXISTS gift_id INTEGER').catch(() => {});
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  setTimeout(() => ensure().catch((e) => console.error('[coins] schema:', e.message)), 5000);

  // ---- settings (Admin panel) ----
  async function settings() {
    const m = {};
    try { (await pool.query("SELECT key, value FROM creator_settings WHERE key LIKE 'coin:%'")).rows.forEach((r) => { m[r.key.slice(5)] = r.value; }); } catch (e) { /* not yet */ }
    let packs = DEFAULT_PACKS;
    try { const p = JSON.parse(m.packs || 'null'); if (Array.isArray(p) && p.length) packs = p; } catch (e) { /* default */ }
    const num = (v, d, lo, hi) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
    return { packs, share: num(m.share, 50, 0, 100), holdDays: num(m.hold, 3, 0, 60), payinfo: m.payinfo || '' };
  }
  const setSetting = (k, v) => pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['coin:' + k, String(v)]);

  async function balance(email, q) {
    const r = await (q || pool).query('SELECT COALESCE(SUM(coins), 0)::int AS n FROM coin_ledger WHERE user_email = $1', [norm(email)]);
    return r.rows[0].n;
  }
  // gift money still waiting (can not be withdrawn yet)
  async function heldCents(email) {
    try {
      await ensure();
      const s = await settings(); if (!s.holdDays) return 0;
      const r = await pool.query("SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM wallet_ledger WHERE LOWER(user_email) = $1 AND kind = 'gift' AND created_at > NOW() - ($2 || ' days')::interval", [norm(email), String(s.holdDays)]);
      return r.rows[0].n;
    } catch (e) { return 0; }
  }
  const me = (req, res) => { const e = norm(req.authEmail); if (!e) res.status(401).json({ success: false, error: 'Please log in.' }); return e; };
  const giftOut = (g) => ({ id: g.id, code: g.code, emoji: g.emoji, name_km: g.name_km, name_en: g.name_en, coins: g.coins, tier: g.tier });

  // ---- what people see ----
  app.get('/api/coins', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const s = await settings();
      const gifts = await pool.query('SELECT * FROM gift_catalog WHERE active = TRUE ORDER BY tier, coins, sort');
      const tops = await pool.query('SELECT id, usd, coins, method, status, note, created_at, decided_at FROM coin_topups WHERE user_email = $1 ORDER BY id DESC LIMIT 10', [e]);
      res.json({ success: true, balance: await balance(e), coinCents: COIN_CENTS, share: s.share, holdDays: s.holdDays,
        packs: s.packs.map((p, i) => ({ i, usd: Number(p.usd) || 0, coins: Number(p.web) || 0, appCoins: Number(p.app) || 0 })),
        payinfo: s.payinfo, gifts: gifts.rows.map(giftOut), topups: tops.rows });
    } catch (err) { console.error('[coins] get:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  app.get('/api/coins/history', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const r = await pool.query(`SELECT l.id, l.coins, l.kind, l.created_at, g.emoji, g.name_km, g.name_en, ge.count,
                                    u.first_name AS to_first_name, u.last_name AS to_last_name
                                  FROM coin_ledger l LEFT JOIN gift_events ge ON l.kind = 'gift' AND ge.id = l.ref_id
                                  LEFT JOIN gift_catalog g ON g.id = ge.gift_id LEFT JOIN users u ON LOWER(u.email) = ge.to_email
                                  WHERE l.user_email = $1 ORDER BY l.id DESC LIMIT 60`, [e]);
      res.json({ success: true, balance: await balance(e), items: r.rows });
    } catch (err) { res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  // website: "I paid for this pack" -> waits for CamFeed to check
  app.post('/api/coins/topup', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    try {
      await ensure();
      const s = await settings();
      const p = s.packs[parseInt(b.pack, 10)];
      if (!p) return res.status(400).json({ success: false, error: 'Please choose a pack.' });
      const method = ['ABA', 'ACLEDA', 'Wing', 'KHQR'].includes(b.method) ? b.method : '';
      if (!method) return res.status(400).json({ success: false, error: 'Please choose how you paid.' });
      const ref = String(b.ref || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const receipt = /^https:\/\//.test(String(b.receipt_url || '')) ? String(b.receipt_url).slice(0, 500) : '';
      if (!ref && !receipt) return res.status(400).json({ success: false, error: 'Please add the transaction number or a photo of the receipt.' });
      const waiting = await pool.query("SELECT COUNT(*)::int AS n FROM coin_topups WHERE user_email = $1 AND status = 'pending'", [e]);
      if (waiting.rows[0].n >= 3) return res.status(429).json({ success: false, error: 'You already have 3 requests waiting. Please wait for CamFeed to check them.' });
      const r = await pool.query('INSERT INTO coin_topups (user_email, usd, coins, method, payer_ref, receipt_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [e, Number(p.usd) || 0, Number(p.web) || 0, method, ref, receipt]);
      // tell the administrators
      try {
        const admins = await pool.query("SELECT email FROM users WHERE role IN ('admin', 'super_admin')");
        const who = await pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email) = $1', [e]);
        const name = who.rows[0] ? (who.rows[0].first_name + ' ' + who.rows[0].last_name).trim() : 'a member';
        for (const a of admins.rows) await pool.query("INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, NULL, 'admin_notice', $3, FALSE)", [a.email, e, '🪙 New coin top-up from ' + name + ': $' + Number(p.usd).toFixed(2) + ' (' + method + '). Open Admin → System → Coins to check it.']).catch(() => {});
      } catch (x) { /* best effort */ }
      res.json({ success: true, id: r.rows[0].id });
    } catch (err) { console.error('[coins] topup:', err.message); res.status(500).json({ success: false, error: 'Could not send.' }); }
  });

  // ---- 🎁 send a gift in a Party Room ----
  app.post('/api/party/rooms/:id/gift', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const b = req.body || {};
    const roomId = parseInt(req.params.id, 10) || 0;
    const count = Math.min(Math.max(parseInt(b.count, 10) || 1, 1), 99);
    let to = norm(b.to_email);
    if (/^1\d{14}$/.test(to) && publicIds) { try { const m = await publicIds.toEmails([to]); to = norm(m.get(to) || to); } catch (x) { /* keep */ } }
    if (!to || to === e) return res.status(400).json({ success: false, code: 'self', error: 'Choose somebody else.' });
    const c = await pool.connect();
    try {
      await ensure();
      const room = await c.query("SELECT id FROM party_rooms WHERE id = $1 AND status = 'open'", [roomId]);
      if (!room.rows.length) { c.release(); return res.status(404).json({ success: false, code: 'closed', error: 'This room has ended.' }); }
      const both = await c.query('SELECT user_email FROM party_members WHERE room_id = $1 AND user_email = ANY($2::text[])', [roomId, [e, to]]);
      if (both.rows.length < 2) { c.release(); return res.status(404).json({ success: false, code: 'gone', error: 'This person has left the room.' }); }
      const g = (await c.query('SELECT * FROM gift_catalog WHERE id = $1 AND active = TRUE', [parseInt(b.gift_id, 10) || 0])).rows[0];
      if (!g) { c.release(); return res.status(400).json({ success: false, code: 'gift', error: 'This gift is not available.' }); }
      const cost = g.coins * count;
      const s = await settings();
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['coins:' + e]);
      const have = await balance(e, c);
      if (have < cost) { await c.query('ROLLBACK'); c.release(); return res.status(402).json({ success: false, code: 'coins', balance: have, error: 'Not enough coins.' }); }
      const share = cost * COIN_CENTS * s.share / 100;               // cents for the receiver (may have a fraction)
      const ev = await c.query('INSERT INTO gift_events (room_id, from_email, to_email, gift_id, count, coins, receiver_cents) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [roomId, e, to, g.id, count, cost, share]);
      const evId = ev.rows[0].id;
      await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'gift', $3, $4, $1)", [e, -cost, 'Gift ' + g.code + ' x' + count, evId]);
      if (share > 0) {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gift:' + to]);
        const cr = await c.query(`INSERT INTO gift_earn (user_email, carry_cents) VALUES ($1, $2) ON CONFLICT (user_email) DO UPDATE SET carry_cents = gift_earn.carry_cents + $2 RETURNING carry_cents`, [to, share]);
        const whole = Math.floor(Number(cr.rows[0].carry_cents));
        if (whole > 0) {
          await c.query('UPDATE gift_earn SET carry_cents = carry_cents - $2 WHERE user_email = $1', [to, whole]);
          await c.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, ref_id, created_by) VALUES ($1, $2, 'gift', 'Gifts in Party Room', $3, 'system')", [to, whole, evId]);
        }
      }
      await c.query("INSERT INTO party_messages (room_id, user_email, kind, text, to_email, gift_id) VALUES ($1, $2, 'gift', $3, $4, $5)", [roomId, e, String(count), to, g.id]);
      await c.query('COMMIT');
      c.release();
      res.json({ success: true, balance: have - cost });
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch (x) { /* nothing open */ }
      c.release();
      console.error('[coins] gift:', err.message);
      res.status(500).json({ success: false, error: 'Could not send the gift.' });
    }
  });

  // ---- Admin › System › 🪙 Coins & gifts ----
  app.post('/api/admin/coins', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const superOnly = () => { if (!a.isSuperAdmin) { res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' }); return false; } return true; };
      const act = String(b.action || '');
      if (act === 'settings') {
        if (!superOnly()) return;
        if (Array.isArray(b.packs)) {
          const packs = b.packs.map((p) => ({ usd: Math.round(Number(p.usd) * 100) / 100, web: parseInt(p.web, 10), app: parseInt(p.app, 10) }))
            .filter((p) => p.usd > 0 && p.usd <= 1000 && p.web > 0 && p.web <= 1000000 && p.app >= 0 && p.app <= 1000000).slice(0, 8);
          if (!packs.length) return res.status(400).json({ success: false, error: 'Add at least one pack (price > 0 and coins > 0).' });
          await setSetting('packs', JSON.stringify(packs));
        }
        if (b.share !== undefined) { const v = Number(b.share); if (!(v >= 0 && v <= 100)) return res.status(400).json({ success: false, error: 'Share must be 0 to 100.' }); await setSetting('share', v); }
        if (b.hold !== undefined) { const v = Number(b.hold); if (!(v >= 0 && v <= 60)) return res.status(400).json({ success: false, error: 'Waiting days must be 0 to 60.' }); await setSetting('hold', v); }
        if (b.payinfo !== undefined) await setSetting('payinfo', String(b.payinfo).slice(0, 2000));
        audit(a.adminEmail, 'coin-settings', 'settings', 'packs / share / hold / pay info changed');
      } else if (act === 'gift') {
        if (!superOnly()) return;
        const g = b.gift || {};
        const coins = parseInt(g.coins, 10), tier = Math.min(Math.max(parseInt(g.tier, 10) || 1, 1), 4);
        const emoji = String(g.emoji || '').trim().slice(0, 16), km = String(g.name_km || '').trim().slice(0, 60), en = String(g.name_en || '').trim().slice(0, 60);
        if (!(coins > 0 && coins <= 1000000) || !emoji || !km || !en) return res.status(400).json({ success: false, error: 'Fill in the picture (emoji), both names and the price in coins.' });
        if (g.id) await pool.query('UPDATE gift_catalog SET emoji = $2, name_km = $3, name_en = $4, coins = $5, tier = $6, active = $7 WHERE id = $1', [parseInt(g.id, 10), emoji, km, en, coins, tier, g.active !== false]);
        else await pool.query('INSERT INTO gift_catalog (code, emoji, name_km, name_en, coins, tier, sort) VALUES ($1, $2, $3, $4, $5, $6, 999)', ['g' + Date.now(), emoji, km, en, coins, tier]);
        audit(a.adminEmail, 'gift-catalog', String(g.id || 'new'), en + ' ' + coins + ' coins' + (g.active === false ? ' (off)' : ''));
      } else if (act === 'decide') {
        if (!superOnly()) return;
        const st = b.status === 'approved' ? 'approved' : 'rejected';
        const note = String(b.note || '').trim().slice(0, 300);
        if (st === 'rejected' && !note) return res.status(400).json({ success: false, error: 'Please write the reason.' });
        const up = await pool.query("UPDATE coin_topups SET status = $2, note = $3, decided_by = $4, decided_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *", [parseInt(b.id, 10) || 0, st, note, a.adminEmail]);
        const t = up.rows[0];
        if (!t) return res.status(409).json({ success: false, error: 'Already decided.' });
        if (st === 'approved') {
          await pool.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'topup', $3, $4, $5)", [t.user_email, t.coins, 'Top-up $' + Number(t.usd).toFixed(2) + ' ' + t.method, t.id, a.adminEmail]);
          await sendNotice(a.adminEmail, t.user_email, '🪙 អបអរសាទរ! CamFeed បានបញ្ចូល ' + t.coins + ' កាក់ ទៅក្នុងគណនីរបស់អ្នករួចហើយ។ អរគុណ!').catch(() => {});
        } else {
          await sendNotice(a.adminEmail, t.user_email, 'សំណើបញ្ចូលកាក់ $' + Number(t.usd).toFixed(2) + ' របស់អ្នកមិនត្រូវបានអនុម័តទេ។ មូលហេតុ៖ ' + note + '។ សូមទាក់ទង CamFeed បើមានចម្ងល់។').catch(() => {});
        }
        audit(a.adminEmail, 'coin-topup-' + st, t.user_email, '$' + Number(t.usd).toFixed(2) + ' ' + t.coins + ' coins ' + note);
      } else if (act === 'adjust') {
        if (!superOnly()) return;
        const who = String(b.user || '').trim();
        const u = (await pool.query('SELECT email FROM users WHERE LOWER(email) = LOWER($1) OR public_id = $1 LIMIT 1', [who])).rows[0];
        if (!u) return res.status(404).json({ success: false, error: 'No such person (use their e-mail, phone account or 15-digit id).' });
        const coins = parseInt(b.coins, 10);
        if (!coins || Math.abs(coins) > 10000000) return res.status(400).json({ success: false, error: 'Enter the number of coins (+ to add, - to take).' });
        if (coins < 0 && (await balance(u.email)) + coins < 0) return res.status(400).json({ success: false, error: 'That would make the coins negative.' });
        await pool.query("INSERT INTO coin_ledger (user_email, coins, kind, note, created_by) VALUES ($1, $2, 'admin', $3, $4)", [norm(u.email), coins, String(b.note || '').slice(0, 200), a.adminEmail]);
        if (coins > 0) await sendNotice(a.adminEmail, norm(u.email), '🪙 CamFeed បានបញ្ចូល ' + coins + ' កាក់ ទៅក្នុងគណនីរបស់អ្នក។').catch(() => {});
        audit(a.adminEmail, 'coin-adjust', u.email, coins + ' coins ' + String(b.note || ''));
      }
      const s = await settings();
      const gifts = await pool.query('SELECT * FROM gift_catalog ORDER BY tier, coins, sort');
      const pending = await pool.query(`SELECT t.*, u.first_name, u.last_name FROM coin_topups t LEFT JOIN users u ON LOWER(u.email) = t.user_email
                                        WHERE t.status = 'pending' ORDER BY t.id LIMIT 200`);
      const recent = await pool.query(`SELECT t.*, u.first_name, u.last_name FROM coin_topups t LEFT JOIN users u ON LOWER(u.email) = t.user_email
                                       WHERE t.status <> 'pending' ORDER BY t.decided_at DESC NULLS LAST LIMIT 30`);
      const tot = await pool.query(`SELECT (SELECT COALESCE(SUM(usd), 0) FROM coin_topups WHERE status = 'approved') AS sold_usd,
                                           (SELECT COALESCE(SUM(coins), 0) FROM gift_events) AS gift_coins,
                                           (SELECT COALESCE(SUM(receiver_cents), 0) FROM gift_events) AS receiver_cents`);
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, settings: s, gifts: gifts.rows, pending: pending.rows, recent: recent.rows, totals: tot.rows[0] });
    } catch (err) { console.error('[coins] admin:', err.message); if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  return { heldCents, balance };
};
