// =============================================================================
// "Continue with Telegram" (Telegram OpenID Connect, authorization-code flow + PKCE, done on the server).
//   GET  /auth/telegram/start        -> redirects the browser to Telegram
//   GET  /auth/telegram/callback     -> Telegram sends the user back here; we verify everything
//   POST /api/telegram/exchange      -> returning user: short-lived link -> CamFeed login token
//   POST /api/telegram/complete      -> new user: DOB / gender / country, then the account is created
//   GET  /api/auth-options           -> tells the login page whether to show the Telegram button
// Env: TELEGRAM_CLIENT_ID (public bot id), TELEGRAM_CLIENT_SECRET, optional TELEGRAM_REDIRECT_URI.
// =============================================================================
const crypto = require('crypto');

const ISSUER = 'https://oauth.telegram.org';
const AUTH_URL = ISSUER + '/auth';
const TOKEN_URL = ISSUER + '/token';
const JWKS_URL = ISSUER + '/.well-known/jwks.json';
const COOKIE_NAME = 'camfeed_tg';
const COOKIE_PATH = '/auth/telegram';
const COOKIE_TTL_SECONDS = 600;
const SIGNUP_TOKEN_TTL = 30 * 60;
const LOGIN_LINK_TTL = 2 * 60;
const SYNTHETIC_DOMAIN = 'telegram.camfeedkh.com';   // accounts created from Telegram get tg<id>@telegram.camfeedkh.com

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function isTelegramAddress(email) {
  return String(email || '').trim().toLowerCase().endsWith('@' + SYNTHETIC_DOMAIN);
}

// ---------- pure helpers (exported for tests) ----------
function pkcePair() {
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function cookieKey(secret) { return crypto.createHash('sha256').update('camfeed-tg-cookie:' + secret).digest(); }

function sealCookie(obj, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cookieKey(secret), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), enc]));
}

