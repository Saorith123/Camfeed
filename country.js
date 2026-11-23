// 🌏 Each person's country (2 letters, e.g. KH). Like Facebook: the Feed, Reels, search and "people you may know" show one's own country first;
// people from other countries come rarely (except people I follow). Ads are shown only in the country the advertiser chose.
// The country comes from what the person chose when signing up; "Other" / empty → the country of their phone's internet (Cloudflare).
'use strict';

const COUNTRIES = [
  ['KH', 'កម្ពុជា', 'Cambodia'], ['TH', 'ថៃ', 'Thailand'], ['VN', 'វៀតណាម', 'Vietnam'], ['LA', 'ឡាវ', 'Laos'], ['MY', 'ម៉ាឡេស៊ី', 'Malaysia'],
  ['SG', 'សិង្ហបុរី', 'Singapore'], ['CN', 'ចិន', 'China'], ['JP', 'ជប៉ុន', 'Japan'], ['KR', 'កូរ៉េខាងត្បូង', 'South Korea'], ['US', 'សហរដ្ឋអាមេរិក', 'United States'],
  ['CA', 'កាណាដា', 'Canada'], ['AU', 'អូស្ត្រាលី', 'Australia'], ['NZ', 'នូវែលសេឡង់', 'New Zealand'], ['FR', 'បារាំង', 'France'], ['GB', 'អង់គ្លេស', 'United Kingdom'],
];
const ALIAS = { 'south korea': 'KR', korea: 'KR', 'united states': 'US', usa: 'US', america: 'US', 'united kingdom': 'GB', uk: 'GB', england: 'GB', cambodia: 'KH', kampuchea: 'KH' };
COUNTRIES.forEach((c) => { ALIAS[c[2].toLowerCase()] = c[0]; ALIAS[c[1]] = c[0]; });

// "Cambodia" / "kh" / "កម្ពុជា" → "KH"; unknown → ''
function ccOf(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) { const u = s.toUpperCase(); return u === 'XX' || u === 'T1' ? '' : u; }
  return ALIAS[s.toLowerCase()] || ALIAS[s] || '';
}

module.exports = function ({ pool }) {
  let ready = null;
  function ensure() {
    if (!ready) ready = pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS cc VARCHAR(2)')
      .then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_users_cc ON users (cc)')).catch((e) => { ready = null; throw e; });
    return ready;
  }
  // everyone's cc from their chosen country, else from the internet country of their newest session
  const caseSql = 'CASE ' + Object.entries(ALIAS).filter(([k]) => /^[a-z ]+$/.test(k)).map(([k, v]) => `WHEN LOWER(TRIM(u2.country)) = '${k}' THEN '${v}'`).join(' ') + ' END';
  async function refresh() {
    await ensure();
    const r = await pool.query(`UPDATE users u SET cc = x.cc FROM (
        SELECT u2.email, COALESCE(${caseSql},
          (SELECT UPPER(s.country) FROM user_sessions s WHERE s.email = u2.email AND s.country ~ '^[A-Za-z]{2}$' AND UPPER(s.country) NOT IN ('XX', 'T1') ORDER BY s.last_seen DESC NULLS LAST LIMIT 1)) AS cc
        FROM users u2) x
      WHERE x.email = u.email AND x.cc IS NOT NULL AND u.cc IS DISTINCT FROM x.cc`);
    if (r.rowCount) console.log('[country] updated', r.rowCount, 'people');
  }
  setTimeout(() => refresh().catch((e) => console.error('[country]', e.message)), 20 * 1000);
  setInterval(() => refresh().catch((e) => console.error('[country]', e.message)), 30 * 60 * 1000);

  async function ccOfUser(email) {
    if (!email) return '';
    try { await ensure(); const r = await pool.query('SELECT cc, country FROM users WHERE email = $1', [email]); const u = r.rows[0]; return u ? (u.cc || ccOf(u.country)) : ''; }
    catch (e) { return ''; }
  }

  // SQL: how much lower a post is ranked when its author lives in another country (0 = same country, followed, mine, or not known)
  const FOREIGN = 90;
  function foreignSql(viewer, authorAlias, followedExpr) {
    const mine = `(SELECT v.cc FROM users v WHERE v.email = ${viewer})`;
    return `(CASE WHEN ${authorAlias}.email = ${viewer} OR (${followedExpr}) OR ${authorAlias}.cc IS NULL OR ${mine} IS NULL OR ${authorAlias}.cc = ${mine} THEN 0 ELSE ${FOREIGN} END)`;
  }
  // SQL for ORDER BY: 1 = same country (or not known), 0 = another country
  function sameSql(viewer, alias) {
    return `(${alias}.cc IS NULL OR (SELECT v.cc FROM users v WHERE v.email = ${viewer}) IS NULL OR ${alias}.cc = (SELECT v.cc FROM users v WHERE v.email = ${viewer}))`;
  }

  return { ensure, refresh, ccOf, ccOfUser, foreignSql, sameSql, list: () => COUNTRIES.map((c) => ({ cc: c[0], km: c[1], en: c[2] })) };
};
module.exports.ccOf = ccOf;
