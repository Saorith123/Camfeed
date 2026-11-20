// 👁 Who can see a post / a share / a story. Five choices:
//   public  = everybody (a story: the people who follow me)
//   friends = friends only (we follow each other)
//   except  = friends, but NOT the people I chose (they never see it)
//   custom  = ONLY the people I chose (nobody else)
//   private = only me
// The chosen people are kept in post_audience / story_audience. Every place that shows posts or stories uses the SQL below,
// so one rule decides everywhere (Feed, profile, videos, shares, search, watch history, notifications, the website).
// Anything unknown is closed (only the owner sees it).
const PRIVACY = ['public', 'friends', 'except', 'custom', 'private'];
const MAX_PEOPLE = 500;

let pool = null;

async function ensureSchema(p) {
  pool = p;
  await pool.query(`CREATE TABLE IF NOT EXISTS post_audience (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    PRIMARY KEY (post_id, user_email))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS story_audience (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    PRIMARY KEY (story_id, user_email))`);
  await pool.query('CREATE INDEX IF NOT EXISTS post_audience_user ON post_audience (user_email)');
  await pool.query('CREATE INDEX IF NOT EXISTS story_audience_user ON story_audience (user_email)');
}

const cleanPrivacy = (v, dflt = 'public') => (PRIVACY.includes(v) ? v : dflt);

// can viewer (SQL value v) see post alias p?
function postVisibleSql(p, v) {
  return `(LOWER(${p}.user_email) = LOWER(${v})
    OR COALESCE(${p}.privacy, 'public') = 'public'
    OR (${p}.privacy IN ('friends', 'except')
        AND EXISTS (SELECT 1 FROM follows fa_ WHERE fa_.follower_email = ${v} AND fa_.following_email = ${p}.user_email)
        AND EXISTS (SELECT 1 FROM follows fb_ WHERE fb_.follower_email = ${p}.user_email AND fb_.following_email = ${v})
        AND (${p}.privacy = 'friends' OR NOT EXISTS (SELECT 1 FROM post_audience pa_ WHERE pa_.post_id = ${p}.id AND pa_.user_email = LOWER(${v}))))
    OR (${p}.privacy = 'custom' AND EXISTS (SELECT 1 FROM post_audience pa2_ WHERE pa2_.post_id = ${p}.id AND pa2_.user_email = LOWER(${v}))))`;
}

// can viewer v see story alias s? (a public story: the people who follow me, as before)
function storyVisibleSql(s, v) {
  const iFollow = `EXISTS (SELECT 1 FROM follows sf_ WHERE LOWER(sf_.follower_email) = LOWER(${v}) AND LOWER(sf_.following_email) = LOWER(${s}.user_email))`;
  const followsMe = `EXISTS (SELECT 1 FROM follows sg_ WHERE LOWER(sg_.follower_email) = LOWER(${s}.user_email) AND LOWER(sg_.following_email) = LOWER(${v}))`;
  return `(LOWER(${s}.user_email) = LOWER(${v})
    OR (COALESCE(${s}.privacy, 'public') = 'public' AND ${iFollow})
    OR (${s}.privacy IN ('friends', 'except') AND ${iFollow} AND ${followsMe}
        AND (${s}.privacy = 'friends' OR NOT EXISTS (SELECT 1 FROM story_audience sa_ WHERE sa_.story_id = ${s}.id AND sa_.user_email = LOWER(${v}))))
    OR (${s}.privacy = 'custom' AND EXISTS (SELECT 1 FROM story_audience sa2_ WHERE sa2_.story_id = ${s}.id AND sa2_.user_email = LOWER(${v}))))`;
}

// the people sent by the app: real accounts only, never the owner, at most MAX_PEOPLE
async function cleanPeople(owner, raw) {
  const me = String(owner || '').toLowerCase();
  const list = [...new Set((Array.isArray(raw) ? raw : []).map((x) => String((x && x.email) || x || '').trim().toLowerCase()).filter((x) => x && x !== me && x.includes('@')))].slice(0, MAX_PEOPLE);
  if (!list.length) return [];
  const r = await pool.query('SELECT LOWER(email) AS e FROM users WHERE LOWER(email) = ANY($1::text[])', [list]);
  return r.rows.map((x) => x.e);
}

// checks the choice before saving: { ok, privacy, people } or { ok:false, error }
async function prepare(owner, privacy, rawPeople, dflt = 'public') {
  const pv = cleanPrivacy(privacy, dflt);
  if (pv !== 'except' && pv !== 'custom') return { ok: true, privacy: pv, people: [] };
  const people = await cleanPeople(owner, rawPeople);
  if (pv === 'custom' && !people.length) return { ok: false, error: 'Please choose at least one person who can see it.' };
  if (pv === 'except' && !people.length) return { ok: true, privacy: 'friends', people: [] };   // nobody left out = friends
  return { ok: true, privacy: pv, people };
}

async function save(kind, id, people, client) {
  const db = client || pool;
  const t = kind === 'story' ? 'story_audience' : 'post_audience', col = kind === 'story' ? 'story_id' : 'post_id';
  await db.query(`DELETE FROM ${t} WHERE ${col} = $1`, [id]);
  if (people && people.length) await db.query(`INSERT INTO ${t} (${col}, user_email) SELECT $1, UNNEST($2::text[]) ON CONFLICT DO NOTHING`, [id, people]);
}

async function list(kind, id) {
  const t = kind === 'story' ? 'story_audience' : 'post_audience', col = kind === 'story' ? 'story_id' : 'post_id';
  const r = await pool.query(`SELECT u.email, u.first_name, u.last_name, u.profile_pic FROM ${t} a JOIN users u ON LOWER(u.email) = a.user_email WHERE a.${col} = $1 ORDER BY u.first_name`, [id]);
  return r.rows;
}

// keep only the people who are allowed to see this post (for tags and notifications)
async function canSeePostList(postId, emails) {
  const out = [];
  for (const e of emails || []) {
    const r = await pool.query(`SELECT 1 FROM posts p WHERE p.id = $1 AND ${postVisibleSql('p', '$2')}`, [postId, e]);
    if (r.rows.length) out.push(e);
  }
  return out;
}

module.exports = { PRIVACY, MAX_PEOPLE, ensureSchema, cleanPrivacy, postVisibleSql, storyVisibleSql, prepare, save, list, canSeePostList };
