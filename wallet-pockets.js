// 👛 The wallet has two pockets (one ledger, every line knows its pocket):
//   🎁 'gift'    = gifts received (Party Room, Live), invite rewards, challenge prizes, star bonuses …
//                  anyone can withdraw from $1; only the Admin's check before paying (+ the gift wait Admin may set, 0 = none)
//   🎬 'content' = money from views (Creator Program) and content bonuses from CamFeed
//                  checked before it comes in, then it waits N days (Admin sets) before it can be withdrawn; its own smallest withdrawal
// Old lines have no pocket written: views money → content, everything else → gift.
const POCKET_SQL = "COALESCE(pocket, CASE WHEN kind = 'revenue_share' THEN 'content' ELSE 'gift' END)";
const POCKETS = ['gift', 'content'];
const pocketOf = (p) => (p === 'content' ? 'content' : 'gift');

// how much is in each pocket, and how much can leave now
async function pockets(q, email, opt) {
  const o = opt || {};
  const giftDays = Math.max(0, Number(o.giftHoldDays) || 0), contentDays = Math.max(0, Number(o.contentHoldDays) || 0);
  const r = await q.query(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE ${POCKET_SQL} = 'gift'), 0)::bigint AS gift,
            COALESCE(SUM(amount_cents) FILTER (WHERE ${POCKET_SQL} = 'content'), 0)::bigint AS content,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'gift' AND amount_cents > 0 AND $2::int > 0 AND created_at > NOW() - ($2::int || ' days')::interval), 0)::bigint AS gift_wait,
            COALESCE(SUM(amount_cents) FILTER (WHERE ${POCKET_SQL} = 'content' AND kind = 'revenue_share' AND amount_cents > 0 AND $3::int > 0 AND created_at > NOW() - ($3::int || ' days')::interval), 0)::bigint AS content_wait,
            MIN(created_at) FILTER (WHERE ${POCKET_SQL} = 'content' AND kind = 'revenue_share' AND amount_cents > 0 AND $3::int > 0 AND created_at > NOW() - ($3::int || ' days')::interval) AS content_first_wait
       FROM wallet_ledger WHERE LOWER(user_email) = LOWER($1)`, [email, giftDays, contentDays]);
  const x = r.rows[0] || {};
  const gift = Number(x.gift) || 0, content = Number(x.content) || 0;
  const giftWait = Math.min(Math.max(0, gift), Number(x.gift_wait) || 0), contentWait = Math.min(Math.max(0, content), Number(x.content_wait) || 0);
  const readyAt = x.content_first_wait ? new Date(new Date(x.content_first_wait).getTime() + contentDays * 86400000) : null;
  return {
    gift, content, total: gift + content,
    giftWait, giftReady: Math.max(0, gift - giftWait),
    contentWait, contentReady: Math.max(0, content - contentWait), contentReadyAt: contentWait > 0 ? readyAt : null,
  };
}

// once: old withdrawals / changes into diamonds were all written as 🎁. Where that made a pocket go below 0,
// move the difference from the other pocket (the total never changes).
async function fixOldLines(pool) {
  const done = await pool.query("SELECT 1 FROM creator_settings WHERE key = 'pockets_v1'").catch(() => ({ rows: [] }));
  if (done.rows.length) return 0;
  const r = await pool.query(
    `SELECT user_email, COALESCE(SUM(amount_cents) FILTER (WHERE ${POCKET_SQL} = 'gift'), 0)::bigint AS g,
            COALESCE(SUM(amount_cents) FILTER (WHERE ${POCKET_SQL} = 'content'), 0)::bigint AS c
       FROM wallet_ledger GROUP BY user_email`);
  let n = 0;
  for (const u of r.rows) {
    const g = Number(u.g) || 0, c = Number(u.c) || 0;
    let from = '', to = '', amt = 0;
    if (g < 0 && c > 0) { amt = Math.min(-g, c); from = 'content'; to = 'gift'; }
    else if (c < 0 && g > 0) { amt = Math.min(-c, g); from = 'gift'; to = 'content'; }
    if (amt <= 0) continue;
    await pool.query(`INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, created_by, pocket) VALUES
      ($1, $2, 'pocket_move', 'Two pockets: old lines sorted', 'system', $3), ($1, $4, 'pocket_move', 'Two pockets: old lines sorted', 'system', $5)`, [u.user_email, amt, to, -amt, from]);
    n++;
  }
  await pool.query("INSERT INTO creator_settings (key, value) VALUES ('pockets_v1', $1) ON CONFLICT (key) DO NOTHING", [String(Date.now())]);
  return n;
}

module.exports = { POCKET_SQL, POCKETS, pocketOf, pockets, fixOldLines };
