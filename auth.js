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

// The value a login token must carry. Until somebody uses "log out of all devices" (epoch 0) it is exactly the old value,
// so nobody is logged out by this update.
function sessionPv(storedPassword, epoch) {
  const e = parseInt(epoch, 10) || 0;
  return e > 0 ? fingerprint(String(storedPassword || '') + ':' + e) : fingerprint(storedPassword);
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
function signToken(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + (ttlSeconds || TOKEN_TTL_SECONDS) })).toString('base64url');
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
const PUBLIC_ROUTES = new Set(['POST /api/login', 'POST /api/register', 'POST /api/register/send-code', 'POST /api/register/verify-code',
  'POST /api/password/forgot', 'POST /api/password/verify-code', 'POST /api/password/reset',
  'POST /api/telegram/exchange', 'POST /api/telegram/complete', 'GET /api/auth-options',
  'POST /api/phone/send-code', 'POST /api/phone/verify-code', 'POST /api/csp-report']);
const BODY_ACTOR_FIELDS = ['email', 'sender', 'userEmail', 'user_email', 'followerEmail', 'blockerEmail', 'reporterEmail', 'adminEmail'];
// GET routes where ?email= is the profile being looked at (not the person asking)
const QUERY_EMAIL_IS_TARGET = new Set(['/api/user-profile', '/api/follow-list']);

// "Chrome on Android", masked address and (when Cloudflare provides it) the country / city of a request
function describeRequest(req) {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  const ipMasked = ip.includes(':') ? ip.split(':').slice(0, 2).join(':') + ':*' : ip.split('.').slice(0, 2).join('.') + '.*.*';
  const h = (k) => String((req.headers && req.headers[k]) || '').slice(0, 60).replace(/[<>]/g, '');
  return { browser, os, ipMasked, country: h('cf-ipcountry'), city: h('cf-ipcity') };
}

