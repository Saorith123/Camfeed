const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const security = require('./security');
const path = require('path');
require('dotenv').config();

// Cloudinary is no longer used: all media is uploaded straight to Cloudflare R2 (/api/videos/upload-*).
// These routes now only accept plain text fields (JSON or multipart without files).
const formFieldsRaw = multer().none();
// text fields of form posts are checked/cleaned exactly like JSON ones
const formFields = (req, res, next) => formFieldsRaw(req, res, (err) => (err ? next(err) : security.inputGuard(req, res, next)));
const createVideoRouter = require('./videoRecommendationRoutes');
const auth = require('./auth');
const mailer = require('./mailer');
const { createSignupVerification, createPasswordReset, EMAIL_RE } = require('./signup-verification');
const { createTelegramLogin, isTelegramAddress } = require('./telegram-login');
const gateway = require('./telegram-gateway');
const { createPublicIds } = require('./public-ids');
const { createPhoneVerification, normalizePhone, phoneEmail, findAccountEmail } = require('./phone-verification');

const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy: needed for correct client IP (login rate limit)
app.disable('x-powered-by');                       // do not announce the framework
app.use(security.securityHeaders);                 // no framing, no sniffing, CSP, no caching of API answers ...
// small bodies everywhere (an attacker can not push megabytes into every route); posts may carry a video thumbnail
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '6mb' });
app.use((req, res, next) => (/^\/api\/(posts|videos)(\/|$)/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Server files must never be downloadable, even if one is dropped into /public by mistake
const NEVER_SERVE = /^\/(server|auth|cleanup|mailer|signup-verification|telegram-login|telegram-gateway|phone-verification|public-ids|security|migrate-passwords|videoRecommendationRoutes|cloudinary|package(-lock)?)\.(js|json)$|^\/\.|\.(env|map|log|sql|bak)$/i;
app.use((req, res, next) => (NEVER_SERVE.test(req.path) ? res.status(404).end() : next()));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Super Admin Account (0962829738 + optional Render Env SUPER_ADMIN_EMAIL)
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAIL || '0962829738,rossaorith@gmail.com,saorithkh2018@gmail.com')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

const ADMIN_MASTER_KEY = process.env.ADMIN_SECRET_KEY || '';
if (!ADMIN_MASTER_KEY) console.warn('[admin] ADMIN_SECRET_KEY is not set: the admin panel is disabled until you set it.');

pool.connect(async (err, client, release) => {
  if (err) return console.error('Error connecting to Database:', err.stack);
  console.log('Database connected successfully to Supabase for Camfeed!');
  try {
    await client.query(`
      ALTER TABLE posts 
      ADD COLUMN IF NOT EXISTS ai_category VARCHAR(100) DEFAULT 'General',
      ADD COLUMN IF NOT EXISTS ai_tags TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shared_post_id INTEGER DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS media_aspect VARCHAR(30) DEFAULT ''
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_user_email ON posts(user_email);
      CREATE INDEX IF NOT EXISTS idx_posts_shared_post_id ON posts(shared_post_id);
      CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id);
      CREATE INDEX IF NOT EXISTS idx_likes_user_post ON likes(user_email, post_id);
      CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
      CREATE INDEX IF NOT EXISTS idx_follows_pair ON follows(follower_email, following_email);
      CREATE INDEX IF NOT EXISTS idx_post_views_pair ON post_views(post_id, viewer_email);
      CREATE INDEX IF NOT EXISTS idx_messages_pair_time ON messages(sender_email, receiver_email, created_at DESC);
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS relationship_status VARCHAR(150) DEFAULT '',
      ADD COLUMN IF NOT EXISTS work VARCHAR(150) DEFAULT '',
      ADD COLUMN IF NOT EXISTS location_privacy VARCHAR(20) DEFAULT 'public',
      ADD COLUMN IF NOT EXISTS birthdate_privacy VARCHAR(20) DEFAULT 'public',
      ADD COLUMN IF NOT EXISTS relationship_privacy VARCHAR(20) DEFAULT 'public',
      ADD COLUMN IF NOT EXISTS gender_privacy VARCHAR(20) DEFAULT 'public',
      ADD COLUMN IF NOT EXISTS work_privacy VARCHAR(20) DEFAULT 'public',
      ADD COLUMN IF NOT EXISTS role VARCHAR(30) DEFAULT 'user',
      ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS last_active TIMESTAMP DEFAULT NULL
    `);

    if (SUPER_ADMIN_EMAILS.length > 0) {
      await client.query(
        `UPDATE users SET role = 'super_admin' WHERE LOWER(email) = ANY($1::text[])`,
        [SUPER_ADMIN_EMAILS]
      );
    }

    await client.query(`
      ALTER TABLE notifications
      ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS comment_id INTEGER DEFAULT NULL
    `);

    await client.query(`
      ALTER TABLE comments
      ADD COLUMN IF NOT EXISTS reply_to_id INTEGER DEFAULT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS comment_likes (
        id SERIAL PRIMARY KEY,
        comment_id INTEGER NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        reaction_type VARCHAR(20) DEFAULT '👍',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(comment_id, user_email)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS post_views (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL,
        viewer_email VARCHAR(255),
        country VARCHAR(100) DEFAULT 'Unknown',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        id SERIAL PRIMARY KEY,
        blocker_email VARCHAR(255) NOT NULL,
        blocked_email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(blocker_email, blocked_email)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_email VARCHAR(255) NOT NULL,
        target_type VARCHAR(30) NOT NULL,
        target_post_id INTEGER DEFAULT NULL,
        target_user_email VARCHAR(255) DEFAULT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('Schema check notice:', e.message);
  }
  try {
    // hashed passwords are ~130 chars; make sure the column can hold them
    await client.query('ALTER TABLE users ALTER COLUMN password TYPE TEXT');
  } catch (e) {
    console.error('Password column notice:', e.message);
  }
  try {
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS name_changed_at TIMESTAMP DEFAULT NULL');
  } catch (e) {
    console.error('name_changed_at notice:', e.message);
  }
  try {
    await signup.ensureSchema();
    await passwordReset.ensureSchema();
    await tgLogin.ensureSchema();
    await phoneSignup.ensureSchema();
    await publicIds.ensureSchema();
    await security.neutralizeExistingData(pool);   // older names / posts / comments / chats: make < > harmless
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_epoch INTEGER DEFAULT 0');      // "log out of all devices"
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs TEXT DEFAULT ''");   // which notifications to receive
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS show_active_status BOOLEAN DEFAULT TRUE');   // "Active status" switch
    await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR(40) PRIMARY KEY, email TEXT NOT NULL, browser VARCHAR(40), os VARCHAR(40), ip_masked VARCHAR(60), country VARCHAR(60), city VARCHAR(60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked BOOLEAN NOT NULL DEFAULT FALSE)`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_sessions_email ON user_sessions (email)');
    await pool.query(`CREATE TABLE IF NOT EXISTS user_interest_scores (
      user_email TEXT NOT NULL, category TEXT NOT NULL, score DOUBLE PRECISION NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_email, category))`);
    await pool.query("DELETE FROM user_sessions WHERE last_seen < NOW() - INTERVAL '90 days'");
  } catch (e) {
    console.error('email verification schema notice:', e.message);
  }
  try {
    // people a user removed from "People you may know" (so they do not come back after refresh)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dismissed_suggestions (
        id SERIAL PRIMARY KEY,
        user_email VARCHAR(255) NOT NULL,
        dismissed_email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, dismissed_email)
      )
    `);
  } catch (e) {
    console.error('dismissed_suggestions notice:', e.message);
  }
  release();
});

// ---- Authentication: every /api call (except login/register) needs a valid token.
// The acting user's email is taken from the token, never from what the browser sends.
const authCore = auth.createAuth(pool);
// People are shown as random numbers instead of e-mails/phone numbers (see public-ids.js). Must run BEFORE authenticate/forceActor.
const publicIds = createPublicIds({ pool });
const rateLimits = security.createRateLimits(auth.makeLimiter);
app.use('/api', security.hideServerErrors);        // the browser never sees database error texts (they go to the log with a reference)
app.use('/api', rateLimits.network);
app.use('/api', publicIds.inbound, publicIds.outbound);
app.use('/api', auth.sanitizeJson, authCore.authenticate, authCore.forceActor);
app.use('/api', rateLimits.person);                // per person: creating things / chatting / everything
app.use('/api', security.inputGuard);              // clean text, only our own https links, only real ids and choices
['id', 'postId', 'commentId', 'reportId'].forEach((name) => app.param(name, security.idParam));   // one call per name (works on every Express version)
const visibility = security.createVisibility(pool);
// the browser reports what its strict policy would have blocked (shown in the Render logs)
app.post('/api/csp-report', express.json({ type: ['application/json', 'application/csp-report', 'application/reports+json'], limit: '20kb' }), security.cspReport(auth.makeLimiter(60, 60 * 1000)));

// E-mail verification before an account can be created (needs EMAIL_PROVIDER + API key + EMAIL_FROM, see README)
const signup = createSignupVerification({ pool, auth, mailer });
const passwordReset = createPasswordReset({ pool, auth, mailer }); // "Forgot password?" by e-mail code
const tgLogin = createTelegramLogin({ pool, auth, authCore, normalizeBirthdate }); // "Continue with Telegram"
const phoneSignup = createPhoneVerification({ pool, auth, gateway, mode: 'signup' }); // phone number + code inside Telegram
const phoneReset = createPhoneVerification({ pool, auth, gateway, mode: 'reset' });
console.log('[phone] Telegram Gateway key: ' + (gateway.isConfigured() ? 'FOUND - phone sign-up is ON' : 'NOT FOUND (set TELEGRAM_GATEWAY_TOKEN in Render) - the Phone tab shows "coming soon"'));
// what a person may see as THEIR OWN contact detail (the hidden phone/Telegram identity is shown as the phone number)
const ownContact = (u) => (isTelegramAddress(u.email) ? (u.phone || '') : u.email);
const isTelegramOnlyAccount = (email) => /^tg\d+@telegram\.camfeedkh\.com$/i.test(String(email || '')); // made with Continue with Telegram: no password

// Global Real-Time Presence Tracker
const lastGlobalPingMap = new Map();
app.use((req, res, next) => {
  if (req.path === '/api/presence/offline') return next();
  const viewerEmail = (
    (req.query && (req.query.email || req.query.viewerEmail || req.query.user1)) ||
    (req.body && (req.body.email || req.body.sender || req.body.userEmail || req.body.followerEmail)) ||
    ''
  ).toString().trim();

  if ((viewerEmail && viewerEmail.includes('@')) || viewerEmail.length >= 6) {
    const key = viewerEmail.toLowerCase();
    const now = Date.now();
    if (!lastGlobalPingMap.has(key) || (now - lastGlobalPingMap.get(key)) > 8000) {
      lastGlobalPingMap.set(key, now);
      pool.query('UPDATE users SET last_active = NOW() WHERE LOWER(email) = $1', [key]).catch(() => {});
    }
  }
  next();
});

// Mount Cloudflare R2 Video/Media Upload, AI Classification & Recommendation Routes
const videoRouter = createVideoRouter(pool);
app.use('/api/videos', videoRouter);

// Deletes database rows AND the files (R2 / Cloudinary) that belong to them, so storage never fills up.
const { createCleanup, extractMediaUrls } = require('./cleanup');
const cleanup = createCleanup({
  pool,
  deleteR2: (url) => (videoRouter.deleteR2ObjectsFromMedia ? videoRouter.deleteR2ObjectsFromMedia(url) : Promise.resolve())
});

const adminPinFailures = auth.makeLimiter(5, 15 * 60 * 1000);   // 5 wrong PINs per admin account per 15 minutes
async function verifyAdminAccess(email, secretKey) {
  if (!email) return { allowed: false, error: 'Missing admin email' };
  const normalized = email.trim().toLowerCase();
  if (adminPinFailures.isLimited(normalized)) return { allowed: false, error: 'Too many wrong PIN attempts. Please wait 15 minutes.' };
  const isSuper = SUPER_ADMIN_EMAILS.includes(normalized);

  const userRes = await pool.query('SELECT email, role, is_banned FROM users WHERE LOWER(email) = $1', [normalized]);
  const dbUser = userRes.rows[0];

  if (!isSuper && (!dbUser || dbUser.is_banned || (dbUser.role !== 'admin' && dbUser.role !== 'super_admin'))) {
    return { allowed: false, error: 'Access Denied: You do not have Admin permission.' };
  }

  if (!ADMIN_MASTER_KEY) {
    return { allowed: false, error: 'Admin PIN is not configured on the server (set ADMIN_SECRET_KEY).' };
  }
  if (!auth.safeEqual(secretKey, ADMIN_MASTER_KEY)) {
    adminPinFailures.hit(normalized);
    return { allowed: false, error: 'Invalid Admin Security PIN / Key.' };
  }

  return { allowed: true, isSuperAdmin: isSuper || dbUser?.role === 'super_admin' };
}

function getPostPreviewTitle(postRow) {
  if (!postRow) return '';
  const raw = (postRow.content || '').trim();
  if (!raw) return '';
  return raw.length > 45 ? raw.substring(0, 45) + '...' : raw;
}

function isVideoPost(postRow) {
  if (!postRow) return false;
  return postRow.media_type === 'video' || (postRow.media_url && postRow.media_url.includes('"type":"video"'));
}

async function classifyPostWithGemini(content, mediaType, thumbnailBase64) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { category: 'General', tags: '' };

  try {
    const promptText = `Analyze this social media post (${mediaType}) and classify it into ONE primary category from: [Comedy, Music, Gaming, Food, Vehicles & Motorcycles, Technology, News, Sports, Education, Travel, Lifestyle, General]. Also extract 3-5 short comma-separated keywords/tags (in English and/or Khmer).
Caption: "${content || ''}"
Respond strictly in JSON format: {"category": "CategoryName", "tags": "tag1, tag2, tag3"}`;

    const parts = [{ text: promptText }];
    if (thumbnailBase64 && thumbnailBase64.startsWith('data:image')) {
      const base64Data = thumbnailBase64.split(',')[1];
      const mimeType = thumbnailBase64.substring(5, thumbnailBase64.indexOf(';'));
      parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (rawText) {
      const parsed = JSON.parse(rawText);
      return {
        category: parsed.category || 'General',
        tags: parsed.tags || ''
      };
    }
  } catch (err) {
    console.error('Gemini AI classification skipped:', err.message);
  }
  return { category: 'General', tags: '' };
}

// Register
// The sign-up form sends DD-MM-YYYY, but PostgreSQL reads dates as MM-DD-YYYY (so "19-01-2009" fails).
// Convert to ISO YYYY-MM-DD. Returns null for an empty value, or undefined for an impossible date.
function normalizeBirthdate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let y, mo, d, m;
  if ((m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else return s; // other free text (e.g. "July 16, 2000") is passed through unchanged
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Sign-up abuse protection: a CAPTCHA (Cloudflare Turnstile) plus a per-IP cap as a backstop.
// The cap is generous because many Cambodian mobile users share one carrier IP.
const registerLimiter = auth.makeLimiter(parseInt(process.env.REGISTER_MAX_PER_HOUR || '10', 10), 60 * 60 * 1000);

// Continue with Telegram (OpenID Connect): the browser leaves for Telegram and comes back to /callback
app.get('/auth/telegram/start', tgLogin.start);
app.get('/auth/telegram/callback', tgLogin.callback);
app.post('/api/telegram/exchange', tgLogin.exchange);
app.post('/api/telegram/complete', tgLogin.complete);
app.get('/api/auth-options', (req, res) => res.json({ success: true, telegram: tgLogin.isConfigured(), phone: gateway.isConfigured() }));

// Phone number + a code that arrives inside the person's Telegram (Telegram Gateway)
const phoneFlow = (req) => (req.body && req.body.purpose === 'reset' ? phoneReset : phoneSignup);
app.post('/api/phone/send-code', (req, res) => phoneFlow(req).sendCode(req, res));
app.post('/api/phone/verify-code', (req, res) => phoneFlow(req).verifyCode(req, res));

app.post('/api/register/send-code', signup.sendCode);
app.post('/api/register/verify-code', signup.verifyCode);

// Forgot password: 1) send a code to the e-mail  2) check the code  3) set a new password
app.post('/api/password/forgot', passwordReset.sendCode);
app.post('/api/password/verify-code', passwordReset.verifyCode);
app.post('/api/password/reset', async (req, res) => {
  const phoneRaw = req.body && req.body.phone;
  const e164 = phoneRaw ? normalizePhone(phoneRaw) : null;
  let email = phoneRaw ? '' : String((req.body && req.body.email) || '').trim();
  const token = phoneRaw ? (req.body && req.body.phoneToken) : (req.body && req.body.emailToken);
  const newPassword = String((req.body && req.body.newPassword) || '');
  try {
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.', errorKm: 'ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 6 តួអក្សរ។' });
    }
    const needVerify = () => res.status(403).json({ success: false, needsEmailVerification: true, error: 'Please verify your email first.', errorKm: 'សូមផ្ទៀងផ្ទាត់អ៊ីមែលរបស់អ្នកជាមុនសិន។' });
    const proofOk = phoneRaw ? (!!e164 && phoneReset.checkToken(e164, token)) : passwordReset.checkEmailToken(email, token);
    if (!proofOk) return needVerify();
    if (phoneRaw) email = (await findAccountEmail(pool, e164)) || '';
    const r = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'No account was found with this email.', errorKm: 'រកមិនឃើញគណនីដែលប្រើអ៊ីមែលនេះទេ។' });
    // single use: the proof is bound to the old password and stops working once it has changed
    const payload = auth.verifyToken(token);
    if (!payload || payload.pv !== auth.fingerprint(user.password)) return needVerify();

    const newHash = await auth.hashPassword(newPassword);
    const upd = await pool.query('UPDATE users SET password = $1 WHERE email = $2 RETURNING *', [newHash, user.email]);
    const fresh = upd.rows[0] || Object.assign({}, user, { password: newHash });
    pool.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [user.email]).catch(() => {});
    authCore.invalidate(user.email);                       // every other logged-in device must log in again
    try { await authCore.revokeAll(user.email); } catch (e) { /* the old tokens stop working anyway: they carry the old password */ }
    auth.clearFailures(`${req.ip}|${email.toLowerCase()}`); // do not keep the person locked out after a reset
    if (phoneRaw) auth.clearFailures(`${req.ip}|${String(phoneRaw).trim().toLowerCase()}`);
    // the person just proved they own the e-mail / phone number: log them in on THIS device and take them straight to the site
    if (fresh.is_banned) return res.json({ success: true, message: 'Password changed. Please log in with your new password.', messageKm: 'បានប្តូរពាក្យសម្ងាត់ហើយ។ សូមចូលគណនីដោយពាក្យសម្ងាត់ថ្មី។' });
    fresh.contact_mail = ownContact(fresh);
    fresh.passwordless = false;
    res.json({ success: true, message: 'Password changed.', messageKm: 'បានប្តូរពាក្យសម្ងាត់ហើយ។', user: fresh, token: authCore.issueToken(fresh, req) });
  } catch (err) {
    console.error('Password reset error:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.', errorKm: 'មានបញ្ហា។ សូមព្យាយាមម្តងទៀត។' });
  }
});

app.post('/api/register', async (req, res) => {
  const { password, firstName, lastName, birthdate, gender, country } = req.body || {};
  let email = String((req.body && req.body.email) || '').trim();
  const viaPhone = !!(req.body && req.body.phone);       // signed up with a phone number + the code that arrived in Telegram
  let phoneE164 = '';
  try {
    if (registerLimiter.isLimited(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many accounts created from this network. Please try again later.' });
    }
    if (viaPhone) {
      phoneE164 = normalizePhone(req.body.phone, country);   // the country chosen in the form decides how a local number is read
      if (!phoneE164 || !phoneSignup.checkToken(phoneE164, req.body.phoneToken)) {
        return res.status(403).json({ success: false, needsEmailVerification: true, error: 'Please verify your phone number first.', errorKm: 'សូមផ្ទៀងផ្ទាត់លេខទូរស័ព្ទរបស់អ្នកជាមុនសិន។' });
      }
      email = phoneEmail(phoneE164);      // hidden identity derived from the VERIFIED number
    } else if (!EMAIL_RE.test(email) || email.length > 254 || isTelegramAddress(email)) {
      // new e-mail accounts need a real e-mail address (a verification code is sent to it)
      return res.status(400).json({ success: false, error: 'Please enter a valid email address (for example name@gmail.com).', errorKm: 'សូមបញ្ចូលអ៊ីមែលត្រឹមត្រូវ (ឧ. name@gmail.com)។' });
    }
    if (viaPhone) {
      // the Telegram code already proved this is a real person who owns the number
    } else if (signup.isRequired()) {
      // e-mail verification is ON: the signed proof from /verify-code must match this e-mail
      if (!signup.checkEmailToken(email, req.body && req.body.emailToken)) {
        return res.status(403).json({ success: false, needsEmailVerification: true, error: 'Please verify your email first.', errorKm: 'សូមផ្ទៀងផ្ទាត់អ៊ីមែលរបស់អ្នកជាមុនសិន។' });
      }
    } else {
      // not configured yet: keep the CAPTCHA as the only protection
      const human = await auth.verifyTurnstile(req.body && req.body.turnstileToken, req.ip);
      if (!human.ok) {
        return res.status(400).json({ success: false, error: human.unavailable
          ? 'Verification service is unavailable. Please try again.'
          : 'Human verification failed. Please try again.' });
      }
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }
    const birth = normalizeBirthdate(birthdate);
    if (birth === undefined) {
      return res.status(400).json({ success: false, error: 'Invalid date of birth.' });
    }
    const isSuper = SUPER_ADMIN_EMAILS.includes(email.toLowerCase());
    const initialRole = isSuper ? 'super_admin' : 'user';
    const hashed = await auth.hashPassword(password);
    const query = `
      INSERT INTO users (email, password, first_name, last_name, birthdate, gender, country, bio, phone_privacy, email_privacy, role, phone) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'private', 'private', $8, $10) 
      RETURNING *
    `;
    const result = await pool.query(query, [email, hashed, firstName, lastName, birth, gender, country, initialRole, 'private', viaPhone ? phoneE164 : null]);
    const user = result.rows[0];
    registerLimiter.hit(req.ip);
    if (!viaPhone && signup.isRequired()) pool.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [user.email]).catch(() => {});
    // password is stripped from the response by auth.sanitizeJson
    user.contact_mail = ownContact(user);
    user.passwordless = false;
    res.status(201).json({ success: true, user, token: authCore.issueToken(user, req) });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ success: false, error: viaPhone ? 'This phone number is already registered.' : 'This email is already registered.' });
    }
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Login (passwords are hashed; old plaintext rows are upgraded automatically on first login)
app.post('/api/login', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const limitKey = `${req.ip}|${email.toLowerCase()}`;
  try {
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please enter email and password.' });
    }
    if (auth.isRateLimited(limitKey)) {
      return res.status(429).json({ success: false, message: 'Too many failed attempts. Please wait 15 minutes and try again.' });
    }
    let result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (!result.rows[0] && !email.includes('@')) {
      const e164 = normalizePhone(email);                     // typed a phone number: find the account (made with the phone tab, or an old one that used the number as its login)
      const found = e164 ? await findAccountEmail(pool, e164) : null;
      if (found) result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [found]);
    }
    const user = result.rows[0];
    let check = { ok: false, needsRehash: false };
    if (user) check = await auth.verifyPassword(password, user.password);
    else await auth.dummyVerify();

    if (!check.ok) {
      auth.recordFailure(limitKey);
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    auth.clearFailures(limitKey);

    if (user.is_banned) {
      return res.status(403).json({ success: false, message: 'គណនីរបស់អ្នកត្រូវបានផ្អាកដោយអ្នកគ្រប់គ្រងប្រព័ន្ធ (Account Suspended).' });
    }
    if (check.needsRehash) {
      const newHash = await auth.hashPassword(password);
      await pool.query('UPDATE users SET password = $1 WHERE email = $2', [newHash, user.email]);
      user.password = newHash;
      authCore.invalidate(user.email);
    }
    if (SUPER_ADMIN_EMAILS.includes(user.email.toLowerCase()) && user.role !== 'super_admin') {
      await pool.query("UPDATE users SET role = 'super_admin' WHERE email = $1", [user.email]);
      user.role = 'super_admin';
    }
    // password is stripped from the response by auth.sanitizeJson; the e-mail field becomes the public id, so the owner gets their own contact detail separately
    user.contact_mail = ownContact(user);
    user.passwordless = isTelegramOnlyAccount(user.email);
    res.json({ success: true, user, token: authCore.issueToken(user, req) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Post
app.post('/api/posts', formFields, authCore.forceActor, async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ success: false, error: 'Request body is missing' });
  }

  const email = req.body.email;
  const content = req.body.content || '';
  const privacy = req.body.privacy || 'public';
  const thumbnailBase64 = req.body.thumbnailBase64 || null;
  const mediaAspect = req.body.mediaAspect || '';

  let mediaUrl = req.file ? req.file.path : (req.body.mediaUrl || null);
  let mediaType = req.file ? (req.file.mimetype && req.file.mimetype.startsWith('video') ? 'video' : 'image') : (req.body.mediaType || 'text');

  if (Array.isArray(req.body.mediaItems) && req.body.mediaItems.length > 0) {
    if (req.body.mediaItems.length === 1) {
      mediaUrl = req.body.mediaItems[0].url;
      mediaType = req.body.mediaItems[0].type || 'image';
    } else {
      mediaUrl = JSON.stringify(req.body.mediaItems);
      mediaType = 'carousel';
    }
  }

  try {
    const aiResult = await classifyPostWithGemini(content, mediaType, thumbnailBase64);

    const query = `
      INSERT INTO posts (user_email, content, media_type, media_url, privacy, ai_category, ai_tags, media_aspect) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
      RETURNING *
    `;
    const result = await pool.query(query, [email, content, mediaType, mediaUrl, privacy, aiResult.category, aiResult.tags, mediaAspect]);
    res.status(201).json({ success: true, post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Share Post to Profile
app.post('/api/posts/share', async (req, res) => {
  const { postId, email, caption } = req.body;
  try {
    if (!postId) return res.status(400).json({ success: false, error: 'Missing post.' });
    if (!(await visibility.guardPost(req, res, postId))) return;
    bumpInterest(req.authEmail, postId, 8);
    const orig = await pool.query(
      'SELECT p.*, u.first_name, u.last_name FROM posts p JOIN users u ON p.user_email = u.email WHERE p.id = $1',
      [postId]
    );
    if (orig.rows.length === 0) return res.status(404).json({ success: false, error: 'Post not found' });

    const p = orig.rows[0];
    const rootPostId = p.shared_post_id ? p.shared_post_id : p.id;

    const result = await pool.query(
      `INSERT INTO posts (user_email, content, media_type, media_url, privacy, ai_category, ai_tags, shared_post_id) 
       VALUES ($1, $2, 'shared', NULL, 'public', $3, $4, $5) 
       RETURNING *`,
      [email, caption || '', p.ai_category || 'General', p.ai_tags || '', rootPostId]
    );

    const sharerRes = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
    const sharerName = `${sharerRes.rows[0]?.first_name || ''} ${sharerRes.rows[0]?.last_name || ''}`.trim();

    const rootRes = await pool.query('SELECT * FROM posts WHERE id = $1', [rootPostId]);
    const rootPost = rootRes.rows[0] || p;
    const ownerEmail = rootPost.user_email;

    if (ownerEmail && ownerEmail !== email) {
      const targetLabel = isVideoPost(rootPost) ? 'វីដេអូរបស់អ្នក' : 'ការបង្ហោះរបស់អ្នក';
      const titleSnippet = getPostPreviewTitle(rootPost);
      const notifMsg = titleSnippet
        ? `${sharerName} បានចែករំលែក${targetLabel}៖ "${titleSnippet}"`
        : `${sharerName} បានចែករំលែក${targetLabel}`;

      await pool.query(
        'INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, $3, $4, $5, FALSE)',
        [ownerEmail, email, rootPostId, 'share', notifMsg]
      );
    }

    res.status(201).json({ success: true, post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get List of People Who Shared a Post/Video
app.get('/api/shares/:postId', async (req, res) => {
  const { postId } = req.params;
  const { email } = req.query;
  try {
    if (!(await visibility.guardPost(req, res, postId))) return;
    const query = `
      SELECT p.id as shared_entry_id, p.created_at as shared_at, p.content as share_caption,
             u.email, u.first_name, u.last_name, u.profile_pic,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = $2 AND f.following_email = u.email) AS is_following
      FROM posts p
      JOIN users u ON p.user_email = u.email
      WHERE p.shared_post_id = $1
      ORDER BY p.created_at DESC
    `;
    const result = await pool.query(query, [postId, email || '']);
    res.json({ success: true, sharers: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Track Post / Video View & Country Metadata
app.post('/api/posts/:id/view', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  try {
    if (!(await visibility.guardPost(req, res, id))) return;
    bumpInterest(req.authEmail, id, 1);
    let viewerCountry = req.headers['cf-ipcountry'] || 'Unknown';
    if (email) {
      const uRes = await pool.query('SELECT country FROM users WHERE email = $1', [email]);
      if (uRes.rows[0]?.country) viewerCountry = uRes.rows[0].country;
    }

    await pool.query(
      'INSERT INTO post_views (post_id, viewer_email, country) VALUES ($1, $2, $3)',
      [id, email || null, viewerCountry]
    );
    const upd = await pool.query(
      'UPDATE posts SET views_count = COALESCE(views_count, 0) + 1 WHERE id = $1 RETURNING views_count',
      [id]
    );
    res.json({ success: true, views_count: upd.rows[0]?.views_count || 1 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Report Post or Video to Admin
app.post('/api/posts/:id/report', async (req, res) => {
  const { id } = req.params;
  const { email, reason } = req.body;
  try {
    if (!(await visibility.guardPost(req, res, id))) return;
    const postRes = await pool.query('SELECT user_email FROM posts WHERE id = $1', [id]);
    const targetUserEmail = postRes.rows[0]?.user_email || null;

    await pool.query(
      `INSERT INTO reports (reporter_email, target_type, target_post_id, target_user_email, reason)
       VALUES ($1, 'post', $2, $3, $4)`,
      [email, id, targetUserEmail, reason || 'Violation reported']
    );
    res.json({ success: true, message: 'របាយការណ៍របស់អ្នកត្រូវបានបញ្ជូនទៅកាន់ Admin ដើម្បីត្រួតពិនិត្យភ្លាមៗ!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Report User Profile to Admin
app.post('/api/users/report', async (req, res) => {
  const { reporterEmail, targetEmail, reason } = req.body;
  try {
    await pool.query(
      `INSERT INTO reports (reporter_email, target_type, target_user_email, reason)
       VALUES ($1, 'profile', $2, $3)`,
      [reporterEmail, targetEmail, reason || 'Profile violation reported']
    );
    res.json({ success: true, message: 'របាយការណ៍អំពីគណនីនេះត្រូវបានបញ្ជូនទៅកាន់ Admin ដើម្បីត្រួតពិនិត្យភ្លាមៗ!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Block & Unblock User
app.post('/api/block', async (req, res) => {
  const { blockerEmail, blockedEmail } = req.body;
  try {
    await pool.query(
      'INSERT INTO blocked_users (blocker_email, blocked_email) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [blockerEmail, blockedEmail]
    );
    await pool.query(
      'DELETE FROM follows WHERE (follower_email = $1 AND following_email = $2) OR (follower_email = $2 AND following_email = $1)',
      [blockerEmail, blockedEmail]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/unblock', async (req, res) => {
  const { blockerEmail, blockedEmail } = req.body;
  try {
    await pool.query(
      'DELETE FROM blocked_users WHERE blocker_email = $1 AND blocked_email = $2',
      [blockerEmail, blockedEmail]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Feed, Profile & Video Posts (Supports `excludeIds` for Infinite Non-Duplicate Scrolling)
let postsSchemaReady = false;
app.get('/api/posts', async (req, res) => {
  const { email, profileEmail, type, limit, offset } = req.query;
  const safeViewer = email || '';
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 15, 5), 50);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  try {
    if (!postsSchemaReady) {
      await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_aspect VARCHAR(30) DEFAULT ''").catch(() => {});
      postsSchemaReady = true;
    }
    const cteAndJoins = `
      WITH blocked AS (
        SELECT blocked_email AS u_email FROM blocked_users WHERE blocker_email = $1
        UNION
        SELECT blocker_email AS u_email FROM blocked_users WHERE blocked_email = $1
      ),
      like_stats AS (
        SELECT post_id,
               COUNT(*)::int AS likes_count,
               ARRAY_AGG(DISTINCT reaction_type) AS reaction_types,
               MAX(CASE WHEN user_email = $1 THEN reaction_type ELSE NULL END) AS user_reaction
        FROM likes
        GROUP BY post_id
      ),
      comment_stats AS (
        SELECT post_id, COUNT(*)::int AS comments_count
        FROM comments
        GROUP BY post_id
      ),
      share_stats AS (
        SELECT shared_post_id AS post_id, COUNT(*)::int AS shares_count
        FROM posts
        WHERE shared_post_id IS NOT NULL
        GROUP BY shared_post_id
      )
      SELECT
        p.*, u.first_name, u.last_name, u.profile_pic,
        COALESCE(ls.likes_count, 0) AS likes_count,
        COALESCE(cs.comments_count, 0) AS comments_count,
        COALESCE(ss.shares_count, 0) AS shares_count,
        ls.user_reaction,
        ls.reaction_types,
        op.id AS orig_id,
        op.content AS orig_content,
        op.media_type AS orig_media_type,
        op.media_url AS orig_media_url,
        op.media_aspect AS orig_media_aspect,
        op.created_at AS orig_created_at,
        op.privacy AS orig_privacy,
        ou.email AS orig_author_email,
        ou.first_name AS orig_first_name,
        ou.last_name AS orig_last_name,
        ou.profile_pic AS orig_profile_pic
    `;

    const baseFrom = `
      FROM posts p
      JOIN users u ON p.user_email = u.email
      LEFT JOIN like_stats ls ON ls.post_id = p.id
      LEFT JOIN comment_stats cs ON cs.post_id = p.id
      LEFT JOIN share_stats ss ON ss.post_id = p.id
      LEFT JOIN posts op ON p.shared_post_id = op.id
      LEFT JOIN users ou ON op.user_email = ou.email
    `;

    if (profileEmail) {
      let query = `${cteAndJoins} ${baseFrom}`;
      if (profileEmail === safeViewer) {
        query += type === 'videos'
          ? ` WHERE p.user_email = $2 AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video')`
          : ` WHERE p.user_email = $2`;
      } else {
        query += type === 'videos'
          ? ` WHERE p.user_email = $2 AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video') AND p.privacy = 'public' AND COALESCE(u.is_banned, FALSE) = FALSE AND p.user_email NOT IN (SELECT u_email FROM blocked)`
          : ` WHERE p.user_email = $2 AND p.privacy = 'public' AND COALESCE(u.is_banned, FALSE) = FALSE AND p.user_email NOT IN (SELECT u_email FROM blocked)`;
      }
      query += ` ORDER BY p.created_at DESC LIMIT $3 OFFSET $4`;
      const result = await pool.query(query, [safeViewer, profileEmail, parsedLimit, parsedOffset]);
      result.rows.forEach((r) => visibility.scrubOriginal(r, req.authEmail));
      return res.json({ success: true, posts: result.rows, hasMore: result.rows.length === parsedLimit });
    }

    const excludeIdsRaw = (req.query.excludeIds || '').toString().trim();
    const excludeIds = excludeIdsRaw
      ? excludeIdsRaw.split(',').map(x => parseInt(x.trim(), 10)).filter(n => Number.isInteger(n) && n > 0)
      : [];

    const videoOnlyCondition = type === 'videos'
      ? ` AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video')`
      : '';

    const excludeCondition = excludeIds.length > 0
      ? ` AND NOT (p.id = ANY($4::int[]))`
      : '';

    // Like Facebook: the feed is RANKED, not sorted by posting time. Popular posts (likes, comments, shares, views) are pushed to more
    // people, and what you are interested in right now (the kinds of posts you watch / react to) comes first. Every refresh mixes it again.
    // FEED_MODE=latest switches back to "newest first".
    const useLatest = process.env.FEED_MODE === 'latest';
    const feedOrder = useLatest ? 'p.created_at DESC, p.id DESC' : 'feed_rank_score DESC, p.created_at DESC';
    const feedQuery = `
      ${cteAndJoins},
      (
        CASE 
          WHEN p.user_email = $1 THEN 85
          WHEN f.following_email IS NOT NULL THEN 90
          ELSE 12
        END
        + (COALESCE(ls.likes_count, 0) * 3.0)
        + (COALESCE(cs.comments_count, 0) * 4.5)
        + (COALESCE(ss.shares_count, 0) * 6.0)
        + (COALESCE(p.views_count, 0) * 0.15)
        + (LN(1.0 + COALESCE(ls.likes_count, 0) + COALESCE(cs.comments_count, 0) * 2.0 + COALESCE(ss.shares_count, 0) * 3.0 + COALESCE(p.views_count, 0) * 0.1) * 4.0)
        + (COALESCE(uis.score, 0) * 2.5)
        + (CASE WHEN pv.post_id IS NOT NULL THEN -25 ELSE 18 END)
        + (25.0 / (EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0 + 2.0))
        + (RANDOM() * 18.0)
      ) AS feed_rank_score
      ${baseFrom}
      LEFT JOIN follows f ON f.follower_email = $1 AND f.following_email = p.user_email
      LEFT JOIN user_interest_scores uis ON uis.user_email = $1 AND uis.category = p.ai_category
      LEFT JOIN (SELECT DISTINCT post_id FROM post_views WHERE viewer_email = $1) pv ON pv.post_id = p.id
      WHERE (p.privacy = 'public' OR p.user_email = $1 OR f.following_email IS NOT NULL)
        ${videoOnlyCondition}
        ${excludeCondition}
        AND COALESCE(u.is_banned, FALSE) = FALSE
        AND p.user_email NOT IN (SELECT u_email FROM blocked)
      ORDER BY ${feedOrder}
      LIMIT $2 OFFSET $3
    `;

    const queryParams = excludeIds.length > 0
      ? [safeViewer, parsedLimit, 0, excludeIds]
      : [safeViewer, parsedLimit, parsedOffset];

    const result = await pool.query(feedQuery, queryParams);
    res.json({ success: true, posts: result.rows, hasMore: result.rows.length === parsedLimit });
  } catch (err) {
    console.error('Error loading posts:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  const { email } = req.query;
  try {
    if (!(await visibility.guardPost(req, res, id))) return;
    const query = `
      SELECT p.*, u.first_name, u.last_name, u.profile_pic,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comments_count,
      (SELECT COUNT(*) FROM posts sp WHERE sp.shared_post_id = p.id) as shares_count,
      (SELECT reaction_type FROM likes l WHERE l.post_id = p.id AND l.user_email = $2) as user_reaction,
      (SELECT ARRAY_AGG(DISTINCT reaction_type) FROM likes l WHERE l.post_id = p.id) as reaction_types,
      op.id as orig_id,
      op.content as orig_content,
      op.media_type as orig_media_type,
      op.media_url as orig_media_url,
      op.created_at as orig_created_at,
      op.privacy as orig_privacy,
      ou.email as orig_author_email,
      ou.first_name as orig_first_name,
      ou.last_name as orig_last_name,
      ou.profile_pic as orig_profile_pic
      FROM posts p 
      JOIN users u ON p.user_email = u.email
      LEFT JOIN posts op ON p.shared_post_id = op.id
      LEFT JOIN users ou ON op.user_email = ou.email
      WHERE p.id = $1
    `;
    const result = await pool.query(query, [id, email || '']);
    if (result.rows.length > 0) {
      res.json({ success: true, post: visibility.scrubOriginal(result.rows[0], req.authEmail) });
    } else {
      res.status(404).json({ success: false, error: 'Post not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  const { content, privacy, email } = req.body;
  try {
    const query = 'UPDATE posts SET content = $1, privacy = $2 WHERE id = $3 AND user_email = $4 RETURNING *';
    const result = await pool.query(query, [content, privacy || 'public', id, email]);
    if (result.rows.length > 0) {
      res.json({ success: true, post: result.rows[0] });
    } else {
      res.status(403).json({ success: false, error: 'Unauthorized or post not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  try {
    const owned = await pool.query('SELECT id FROM posts WHERE id = $1 AND LOWER(user_email) = LOWER($2)', [id, (email || '').trim()]);
    if (owned.rows.length > 0) {
      await cleanup.deletePostCompletely(owned.rows[0].id); // post, shares, comments, likes + photos/videos in storage
      res.json({ success: true });
    } else {
      res.status(403).json({ success: false, error: 'Unauthorized or post not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Profile & Cover Pictures
app.post('/api/update-profile-pics', formFields, authCore.forceActor, async (req, res) => {
  const { email, bio, profilePicUrl, coverPicUrl } = req.body;
  try {
    let profileUrl = profilePicUrl || (req.files && req.files['profilePic'] ? req.files['profilePic'][0].path : null);
    let coverUrl = coverPicUrl || (req.files && req.files['coverPic'] ? req.files['coverPic'][0].path : null);
    const oldPics = await pool.query('SELECT profile_pic, cover_pic FROM users WHERE email = $1', [email]);

    let query = 'UPDATE users SET bio = $1';
    let params = [bio || ''];
    let idx = 2;

    if (profileUrl) {
      query += `, profile_pic = $${idx++}`;
      params.push(profileUrl);
    }
    if (coverUrl) {
      query += `, cover_pic = $${idx++}`;
      params.push(coverUrl);
    }
    query += ` WHERE email = $${idx} RETURNING *`;
    params.push(email);

    const result = await pool.query(query, params);
    const oldUrls = [];
    const o = oldPics.rows[0];
    if (o) {
      if (profileUrl && o.profile_pic && o.profile_pic !== profileUrl) oldUrls.push(o.profile_pic);
      if (coverUrl && o.cover_pic && o.cover_pic !== coverUrl) oldUrls.push(o.cover_pic);
    }
    res.json({ success: true, user: result.rows[0] });
    if (oldUrls.length) cleanup.purgeMediaUrls(oldUrls).catch(() => {}); // old picture no longer needed
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Personal Details & Per-Field Privacy
app.post('/api/update-profile-details', async (req, res) => {
  const {
    email,
    location, location_privacy,
    birthdate, birthdate_privacy,
    relationship_status, relationship_privacy,
    gender, gender_privacy,
    work, work_privacy,
    phone, phone_privacy,
    email_privacy
  } = req.body;

  try {
    const normalizedBirthdate = normalizeBirthdate(birthdate);
    if (normalizedBirthdate === undefined) {
      return res.status(400).json({ success: false, error: 'Invalid date of birth (use DD-MM-YYYY).' });
    }
    const query = `
      UPDATE users 
      SET location = $1, location_privacy = $2,
          birthdate = $3, birthdate_privacy = $4,
          relationship_status = $5, relationship_privacy = $6,
          gender = $7, gender_privacy = $8,
          work = $9, work_privacy = $10,
          phone = $11, phone_privacy = $12,
          email_privacy = $13
      WHERE email = $14 
      RETURNING *
    `;
    const result = await pool.query(query, [
      location || '', location_privacy || 'public',
      normalizedBirthdate, birthdate_privacy || 'public',
      relationship_status || '', relationship_privacy || 'public',
      gender || 'Male', gender_privacy || 'public',
      work || '', work_privacy || 'public',
      phone || '', phone_privacy || 'public',
      email_privacy || 'public',
      email
    ]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reaction Endpoint
app.post('/api/reaction', async (req, res) => {
  const { postId, email, reactionType } = req.body;
  try {
    if (!postId) return res.status(400).json({ success: false, error: 'Missing post.' });
    if (!(await visibility.guardPost(req, res, postId))) return;
    const check = await pool.query('SELECT * FROM likes WHERE post_id = $1 AND user_email = $2', [postId, email]);
    const postInfo = await pool.query(
      'SELECT p.*, u.first_name, u.last_name FROM posts p JOIN users u ON u.email = $2 WHERE p.id = $1',
      [postId, email]
    );
    const postRow = postInfo.rows[0];
    const ownerEmail = postRow?.user_email;
    const likerName = `${postRow?.first_name || ''} ${postRow?.last_name || ''}`.trim();

    let reacted = false;
    if (check.rows.length > 0) {
      if (check.rows[0].reaction_type === reactionType) {
        await pool.query('DELETE FROM likes WHERE post_id = $1 AND user_email = $2', [postId, email]);
        reacted = false;
      } else {
        await pool.query('UPDATE likes SET reaction_type = $1 WHERE post_id = $2 AND user_email = $3', [reactionType, postId, email]);
        reacted = true;
      }
    } else {
      await pool.query('INSERT INTO likes (post_id, user_email, reaction_type) VALUES ($1, $2, $3)', [postId, email, reactionType || '👍']);
      reacted = true;
      bumpInterest(req.authEmail, postId, 5);

      if (ownerEmail && ownerEmail !== email) {
        const targetLabel = isVideoPost(postRow) ? 'វីដេអូរបស់អ្នក' : 'ការបង្ហោះរបស់អ្នក';
        const titleSnippet = getPostPreviewTitle(postRow);
        const emojiIcon = reactionType || '👍';
        const notifMsg = titleSnippet
          ? `${likerName} បានបញ្ចេញប្រតិកម្ម ${emojiIcon} លើ${targetLabel}៖ "${titleSnippet}"`
          : `${likerName} បានបញ្ចេញប្រតិកម្ម ${emojiIcon} លើ${targetLabel}`;

        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, $3, $4, $5, FALSE)',
          [ownerEmail, email, postId, 'reaction', notifMsg]
        );
      }
    }

    const countRes = await pool.query('SELECT COUNT(*) FROM likes WHERE post_id = $1', [postId]);
    const typesRes = await pool.query('SELECT DISTINCT reaction_type FROM likes WHERE post_id = $1', [postId]);
    const reaction_types = typesRes.rows.map(r => r.reaction_type);
    res.json({ success: true, reacted, likes_count: countRes.rows[0].count, reaction_types });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reactions/:postId', async (req, res) => {
  const { postId } = req.params;
  const { email } = req.query;
  try {
    if (!(await visibility.guardPost(req, res, postId))) return;
    const query = `
      SELECT u.email, u.first_name, u.last_name, u.profile_pic, l.reaction_type,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = $2 AND f.following_email = u.email) AS is_following
      FROM likes l
      JOIN users u ON l.user_email = u.email
      WHERE l.post_id = $1
    `;
    const result = await pool.query(query, [postId, email]);
    res.json({ success: true, reactors: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Comments
app.get('/api/comments/:postId', async (req, res) => {
  const { postId } = req.params;
  const { email } = req.query;
  try {
    if (!(await visibility.guardPost(req, res, postId))) return;
    const query = `
      SELECT c.*, u.first_name, u.last_name, u.profile_pic,
             (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS likes_count,
             (SELECT reaction_type FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_email = $2) AS user_reaction,
             (SELECT ARRAY_AGG(DISTINCT reaction_type) FROM comment_likes cl WHERE cl.comment_id = c.id) AS reaction_types
      FROM comments c 
      JOIN users u ON c.user_email = u.email 
      WHERE c.post_id = $1 
      ORDER BY c.created_at ASC
    `;
    const result = await pool.query(query, [postId, email || '']);
    res.json({ success: true, comments: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// React to a Comment
app.post('/api/comments/:id/reaction', async (req, res) => {
  const { id } = req.params;
  const { email, reactionType } = req.body;
  try {
    const parentPost = await visibility.postIdOfComment(id);
    if (!parentPost || !(await visibility.guardPost(req, res, parentPost))) { if (!parentPost) res.status(404).json({ success: false, error: 'Comment not found' }); return; }
    const check = await pool.query('SELECT * FROM comment_likes WHERE comment_id = $1 AND user_email = $2', [id, email]);
    const cInfo = await pool.query(
      'SELECT c.*, u.first_name, u.last_name FROM comments c JOIN users u ON u.email = $2 WHERE c.id = $1',
      [id, email]
    );
    const commentRow = cInfo.rows[0];
    if (!commentRow) return res.status(404).json({ success: false, error: 'Comment not found' });

    let reacted = false;
    const emoji = reactionType || '👍';
    if (check.rows.length > 0) {
      if (check.rows[0].reaction_type === emoji) {
        await pool.query('DELETE FROM comment_likes WHERE comment_id = $1 AND user_email = $2', [id, email]);
        reacted = false;
      } else {
        await pool.query('UPDATE comment_likes SET reaction_type = $1 WHERE comment_id = $2 AND user_email = $3', [emoji, id, email]);
        reacted = true;
      }
    } else {
      await pool.query('INSERT INTO comment_likes (comment_id, user_email, reaction_type) VALUES ($1, $2, $3)', [id, email, emoji]);
      reacted = true;

      if (commentRow.user_email && commentRow.user_email !== email) {
        const reactorName = `${commentRow.first_name || ''} ${commentRow.last_name || ''}`.trim();
        const snippet = (commentRow.content || '').slice(0, 40);
        const notifMsg = `${reactorName} បានបញ្ចេញប្រតិកម្ម ${emoji} លើមតិរបស់អ្នក៖ "${snippet}"`;
        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, post_id, comment_id, type, message, is_read) VALUES ($1, $2, $3, $4, $5, $6, FALSE)',
          [commentRow.user_email, email, commentRow.post_id, id, 'comment_reaction', notifMsg]
        );
      }
    }

    const countRes = await pool.query('SELECT COUNT(*) FROM comment_likes WHERE comment_id = $1', [id]);
    const typesRes = await pool.query('SELECT DISTINCT reaction_type FROM comment_likes WHERE comment_id = $1', [id]);
    res.json({
      success: true,
      reacted,
      likes_count: parseInt(countRes.rows[0].count) || 0,
      reaction_types: typesRes.rows.map(r => r.reaction_type)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/comments', async (req, res) => {
  const { postId, email, content, replyToCommentId } = req.body;
  try {
    if (!postId || !content || !String(content).trim()) return res.status(400).json({ success: false, error: 'A comment needs a post and some text.' });
    if (!(await visibility.guardPost(req, res, postId))) return;
    bumpInterest(req.authEmail, postId, 4);
    const query = 'INSERT INTO comments (post_id, user_email, content, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING *';
    const result = await pool.query(query, [postId, email, content, replyToCommentId || null]);
    const newComment = result.rows[0];

    const userInfo = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
    const commenterName = `${userInfo.rows[0]?.first_name || ''} ${userInfo.rows[0]?.last_name || ''}`.trim();

    const postInfo = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    const postRow = postInfo.rows[0];
    const targetLabel = isVideoPost(postRow) ? 'វីដេអូរបស់អ្នក' : 'ការបង្ហោះរបស់អ្នក';
    const titleSnippet = getPostPreviewTitle(postRow);

    if (replyToCommentId) {
      const parentCommentInfo = await pool.query('SELECT user_email FROM comments WHERE id = $1', [replyToCommentId]);
      const parentAuthorEmail = parentCommentInfo.rows[0]?.user_email;

      if (parentAuthorEmail && parentAuthorEmail !== email) {
        const notifMsg = `${commenterName} បានឆ្លើយតបមតិរបស់អ្នក៖ "${content}"`;
        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, post_id, comment_id, type, message, is_read) VALUES ($1, $2, $3, $4, $5, $6, FALSE)',
          [parentAuthorEmail, email, postId, newComment.id, 'reply', notifMsg]
        );
      }
    } else {
      const ownerEmail = postRow?.user_email;

      if (ownerEmail && ownerEmail !== email) {
        const notifMsg = titleSnippet
          ? `${commenterName} បានបញ្ចេញមតិលើ${targetLabel} (${titleSnippet})៖ "${content}"`
          : `${commenterName} បានបញ្ចេញមតិលើ${targetLabel}៖ "${content}"`;

        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, post_id, comment_id, type, message, is_read) VALUES ($1, $2, $3, $4, $5, $6, FALSE)',
          [ownerEmail, email, postId, newComment.id, 'comment', notifMsg]
        );
      }
    }

    res.json({ success: true, comment: newComment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/comments/:id', async (req, res) => {
  const { id } = req.params;
  const { email, content } = req.body;
  try {
    const query = 'UPDATE comments SET content = $1 WHERE id = $2 AND user_email = $3 RETURNING *';
    const result = await pool.query(query, [content, id, email]);
    if (result.rows.length > 0) {
      res.json({ success: true, comment: result.rows[0] });
    } else {
      res.status(403).json({ success: false, error: 'Unauthorized or comment not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  try {
    const checkQuery = `
      SELECT c.*, p.user_email as post_owner_email 
      FROM comments c 
      JOIN posts p ON c.post_id = p.id 
      WHERE c.id = $1
    `;
    const checkRes = await pool.query(checkQuery, [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Comment not found' });
    }

    const comment = checkRes.rows[0];
    if (comment.user_email !== email && comment.post_owner_email !== email) {
      return res.status(403).json({ success: false, error: 'Unauthorized to delete this comment' });
    }

    await cleanup.deleteCommentCompletely(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/comments/report', async (req, res) => {
  const { commentId, email, reason } = req.body;
  try {
    await pool.query(
      `INSERT INTO reports (reporter_email, target_type, target_post_id, reason)
       VALUES ($1, 'comment', $2, $3)`,
      [email, commentId, reason || 'Comment violation']
    );
    res.json({ success: true, message: 'Report received successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Notifications & Mark Read
app.get('/api/notifications', async (req, res) => {
  const { email } = req.query;
  try {
    const prefRow = await pool.query('SELECT notification_prefs FROM users WHERE email = $1', [email]);
    const hiddenTypes = disabledNotificationTypes(readNotificationPrefs(prefRow.rows[0] && prefRow.rows[0].notification_prefs));
    const query = `
      SELECT n.*, u.first_name, u.last_name, u.profile_pic, p.media_type as post_media_type
      FROM notifications n 
      JOIN users u ON n.sender_email = u.email 
      LEFT JOIN posts p ON n.post_id = p.id
      WHERE n.recipient_email = $1 
        AND n.type <> ALL($2::text[])
      ORDER BY n.created_at DESC
      LIMIT 40
    `;
    const result = await pool.query(query, [email, hiddenTypes]);
    res.json({ success: true, notifications: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { email, notificationId } = req.body;
  try {
    if (notificationId) {
      await pool.query(
        'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND recipient_email = $2',
        [notificationId, email]
      );
    } else if (email) {
      await pool.query(
        'UPDATE notifications SET is_read = TRUE WHERE recipient_email = $1 AND COALESCE(is_read, FALSE) = FALSE',
        [email]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// User Profile
app.get('/api/user-profile', async (req, res) => {
  const { email } = req.query;
  const viewerEmail = req.authEmail || req.query.viewerEmail;     // who is asking comes from the login, not from what the browser says
  try {
    if (viewerEmail && viewerEmail !== email) {
      const blockCheck = await pool.query(
        'SELECT 1 FROM blocked_users WHERE (blocker_email = $1 AND blocked_email = $2) OR (blocker_email = $2 AND blocked_email = $1)',
        [viewerEmail, email]
      );
      if (blockCheck.rows.length > 0) {
        return res.status(403).json({ success: false, blocked: true, error: 'Profile unavailable' });
      }
    }

    const query = `
      SELECT u.*, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '35 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $2), TRUE)) AS is_online,
      (SELECT COUNT(*) FROM follows f WHERE f.following_email = u.email) as followers_count,
      (SELECT COUNT(*) FROM follows f WHERE f.follower_email = u.email) as following_count,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = $2 AND f.following_email = u.email)) as is_following,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = u.email AND f.following_email = $2)) as is_followed_by
      FROM users u WHERE u.email = $1
    `;
    const result = await pool.query(query, [email, viewerEmail]);
    if (result.rows.length > 0) {
      const u = result.rows[0];
      for (const internal of ['password', 'sessions_epoch', 'telegram_id', 'email_verified', 'notification_prefs']) delete u[internal];
      u.is_friend = u.is_following && u.is_followed_by;
      // "email" is turned into the public id on the way out, so the contact e-mail travels in its own field, only when allowed
      const isSelf = String(viewerEmail || '').toLowerCase() === String(email || '').toLowerCase();
      u.contact_mail = isTelegramAddress(u.email) ? '' : ((isSelf || u.email_privacy === 'public') ? u.email : '');

      if (viewerEmail !== email) {
        if (u.location_privacy === 'private') u.location = '';
        if (u.birthdate_privacy === 'private') u.birthdate = '';
        if (u.relationship_privacy === 'private') u.relationship_status = '';
        if (u.gender_privacy === 'private') u.gender = '';
        if (u.work_privacy === 'private') u.work = '';
        if (u.phone_privacy === 'private') u.phone = '';
      }
      if (isSelf) u.show_active_status = u.show_active_status !== false;
      if (!isSelf) for (const k of ['role', 'is_banned', 'name_changed_at', 'last_active', 'country', 'show_active_status']) delete u[k];   // internal details of other people
      res.json({ success: true, user: u });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  const { email, suggestions } = req.query;
  const hideDismissed = suggestions === '1' || suggestions === 'true';
  try {
    const buildQuery = (withDismissed) => `
      SELECT email, first_name, last_name, profile_pic, cover_pic, bio, birthdate, location, phone_privacy, email_privacy, location_privacy, birthdate_privacy,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = $1 AND f.following_email = users.email) AS is_following,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = users.email AND f.following_email = $1) AS is_followed_by
      FROM users 
      WHERE email != $1
        AND COALESCE(is_banned, FALSE) = FALSE
        AND email NOT IN (
          SELECT blocked_email FROM blocked_users WHERE blocker_email = $1
          UNION
          SELECT blocker_email FROM blocked_users WHERE blocked_email = $1
        )
        ${withDismissed ? 'AND email NOT IN (SELECT dismissed_email FROM dismissed_suggestions WHERE user_email = $1)' : ''}
      ORDER BY first_name ASC
      LIMIT 300
    `;
    let result;
    try {
      result = await pool.query(buildQuery(hideDismissed), [email]);
    } catch (e) {
      if (hideDismissed && e.code === '42P01') result = await pool.query(buildQuery(false), [email]); // table not created yet
      else throw e;
    }
    
    const usersWithFriendship = result.rows.map((u) => {
      if (u.location_privacy === 'private') u.location = '';       // what the owner keeps private is not sent at all
      if (u.birthdate_privacy === 'private') u.birthdate = '';
      return { ...u, is_friend: !!(u.is_following && u.is_followed_by) };
    });

    res.json({ success: true, users: usersWithFriendship });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Follow List
app.get('/api/follow-list', async (req, res) => {
  const { email, type } = req.query;
  try {
    let query = '';
    if (type === 'friends') {
      query = `
        SELECT u.email, u.first_name, u.last_name, u.profile_pic, TRUE AS is_following
        FROM follows f1
        JOIN follows f2 ON f1.following_email = f2.follower_email AND f2.following_email = $1
        JOIN users u ON u.email = f1.following_email
        WHERE f1.follower_email = $1
      `;
    } else if (type === 'followers') {
      query = `
        SELECT u.email, u.first_name, u.last_name, u.profile_pic,
        EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_email = $2 AND f2.following_email = u.email) AS is_following
        FROM follows f
        JOIN users u ON f.follower_email = u.email
        WHERE f.following_email = $1
      `;
    } else {
      query = `
        SELECT u.email, u.first_name, u.last_name, u.profile_pic,
        EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_email = $2 AND f2.following_email = u.email) AS is_following
        FROM follows f
        JOIN users u ON f.following_email = u.email
        WHERE f.follower_email = $1
      `;
    }
    const result = await pool.query(query, type === 'friends' ? [email] : [email, email]);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/follow', async (req, res) => {
  const { followerEmail, followingEmail, action } = req.body;
  try {
    const userInfo = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [followerEmail]);
    const followerName = `${userInfo.rows[0]?.first_name || ''} ${userInfo.rows[0]?.last_name || ''}`.trim();

    if (action === 'follow') {
      await pool.query('INSERT INTO follows (follower_email, following_email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [followerEmail, followingEmail]);
      if (followerEmail !== followingEmail) {
        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, type, message, is_read) VALUES ($1, $2, $3, $4, FALSE)',
          [followingEmail, followerEmail, 'follow', `${followerName} បានចាប់ផ្តើមតាមដាន (Follow) អ្នក។`]
        );
      }
    } else {
      await pool.query('DELETE FROM follows WHERE follower_email = $1 AND following_email = $2', [followerEmail, followingEmail]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Chat Conversations
app.get('/api/chat-conversations', async (req, res) => {
  const { email } = req.query;
  try {
    const query = `
      SELECT DISTINCT u.email, u.first_name, u.last_name, u.profile_pic, CASE WHEN COALESCE(u.show_active_status, TRUE) THEN u.last_active END AS last_active, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '35 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online,
      (
        SELECT m.message FROM messages m 
        WHERE (m.sender_email = u.email AND m.receiver_email = $1) OR (m.sender_email = $1 AND m.receiver_email = u.email)
        ORDER BY m.created_at DESC LIMIT 1
      ) as last_message,
      (
        SELECT m.sender_email FROM messages m 
        WHERE (m.sender_email = u.email AND m.receiver_email = $1) OR (m.sender_email = $1 AND m.receiver_email = u.email)
        ORDER BY m.created_at DESC LIMIT 1
      ) as last_sender_email,
      (
        SELECT COUNT(*)::int FROM messages m
        WHERE m.sender_email = u.email AND m.receiver_email = $1 AND COALESCE(m.is_read, FALSE) = FALSE
      ) as unread_count,
      (
        SELECT m.created_at FROM messages m 
        WHERE (m.sender_email = u.email AND m.receiver_email = $1) OR (m.sender_email = $1 AND m.receiver_email = u.email)
        ORDER BY m.created_at DESC LIMIT 1
      ) as last_time
      FROM users u
      JOIN messages m ON u.email = m.sender_email OR u.email = m.receiver_email
      WHERE (m.sender_email = $1 OR m.receiver_email = $1) AND u.email != $1
        AND u.email NOT IN (
          SELECT blocked_email FROM blocked_users WHERE blocker_email = $1
          UNION
          SELECT blocker_email FROM blocked_users WHERE blocked_email = $1
        )
      
      UNION
      
      SELECT u.email, u.first_name, u.last_name, u.profile_pic, CASE WHEN COALESCE(u.show_active_status, TRUE) THEN u.last_active END AS last_active, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '35 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online,
      'Start a conversation' as last_message,
      NULL as last_sender_email,
      0 as unread_count,
      NOW() - INTERVAL '1 year' as last_time
      FROM users u
      JOIN follows f ON (f.following_email = u.email AND f.follower_email = $1) OR (f.follower_email = u.email AND f.following_email = $1)
      WHERE u.email != $1 
        AND u.email NOT IN (
          SELECT blocked_email FROM blocked_users WHERE blocker_email = $1
          UNION
          SELECT blocker_email FROM blocked_users WHERE blocked_email = $1
        )
        AND u.email NOT IN (
          SELECT DISTINCT CASE WHEN sender_email = $1 THEN receiver_email ELSE sender_email END 
          FROM messages WHERE sender_email = $1 OR receiver_email = $1
        )
      
      ORDER BY last_time DESC NULLS LAST
    `;
    const result = await pool.query(query, [email]);
    res.json({ success: true, conversations: result.rows });
  } catch (err) {
    console.error("Error loading conversations:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/search-users', async (req, res) => {
  const { email, keyword } = req.query;
  try {
    const query = `
      SELECT email, first_name, last_name, profile_pic, CASE WHEN COALESCE(show_active_status, TRUE) THEN last_active END AS last_active, (last_active IS NOT NULL AND last_active >= NOW() - INTERVAL '35 seconds' AND COALESCE(show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online 
      FROM users 
      WHERE email != $1 
        AND COALESCE(is_banned, FALSE) = FALSE
        AND email NOT IN (
          SELECT blocked_email FROM blocked_users WHERE blocker_email = $1
          UNION
          SELECT blocker_email FROM blocked_users WHERE blocked_email = $1
        )
        AND (first_name ILIKE $2 OR last_name ILIKE $2 OR LOWER(email) = ANY($3::text[])
             OR ($4 <> '' AND COALESCE(phone_privacy, 'public') = 'public'
                 AND (regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $4
                      OR (regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '0%' AND '855' || substr(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 2) = $4))))
      LIMIT 10
    `;
    const likeSafe = String(keyword || '').replace(/[\\%_]/g, '\\$&');      // a typed % or _ must not act as a wildcard
    const typed = String(keyword || '').trim();
    // a FULL phone number finds the person, however it is written (012 345 678, +855 12 345 678, 85512345678 ...); only exact matches, never part of a number
    const e164 = normalizePhone(typed);
    const identities = [typed.toLowerCase()];
    if (e164) {
      const digits = e164.slice(1);
      identities.push(phoneEmail(e164), digits, '+' + digits);                       // the hidden identity of accounts made with a phone, and old accounts that used the number as their login
      if (digits.startsWith('855')) identities.push('0' + digits.slice(3));
    }
    const result = await pool.query(query, [email, `%${likeSafe}%`, identities, e164 ? e164.slice(1) : '']);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/chat-notifications', async (req, res) => {
  const { email } = req.query;
  try {
    const query = `
      SELECT m.*, u.first_name, u.last_name, u.profile_pic 
      FROM messages m
      JOIN users u ON m.sender_email = u.email
      WHERE m.receiver_email = $1 AND m.is_read = FALSE
      ORDER BY m.created_at DESC
    `;
    const result = await pool.query(query, [email]);
    res.json({ success: true, unreadMessages: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mark-read', async (req, res) => {
  const { userEmail, senderEmail } = req.body;
  try {
    await pool.query(
      'UPDATE messages SET is_read = TRUE WHERE receiver_email = $1 AND sender_email = $2',
      [userEmail, senderEmail]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  const { user1, user2 } = req.query;
  try {
    const query = `
      SELECT * FROM messages 
      WHERE (sender_email = $1 AND receiver_email = $2) OR (sender_email = $2 AND receiver_email = $1)
      ORDER BY created_at ASC
    `;
    const result = await pool.query(query, [user1, user2]);
    res.json({ success: true, messages: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Real-Time Online / Offline Presence Endpoints
let presenceColReady = false;
app.post('/api/presence/ping', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.json({ success: false });
  try {
    if (!presenceColReady) {
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active TIMESTAMP DEFAULT NULL').catch(() => {});
      presenceColReady = true;
    }
    await pool.query('UPDATE users SET last_active = NOW() WHERE LOWER(email) = LOWER($1)', [email.toString().trim()]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/presence/offline', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.json({ success: false });
  const norm = email.toString().trim().toLowerCase();
  lastGlobalPingMap.delete(norm);
  try {
    await pool.query("UPDATE users SET last_active = NOW() - INTERVAL '45 seconds' WHERE LOWER(email) = $1", [norm]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send Chat Message
app.post('/api/messages', (req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    return formFields(req, res, (err) => {
      if (err) {
        console.error("Media upload error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
      next();
    });
  }
  next();
}, authCore.forceActor, async (req, res) => {
  try {
    const sender = req.body.sender;
    const receiver = req.body.receiver;

    if (!sender || !receiver) {
      return res.status(400).json({ success: false, error: 'Sender and receiver are required' });
    }

    const blockCheck = await pool.query(
      'SELECT 1 FROM blocked_users WHERE (blocker_email = $1 AND blocked_email = $2) OR (blocker_email = $2 AND blocked_email = $1)',
      [sender, receiver]
    );
    if (blockCheck.rows.length > 0) {
      return res.status(403).json({ success: false, error: 'Cannot send messages to this user (Blocked).' });
    }

    await pool.query('UPDATE users SET last_active = NOW() WHERE email = $1', [sender]).catch(() => {});

    let defaultMsg = '';
    let messageType = req.body.message_type || 'text';
    let mediaUrl = req.body.media_url || null;

    if (req.file) {
      const mimetype = req.file.mimetype || '';
      if (mimetype.startsWith('video')) {
        messageType = 'video';
        defaultMsg = '[Video Message]';
      } else if (mimetype.startsWith('image')) {
        messageType = 'image';
        defaultMsg = '[Image Message]';
      } else {
        messageType = 'audio';
        defaultMsg = '[Voice Message]';
      }
      mediaUrl = req.file.path;
    } else if (mediaUrl) {
      if (messageType === 'video') defaultMsg = '[Video]';
      else if (messageType === 'image') defaultMsg = '[Photo]';
      else if (messageType === 'audio') defaultMsg = '[Voice Message]';
    }

    const message = req.body.message || defaultMsg;

    const query = `
      INSERT INTO messages (sender_email, receiver_email, message, media_url, message_type, is_read) 
      VALUES ($1, $2, $3, $4, $5, FALSE) 
      RETURNING *
    `;
    const result = await pool.query(query, [sender, receiver, message, mediaUrl, messageType]);
    res.status(201).json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error("Error saving message in DB:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edit Sent Chat Message
app.put('/api/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { sender, message, media_url } = req.body || {};
  try {
    if (!sender) return res.status(400).json({ success: false, error: 'Missing sender' });
    let result;
    if (media_url === null) {
      result = await pool.query(
        'UPDATE messages SET message = $1, media_url = NULL WHERE id = $2 AND sender_email = $3 RETURNING *',
        [message || '__CAMFEED_MSG_DELETED__', id, sender]
      );
    } else {
      result = await pool.query(
        'UPDATE messages SET message = $1 WHERE id = $2 AND sender_email = $3 RETURNING *',
        [message, id, sender]
      );
    }
    if (result.rows.length > 0) {
      res.json({ success: true, message: result.rows[0] });
    } else {
      res.status(403).json({ success: false, error: 'Unauthorized or message not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Sent Chat Message (Auto-deletes R2 media file too)
app.delete('/api/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { sender, tombstone } = req.body || {};
  try {
    if (!sender) return res.status(400).json({ success: false, error: 'Missing sender' });
    const marker = tombstone || '__CAMFEED_MSG_DELETED__';
    const prevRes = await pool.query('SELECT media_url FROM messages WHERE id = $1 AND LOWER(sender_email) = LOWER($2)', [id, sender]);
    const result = await pool.query(
      "UPDATE messages SET message = $1, media_url = NULL, message_type = 'deleted' WHERE id = $2 AND LOWER(sender_email) = LOWER($3) RETURNING *",
      [marker, id, sender]
    );
    if (result.rows.length > 0) {
      res.json({ success: true, message: result.rows[0] });
      if (prevRes.rows[0]?.media_url) cleanup.purgeMediaUrls(extractMediaUrls(prevRes.rows[0].media_url)).catch(() => {});
    } else {
      res.status(403).json({ success: false, error: 'Unauthorized or message not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Translate individual post caption on demand
app.post('/api/translate-text', async (req, res) => {
  const { text, targetLang } = req.body;
  if (!text || !text.trim()) return res.json({ success: false });
  const tl = targetLang === 'en' ? 'en' : 'km';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url);
    const data = await r.json();
    const translated = Array.isArray(data?.[0]) ? data[0].map(seg => seg[0]).join('') : text;
    res.json({ success: true, translatedText: translated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
// ACCOUNT SETTINGS (name / password / delete account)
// =============================================================================
const MIN_PASSWORD_LENGTH = 6;
const NAME_CHANGE_COOLDOWN_DAYS = 15;

app.put('/api/settings/name', async (req, res) => {
  const email = req.authEmail;
  const firstName = String((req.body && req.body.firstName) || '').trim();
  const lastName = String((req.body && req.body.lastName) || '').trim();
  try {
    if (!firstName || !lastName) {
      return res.status(400).json({ success: false, message: 'First and last name are required.' });
    }
    const cur = await pool.query('SELECT name_changed_at FROM users WHERE email = $1', [email]);
    const last = cur.rows[0] && cur.rows[0].name_changed_at;
    if (last) {
      const daysSince = (Date.now() - new Date(last).getTime()) / 86400000;
      if (daysSince < NAME_CHANGE_COOLDOWN_DAYS) {
        const left = Math.ceil(NAME_CHANGE_COOLDOWN_DAYS - daysSince);
        return res.status(400).json({ success: false, message: `You can change your name again in ${left} day(s).` });
      }
    }
    const upd = await pool.query(
      'UPDATE users SET first_name = $1, last_name = $2, name_changed_at = NOW() WHERE email = $3 RETURNING *',
      [firstName, lastName, email]);
    res.json({ success: true, user: upd.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/settings/password', async (req, res) => {
  const email = req.authEmail;
  const currentPassword = String((req.body && req.body.currentPassword) || '');
  const newPassword = String((req.body && req.body.newPassword) || '');
  try {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ success: false, message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = r.rows[0];
    if (user && isTelegramOnlyAccount(user.email)) {
      return res.status(400).json({ success: false, message: 'Your account signs in with Telegram, so it has no password to change.' });
    }
    const check = user ? await auth.verifyPassword(currentPassword, user.password) : { ok: false };
    if (!check.ok) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }
    const newHash = await auth.hashPassword(newPassword);
    await pool.query('UPDATE users SET password = $1 WHERE email = $2', [newHash, email]);
    authCore.invalidate(email); // every other logged-in device must log in again
    user.password = newHash;
    res.json({ success: true, message: 'Password updated successfully!', token: authCore.issueToken(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/settings/account', async (req, res) => {
  const email = req.authEmail;
  const password = String((req.body && req.body.password) || '');
  try {
    if (SUPER_ADMIN_EMAILS.includes(email.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Super Admin account cannot be deleted here.' });
    }
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const row = r.rows[0];
    let confirmed = false;
    if (row && isTelegramOnlyAccount(row.email)) confirmed = password.trim().toUpperCase() === 'DELETE';   // no password: type DELETE instead
    else if (row) confirmed = (await auth.verifyPassword(password, row.password)).ok;
    if (!confirmed) {
      return res.status(400).json({ success: false, message: row && isTelegramOnlyAccount(row.email) ? 'Type DELETE to confirm.' : 'Password is incorrect.' });
    }
    await cleanup.deleteUserCompletely(email); // posts, videos, comments, likes, follows, chats, profile pictures + all files
    authCore.invalidate(email);
    res.json({ success: true, message: 'Account deleted.' });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ success: false, message: 'Could not delete the account: ' + err.message });
  }
});

// Remove someone from "People you may know" (stays removed after refresh; search still finds them)
// What a person watches / reacts to / comments on / shares raises the score of that kind of post (its AI category) for THEM only.
function bumpInterest(email, postId, delta) {
  if (!email || !postId) return;
  pool.query(
    `INSERT INTO user_interest_scores (user_email, category, score, updated_at)
     SELECT $1, ai_category, $3, NOW() FROM posts WHERE id = $2 AND ai_category IS NOT NULL AND ai_category <> ''
     ON CONFLICT (user_email, category) DO UPDATE SET score = GREATEST(0, user_interest_scores.score + $3), updated_at = NOW()`,
    [email, postId, delta]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Settings page: privacy switches, blocked people, notification choices, log out everywhere, download my data
// ---------------------------------------------------------------------------
const PRIVACY_FIELDS = ['phone_privacy', 'email_privacy', 'location_privacy', 'birthdate_privacy', 'relationship_privacy', 'gender_privacy', 'work_privacy'];
const NOTIFICATION_GROUPS = { reactions: ['reaction', 'comment_reaction'], comments: ['comment', 'reply'], follows: ['follow'], shares: ['share'] };

function readNotificationPrefs(raw) {                      // everything is ON unless the person switched it off
  let saved = {};
  try { saved = JSON.parse(raw || '{}') || {}; } catch (e) { saved = {}; }
  const prefs = {};
  for (const g of Object.keys(NOTIFICATION_GROUPS)) prefs[g] = saved[g] !== false;
  return prefs;
}
function disabledNotificationTypes(prefs) {
  return Object.keys(NOTIFICATION_GROUPS).filter((g) => prefs[g] === false).flatMap((g) => NOTIFICATION_GROUPS[g]);
}
const exportLimiter = auth.makeLimiter(5, 60 * 60 * 1000);   // 5 downloads of "my data" per hour per person

app.put('/api/settings/privacy', async (req, res) => {
  const email = req.authEmail;
  const body = req.body || {};
  try {
    const sets = [], values = [email];
    for (const f of PRIVACY_FIELDS) {
      if (!(f in body)) continue;
      const v = String(body[f]);
      if (v !== 'public' && v !== 'private') return res.status(400).json({ success: false, message: 'Invalid privacy value.' });
      values.push(v); sets.push(`${f} = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
    const r = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE email = $1 RETURNING ${PRIVACY_FIELDS.join(', ')}`, values);
    res.json({ success: true, privacy: r.rows[0] });
  } catch (err) {
    console.error('Privacy settings error:', err.message);
    res.status(500).json({ success: false, message: 'Could not save. Please try again.' });
  }
});

app.get('/api/blocked-users', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.email, u.first_name, u.last_name, u.profile_pic, b.created_at AS blocked_at
       FROM blocked_users b JOIN users u ON u.email = b.blocked_email
       WHERE b.blocker_email = $1 ORDER BY b.created_at DESC LIMIT 200`, [req.authEmail]);
    res.json({ success: true, users: r.rows });
  } catch (err) {
    console.error('Blocked users error:', err.message);
    res.status(500).json({ success: false, message: 'Could not load the list.' });
  }
});

app.get('/api/settings/notifications', async (req, res) => {
  try {
    const r = await pool.query('SELECT notification_prefs FROM users WHERE email = $1', [req.authEmail]);
    res.json({ success: true, prefs: readNotificationPrefs(r.rows[0] && r.rows[0].notification_prefs) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not load.' });
  }
});

app.put('/api/settings/notifications', async (req, res) => {
  try {
    const body = req.body || {};
    const r0 = await pool.query('SELECT notification_prefs FROM users WHERE email = $1', [req.authEmail]);
    const prefs = readNotificationPrefs(r0.rows[0] && r0.rows[0].notification_prefs);
    let touched = false;
    for (const g of Object.keys(NOTIFICATION_GROUPS)) {
      if (g in body) {
        if (typeof body[g] !== 'boolean') return res.status(400).json({ success: false, message: 'Invalid value.' });
        prefs[g] = body[g]; touched = true;
      }
    }
    if (!touched) return res.status(400).json({ success: false, message: 'Nothing to change.' });
    await pool.query('UPDATE users SET notification_prefs = $1 WHERE email = $2', [JSON.stringify(prefs), req.authEmail]);
    res.json({ success: true, prefs });
  } catch (err) {
    console.error('Notification settings error:', err.message);
    res.status(500).json({ success: false, message: 'Could not save. Please try again.' });
  }
});

// every other device (and this one) must log in again; this device gets a fresh token in the answer
app.post('/api/settings/logout-all', async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET sessions_epoch = COALESCE(sessions_epoch, 0) + 1 WHERE email = $1 RETURNING *', [req.authEmail]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Account not found.' });
    authCore.invalidate(req.authEmail);
    await authCore.revokeAll(req.authEmail).catch(() => {});
    res.json({ success: true, message: 'Logged out of all other devices.', token: authCore.issueToken(r.rows[0], req) });
  } catch (err) {
    console.error('Logout-all error:', err.message);
    res.status(500).json({ success: false, message: 'Could not do that. Please try again.' });
  }
});

// a copy of what the person has on CamFeed (never the password; limited size)
app.get('/api/settings/export', async (req, res) => {
  const email = req.authEmail;
  try {
    if (exportLimiter.isLimited(email)) return res.status(429).json({ success: false, message: 'You can download your data a few times per hour. Please try again later.' });
    exportLimiter.hit(email);
    const LIMIT = 5000;
    const one = async (sql) => (await pool.query(sql, [email, LIMIT])).rows;
    const me = (await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
    if (!me) return res.status(404).json({ success: false, message: 'Account not found.' });
    const contact = ownContact(me);
    delete me.password; delete me.sessions_epoch;
    const data = {
      exported_at: new Date().toISOString(),
      note: 'People are shown with their public id instead of an e-mail address. Lists are limited to ' + LIMIT + ' rows.',
      account: { contact, profile: me },
      posts: await one('SELECT * FROM posts WHERE user_email = $1 ORDER BY created_at DESC LIMIT $2'),
      comments: await one('SELECT * FROM comments WHERE user_email = $1 ORDER BY created_at DESC LIMIT $2'),
      following: await one('SELECT following_email FROM follows WHERE follower_email = $1 LIMIT $2'),
      followers: await one('SELECT follower_email FROM follows WHERE following_email = $1 LIMIT $2'),
      blocked: await one('SELECT blocked_email, created_at FROM blocked_users WHERE blocker_email = $1 LIMIT $2'),
      messages: await one('SELECT * FROM messages WHERE sender_email = $1 OR receiver_email = $1 ORDER BY created_at DESC LIMIT $2')
    };
    res.setHeader('Content-Disposition', 'attachment; filename="camfeed-my-data.json"');
    res.json({ success: true, data });
  } catch (err) {
    console.error('Export error:', err.message);
    res.status(500).json({ success: false, message: 'Could not prepare your data. Please try again.' });
  }
});

app.put('/api/settings/active-status', async (req, res) => {
  try {
    if (typeof (req.body || {}).show !== 'boolean') return res.status(400).json({ success: false, message: 'Invalid value.' });
    await pool.query('UPDATE users SET show_active_status = $1 WHERE email = $2', [req.body.show, req.authEmail]);
    res.json({ success: true, show: req.body.show });
  } catch (err) { res.status(500).json({ success: false, message: 'Could not save. Please try again.' }); }
});

// where I am logged in (one row per device) and ending one device / all the others
app.get('/api/settings/sessions', async (req, res) => {
  try {
    const rows = await authCore.listSessions(req.authEmail);
    res.json({ success: true, sessions: rows.map((r) => ({ sid: r.sid, browser: r.browser, os: r.os, ip_masked: r.ip_masked, country: r.country, city: r.city, created_at: r.created_at, last_seen: r.last_seen, current: r.sid === req.sid })) });
  } catch (err) { res.status(500).json({ success: false, message: 'Could not load.' }); }
});
app.post('/api/settings/sessions/revoke', async (req, res) => {
  try {
    const sid = String((req.body || {}).sid || '');
    if (!/^[0-9a-f]{24}$/.test(sid)) return res.status(400).json({ success: false, message: 'Invalid device.' });
    const ok = await authCore.revokeSession(req.authEmail, sid);
    res.json({ success: ok, endedCurrent: ok && sid === req.sid, message: ok ? 'Device logged out.' : 'Device not found.' });
  } catch (err) { res.status(500).json({ success: false, message: 'Could not do that. Please try again.' }); }
});
app.post('/api/settings/sessions/revoke-others', async (req, res) => {
  try { const n = await authCore.revokeOthers(req.authEmail, req.sid); res.json({ success: true, count: n }); }
  catch (err) { res.status(500).json({ success: false, message: 'Could not do that. Please try again.' }); }
});

// what I did: reactions, shares, comments & replies, posts & uploads (newest first)
app.get('/api/settings/activity', async (req, res) => {
  const type = String(req.query.type || '');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50), offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    let rows;
    const who = req.authEmail;
    if (type === 'reactions') {
      const base = (order) => `SELECT l.post_id, l.reaction_type, p.content, p.media_type, p.user_email AS author_email, u.first_name AS author_first, u.last_name AS author_last, ${order === 'time' ? 'l.created_at' : 'NULL::timestamp'} AS at
        FROM likes l JOIN posts p ON p.id = l.post_id JOIN users u ON u.email = p.user_email WHERE l.user_email = $1 AND p.privacy <> 'private' OR (l.user_email = $1 AND p.user_email = $1)
        ORDER BY ${order === 'time' ? 'l.created_at DESC NULLS LAST' : 'l.post_id DESC'} LIMIT $2 OFFSET $3`;
      try { rows = (await pool.query(base('time'), [who, limit, offset])).rows; }
      catch (e) { if (e && e.code === '42703') rows = (await pool.query(base('id'), [who, limit, offset])).rows; else throw e; }
    } else if (type === 'comments') {
      rows = (await pool.query(`SELECT c.id, c.post_id, c.content, c.reply_to_id, c.created_at AS at, p.user_email AS author_email, u.first_name AS author_first, u.last_name AS author_last
        FROM comments c JOIN posts p ON p.id = c.post_id JOIN users u ON u.email = p.user_email WHERE c.user_email = $1 ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`, [who, limit, offset])).rows;
    } else if (type === 'shares') {
      rows = (await pool.query(`SELECT p.id, p.content AS caption, p.created_at AS at, o.id AS post_id, o.content, o.media_type, o.user_email AS author_email, u.first_name AS author_first, u.last_name AS author_last
        FROM posts p JOIN posts o ON o.id = p.shared_post_id JOIN users u ON u.email = o.user_email WHERE p.user_email = $1 AND p.shared_post_id IS NOT NULL ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [who, limit, offset])).rows;
    } else if (type === 'posts') {
      rows = (await pool.query(`SELECT id, content, media_type, privacy, created_at AS at FROM posts WHERE user_email = $1 AND shared_post_id IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [who, limit, offset])).rows;
    } else return res.status(400).json({ success: false, message: 'Unknown activity.' });
    res.json({ success: true, type, items: rows, hasMore: rows.length === limit });
  } catch (err) {
    console.error('Activity error:', err.message);
    res.status(500).json({ success: false, message: 'Could not load.' });
  }
});

app.post('/api/suggestions/dismiss', async (req, res) => {
  const email = req.authEmail;
  const targetEmail = String((req.body && req.body.targetEmail) || '').trim();
  try {
    if (!targetEmail || targetEmail.toLowerCase() === email.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Invalid user.' });
    }
    await pool.query(
      'INSERT INTO dismissed_suggestions (user_email, dismissed_email) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [email, targetEmail]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
// ADMIN CONTROL CENTER ROUTES
// =============================================================================

app.post('/api/admin/dashboard', async (req, res) => {
  const { adminEmail, adminKey } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed) {
      return res.status(403).json({ success: false, error: auth.error });
    }

    const [usersRes, reportsRes, postsRes, viewsSumRes] = await Promise.all([
      pool.query(`
        SELECT email, first_name, last_name, profile_pic, country, role, is_banned,
               (SELECT COUNT(*) FROM posts p WHERE p.user_email = users.email) as posts_count,
               (SELECT COUNT(*) FROM follows f WHERE f.following_email = users.email) as followers_count
        FROM users
        ORDER BY CASE WHEN role = 'super_admin' THEN 1 WHEN role = 'admin' THEN 2 ELSE 3 END, first_name ASC
      `),
      pool.query(`
        SELECT r.*,
               ru.first_name as reporter_first, ru.last_name as reporter_last,
               tu.first_name as target_first, tu.last_name as target_last, tu.profile_pic as target_pic,
               p.content as post_content, p.media_type as post_media_type, p.media_url as post_media_url
        FROM reports r
        LEFT JOIN users ru ON r.reporter_email = ru.email
        LEFT JOIN users tu ON r.target_user_email = tu.email
        LEFT JOIN posts p ON r.target_post_id = p.id
        ORDER BY CASE WHEN r.status = 'pending' THEN 1 ELSE 2 END, r.created_at DESC
        LIMIT 100
      `),
      pool.query(`
        SELECT p.*, u.first_name, u.last_name, u.profile_pic,
               (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as likes_count,
               (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comments_count
        FROM posts p
        JOIN users u ON p.user_email = u.email
        ORDER BY p.created_at DESC
        LIMIT 60
      `),
      pool.query(`SELECT COALESCE(SUM(views_count), 0) as total_views FROM posts`)
    ]);

    res.json({
      success: true,
      isSuperAdmin: auth.isSuperAdmin,
      stats: {
        totalUsers: usersRes.rows.length,
        totalPosts: postsRes.rows.length,
        totalViews: parseInt(viewsSumRes.rows[0]?.total_views || 0),
        pendingReports: reportsRes.rows.filter(r => r.status === 'pending').length
      },
      users: usersRes.rows,
      reports: reportsRes.rows,
      posts: postsRes.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/set-role', async (req, res) => {
  const { adminEmail, adminKey, targetEmail, newRole } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed || !auth.isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only Super Admin can assign or remove Team Admins.' });
    }
    if (SUPER_ADMIN_EMAILS.includes(targetEmail.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Cannot change role of Super Admin.' });
    }
    const safeRole = newRole === 'admin' ? 'admin' : 'user';
    await pool.query('UPDATE users SET role = $1 WHERE email = $2', [safeRole, targetEmail]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/ban-user', async (req, res) => {
  const { adminEmail, adminKey, targetEmail, ban } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed) return res.status(403).json({ success: false, error: auth.error });

    if (SUPER_ADMIN_EMAILS.includes(targetEmail.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Cannot ban Super Admin.' });
    }
    await pool.query('UPDATE users SET is_banned = $1 WHERE email = $2', [!!ban, targetEmail]);
    authCore.invalidate(targetEmail);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:targetEmail', async (req, res) => {
  const { targetEmail } = req.params;
  const { adminEmail, adminKey } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed || !auth.isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only Super Admin can delete user accounts.' });
    }
    if (SUPER_ADMIN_EMAILS.includes(targetEmail.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Cannot delete Super Admin.' });
    }
    const target = await pool.query('SELECT email FROM users WHERE LOWER(email) = LOWER($1)', [targetEmail]);
    if (!target.rows[0]) return res.status(404).json({ success: false, error: 'User not found.' });
    await cleanup.deleteUserCompletely(target.rows[0].email); // everything the user created, chats and files included
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/posts/:postId', async (req, res) => {
  const { postId } = req.params;
  const { adminEmail, adminKey } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed) return res.status(403).json({ success: false, error: auth.error });

    await cleanup.deletePostCompletely(postId); // also marks its reports as resolved_deleted
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/reports/:reportId/status', async (req, res) => {
  const { reportId } = req.params;
  const { adminEmail, adminKey, status } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed) return res.status(403).json({ success: false, error: auth.error });

    await pool.query('UPDATE reports SET status = $1 WHERE id = $2', [status || 'dismissed', reportId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
// Errors raised by Express itself (broken JSON, body too large ...): a short answer, never a stack trace or file path
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooBig = err && (err.type === 'entity.too.large' || err.status === 413);
  const badJson = err && (err.type === 'entity.parse.failed' || err.status === 400);
  if (!tooBig && !badJson) console.error('[error] unhandled:', req.method, String(req.originalUrl || '').split('?')[0], err && err.message);
  const status = tooBig ? 413 : (badJson ? 400 : 500);
  const text = tooBig ? 'The request is too large.' : (badJson ? 'The request could not be read.' : 'Something went wrong on our side. Please try again.');
  res.status(status).json({ success: false, error: text });
});

app.listen(PORT, () => {
  console.log(`Camfeed server is running on port ${PORT}`);
});