function openCookie(value, secret) {
  try {
    const raw = Buffer.from(String(value), 'base64url');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', cookieKey(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const obj = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    return obj && obj.exp > Date.now() ? obj : null;
  } catch (e) { return null; }
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// Verifies an ID token: signature (RS256 / ES256) against Telegram's published keys + issuer, audience, expiry.
function verifyIdToken(idToken, { jwks, clientId, now }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new Error('unsupported algorithm ' + header.alg);
  const keys = (jwks && jwks.keys) || [];
  const jwk = header.kid ? keys.find(k => k.kid === header.kid) : (keys.length === 1 ? keys[0] : null);
  if (!jwk) { const e = new Error('unknown key'); e.unknownKey = true; throw e; }
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(parts[0] + '.' + parts[1]);
  const sig = Buffer.from(parts[2], 'base64url');
  const ok = header.alg === 'RS256'
    ? crypto.verify('RSA-SHA256', data, key, sig)
    : crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new Error('bad signature');
  const t = Math.floor((now || Date.now()) / 1000);
  if (payload.iss !== ISSUER) throw new Error('wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
  if (!aud.includes(String(clientId))) throw new Error('wrong audience');
  if (typeof payload.exp !== 'number' || payload.exp < t - 60) throw new Error('token expired');
  if (typeof payload.iat === 'number' && payload.iat > t + 300) throw new Error('token issued in the future');
  return payload;
}

function createTelegramLogin({ pool, auth, authCore, normalizeBirthdate }) {
  const clientId = () => String(process.env.TELEGRAM_CLIENT_ID || '').trim();
  const clientSecret = () => String(process.env.TELEGRAM_CLIENT_SECRET || '').trim();
  const redirectUri = () => process.env.TELEGRAM_REDIRECT_URI || 'https://camfeedkh.com/auth/telegram/callback';
  const isConfigured = () => !!(clientId() && clientSecret());
  const secret = () => process.env.JWT_SECRET || 'camfeed-dev-secret-not-for-production';
  const limiter = auth.makeLimiter(40, 60 * 60 * 1000);

  if (!isConfigured()) console.warn('[telegram] TELEGRAM_CLIENT_ID / TELEGRAM_CLIENT_SECRET not set: "Continue with Telegram" is hidden.');

  async function ensureSchema() {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(40)');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL');
  }

  // ---- Telegram's public signing keys (cached 12 h, refreshed once when an unknown key id appears) ----
  let jwksCache = null, jwksAt = 0, jwksTried = 0;
  async function getJwks(force) {
    const now = Date.now();
    if (!force && jwksCache && now - jwksAt < 12 * 3600 * 1000) return jwksCache;
    if (force && now - jwksTried < 30 * 1000 && jwksCache) return jwksCache;   // at most one refresh per 30 s
    jwksTried = now;
    const r = await fetch(JWKS_URL);
    if (!r.ok) throw new Error('JWKS ' + r.status);
    jwksCache = await r.json(); jwksAt = now;
    return jwksCache;
  }

  const sendBack = (res, qs) => res.redirect(302, '/index.html?' + qs);
  const secureFlag = (req) => (req.secure || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  const setCookie = (req, res, value, maxAge) =>
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureFlag(req)}`);

  // 1) send the browser to Telegram
  function start(req, res) {
    try {
      if (!isConfigured()) return sendBack(res, 'tg_error=unavailable');
      if (limiter.isLimited(req.ip)) return sendBack(res, 'tg_error=busy');
      limiter.hit(req.ip);
      const state = b64u(crypto.randomBytes(24));
      const { verifier, challenge } = pkcePair();
      setCookie(req, res, sealCookie({ state, verifier, exp: Date.now() + COOKIE_TTL_SECONDS * 1000 }, secret()), COOKIE_TTL_SECONDS);
      const q = new URLSearchParams({
        client_id: clientId(), redirect_uri: redirectUri(), response_type: 'code', scope: 'openid profile phone',
        state, code_challenge: challenge, code_challenge_method: 'S256'
      });
      res.redirect(302, AUTH_URL + '?' + q.toString());
    } catch (e) {
      console.error('[telegram] start error:', e.message);
      sendBack(res, 'tg_error=failed');
    }
  }

  // 2) Telegram sends the user back with ?code=...&state=...
  async function callback(req, res) {
    try {
      if (!isConfigured()) return sendBack(res, 'tg_error=unavailable');
      if (limiter.isLimited(req.ip)) return sendBack(res, 'tg_error=busy');
      limiter.hit(req.ip);
      const sealed = openCookie(readCookie(req.headers.cookie, COOKIE_NAME), secret());
      setCookie(req, res, '', 0);                                   // one use only
      const q = req.query || {};
      if (q.error) return sendBack(res, 'tg_error=cancelled');
      if (!sealed || !q.state || !q.code ||
          q.state.length !== sealed.state.length || !crypto.timingSafeEqual(Buffer.from(String(q.state)), Buffer.from(sealed.state))) {
        return sendBack(res, 'tg_error=state');
      }

      // exchange the code for tokens (server to server, with the client secret and the PKCE verifier)
      const tr = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(clientId() + ':' + clientSecret()).toString('base64') },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(q.code), redirect_uri: redirectUri(), client_id: clientId(), code_verifier: sealed.verifier }).toString()
      });
      if (!tr.ok) { console.error('[telegram] token endpoint responded', tr.status); return sendBack(res, 'tg_error=failed'); }
      const tokens = await tr.json();

      let claims;
      try { claims = verifyIdToken(tokens.id_token, { jwks: await getJwks(false), clientId: clientId() }); }
      catch (e) {
        if (!e.unknownKey) throw e;
        claims = verifyIdToken(tokens.id_token, { jwks: await getJwks(true), clientId: clientId() });
      }

      const tgId = String(claims.id || claims.sub || '');
      if (!/^\d{3,20}$/.test(tgId)) return sendBack(res, 'tg_error=failed');
      const phoneDigits = String(claims.phone_number || '').replace(/\D/g, '');
      if (claims.phone_number_verified !== true || phoneDigits.length < 8) return sendBack(res, 'tg_error=phone_required');

      const found = await pool.query('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [tgId]);
      let user = found.rows[0];
      if (!user) {
        // the same verified phone number = the same account (it may have been created with the phone + Telegram code)
        const byPhone = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1', [`ph${phoneDigits}@${SYNTHETIC_DOMAIN}`]);
        if (byPhone.rows[0]) {
          user = byPhone.rows[0];
          if (!user.telegram_id) await pool.query('UPDATE users SET telegram_id = $1 WHERE email = $2 AND telegram_id IS NULL', [tgId, user.email]);
        }
      }
      if (user) {
        if (user.is_banned) return sendBack(res, 'tg_error=banned');
        const link = auth.signToken({ sub: user.email, purpose: 'tg-login' }, LOGIN_LINK_TTL);
        return res.redirect(302, '/index.html#tg_login=' + encodeURIComponent(link));
      }
      // new person: ask for date of birth / gender / country first (nothing is created yet)
      const given = String(claims.given_name || '').trim();
      const family = String(claims.family_name || '').trim();
      const full = String(claims.name || '').trim();
      const proof = auth.signToken({
        purpose: 'tg-signup', tg: tgId, fn: (given || full || 'Telegram').slice(0, 60), ln: family.slice(0, 60),
        ph: '+' + phoneDigits, pic: /^https:\/\//.test(claims.picture || '') ? String(claims.picture).slice(0, 500) : '',
        cc: phoneDigits.startsWith('855') ? 'Cambodia' : ''
      }, SIGNUP_TOKEN_TTL);
      res.redirect(302, '/index.html#tg_signup=' + encodeURIComponent(proof));
    } catch (e) {
      console.error('[telegram] callback error:', e.message);
      sendBack(res, 'tg_error=failed');
    }
  }

  const fail = (res, status, en, km) => res.status(status).json({ success: false, error: en, errorKm: km });

  // 3a) returning user: swap the 2-minute link for a normal CamFeed login
  async function exchange(req, res) {
    try {
      const p = auth.verifyToken(req.body && req.body.token);
      if (!p || p.purpose !== 'tg-login' || !p.sub) return fail(res, 400, 'This login link has expired. Please try again.', 'តំណចូលនេះផុតកំណត់ហើយ។ សូមព្យាយាមម្តងទៀត។');
      const r = await pool.query('SELECT * FROM users WHERE email = $1 AND telegram_id IS NOT NULL LIMIT 1', [p.sub]);
      const user = r.rows[0];
      if (!user) return fail(res, 404, 'Account not found.', 'រកមិនឃើញគណនី។');
      if (user.is_banned) return fail(res, 403, 'Account Suspended.', 'គណនីត្រូវបានផ្អាក។');
      pool.query('UPDATE users SET last_active = NOW() WHERE email = $1', [user.email]).catch(() => {});
      res.json({ success: true, user, token: authCore.issueToken(user) });
    } catch (e) {
      console.error('[telegram] exchange error:', e.message);
      fail(res, 500, 'Something went wrong. Please try again.', 'មានបញ្ហា។ សូមព្យាយាមម្តងទៀត។');
    }
  }

  // 3b) new user: create the account after the extra details
  async function complete(req, res) {
    try {
      const body = req.body || {};
      const p = auth.verifyToken(body.token);
      if (!p || p.purpose !== 'tg-signup' || !p.tg) return fail(res, 400, 'This sign-up has expired. Please try again.', 'ការចុះឈ្មោះនេះផុតកំណត់ហើយ។ សូមព្យាយាមម្តងទៀត។');
      const gender = ['Male', 'Female', 'Custom'].includes(body.gender) ? body.gender : '';
      const country = String(body.country || '').trim().slice(0, 60);
      const birth = normalizeBirthdate(body.birthdate);
      if (!gender || !country || !birth || birth === undefined) return fail(res, 400, 'Please enter your date of birth, gender and country.', 'សូមបញ្ចូលថ្ងៃខែឆ្នាំកំណើត ភេទ និងប្រទេស។');

      const email = `tg${p.tg}@${SYNTHETIC_DOMAIN}`;
      // nobody knows this password: Telegram is the only way in
      const unusable = await auth.hashPassword(crypto.randomBytes(48).toString('hex'));
      let user;
      try {
        const r = await pool.query(
          `INSERT INTO users (email, password, first_name, last_name, birthdate, gender, country, bio, phone_privacy, email_privacy, role, profile_pic, phone, telegram_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'private', 'private', 'user', $8, $9, $10) RETURNING *`,
          [email, unusable, p.fn, p.ln || '', birth, gender, country, p.pic || null, p.ph, String(p.tg)]);
        user = r.rows[0];
      } catch (e) {
        if (e && e.code === '23505') {                                    // double tap / second tab: the account already exists
          const again = await pool.query('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [String(p.tg)]);
          user = again.rows[0];
        }
        if (!user) throw e;
      }
      if (user.is_banned) return fail(res, 403, 'Account Suspended.', 'គណនីត្រូវបានផ្អាក។');
      res.status(201).json({ success: true, user, token: authCore.issueToken(user) });
    } catch (e) {
      console.error('[telegram] complete error:', e.message);
      fail(res, 500, 'Something went wrong. Please try again.', 'មានបញ្ហា។ សូមព្យាយាមម្តងទៀត។');
    }
  }

  function options(req, res) { res.json({ success: true, telegram: isConfigured() }); }

  return { start, callback, exchange, complete, options, ensureSchema, isConfigured };
}

module.exports = { createTelegramLogin, verifyIdToken, pkcePair, sealCookie, openCookie, readCookie, isTelegramAddress, SYNTHETIC_DOMAIN };