function createAuth(pool) {
  const sidCache = new Map();    // sid -> { revoked, at }
  const touched = new Map();     // sid -> last time we wrote last_seen
  const SID_TTL_MS = 30 * 1000, TOUCH_EVERY_MS = 5 * 60 * 1000;

  const stateCache = new Map(); // lower(email) -> { email, banned, pv, at }
  const STATE_TTL_MS = 30 * 1000;

  async function getUserState(email) {
    const key = String(email).toLowerCase();
    const hit = stateCache.get(key);
    if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit;
    let r;
    try {
      r = await pool.query(
        'SELECT email, password, COALESCE(is_banned, FALSE) AS is_banned, COALESCE(sessions_epoch, 0) AS sessions_epoch FROM users WHERE LOWER(email) = $1 LIMIT 1', [key]);
    } catch (e) {
      if (!e || e.code !== '42703') throw e;      // column not created yet (first seconds after an update): behave as before
      r = await pool.query(
        'SELECT email, password, COALESCE(is_banned, FALSE) AS is_banned FROM users WHERE LOWER(email) = $1 LIMIT 1', [key]);
    }
    if (!r.rows[0]) { stateCache.delete(key); return null; }
    const row = r.rows[0];
    const state = { email: row.email, banned: !!row.is_banned, pv: sessionPv(row.password, row.sessions_epoch), at: Date.now() };
    stateCache.set(key, state);
    return state;
  }

  function invalidate(email) { if (email) stateCache.delete(String(email).toLowerCase()); }

  async function writeSession(sid, email, req) {
    try {
      const d = describeRequest(req);
      await pool.query(
        `INSERT INTO user_sessions (sid, email, browser, os, ip_masked, country, city) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sid) DO UPDATE SET last_seen = NOW()`, [sid, email, d.browser, d.os, d.ipMasked, d.country, d.city]);
    } catch (e) { console.error('[auth] could not record the session:', e.message); }
  }

  // every login gets its own id (sid): that is what lets a person end ONE device
  function issueToken(userRow, req) {
    const sid = crypto.randomBytes(12).toString('hex');
    if (req) { touched.set(sid, Date.now()); writeSession(sid, userRow.email, req); }
    return signToken({ sub: userRow.email, pv: sessionPv(userRow.password, userRow.sessions_epoch), sid });
  }

  async function sessionRevoked(sid) {
    const hit = sidCache.get(sid);
    if (hit && Date.now() - hit.at < SID_TTL_MS) return hit.revoked;
    try {
      const r = await pool.query('SELECT revoked FROM user_sessions WHERE sid = $1', [sid]);
      const revoked = !!(r.rows[0] && r.rows[0].revoked);
      sidCache.set(sid, { revoked, at: Date.now() });
      return revoked;
    } catch (e) { return false; }      // table not there yet: do not lock anybody out
  }

  async function listSessions(email) {
    const r = await pool.query(
      `SELECT sid, browser, os, ip_masked, country, city, created_at, last_seen FROM user_sessions
       WHERE LOWER(email) = LOWER($1) AND revoked = FALSE AND last_seen > NOW() - INTERVAL '60 days' ORDER BY last_seen DESC LIMIT 50`, [email]);
    return r.rows;
  }
  async function revokeSession(email, sid) {
    const r = await pool.query('UPDATE user_sessions SET revoked = TRUE WHERE sid = $1 AND LOWER(email) = LOWER($2) RETURNING sid', [sid, email]);
    sidCache.delete(sid); return r.rows.length > 0;
  }
  async function revokeOthers(email, keepSid) {
    const r = await pool.query('UPDATE user_sessions SET revoked = TRUE WHERE LOWER(email) = LOWER($1) AND revoked = FALSE AND sid <> $2 RETURNING sid', [email, keepSid || '']);
    r.rows.forEach((x) => sidCache.delete(x.sid)); return r.rows.length;
  }
  async function revokeAll(email) {
    const r = await pool.query('UPDATE user_sessions SET revoked = TRUE WHERE LOWER(email) = LOWER($1) AND revoked = FALSE RETURNING sid', [email]);
    r.rows.forEach((x) => sidCache.delete(x.sid)); return r.rows.length;
  }

  async function authenticate(req, res, next) {
    try {
      const route = req.method + ' ' + req.baseUrl + req.path;
      if (PUBLIC_ROUTES.has(route)) return next();
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const payload = m ? verifyToken(m[1]) : null;
      if (!payload || !payload.sub || payload.purpose) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Please log in again.' });
      }
      const state = await getUserState(payload.sub);
      if (!state || state.pv !== payload.pv) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Session expired. Please log in again.' });
      }
      if (state.banned) {
        return res.status(403).json({ success: false, error: 'Account Suspended.' });
      }
      if (payload.sid) {
        if (await sessionRevoked(payload.sid)) {
          return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'This device was logged out. Please log in again.' });
        }
        req.sid = payload.sid;
        const last = touched.get(payload.sid) || 0;
        if (Date.now() - last > TOUCH_EVERY_MS) { touched.set(payload.sid, Date.now()); writeSession(payload.sid, state.email, req); }
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

  return { authenticate, forceActor, issueToken, invalidate, getUserState, listSessions, revokeSession, revokeOthers, revokeAll };
}

// ---------- Cloudflare Turnstile (CAPTCHA) ----------
if (!process.env.TURNSTILE_SECRET_KEY) {
  console.warn('[auth] TURNSTILE_SECRET_KEY is not set: sign-up CAPTCHA is NOT enforced. Set it in Render to turn it on.');
}
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };           // not configured yet
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body, signal: ctl.signal });
    const d = await r.json();
    return { ok: !!d.success };
  } catch (e) {
    return { ok: false, unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- simple in-memory limiter (max hits per window per key) ----------
function makeLimiter(max, windowMs) {
  const map = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of map) if (v.resetAt < n) map.delete(k); },
    Math.max(windowMs, 60000)).unref();
  return {
    isLimited(key) { const e = map.get(key); return !!e && e.resetAt >= Date.now() && e.count >= max; },
    hit(key) {
      const n = Date.now(), e = map.get(key);
      if (!e || e.resetAt < n) map.set(key, { count: 1, resetAt: n + windowMs }); else e.count++;
    }
  };
}

module.exports = {
  createAuth, sanitizeJson, stripSecrets,
  hashPassword, verifyPassword, isHashed, dummyVerify, safeEqual,
  signToken, verifyToken, fingerprint, sessionPv,
  isRateLimited, recordFailure, clearFailures,
  verifyTurnstile, makeLimiter
};
