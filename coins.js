// 🪙 Coins and 🎁 gifts (Party Room phase 2A).
//  * People buy coins on the website (ABA / ACLEDA / Wing): they pick a pack, pay, send the receipt; CamFeed checks it in
//    Admin > Coins and approves -> the coins arrive. (Google Play purchases inside the app come later, phase 2B.)
//  * In a Party Room a person spends coins on a gift for somebody on a seat. The receiver gets a share of the gift's value
//    (Admin sets the %, start 50%) in the same wallet as the creator money; it can be withdrawn after a few days (Admin sets).
//  * 1 coin = 1 US cent. Packs, the share, the waiting days, the payment details and every gift are set in the Admin panel.
module.exports = function installCoins({ app, pool, adminGate, audit, sendNotice, publicIds, walletCents, starShare, starsOf }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const COIN_CENTS = 1;
  // 👑 levels by XP (like Bigo): XP comes from coins spent (gifts, frames, VIP), gift coins received, minutes in rooms and the
  // daily check-in (VIP gets more of the time / check-in XP). Level N starts at DEFAULT_LEVELS[N-1] XP (50 levels; Admin can change)
  const DEFAULT_LEVELS = Array.from({ length: 50 }, (_, i) => (i === 0 ? 0 : Math.round(50 * Math.pow(i, 1.8) / 10) * 10));
  const SPEND_KINDS = ['gift', 'frame', 'vip'];
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

  // 🖼️ Party Room picture frames (our own designs, drawn by the app from colours + one emoji): bought with coins for N days
  const FRAME_SEED = [
    ['heart', 'ស៊ុមបេះដូង', 'Heart frame', '#FDA4AF,#E11D48', '💗', 'pulse', 100, 7],
    ['rumdul', 'ស៊ុមផ្ការំដួល', 'Rumdul frame', '#FDE68A,#F59E0B', '🌸', 'none', 200, 7],
    ['lotus', 'ស៊ុមផ្កាឈូក', 'Lotus frame', '#F9A8D4,#DB2777', '🪷', 'pulse', 300, 7],
    ['fire', 'ស៊ុមភ្លើង', 'Fire frame', '#FB923C,#DC2626', '🔥', 'pulse', 500, 7],
    ['kbach', 'ស៊ុមក្បាច់មាស', 'Golden kbach frame', '#FDE047,#B45309', '✨', 'spin', 800, 7],
    ['crown', 'ស៊ុមមកុដ', 'Crown frame', '#FACC15,#A855F7', '👑', 'spin', 1500, 7],
    ['naga', 'ស៊ុមនាគ', 'Naga frame', '#34D399,#0EA5E9', '🐉', 'spin', 2000, 7],
    ['diamond', 'ស៊ុមពេជ្រ', 'Diamond frame', '#A5F3FC,#6366F1', '💎', 'spin', 3000, 7],
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
        await pool.query(`CREATE TABLE IF NOT EXISTS party_frames (
          id SERIAL PRIMARY KEY, code VARCHAR(30) UNIQUE, name_km VARCHAR(60) NOT NULL, name_en VARCHAR(60) NOT NULL, colors VARCHAR(80) NOT NULL,
          emoji VARCHAR(16) NOT NULL DEFAULT '', anim VARCHAR(10) NOT NULL DEFAULT 'none', coins INTEGER NOT NULL, days INTEGER NOT NULL DEFAULT 7,
          active BOOLEAN NOT NULL DEFAULT TRUE, sort INTEGER NOT NULL DEFAULT 0)`);
        await pool.query('CREATE TABLE IF NOT EXISTS user_frames (user_email TEXT NOT NULL, frame_id INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (user_email, frame_id))');
        await pool.query('CREATE TABLE IF NOT EXISTS frame_wear (user_email TEXT PRIMARY KEY, frame_id INTEGER NOT NULL)');
        await pool.query('CREATE TABLE IF NOT EXISTS party_checkin (user_email TEXT PRIMARY KEY, last_day DATE NOT NULL, streak INTEGER NOT NULL DEFAULT 0)');   // 📅 daily check-in
        await pool.query('ALTER TABLE party_checkin ADD COLUMN IF NOT EXISTS deck TEXT');                     // this week's shuffled prizes
        await pool.query('ALTER TABLE party_checkin ADD COLUMN IF NOT EXISTS deck_pos INTEGER NOT NULL DEFAULT 0');
        await pool.query('ALTER TABLE party_checkin ADD COLUMN IF NOT EXISTS last_win DATE');                  // the last day this person won coins
        await pool.query('CREATE TABLE IF NOT EXISTS checkin_days (day DATE PRIMARY KEY, checkins INTEGER NOT NULL DEFAULT 0, winners INTEGER NOT NULL DEFAULT 0)');
        await pool.query('CREATE TABLE IF NOT EXISTS user_xp (user_email TEXT PRIMARY KEY, xp BIGINT NOT NULL DEFAULT 0, day DATE, day_room INTEGER NOT NULL DEFAULT 0)');   // XP from time in rooms + check-in
        await pool.query('CREATE TABLE IF NOT EXISTS user_vip (user_email TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)');      // 👑 VIP (bought by the month)
        if (!(await pool.query('SELECT COUNT(*)::int AS n FROM party_frames')).rows[0].n) {
          let i = 0;
          for (const [code, km, en, colors, emoji, anim, coins, days] of FRAME_SEED) {
            await pool.query('INSERT INTO party_frames (code, name_km, name_en, colors, emoji, anim, coins, days, sort) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (code) DO NOTHING', [code, km, en, colors, emoji, anim, coins, days, i++]);
          }
        }
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
    let levels = DEFAULT_LEVELS;
    try { const l = JSON.parse(m.xp_levels || 'null'); if (Array.isArray(l) && l.length) levels = l.map((x) => parseInt(x, 10)).filter((x) => x >= 0).sort((a, b) => a - b); } catch (e) { /* default */ }
    return { packs, share: num(m.share, 50, 0, 100), holdDays: num(m.hold, 3, 0, 60), payinfo: m.payinfo || '', walletOn: m.wallet_on !== '0',
      // 🎁 the check-in gift box, by the week: in every 7 check-ins the prizes are fixed (default 0 coins ×2, 1 coin ×3, 2 coins ×2
      // = 7 coins a week) and come in a shuffled order — Admin sets them
      checkinDeck: (() => { try { const l = JSON.parse(m.checkin_deck || 'null'); if (Array.isArray(l) && l.length) { const d = l.map((x) => ({ coins: Math.max(0, parseInt(x.coins, 10) || 0), times: Math.max(0, parseInt(x.times, 10) || 0) })).filter((x) => x.times > 0); if (d.length) return d; } } catch (e) { /* default */ }
        return [{ coins: 0, times: 2 }, { coins: 1, times: 3 }, { coins: 2, times: 2 }]; })(),
      checkinWinners: num(m.checkin_winners, 20, 0, 1000000), checkinCooldown: num(m.checkin_cooldown, 7, 0, 365),
      checkinOn: m.checkin_on !== '0', checkin: (() => { try { const l = JSON.parse(m.checkin || 'null'); if (Array.isArray(l) && l.length === 7) return l.map((x) => Math.max(0, parseInt(x, 10) || 0)); } catch (e) { /* default */ } return [5, 5, 10, 10, 15, 20, 50]; })(),
      levels, vipOn: m.vip_on !== '0',
      xp: { spend: num(m.xp_spend, 1, 0, 100), receive: num(m.xp_recv, 2, 0, 100), listen: num(m.xp_listen, 1, 0, 100), seat: num(m.xp_seat, 2, 0, 100),
        roomMax: num(m.xp_room_max, 60, 0, 10000), checkin: num(m.xp_checkin, 20, 0, 100000), vipBonus: num(m.xp_vip_bonus, 20, 0, 500) },
      perks: { nameColor: num(m.perk_name_color, 10, 0, 1000), entry: num(m.perk_entry, 20, 0, 1000) }, vipPrice: num(m.vip_price, 3000, 1, 10000000), vipDays: num(m.vip_days, 30, 1, 365) };
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
        walletOn: s.walletOn, walletCents: walletCents ? await walletCents(e) : 0,
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

  // ---- 💰 change money in my wallet (rewards, video earnings, gifts...) into coins: at once, no checking needed ----
  //      The money never leaves CamFeed, so it is allowed even for gift money still waiting its days.
  app.post('/api/coins/from-wallet', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const c = await pool.connect();
    try {
      await ensure();
      const s = await settings();
      if (!s.walletOn) { c.release(); return res.status(403).json({ success: false, code: 'off', error: 'Not available now.' }); }
      const p = s.packs[parseInt((req.body || {}).pack, 10)];
      if (!p) { c.release(); return res.status(400).json({ success: false, error: 'Please choose a pack.' }); }
      const cents = Math.round((Number(p.usd) || 0) * 100), coins = Number(p.web) || 0;
      if (!(cents > 0 && coins > 0)) { c.release(); return res.status(400).json({ success: false }); }
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wallet:' + e]);
      const w = await c.query('SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM wallet_ledger WHERE LOWER(user_email) = $1', [e]);
      const have = w.rows[0].n;
      if (have < cents) { await c.query('ROLLBACK'); c.release(); return res.status(402).json({ success: false, code: 'wallet', walletCents: have, needCents: cents, error: 'Your wallet does not have enough money.' }); }
      const ins = await c.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, created_by) VALUES ($1, $2, 'coins', $3, $1) RETURNING id", [e, -cents, 'Changed into ' + coins + ' coins']);
      await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'wallet', $3, $4, $1)", [e, coins, 'From wallet $' + (cents / 100).toFixed(2), ins.rows[0].id]);
      await c.query('COMMIT');
      c.release();
      res.json({ success: true, balance: await balance(e), walletCents: have - cents, coins });
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch (x) { /* nothing open */ }
      c.release();
      console.error('[coins] wallet:', err.message);
      res.status(500).json({ success: false, error: 'Could not change.' });
    }
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
      const ss = starShare ? await starShare(to) : null;             // ⭐ a CamFeed Star gets the Stars' share (Admin sets it)
      const share = cost * COIN_CENTS * (ss != null ? ss : s.share) / 100;   // cents for the receiver (may have a fraction)
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

  // ---- 🖼️ frames: the shop, buy, wear ----
  const frameOut = (f) => ({ id: f.id, code: f.code, name_km: f.name_km, name_en: f.name_en, colors: String(f.colors || '').split(',').map((x) => x.trim()).filter(Boolean),
    emoji: f.emoji || '', anim: f.anim || 'none', coins: f.coins, days: f.days, active: f.active });
  async function frameShop(e) {
    const list = await pool.query('SELECT * FROM party_frames WHERE active = TRUE ORDER BY coins, sort');
    const mine = await pool.query('SELECT frame_id, expires_at FROM user_frames WHERE user_email = $1 AND expires_at > NOW()', [e]);
    const w = await pool.query('SELECT frame_id FROM frame_wear WHERE user_email = $1', [e]);
    const until = new Map(mine.rows.map((x) => [x.frame_id, x.expires_at]));
    const wearing = w.rows[0] && until.has(w.rows[0].frame_id) ? w.rows[0].frame_id : null;
    return { success: true, balance: await balance(e), wearing, frames: list.rows.map((f) => ({ ...frameOut(f), until: until.get(f.id) || null })) };
  }
  app.get('/api/party/frames', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try { await ensure(); res.json(await frameShop(e)); } catch (err) { console.error('[coins] frames:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  app.post('/api/party/frames/:id/buy', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const c = await pool.connect();
    try {
      await ensure();
      const f = (await c.query('SELECT * FROM party_frames WHERE id = $1 AND active = TRUE', [parseInt(req.params.id, 10) || 0])).rows[0];
      if (!f) { c.release(); return res.status(400).json({ success: false, code: 'frame', error: 'This frame is not available.' }); }
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['coins:' + e]);
      const have = await balance(e, c);
      if (have < f.coins) { await c.query('ROLLBACK'); c.release(); return res.status(402).json({ success: false, code: 'coins', balance: have, need: f.coins, error: 'Not enough coins.' }); }
      await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, ref_id, created_by) VALUES ($1, $2, 'frame', $3, $4, $1)", [e, -f.coins, 'Frame ' + f.code + ' ' + f.days + 'd', f.id]);
      // bought again while still worn: the days are added on
      await c.query(`INSERT INTO user_frames (user_email, frame_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' days')::interval)
                     ON CONFLICT (user_email, frame_id) DO UPDATE SET expires_at = GREATEST(user_frames.expires_at, NOW()) + ($3 || ' days')::interval`, [e, f.id, String(f.days)]);
      await c.query('INSERT INTO frame_wear (user_email, frame_id) VALUES ($1, $2) ON CONFLICT (user_email) DO UPDATE SET frame_id = $2', [e, f.id]);
      await c.query('COMMIT');
      c.release();
      res.json(await frameShop(e));
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch (x) { /* nothing open */ }
      c.release();
      console.error('[coins] frame buy:', err.message);
      res.status(500).json({ success: false, error: 'Could not buy the frame.' });
    }
  });
  app.post('/api/party/frames/wear', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const id = parseInt(req.body && req.body.frame_id, 10) || 0;
      if (!id) await pool.query('DELETE FROM frame_wear WHERE user_email = $1', [e]);
      else {
        const ok = (await pool.query('SELECT 1 FROM user_frames WHERE user_email = $1 AND frame_id = $2 AND expires_at > NOW()', [e, id])).rows.length;
        if (!ok) return res.status(400).json({ success: false, error: 'Buy this frame first.' });
        await pool.query('INSERT INTO frame_wear (user_email, frame_id) VALUES ($1, $2) ON CONFLICT (user_email) DO UPDATE SET frame_id = $2', [e, id]);
      }
      res.json(await frameShop(e));
    } catch (err) { res.status(500).json({ success: false, error: 'Could not change the frame.' }); }
  });
  // ---- 👑 VIP + levels ----
  function levelOf(xp, levels) { let lv = 1; levels.forEach((t, i) => { if (xp >= t) lv = i + 1; }); return lv; }
  async function spentOf(emails) {
    const r = await pool.query(`SELECT user_email, COALESCE(SUM(-coins), 0)::int AS n FROM coin_ledger WHERE user_email = ANY($1) AND coins < 0 AND kind = ANY($2) GROUP BY user_email`, [emails.map(norm), SPEND_KINDS]);
    return new Map(r.rows.map((x) => [x.user_email, x.n]));
  }
  /// XP of each person: Map email → {xp, spent, received, activity}
  async function xpOf(emails, s) {
    const es = emails.map(norm);
    const sp = await spentOf(es);
    const rc = new Map((await pool.query('SELECT to_email AS e, COALESCE(SUM(coins), 0)::int AS n FROM gift_events WHERE to_email = ANY($1) GROUP BY to_email', [es]).catch(() => ({ rows: [] }))).rows.map((x) => [x.e, x.n]));
    const ac = new Map((await pool.query('SELECT user_email AS e, xp FROM user_xp WHERE user_email = ANY($1)', [es])).rows.map((x) => [x.e, Number(x.xp) || 0]));
    const m = new Map();
    for (const e of es) {
      const spent = sp.get(e) || 0, received = rc.get(e) || 0, activity = ac.get(e) || 0;
      m.set(e, { spent, received, activity, xp: Math.round(spent * s.xp.spend + received * s.xp.receive + activity) });
    }
    return m;
  }
  // ⏱️ XP for time in rooms: once a minute, everybody really in an open room (a seat gives more), up to a daily limit
  async function roomXpTick() {
    try {
      await ensure();
      const s = await settings();
      if (!s.xp.roomMax || (!s.xp.listen && !s.xp.seat)) return;
      await pool.query(`
        INSERT INTO user_xp (user_email, xp, day, day_room)
        SELECT m.user_email, 0, (NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date, 0 FROM party_members m JOIN party_rooms r ON r.id = m.room_id AND r.status = 'open'
        WHERE m.last_seen >= NOW() - INTERVAL '40 seconds' ON CONFLICT (user_email) DO NOTHING`);
      await pool.query(`
        WITH here AS (
          SELECT DISTINCT ON (m.user_email) m.user_email,
                 CASE WHEN m.seat IS NOT NULL THEN $1::int ELSE $2::int END * CASE WHEN EXISTS (SELECT 1 FROM user_vip v WHERE v.user_email = m.user_email AND v.expires_at > NOW()) THEN (1 + $4::numeric / 100) ELSE 1 END AS add
          FROM party_members m JOIN party_rooms r ON r.id = m.room_id AND r.status = 'open'
          WHERE m.last_seen >= NOW() - INTERVAL '40 seconds' ORDER BY m.user_email, (m.seat IS NOT NULL) DESC)
        UPDATE user_xp u SET
          day_room = CASE WHEN u.day = (NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date THEN LEAST(u.day_room + ROUND(h.add)::int, $3) ELSE LEAST(ROUND(h.add)::int, $3) END,
          xp = u.xp + GREATEST(0, (CASE WHEN u.day = (NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date THEN LEAST(u.day_room + ROUND(h.add)::int, $3) - u.day_room ELSE LEAST(ROUND(h.add)::int, $3) END)),
          day = (NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date
        FROM here h WHERE u.user_email = h.user_email`, [s.xp.seat, s.xp.listen, s.xp.roomMax, s.vipOn ? s.xp.vipBonus : 0]);
    } catch (e) { console.error('[coins] room xp:', e.message); }
  }
  setTimeout(() => { roomXpTick(); setInterval(roomXpTick, 60 * 1000); }, 80 * 1000);
  /// for party.js: Map email → {level, vip}
  async function badgesOf(emails) {
    const m = new Map();
    if (!emails.length) return m;
    try {
      await ensure();
      const s = await settings();
      const xp = await xpOf(emails, s);
      const v = new Set((await pool.query('SELECT user_email FROM user_vip WHERE user_email = ANY($1) AND expires_at > NOW()', [emails.map(norm)])).rows.map((x) => x.user_email));
      const st = starsOf ? await starsOf(emails) : new Set();
      for (const e of emails.map(norm)) {
        const lv = levelOf((xp.get(e) || {}).xp || 0, s.levels);
        // level perks (Admin sets from which level; 0 = off): a coloured name, a "Lv.N came in" banner
        m.set(e, { level: lv, vip: s.vipOn && v.has(e), star: st.has(e), nameColor: s.perks.nameColor > 0 && lv >= s.perks.nameColor, entry: s.perks.entry > 0 && lv >= s.perks.entry });
      }
    } catch (e) { /* nothing yet */ }
    return m;
  }
  async function vipInfo(e) {
    const s = await settings();
    const x = (await xpOf([e], s)).get(e) || { xp: 0, spent: 0, received: 0, activity: 0 };
    const lv = levelOf(x.xp, s.levels);
    const until = (await pool.query('SELECT expires_at FROM user_vip WHERE user_email = $1 AND expires_at > NOW()', [e])).rows[0];
    const today = (await pool.query("SELECT CASE WHEN day = (NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date THEN day_room ELSE 0 END AS n FROM user_xp WHERE user_email = $1", [e])).rows[0];
    return { success: true, balance: await balance(e), xp: x.xp, spent: x.spent, received: x.received, activity: x.activity, todayRoomXp: today ? today.n : 0,
      rules: s.xp, perks: s.perks, level: lv, levelAt: s.levels[lv - 1] || 0, nextAt: s.levels[lv] == null ? null : s.levels[lv], maxLevel: s.levels.length,
      vipOn: s.vipOn, vipUntil: until ? until.expires_at : null, vipPrice: s.vipPrice, vipDays: s.vipDays };
  }
  app.get('/api/party/vip', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try { await ensure(); res.json(await vipInfo(e)); } catch (err) { console.error('[coins] vip:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  app.post('/api/party/vip/buy', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const c = await pool.connect();
    try {
      await ensure();
      const s = await settings();
      if (!s.vipOn) { c.release(); return res.status(400).json({ success: false, error: 'VIP is not open now.' }); }
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['coins:' + e]);
      const have = await balance(e, c);
      if (have < s.vipPrice) { await c.query('ROLLBACK'); c.release(); return res.status(402).json({ success: false, code: 'coins', balance: have, need: s.vipPrice, error: 'Not enough coins.' }); }
      await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, created_by) VALUES ($1, $2, 'vip', $3, $1)", [e, -s.vipPrice, 'VIP ' + s.vipDays + 'd']);
      await c.query(`INSERT INTO user_vip (user_email, expires_at) VALUES ($1, NOW() + ($2 || ' days')::interval)
                     ON CONFLICT (user_email) DO UPDATE SET expires_at = GREATEST(user_vip.expires_at, NOW()) + ($2 || ' days')::interval`, [e, String(s.vipDays)]);
      await c.query('COMMIT');
      c.release();
      res.json(await vipInfo(e));
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch (x) { /* nothing open */ }
      c.release();
      console.error('[coins] vip buy:', err.message);
      res.status(500).json({ success: false, error: 'Could not buy VIP.' });
    }
  });

  // ---- 📅 daily check-in: 7 days in a row, a few coins each day (Admin sets them); a missed day starts again at day 1 ----
  const KH_DAY = "(NOW() AT TIME ZONE 'Asia/Phnom_Penh')::date";
  async function checkinInfo(e) {
    const s = await settings();
    const r = (await pool.query(`SELECT last_day, streak, (last_day = ${KH_DAY}) AS today, (last_day = ${KH_DAY} - 1) AS yesterday FROM party_checkin WHERE user_email = $1`, [e])).rows[0];
    const done = !!(r && r.today);
    const streak = r && (r.today || r.yesterday) ? r.streak : 0;            // days in a row so far
    const nextDay = done ? null : (streak % 7) + 1;                          // the day (1–7) that today's check-in gives
    const max = s.checkinDeck.reduce((a, x) => Math.max(a, x.coins), 0);
    const week = s.checkinDeck.reduce((a, x) => a + x.coins * x.times, 0), len = s.checkinDeck.reduce((a, x) => a + x.times, 0);
    return { success: true, on: s.checkinOn, box: true, maxCoins: max, weekCoins: 0, cycle: len, winnersPerDay: s.checkinWinners, xp: s.xp.checkin, rewards: s.checkin, doneToday: done, streak, day: done ? ((streak - 1) % 7) + 1 : nextDay, balance: await balance(e) };
  }
  app.get('/api/party/checkin', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try { await ensure(); res.json(await checkinInfo(e)); } catch (err) { console.error('[coins] checkin:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });
  app.post('/api/party/checkin', async (req, res) => {
    const e = me(req, res); if (!e) return;
    const c = await pool.connect();
    try {
      await ensure();
      const s = await settings();
      if (!s.checkinOn) { c.release(); return res.status(400).json({ success: false, error: 'Check-in is not open now.' }); }
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['checkin:' + e]);
      const r = (await c.query(`SELECT streak, deck, deck_pos, (last_day = ${KH_DAY}) AS today, (last_day = ${KH_DAY} - 1) AS yesterday FROM party_checkin WHERE user_email = $1`, [e])).rows[0];
      if (r && r.today) { await c.query('ROLLBACK'); c.release(); return res.status(409).json({ success: false, code: 'done', error: 'Already checked in today.' }); }
      const streak = (r && r.yesterday ? r.streak : 0) + 1;
      const day = ((streak - 1) % 7) + 1;
      // 🎁 coins go round between people: only N winners a day (Admin), picked by chance through the whole day
      // (chance = N ÷ yesterday's check-ins, so morning and evening people have the same luck), and a winner waits
      // some days before winning again; everybody else gets the XP
      const rand = () => require('crypto').randomInt(0, 1000000) / 1000000;
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['checkin:winners']);
      await c.query(`INSERT INTO checkin_days (day) VALUES (${KH_DAY}) ON CONFLICT (day) DO NOTHING`);
      const today = (await c.query(`SELECT winners FROM checkin_days WHERE day = ${KH_DAY}`)).rows[0];
      const yest = (await c.query(`SELECT checkins FROM checkin_days WHERE day = ${KH_DAY} - 1`)).rows[0];
      const lw = (await c.query(`SELECT (last_win IS NOT NULL AND last_win > ${KH_DAY} - $2::int) AS waiting FROM party_checkin WHERE user_email = $1`, [e, s.checkinCooldown])).rows[0];
      let coins = 0;
      const prizes = s.checkinDeck.filter((x) => x.coins > 0);
      if (s.checkinWinners > 0 && prizes.length && today.winners < s.checkinWinners && !(lw && lw.waiting)) {
        const expect = Math.max(s.checkinWinners, yest ? yest.checkins : 0);
        if (rand() < s.checkinWinners / expect) {
          const tw = prizes.reduce((a, x) => a + x.times, 0);
          let roll = rand() * tw;
          for (const x of prizes) { if (roll < x.times) { coins = x.coins; break; } roll -= x.times; }
          if (!coins) coins = prizes[prizes.length - 1].coins;
        }
      }
      await c.query(`UPDATE checkin_days SET checkins = checkins + 1, winners = winners + $1 WHERE day = ${KH_DAY}`, [coins > 0 ? 1 : 0]);
      await c.query(`INSERT INTO party_checkin (user_email, last_day, streak, last_win) VALUES ($1, ${KH_DAY}, $2, CASE WHEN $3 THEN ${KH_DAY} ELSE NULL END)
                     ON CONFLICT (user_email) DO UPDATE SET last_day = ${KH_DAY}, streak = $2, last_win = CASE WHEN $3 THEN ${KH_DAY} ELSE party_checkin.last_win END`, [e, streak, coins > 0]);
      if (coins > 0) await c.query("INSERT INTO coin_ledger (user_email, coins, kind, note, created_by) VALUES ($1, $2, 'checkin', $3, 'system')", [e, coins, 'Check-in day ' + day]);
      if (s.xp.checkin > 0) {                                       // ⭐ check-in XP (+ VIP bonus)
        const isVip = s.vipOn && (await c.query('SELECT 1 FROM user_vip WHERE user_email = $1 AND expires_at > NOW()', [e])).rows.length > 0;
        var gotXp = Math.round(s.xp.checkin * (isVip ? 1 + s.xp.vipBonus / 100 : 1));
        const add = gotXp;
        await c.query('INSERT INTO user_xp (user_email, xp) VALUES ($1, $2) ON CONFLICT (user_email) DO UPDATE SET xp = user_xp.xp + $2', [e, add]);
      }
      await c.query('COMMIT');
      c.release();
      res.json({ ...(await checkinInfo(e)), got: coins, gotDay: day, gotXp: typeof gotXp === 'number' ? gotXp : 0 });
    } catch (err) {
      try { await c.query('ROLLBACK'); } catch (x) { /* nothing open */ }
      c.release();
      console.error('[coins] checkin post:', err.message);
      res.status(500).json({ success: false, error: 'Could not check in.' });
    }
  });

  // ---- 🏆 ranking: who sent / received the most gift coins, which rooms got the most (today / this week / this month, Cambodia time) ----
  app.get('/api/party/ranking', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const type = ['send', 'receive', 'rooms'].includes(req.query.type) ? req.query.type : 'send';
      const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week';
      const since = `(date_trunc('${period}', NOW() AT TIME ZONE 'Asia/Phnom_Penh') AT TIME ZONE 'Asia/Phnom_Penh')`;
      let sql;
      if (type === 'rooms') {
        sql = `SELECT r.owner_email AS email, SUM(g.coins)::int AS coins, MAX(r.title) AS title FROM gift_events g JOIN party_rooms r ON r.id = g.room_id
               WHERE g.created_at >= ${since} GROUP BY r.owner_email ORDER BY coins DESC LIMIT 50`;
      } else {
        const col = type === 'send' ? 'from_email' : 'to_email';
        sql = `SELECT ${col} AS email, SUM(coins)::int AS coins FROM gift_events WHERE created_at >= ${since} GROUP BY ${col} ORDER BY coins DESC LIMIT 50`;
      }
      const rows = (await pool.query(sql)).rows;
      const emails = rows.map((x) => norm(x.email));
      const us = emails.length ? (await pool.query('SELECT email, first_name, last_name, profile_pic FROM users WHERE LOWER(email) = ANY($1)', [emails])).rows : [];
      const um = new Map(us.map((u) => [norm(u.email), u]));
      const bd = await badgesOf(emails);
      const list = rows.map((x, i) => { const u = um.get(norm(x.email)) || {}; const b = bd.get(norm(x.email)) || {};
        return { rank: i + 1, email: u.email || x.email, first_name: u.first_name || '', last_name: u.last_name || '', profile_pic: u.profile_pic || '', coins: x.coins, title: x.title || '', level: b.level || 1, vip: !!b.vip }; });
      const mine = list.find((x) => norm(x.email) === e) || null;
      res.json({ success: true, type, period, list, me: mine ? { rank: mine.rank, coins: mine.coins } : null });
    } catch (err) { console.error('[coins] ranking:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  /// the frames people in a room wear now (for party.js): Map email → {colors, emoji, anim}
  async function framesOf(emails) {
    const m = new Map();
    if (!emails.length) return m;
    try {
      await ensure();
      const r = await pool.query(`SELECT w.user_email, f.colors, f.emoji, f.anim FROM frame_wear w JOIN user_frames u ON u.user_email = w.user_email AND u.frame_id = w.frame_id AND u.expires_at > NOW()
                                  JOIN party_frames f ON f.id = w.frame_id WHERE w.user_email = ANY($1)`, [emails.map(norm)]);
      for (const x of r.rows) m.set(x.user_email, { colors: String(x.colors || '').split(',').map((y) => y.trim()).filter(Boolean), emoji: x.emoji || '', anim: x.anim || 'none' });
    } catch (e) { /* no frames yet */ }
    return m;
  }

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
        if (b.walletOn !== undefined) await setSetting('wallet_on', b.walletOn ? '1' : '0');
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
      } else if (act === 'vip') {
        if (!superOnly()) return;
        if (Array.isArray(b.levels)) {
          const l = b.levels.map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x <= 1000000000).sort((x, y) => x - y);
          if (l.length < 2 || l[0] !== 0) return res.status(400).json({ success: false, error: 'Levels: start with 0, then the XP for each next level (at least 2).' });
          await setSetting('xp_levels', JSON.stringify(l.slice(0, 200)));
        }
        if (b.xp && typeof b.xp === 'object') {                     // how much XP each thing gives
          for (const [k, key, hi] of [['spend', 'xp_spend', 100], ['receive', 'xp_recv', 100], ['listen', 'xp_listen', 100], ['seat', 'xp_seat', 100], ['roomMax', 'xp_room_max', 10000], ['checkin', 'xp_checkin', 100000], ['vipBonus', 'xp_vip_bonus', 500]]) {
            if (b.xp[k] === undefined) continue;
            const v = Number(b.xp[k]); if (!(Number.isFinite(v) && v >= 0 && v <= hi)) return res.status(400).json({ success: false, error: 'XP "' + k + '" must be 0–' + hi + '.' });
            await setSetting(key, v);
          }
        }
        if (b.perks && typeof b.perks === 'object') {               // from which level (0 = off)
          for (const [k, key] of [['nameColor', 'perk_name_color'], ['entry', 'perk_entry']]) {
            if (b.perks[k] === undefined) continue;
            const v = parseInt(b.perks[k], 10); if (!(v >= 0 && v <= 1000)) return res.status(400).json({ success: false, error: 'Perk level must be 0–1000.' });
            await setSetting(key, v);
          }
        }
        if (b.vipPrice !== undefined) { const v = parseInt(b.vipPrice, 10); if (!(v > 0 && v <= 10000000)) return res.status(400).json({ success: false, error: 'VIP price must be more than 0 coins.' }); await setSetting('vip_price', v); }
        if (b.vipDays !== undefined) { const v = parseInt(b.vipDays, 10); if (!(v > 0 && v <= 365)) return res.status(400).json({ success: false, error: 'VIP days must be 1 to 365.' }); await setSetting('vip_days', v); }
        if (b.vipOn !== undefined) await setSetting('vip_on', b.vipOn ? '1' : '0');
        audit(a.adminEmail, 'vip-settings', 'settings', 'levels / VIP price / days changed');
      } else if (act === 'checkin') {
        if (!superOnly()) return;
        if (Array.isArray(b.checkin) && b.checkin.length) {
          const l = b.checkin.map((x) => parseInt(x, 10));
          if (l.length !== 7 || l.some((x) => !(x >= 0 && x <= 100000))) return res.status(400).json({ success: false, error: 'Write 7 numbers (coins for day 1 … day 7), 0 or more.' });
          await setSetting('checkin', JSON.stringify(l));
        }
        if (Array.isArray(b.checkinDeck)) {                           // "coins:times" pairs for one round (a week)
          const l = b.checkinDeck.map((x) => ({ coins: parseInt(x.coins, 10), times: parseInt(x.times, 10) })).filter((x) => x.coins >= 0 && x.coins <= 100000 && x.times > 0 && x.times <= 31);
          if (!l.length) return res.status(400).json({ success: false, error: 'Write the prizes like 0:2,1:3,2:2 (coins:how many times in a week).' });
          await setSetting('checkin_deck', JSON.stringify(l.slice(0, 10)));
        }
        if (b.checkinWinners !== undefined) { const v = parseInt(b.checkinWinners, 10); if (!(v >= 0 && v <= 1000000)) return res.status(400).json({ success: false, error: 'Winners a day: 0 or more.' }); await setSetting('checkin_winners', v); }
        if (b.checkinCooldown !== undefined) { const v = parseInt(b.checkinCooldown, 10); if (!(v >= 0 && v <= 365)) return res.status(400).json({ success: false, error: 'Days before winning again: 0–365.' }); await setSetting('checkin_cooldown', v); }
        if (b.checkinOn !== undefined) await setSetting('checkin_on', b.checkinOn ? '1' : '0');
        audit(a.adminEmail, 'checkin-settings', 'settings', 'check-in coins changed');
      } else if (act === 'frame') {
        if (!superOnly()) return;
        const g = b.frame || {};
        const coins = parseInt(g.coins, 10), days = parseInt(g.days, 10);
        const km = String(g.name_km || '').trim().slice(0, 60), en = String(g.name_en || '').trim().slice(0, 60), emoji = String(g.emoji || '').trim().slice(0, 16);
        const colors = String(g.colors || '').split(',').map((x) => x.trim()).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x)).slice(0, 4).join(',');
        const anim = ['none', 'pulse', 'spin'].includes(g.anim) ? g.anim : 'none';
        if (!(coins > 0 && coins <= 1000000) || !(days > 0 && days <= 365) || !km || !en || !colors) return res.status(400).json({ success: false, error: 'Fill in both names, colours (#RRGGBB, comma between), price in coins and days.' });
        if (g.id) await pool.query('UPDATE party_frames SET name_km = $2, name_en = $3, colors = $4, emoji = $5, anim = $6, coins = $7, days = $8, active = $9 WHERE id = $1', [parseInt(g.id, 10), km, en, colors, emoji, anim, coins, days, g.active !== false]);
        else await pool.query('INSERT INTO party_frames (code, name_km, name_en, colors, emoji, anim, coins, days, sort) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 999)', ['f' + Date.now(), km, en, colors, emoji, anim, coins, days]);
        audit(a.adminEmail, 'party-frame', String(g.id || 'new'), en + ' ' + coins + ' coins / ' + days + ' days' + (g.active === false ? ' (off)' : ''));
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
      const frames = await pool.query(`SELECT f.*, (SELECT COUNT(*)::int FROM user_frames u WHERE u.frame_id = f.id AND u.expires_at > NOW()) AS owners FROM party_frames f ORDER BY f.coins, f.sort`);
      const vips = await pool.query('SELECT COUNT(*)::int AS n FROM user_vip WHERE expires_at > NOW()');
      const ckd = (await pool.query(`SELECT checkins, winners FROM checkin_days WHERE day = ${KH_DAY}`)).rows[0] || { checkins: 0, winners: 0 };
      const ck = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE((SELECT SUM(coins) FROM coin_ledger WHERE kind = 'checkin' AND created_at > NOW() - INTERVAL '30 days'), 0)::int AS coins FROM party_checkin WHERE last_day = ${KH_DAY}`);
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, settings: s, vipNow: vips.rows[0].n, checkinToday: ck.rows[0].n, checkinCoins30: ck.rows[0].coins, checkinWinnersToday: ckd.winners, gifts: gifts.rows, frames: frames.rows, pending: pending.rows, recent: recent.rows, totals: tot.rows[0] });
    } catch (err) { console.error('[coins] admin:', err.message); if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  return { heldCents, balance, framesOf, badgesOf };
};
