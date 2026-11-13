// =============================================================================
// CamFeed auth module: password hashing (scrypt), signed tokens (HS256 JWT),
// login rate-limit, and middleware that forces "who is acting" to come from the
// verified token instead of trusting an email sent by the browser.
// No extra npm packages needed (uses Node's built-in crypto).
// =============================================================================
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 64;

let SECRET = process.env.JWT_SECRET || '';
if (SECRET.length < 32) {
  SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[auth] JWT_SECRET is missing or shorter than 32 chars. Using a temporary random secret: ' +
    'everyone will be logged out on each restart. Set JWT_SECRET in your environment (Render).');
}

// ---------- tiny helpers ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function fingerprint(storedPassword) {
  return crypto.createHash('sha256').update(String(storedPassword || '')).digest('hex').slice(0, 12);
}

// ---------- password hashing ----------
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(plain), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}

// returns { ok, needsRehash }
async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored) return { ok: false, needsRehash: false };
  if (isHashed(stored)) {
    const parts = stored.split('$');
    if (parts.length !== 6) return { ok: false, needsRehash: false };
    const [, n, r, p, saltB64, keyB64] = parts;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(String(plain), Buffer.from(saltB64, 'base64'), expected.length,
      { N: +n, r: +r, p: +p });
    return { ok: crypto.timingSafeEqual(key, expected), needsRehash: false };
  }
  // Legacy plaintext row: accept once, caller re-hashes it immediately.
  return { ok: safeEqual(plain, stored), needsRehash: true };
}

// Burns similar CPU time when the email does not exist (avoids user-enumeration by timing)
let _dummyHash = null;
async function dummyVerify() {
  if (!_dummyHash) _dummyHash = await hashPassword('camfeed-dummy-password');
  await verifyPassword('wrong-password', _dummyHash);
}

// ---------- tokens (HS256 JWT) ----------
function signToken(payload) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  try {
    const hdr = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (!hdr || hdr.alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', SECRET).update(h + '.' + b).digest();
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ---------- login rate limit (in memory) ----------
const MAX_FAILS = 8, WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();
function isRateLimited(key) {
  const e = fails.get(key);
  if (!e) return false;
  if (e.resetAt < Date.now()) { fails.delete(key); return false; }
  return e.count >= MAX_FAILS;
}
function recordFailure(key) {
  const now = Date.now();
  const e = fails.get(key);
  if (!e || e.resetAt < now) fails.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else e.count++;
}
function clearFailures(key) { fails.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fails) if (v.resetAt < now) fails.delete(k);
}, 10 * 60 * 1000).unref();

// ---------- response sanitizer: never send password fields to any browser ----------
function stripSecrets(v, depth) {
  depth = depth || 0;
  if (v === null || typeof v !== 'object' || depth > 8) return v;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return v.map(x => stripSecrets(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === 'password' || k === 'password_hash') continue;
    out[k] = stripSecrets(v[k], depth + 1);
  }
  return out;
}
function sanitizeJson(req, res, next) {
  const orig = res.json.bind(res);
  res.json = body => orig(stripSecrets(body));
  next();
}

// ---------- factory (needs the pg pool for ban / password-change checks) ----------
const PUBLIC_ROUTES = new Set(['POST /api/login', 'POST /api/register']);
const BODY_ACTOR_FIELDS = ['email', 'sender', 'userEmail', 'user_email', 'followerEmail', 'blockerEmail', 'reporterEmail', 'adminEmail'];
// GET routes where ?email= is the profile being looked at (not the person asking)
const QUERY_EMAIL_IS_TARGET = new Set(['/api/user-profile', '/api/follow-list']);

function createAuth(pool) {
  const stateCache = new Map(); // lower(email) -> { email, banned, pv, at }
  const STATE_TTL_MS = 30 * 1000;

  async function getUserState(email) {
    const key = String(email).toLowerCase();
    const hit = stateCache.get(key);
    if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit;
    const r = await pool.query(
      'SELECT email, password, COALESCE(is_banned, FALSE) AS is_banned FROM users WHERE LOWER(email) = $1 LIMIT 1', [key]);
    if (!r.rows[0]) { stateCache.delete(key); return null; }
    const row = r.rows[0];
    const state = { email: row.email, banned: !!row.is_banned, pv: fingerprint(row.password), at: Date.now() };
    stateCache.set(key, state);
    return state;
  }

  function invalidate(email) { if (email) stateCache.delete(String(email).toLowerCase()); }

  function issueToken(userRow) {
    return signToken({ sub: userRow.email, pv: fingerprint(userRow.password) });
  }

  async function authenticate(req, res, next) {
    try {
      const route = req.method + ' ' + req.baseUrl + req.path;
      if (PUBLIC_ROUTES.has(route)) return next();
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const payload = m ? verifyToken(m[1]) : null;
      if (!payload || !payload.sub) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Please log in again.' });
      }
      const state = await getUserState(payload.sub);
      if (!state || state.pv !== payload.pv) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Session expired. Please log in again.' });
      }
      if (state.banned) {
        return res.status(403).json({ success: false, error: 'Account Suspended.' });
      }
      req.authEmail = state.email;
      next();
    } catch (err) {
      console.error('[auth] authenticate error:', err.message);
      res.status(500).json({ success: false, error: 'Authentication check failed.' });
    }
  }

  // Overwrite every "who is acting" field with the verified identity.
  function forceActor(req, res, next) {
    const actor = req.authEmail;
    if (!actor) return next();
    const path = req.baseUrl + req.path;

    if (req.body && typeof req.body === 'object') {
      for (const f of BODY_ACTOR_FIELDS) {
        if (f in req.body && req.body[f] !== undefined) req.body[f] = actor;
      }
    }

    // Express 5: req.query is a getter that returns a NEW object each time, so we
    // replace it with our own property instead of mutating it.
    const q = Object.assign({}, req.query);
    const fields = QUERY_EMAIL_IS_TARGET.has(path)
      ? ['viewerEmail', 'userEmail', 'user_email']
      : ['email', 'viewerEmail', 'userEmail', 'user_email'];
    let changed = false;
    for (const f of fields) if (f in q) { q[f] = actor; changed = true; }
    if (changed) {
      Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });
    }

    // Private chat history: you may only read conversations you are part of
    if (req.method === 'GET' && path === '/api/messages') {
      const me = actor.toLowerCase();
      const u1 = String(q.user1 || '').toLowerCase();
      const u2 = String(q.user2 || '').toLowerCase();
      if (u1 !== me && u2 !== me) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
    }
    next();
  }

  return { authenticate, forceActor, issueToken, invalidate, getUserState };
}

module.exports = {
  createAuth, sanitizeJson, stripSecrets,
  hashPassword, verifyPassword, isHashed, dummyVerify, safeEqual,
  signToken, verifyToken, fingerprint,
  isRateLimited, recordFailure, clearFailures
};
