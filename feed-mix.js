// Feed mix: the Admin chooses what share of each page comes from which kind of post (Admin > 🧩 App features > Feed mix).
// The posts arrive already ranked (unseen first, best first). Each one is put in ONE group, then the page is filled slot by slot
// from the group that is furthest behind its share. A group with nothing left gives its place to the others.
//   friends  = the author and I follow each other
//   follow   = I follow the author
//   trending = many likes, comments and shares in a short time (momentum, not only big totals)
//   interest = the kind of post I watch / react to (user_interest_scores)
//   fresh    = posted in the last hours (new posts of people I don't follow)
//   discover = everything else (chance to find new people)
const DEFAULT_MIX = { friends: 25, follow: 20, trending: 20, interest: 15, fresh: 10, discover: 10, freshHours: 24, trendMin: 3 };
const GROUPS = ['friends', 'follow', 'trending', 'interest', 'fresh', 'discover'];

function settings(cfg) {
  const c = Object.assign({}, DEFAULT_MIX, cfg || {});
  for (const g of GROUPS) c[g] = Math.max(0, Number(c[g]) || 0);
  if (!GROUPS.some((g) => c[g] > 0)) Object.assign(c, DEFAULT_MIX);
  return c;
}

const n = (v) => Number(v) || 0;
function momentum(r) {
  const hrs = Math.max(0, (Date.now() - new Date(r.created_at).getTime()) / 3600000);
  const eng = n(r.likes_count) + n(r.comments_count) * 2 + n(r.shares_count) * 3;
  return { eng, m: eng / Math.pow(hrs + 2, 1.3) };   // a young post with a few reactions beats an old one with many
}

function groupOf(r, c, me) {
  const mine = String(r.user_email || '').toLowerCase() === String(me || '').toLowerCase();
  const iFollow = r.following_email != null || r.is_following === true || r.author_followed === true;
  if (!mine && iFollow && r.author_follows_me) return 'friends';
  if (mine || iFollow) return 'follow';
  const { eng, m } = momentum(r);
  if (eng >= c.trendMin && m >= 0.4) return 'trending';
  if (n(r.interest_score) > 0) return 'interest';
  if (Date.now() - new Date(r.created_at).getTime() < c.freshHours * 3600000) return 'fresh';
  return 'discover';
}

function mix(rows, cfg, me) {
  const c = settings(cfg);
  const q = {}; for (const g of GROUPS) q[g] = [];
  for (const r of rows) { const g = groupOf(r, c, me); r.feed_group = g; q[g].push(r); }
  q.trending.sort((a, b) => momentum(b).m - momentum(a).m);
  const taken = {}; for (const g of GROUPS) taken[g] = 0;
  const out = [];
  while (out.length < rows.length) {
    let live = GROUPS.filter((g) => q[g].length && c[g] > 0);
    if (!live.length) live = GROUPS.filter((g) => q[g].length);   // a 0 % group is used only when nothing else is left
    if (!live.length) break;
    const total = live.reduce((s, g) => s + c[g], 0) || live.length;
    // the group furthest behind its share (of the groups that still have posts) gets this slot
    let best = live[0], gap = -Infinity;
    for (const g of live) {
      const want = ((c[g] || (total === live.length ? 1 : 0)) / total) * (out.length + 1);
      const d = want - taken[g];
      if (d > gap) { gap = d; best = g; }
    }
    out.push(q[best].shift()); taken[best]++;
  }
  return out;
}

module.exports = { mix, DEFAULT_MIX, GROUPS };
