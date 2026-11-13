// =============================================================================
// Public IDs: people are shown to the browser (and to everyone else) as a random 15-digit number
// instead of their e-mail address / phone number, e.g.  profile.html?email=100482915637204
//
// How it works (the rest of the server keeps using e-mails internally, so nothing else had to be rewritten):
//   * every request  : an id in a user field (email, viewerEmail, targetEmail, user1, user2 ...) is turned back into the e-mail
//   * every response : every user field (email, user_email, sender_email, follower_email ...) is turned into that person's id
//   * admin routes   : left untouched (administrators may see real e-mails)
// Safety switch: set MASK_USER_IDS=false in Render to turn the whole layer off.
// =============================================================================
const crypto = require('crypto');

const ID_RE = /^1\d{14}$/;                                  // 15 digits, never starts with 0 (can not be mistaken for a phone number such as 0962...)
const EXTRA_KEYS = new Set(['user1', 'user2', 'sender', 'receiver', 'chat_with']);
const isIdentityKey = (k) => typeof k === 'string' && (/email$/i.test(k) || EXTRA_KEYS.has(k));
const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX = 50000;

function randomId() { return '1' + String(crypto.randomInt(0, 100000000000000)).padStart(14, '0'); }

function createPublicIds({ pool }) {
  const enabled = () => String(process.env.MASK_USER_IDS || 'true').toLowerCase() !== 'false';
  const secret = String(process.env.JWT_SECRET || '').length >= 32 ? process.env.JWT_SECRET : crypto.randomBytes(32).toString('hex');
  const byEmail = new Map();   // lower(email) -> { id, exp }
  const byId = new Map();      // id -> { email, exp }

  const remember = (email, id) => {
    const now = Date.now(), exp = now + CACHE_TTL_MS;
    if (byEmail.size > CACHE_MAX) { byEmail.clear(); byId.clear(); }
    byEmail.set(String(email).toLowerCase(), { id, exp }); byId.set(id, { email, exp });
  };
  const fresh = (e) => e && e.exp > Date.now();
  const forget = (email) => { const e = byEmail.get(String(email).toLowerCase()); if (e) { byId.delete(e.id); byEmail.delete(String(email).toLowerCase()); } };

  // stable look-alike for e-mails that belong to nobody (e.g. rows of deleted users): never the real e-mail
  const pseudoId = (lower) => '1' + (BigInt('0x' + crypto.createHmac('sha256', secret).update(lower).digest('hex').slice(0, 14)) % 100000000000000n).toString().padStart(14, '0');

  async function ensureSchema() {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id VARCHAR(20)');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_uniq ON users (public_id) WHERE public_id IS NOT NULL');
    // give everybody who already exists an id (new people get theirs the first time they are shown)
    const missing = await pool.query('SELECT email FROM users WHERE public_id IS NULL');
    for (const row of missing.rows) { try { await assignId(row.email); } catch (e) { console.error('[ids] backfill failed for one user:', e.message); } }
    if (missing.rows.length) console.log(`[ids] gave public ids to ${missing.rows.length} existing user(s)`);
  }

  async function assignId(email) {
    for (let i = 0; i < 8; i++) {
      const id = randomId();
      try {
        const r = await pool.query('UPDATE users SET public_id = $1 WHERE email = $2 AND public_id IS NULL RETURNING public_id', [id, email]);
        if (r.rows.length) { remember(email, r.rows[0].public_id); return r.rows[0].public_id; }
        const again = await pool.query('SELECT public_id FROM users WHERE email = $1', [email]);   // somebody else just gave one
        if (again.rows[0] && again.rows[0].public_id) { remember(email, again.rows[0].public_id); return again.rows[0].public_id; }
        return null;
      } catch (e) { if (e && e.code === '23505') continue; throw e; }     // id already taken: pick another
    }
    throw new Error('could not find a free public id');
  }

  // e-mails -> Map(lower(email) -> id)
  async function toIds(list) {
    const out = new Map(); const need = [];
    for (const raw of list) {
      const lower = String(raw).toLowerCase();
      if (out.has(lower)) continue;
      const c = byEmail.get(lower);
      if (fresh(c)) out.set(lower, c.id); else need.push(lower);
    }
    if (need.length) {
      const res = await pool.query('SELECT email, public_id FROM users WHERE LOWER(email) = ANY($1::text[])', [need]);
      for (const row of res.rows) {
        const lower = String(row.email).toLowerCase();
        const id = row.public_id || await assignId(row.email);
        if (id) { remember(row.email, id); out.set(lower, id); }
      }
      for (const lower of need) if (!out.has(lower)) out.set(lower, pseudoId(lower));
    }
    return out;
  }

  // ids -> Map(id -> stored e-mail)
  async function toEmails(ids) {
    const out = new Map(); const need = [];
    for (const id of ids) {
      if (!ID_RE.test(id) || out.has(id)) continue;
      const c = byId.get(id);
      if (fresh(c)) out.set(id, c.email); else need.push(id);
    }
    if (need.length) {
      const res = await pool.query('SELECT email, public_id FROM users WHERE public_id = ANY($1::text[])', [need]);
      for (const row of res.rows) { remember(row.email, row.public_id); out.set(row.public_id, row.email); }
    }
    return out;
  }

  // walk any JSON-like value and report every "who is this" string field: cb(holder, key, value)
  function walk(value, cb, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return;
    if (seen.has(value)) return; seen.add(value);
    if (typeof value.toJSON === 'function' && !Array.isArray(value)) { try { walk(value.toJSON(), cb, seen); } catch (e) {} return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, cb, seen); return; }
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (typeof v === 'string') { if (isIdentityKey(key) && v) cb(value, key, v); }
      else walk(v, cb, seen);
    }
  }

  async function maskBody(body) {
    const found = [];
    walk(body, (holder, key, v) => found.push({ holder, key, v }));
    if (!found.length) return body;
    const map = await toIds(found.map((f) => f.v));
    for (const f of found) { const id = map.get(String(f.v).toLowerCase()); if (id) f.holder[f.key] = id; }
    return body;
  }

  async function unmaskRequest(req) {
    const q = Object.assign({}, req.query || {});
    const found = [];
    walk(q, (h, k, v) => { if (ID_RE.test(v)) found.push({ h, k, v }); });
    walk(req.body, (h, k, v) => { if (ID_RE.test(v)) found.push({ h, k, v }); });
    if (!found.length) return;
    const map = await toEmails([...new Set(found.map((f) => f.v))]);
    for (const f of found) { const e = map.get(f.v); if (e) f.h[f.k] = e; }
    Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });   // Express 5: req.query is a getter
  }

  const skip = (req) => !enabled() || String(req.originalUrl || req.url || '').split('?')[0].startsWith('/api/admin');

  async function inbound(req, res, next) {
    if (skip(req)) return next();
    try { await unmaskRequest(req); } catch (e) { console.error('[ids] could not read ids in a request:', e.message); }
    next();
  }

  function outbound(req, res, next) {
    if (skip(req)) return next();
    const original = res.json.bind(res);
    res.json = function (body) {
      maskBody(body).then((b) => original(b)).catch((e) => { console.error('[ids] could not hide e-mails in a response (sent as is):', e.message); original(body); });
      return res;
    };
    next();
  }

  return { ensureSchema, inbound, outbound, toIds, toEmails, maskBody, forget, ID_RE, isIdentityKey, assignId, enabled };
}

module.exports = { createPublicIds, ID_RE, isIdentityKey, randomId };
