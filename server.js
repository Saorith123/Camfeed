// a stray error in one request must never take the whole site down (that shows as "502 Bad Gateway"); it is written to the log instead
process.on('unhandledRejection', (e) => console.error('[crash-guard] unhandledRejection:', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
process.on('uncaughtException', (e) => console.error('[crash-guard] uncaughtException:', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
{ const t = setInterval(() => { const m = process.memoryUsage(); if (m.rss > 380 * 1048576) console.warn('[memory] high: rss ' + Math.round(m.rss / 1048576) + ' MB, heap ' + Math.round(m.heapUsed / 1048576) + ' MB'); }, 60000); if (t.unref) t.unref(); }
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}   // 🌐 reach Telegram / Gemini over IPv4 first ("fetch failed" over IPv6 on some servers)
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
const { createPhoneVerification, normalizePhone, phoneEmail, findAccountEmail, phoneIdentities: phoneIdentitiesOf } = require('./phone-verification');

const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy: needed for correct client IP (login rate limit)
app.disable('x-powered-by');                       // do not announce the framework
// light-weight check for uptime monitors (no database, no login) - keeps the server awake and shows if it is alive
const DEPLOY_NO = 181;   // 🔢 which DEPLOY zip is live: open camfeedkh.com/healthz
app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok · DEPLOY ' + DEPLOY_NO));
// 🛠️ Maintenance (e.g. while the database moves): Render › Environment › MAINTENANCE_MODE = 1 → nothing is read or written.
// The app shows "CamFeed is being improved" and tries again by itself; the website shows maintenance.html. Remove it (or 0) to open again.
const MAINT_ON = () => String(process.env.MAINTENANCE_MODE || '') === '1';
app.use((req, res, next) => {
  if (!MAINT_ON()) return next();
  if (req.path.startsWith('/api/')) return res.status(503).set('Retry-After', '60').json({ success: false, maintenance: true, code: 'maintenance', message: 'CamFeed is being improved. Please come back in a few minutes.' });
  if (/\.(js|css|png|jpe?g|webp|svg|ico|woff2?|ttf|json|mp3|m4a)$/i.test(req.path)) return next();   // the maintenance page's own files
  res.status(503).set('Retry-After', '60').sendFile(path.join(__dirname, 'public', 'maintenance.html'));
});
app.use(security.securityHeaders);                 // no framing, no sniffing, CSP, no caching of API answers ...
// small bodies everywhere (an attacker can not push megabytes into every route); posts may carry a video thumbnail
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '6mb' });
app.use((req, res, next) => (/^\/api\/(posts|videos)(\/|$)/.test(req.path) || req.path === '/api/stars/apply' || /^\/api\/party\/rooms\/\d+\/board$/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));   // 🖼️ a Party Room picture   // ⭐ a Star application carries 2 photos
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Typed logins and codes are cleaned before any route reads them: Khmer digits (០-៩) -> 0-9, invisible characters that Khmer keyboards
// insert (zero-width space ...) removed, and spaces removed where they can never belong (an e-mail, a referral number, a one-time code).
// "012 345 678", "+855 12-345-678", "០១២ ៣៤៥ ៦៧៨" and "123 456" are all understood. Passwords are never touched.
const KH_DIGITS = /[០-៩]/g, INVISIBLE = /[​-‍⁠﻿]/g;
const cleanTyped = (v) => String(v).replace(KH_DIGITS, (c) => String(c.charCodeAt(0) - 0x17E0)).replace(INVISIBLE, '').replace(/ /g, ' ').trim();
app.use((req, res, next) => {
  const b = req.body;
  if (b && typeof b === 'object' && !Array.isArray(b) && req.path.startsWith('/api/') && !/withdraw/i.test(req.path)) {
    for (const k of ['email', 'phone', 'identifier', 'ident', 'login', 'who', 'code', 'ref', 'referral', 'referralCode']) {
      if (typeof b[k] !== 'string') continue;
      let v = cleanTyped(b[k]);
      if ((k === 'email' || k === 'identifier' || k === 'ident' || k === 'login' || k === 'who') && v.includes('@')) v = v.replace(/\s+/g, '');
      if (k === 'code' || k === 'ref' || k === 'referral' || k === 'referralCode') v = v.replace(/[\s\-]+/g, '');
      b[k] = v;
    }
  }
  next();
});

// Server files must never be downloadable, even if one is dropped into /public by mistake
const NEVER_SERVE = /^\/(server|auth|cleanup|mailer|signup-verification|telegram-login|telegram-gateway|phone-verification|public-ids|security|migrate-passwords|videoRecommendationRoutes|interests|tg-pay|coins|ad-rules|media-reacts|country|verify|gemini|ad-wallet|google-play|cloudinary|package(-lock)?)\.(js|json)$|^\/\.|\.(env|map|log|sql|bak)$/i;
app.use((req, res, next) => (NEVER_SERVE.test(req.path) ? res.status(404).end() : next()));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Public post page /p/:id  (like Facebook: anyone can SEE a public post without logging in, and chat apps show a picture + title
// when the link is shared). Only PUBLIC posts of people who are not banned are shown. Everything is escaped. No scripts needed to read it.
// ---------------------------------------------------------------------------
const pubEsc = (v) => String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const pubCut = (v, n) => { const a = Array.from(String(v || '').replace(/\s+/g, ' ').trim()); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
const pubHits = new Map();
function pubLimited(ip) {                                                    // 90 page views / minute / IP (stops bots that copy everything)
  const now = Date.now(), e = pubHits.get(ip) || { n: 0, t: now };
  if (now - e.t > 60000) { e.n = 0; e.t = now; }
  e.n++; pubHits.set(ip, e);
  if (pubHits.size > 5000) for (const [k, v] of pubHits) if (now - v.t > 60000) pubHits.delete(k);
  return e.n > 90;
}
function pubMedia(row) {                                                     // -> { images: [url], video: url|null }
  const out = { images: [], video: null }, raw = String(row.media_url || '').trim();
  if (!raw) return out;
  const isVid = (u, t) => t === 'video' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u || '');
  let items = [];
  if (raw[0] === '[' || raw[0] === '{') { try { const j = JSON.parse(raw); items = Array.isArray(j) ? j : [j]; } catch (e) { items = []; } }
  else items = [{ url: raw, type: row.media_type }];
  for (const it of items) {
    const url = security.safeUrl(typeof it === 'string' ? it : (it && it.url));
    if (!url) continue;
    const type = typeof it === 'string' ? row.media_type : (it.type || row.media_type);
    if (isVid(url, type)) { if (!out.video) out.video = url; } else if (out.images.length < 4) out.images.push(url);
  }
  return out;
}
app.get('/p/:id', async (req, res) => {
  const base = (process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  const id = /^\d{1,10}$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : NaN;
  const page = (status, title, desc, image, body, extraMeta) => {
    res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store' });
    res.send(`<!DOCTYPE html><html lang="km"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pubEsc(title)}</title><meta name="description" content="${pubEsc(desc)}">${extraMeta || ''}
<meta property="og:site_name" content="CamFeed"><meta property="og:title" content="${pubEsc(title)}"><meta property="og:description" content="${pubEsc(desc)}">
${image ? `<meta property="og:image" content="${pubEsc(image)}"><meta name="twitter:image" content="${pubEsc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${pubEsc(title)}"><meta name="twitter:description" content="${pubEsc(desc)}">
<link rel="icon" type="image/png" href="/icons/favicon-48.png"><link href="https://fonts.googleapis.com/css2?family=Battambang:wght@300;400;700;900&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;background:#f0f2f5;color:#050505;font-family:'Battambang',system-ui,sans-serif}
.top{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:0;z-index:5}
.brand{font-size:24px;font-weight:700;color:#1877f2;text-decoration:none}.btns{display:flex;gap:8px}
.b{display:inline-block;padding:9px 16px;border-radius:20px;font-weight:700;font-size:14px;text-decoration:none;border:0;cursor:pointer}.b1{background:#1877f2;color:#fff}.b2{background:#e7f3ff;color:#1877f2}
.wrap{max-width:640px;margin:14px auto;padding:0 10px}.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden;margin-bottom:12px}
.hd{display:flex;gap:10px;align-items:center;padding:12px 14px}.av{width:44px;height:44px;border-radius:50%;background:#dbe3ee;object-fit:cover;display:flex;align-items:center;justify-content:center;font-weight:700;color:#456}
.nm{font-weight:700}.dt{font-size:12.5px;color:#65676b}.tx{padding:2px 14px 12px;white-space:pre-wrap;word-break:break-word;font-size:16px;line-height:1.5}
.md img,.md video{display:block;width:100%;max-height:80vh;object-fit:contain;background:#000}.md img+img{margin-top:2px}
.st{padding:10px 14px;color:#65676b;font-size:14px;border-top:1px solid #eee;display:flex;gap:16px}
.cta{padding:18px 14px;text-align:center}.cta h2{margin:0 0 6px;font-size:18px}.cta p{margin:0 0 12px;color:#65676b;font-size:14px}.ft{text-align:center;color:#8a8d91;font-size:12.5px;padding:6px 0 24px}.ft a{color:#65676b}</style></head><body>
<div class="top"><a class="brand" href="/">CamFeed</a><div class="btns"><a class="b b2" href="/index.html?next=${pubEsc('/p/' + (Number.isInteger(id) ? id : 0))}">ចូល (Log in)</a><a class="b b1" href="/index.html?next=${pubEsc('/p/' + (Number.isInteger(id) ? id : 0))}">ចុះឈ្មោះ</a></div></div>
<div class="wrap">${body}<div class="ft"><a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a> · <a href="/community.html">Community</a><br>© CamFeed</div></div></body></html>`);
  };
  try {
    if (pubLimited(req.ip || 'x')) return page(429, 'CamFeed', 'Too many requests', null, '<div class="card cta"><h2>សូមរង់ចាំបន្តិច</h2></div>', '<meta name="robots" content="noindex">');
    const notFound = () => page(404, 'CamFeed', 'ប្រកាសនេះមិនមាន ឬមិនមែនសាធារណៈ', `${base}/icons/icon-512.png`,
      `<div class="card cta"><h2>ប្រកាសនេះមិនមាន ឬជាឯកជន</h2><p>This post is not available or is private.</p><a class="b b1" href="/index.html">ចូលទៅ CamFeed</a></div>`, '<meta name="robots" content="noindex">');
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) return notFound();
    const sel = `SELECT p.id, p.content, p.media_type, p.media_url, p.privacy, p.created_at, p.shared_post_id, u.first_name, u.last_name, u.profile_pic, COALESCE(u.is_banned, FALSE) AS banned,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS likes, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comments,
      (SELECT COUNT(*) FROM posts sp WHERE sp.shared_post_id = p.id)::int AS shares FROM posts p JOIN users u ON u.email = p.user_email WHERE p.id = $1`;
    let post = (await pool.query(sel, [id])).rows[0];
    if (!post || post.banned || String(post.privacy || 'public') !== 'public') return notFound();
    let shownBy = null;
    if (post.shared_post_id) {                                                // a share: show the original post when it is public too
      const orig = (await pool.query(sel, [post.shared_post_id])).rows[0];
      if (orig && !orig.banned && String(orig.privacy || 'public') === 'public') { shownBy = post; post = orig; }
    }
    const name = (String(post.first_name || '') + ' ' + String(post.last_name || '')).trim() || 'CamFeed';
    const media = pubMedia(post), text = String(post.content || '').slice(0, 5000);
    const ogImage = media.images[0] || `${base}/icons/icon-512.png`;
    const title = pubCut(text, 70) ? pubCut(text, 70) + ' · ' + name : name + ' ក្នុង CamFeed';
    const desc = pubCut(text, 180) || (media.video ? 'មើលវីដេអូនេះនៅ CamFeed' : media.images.length ? 'មើលរូបភាពនេះនៅ CamFeed' : 'ចូលរួម CamFeed ដើម្បីមើល ចែករំលែក និងនិយាយជាមួយមិត្តភក្តិ');
    const url = `${base}/p/${id}`;
    const avatar = security.safeUrl(post.profile_pic || '');
    const meta = `<link rel="canonical" href="${pubEsc(url)}"><meta property="og:url" content="${pubEsc(url)}"><meta property="og:type" content="${media.video ? 'video.other' : 'article'}">` +
      (media.video ? `<meta property="og:video" content="${pubEsc(media.video)}"><meta property="og:video:secure_url" content="${pubEsc(media.video)}"><meta property="og:video:type" content="video/mp4">` : '');
    const when = post.created_at ? new Date(post.created_at).toISOString().slice(0, 10) : '';
    const body = `<div class="card">
      ${shownBy ? `<div class="dt" style="padding:10px 14px 0">🔁 ចែករំលែកដោយ ${pubEsc(((shownBy.first_name || '') + ' ' + (shownBy.last_name || '')).trim())}</div>` : ''}
      <div class="hd">${avatar ? `<img class="av" src="${pubEsc(avatar)}" alt="">` : `<div class="av">${pubEsc(Array.from(name)[0] || 'C')}</div>`}<div><div class="nm notranslate" translate="no">${pubEsc(name)}</div><div class="dt">${pubEsc(when)} · 🌐 Public</div></div></div>
      ${text ? `<div class="tx notranslate" translate="no">${pubEsc(text)}</div>` : ''}
      ${(media.video || media.images.length) ? `<div class="md">${media.video ? `<video src="${pubEsc(media.video)}" controls playsinline preload="metadata"></video>` : ''}${media.images.map((u) => `<img src="${pubEsc(u)}" alt="" loading="lazy">`).join('')}</div>` : ''}
      <div class="st"><span>👍 ${Number(post.likes) || 0}</span><span>💬 ${Number(post.comments) || 0}</span><span>↗️ ${Number(post.shares) || 0}</span></div></div>
    <div class="card cta"><h2>ចូលរួម CamFeed</h2><p>ចុះឈ្មោះ ឬចូល ដើម្បី Like, Comment, ចែករំលែក និងតាមដាន ${pubEsc(name)}។<br>Log in to like, comment and share.</p>
      <a class="b b1" href="/index.html?next=${pubEsc('/p/' + id)}">ចូល ឬចុះឈ្មោះ</a></div>
    <script>try{if(localStorage.getItem('camfeed_user'))location.replace('/feed.html?post=${id}');}catch(e){}</script>`;
    page(200, title, desc, ogImage, body, meta);
  } catch (err) {
    console.error('[public post]', err.message);
    page(500, 'CamFeed', 'Error', null, '<div class="card cta"><h2>មានបញ្ហា សូមព្យាយាមម្តងទៀត</h2></div>', '<meta name="robots" content="noindex">');
  }
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
      ADD COLUMN IF NOT EXISTS media_aspect VARCHAR(30) DEFAULT '',
      ADD COLUMN IF NOT EXISTS tagged_emails TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS tag_pending TEXT DEFAULT ''
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
      CREATE TABLE IF NOT EXISTS feed_seen (viewer_email TEXT NOT NULL, post_id INTEGER NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), times INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (viewer_email, post_id));
      CREATE INDEX IF NOT EXISTS idx_feed_seen_time ON feed_seen(viewer_email, seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_pair_time ON messages(sender_email, receiver_email, created_at DESC);
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS relationship_status VARCHAR(150) DEFAULT '',
      ADD COLUMN IF NOT EXISTS work VARCHAR(150) DEFAULT '',
      ADD COLUMN IF NOT EXISTS tag_review BOOLEAN DEFAULT FALSE,
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
      CREATE TABLE IF NOT EXISTS hidden_posts (
        user_email VARCHAR(255) NOT NULL,
        post_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_email, post_id)
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
    // 🖼️ old databases gave every new account a grey "150 x 150" / "800 x 300" picture from via.placeholder.com: no picture is better (the app and site draw their own)
    for (const c of ['profile_pic', 'cover_pic']) {
      await pool.query(`ALTER TABLE users ALTER COLUMN ${c} DROP DEFAULT`).catch(() => {});
      await pool.query(`UPDATE users SET ${c} = NULL WHERE ${c} ILIKE '%placeholder.com%' OR ${c} ILIKE '%placehold.co%'`).catch(() => {});
    }
    // who may see my lists of friends / followers / following: 'public' | 'friends' | 'private' (only me)
    for (const c of ['friends_list_privacy', 'followers_list_privacy', 'following_list_privacy']) await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${c} VARCHAR(10) DEFAULT 'public'`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR(40) PRIMARY KEY, email TEXT NOT NULL, browser VARCHAR(40), os VARCHAR(40), ip_masked VARCHAR(60), country VARCHAR(60), city VARCHAR(60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked BOOLEAN NOT NULL DEFAULT FALSE)`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_sessions_email ON user_sessions (email)');
    await pool.query(`CREATE TABLE IF NOT EXISTS user_interest_scores (
      user_email TEXT NOT NULL, category TEXT NOT NULL, score DOUBLE PRECISION NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_email, category))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit (
      id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), admin_email TEXT, action VARCHAR(60), target TEXT, details TEXT)`);
    await pool.query("DELETE FROM admin_audit WHERE at < NOW() - INTERVAL '180 days'");
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()');
    // accounts that existed before the joined date was recorded: use the day of their first post (never later than what is stored)
    await pool.query('UPDATE users u SET created_at = p.first_post FROM (SELECT user_email, MIN(created_at) AS first_post FROM posts GROUP BY user_email) p WHERE p.user_email = u.email AND p.first_post < u.created_at').catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS creator_applications (
      user_email TEXT PRIMARY KEY, status VARCHAR(20) NOT NULL DEFAULT 'pending', requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, decided_by TEXT, note TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS wallet_ledger (
      id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, amount_cents INTEGER NOT NULL, kind VARCHAR(30) NOT NULL, note TEXT, ref_id INTEGER, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger (user_email)');
    await pool.query(`CREATE TABLE IF NOT EXISTS sponsored_ads (
      id SERIAL PRIMARY KEY, advertiser_name VARCHAR(80) NOT NULL, placement VARCHAR(20) NOT NULL DEFAULT 'feed_banner', caption TEXT, target_url TEXT, media_url TEXT NOT NULL,
      skip_seconds INTEGER NOT NULL DEFAULT 5, status VARCHAR(12) NOT NULL DEFAULT 'active', impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
      created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ad_events (
      ad_id INTEGER NOT NULL, user_email TEXT NOT NULL, kind VARCHAR(10) NOT NULL, day DATE NOT NULL DEFAULT CURRENT_DATE, PRIMARY KEY (ad_id, user_email, kind, day))`);
    await pool.query('ALTER TABLE sponsored_ads ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ');
    await pool.query(`CREATE TABLE IF NOT EXISTS ad_requests (
      id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, business_name VARCHAR(80) NOT NULL, contact VARCHAR(120) NOT NULL, placement VARCHAR(20) NOT NULL DEFAULT 'feed_banner',
      caption TEXT, target_url TEXT, media_url TEXT NOT NULL, days INTEGER NOT NULL DEFAULT 7, budget_note VARCHAR(120),
      status VARCHAR(16) NOT NULL DEFAULT 'pending', price_cents INTEGER, admin_note VARCHAR(300), pay_ref VARCHAR(120), ad_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ad_requests_user ON ad_requests (user_email)');
    await pool.query(`ALTER TABLE sponsored_ads
      ADD COLUMN IF NOT EXISTS objective VARCHAR(16) NOT NULL DEFAULT 'traffic', ADD COLUMN IF NOT EXISTS post_id INTEGER, ADD COLUMN IF NOT EXISTS interests TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS country VARCHAR(60) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS budget_cents INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS days INTEGER NOT NULL DEFAULT 7,
      ADD COLUMN IF NOT EXISTS spent_cents NUMERIC(14,4) NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS cpm_feed_cents NUMERIC(8,2) NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS cpm_video_cents NUMERIC(8,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS owner_email TEXT, ADD COLUMN IF NOT EXISTS cta VARCHAR(16) NOT NULL DEFAULT 'learn_more',
      ADD COLUMN IF NOT EXISTS base_likes INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS base_comments INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS base_shares INTEGER NOT NULL DEFAULT 0`);
    await pool.query('ALTER TABLE sponsored_ads ALTER COLUMN media_url DROP NOT NULL');
    await pool.query(`ALTER TABLE ad_requests
      ADD COLUMN IF NOT EXISTS objective VARCHAR(16) NOT NULL DEFAULT 'traffic', ADD COLUMN IF NOT EXISTS post_id INTEGER, ADD COLUMN IF NOT EXISTS interests TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS country VARCHAR(60) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS budget_cents INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS cta VARCHAR(16) NOT NULL DEFAULT 'learn_more'`);
    await pool.query('ALTER TABLE ad_requests ALTER COLUMN media_url DROP NOT NULL');
    for (const t of ['ad_requests', 'sponsored_ads']) {      // 🛍️ products, 🏷️ keywords, 📍 provinces, age, gender
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS items TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS kw_ids TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS provinces TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS age_min INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS age_max INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gender VARCHAR(8) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS places TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS devices TEXT NOT NULL DEFAULT ''`);
    }
    await pool.query('CREATE TABLE IF NOT EXISTS ad_hidden (user_email TEXT NOT NULL, ad_id INTEGER NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_email, ad_id))');
    await pool.query(`CREATE TABLE IF NOT EXISTS ad_daily (
      ad_id INTEGER NOT NULL, day DATE NOT NULL, feed_imps INTEGER NOT NULL DEFAULT 0, video_imps INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, skips INTEGER NOT NULL DEFAULT 0,
      completes INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0, spent_cents NUMERIC(14,4) NOT NULL DEFAULT 0, PRIMARY KEY (ad_id, day))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ad_user_day (
      ad_id INTEGER NOT NULL, user_email TEXT NOT NULL, day DATE NOT NULL DEFAULT CURRENT_DATE, imps INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, skips INTEGER NOT NULL DEFAULT 0,
      completes INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ad_id, user_email, day))`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ad_user_day_ad ON ad_user_day (ad_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, amount_cents INTEGER NOT NULL, method VARCHAR(20) NOT NULL, account_name VARCHAR(80), account_number VARCHAR(40),
      status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, decided_by TEXT, note TEXT)`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS ux_withdraw_pending ON withdrawal_requests (user_email) WHERE status = 'pending'");   // one open request at a time
    for (const col of ['payout_code TEXT', 'code_issued_at TIMESTAMPTZ', 'code_viewed_at TIMESTAMPTZ', 'reissue_requested_at TIMESTAMPTZ', 'reissue_count INTEGER NOT NULL DEFAULT 0',
      'hold_until TIMESTAMPTZ', 'name_check VARCHAR(12)', 'new_details BOOLEAN NOT NULL DEFAULT FALSE', 'tg_sent BOOLEAN NOT NULL DEFAULT FALSE']) {
      await pool.query('ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS ' + col).catch(() => {});
    }
    await pool.query('CREATE TABLE IF NOT EXISTS referrals (referred_email TEXT PRIMARY KEY, referrer_email TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pool.query('ALTER TABLE creator_applications ADD COLUMN IF NOT EXISTS message TEXT').catch(() => {});
    await pool.query('ALTER TABLE creator_applications ADD COLUMN IF NOT EXISTS earn_suspended BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS suspend_reason TEXT').catch(() => {});
    await pool.query("CREATE TABLE IF NOT EXISTS stories (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, media_type VARCHAR(10) NOT NULL, media_url TEXT, caption TEXT, bg VARCHAR(20), privacy VARCHAR(10) NOT NULL DEFAULT 'public', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL)").catch(() => {});
    await audience.ensureSchema(pool).catch((e) => console.error('[audience] schema:', e.message));   // 👁 chosen people for "friends except" / "only these people"
    await pool.query("CREATE TABLE IF NOT EXISTS live_streams (id SERIAL PRIMARY KEY, host_email TEXT NOT NULL, title TEXT, privacy VARCHAR(10) NOT NULL DEFAULT 'public', cf_uid TEXT, whip_url TEXT, whep_url TEXT, iframe_url TEXT, status VARCHAR(10) NOT NULL DEFAULT 'created', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, last_ping TIMESTAMPTZ, ended_at TIMESTAMPTZ, ended_by TEXT, end_reason TEXT, peak INTEGER NOT NULL DEFAULT 0, total_viewers INTEGER NOT NULL DEFAULT 0)").catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_live_status ON live_streams (status, last_ping)').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS live_viewers (live_id INTEGER NOT NULL, viewer_email TEXT NOT NULL, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (live_id, viewer_email))').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS live_comments (id SERIAL PRIMARY KEY, live_id INTEGER NOT NULL, user_email TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_live_comments ON live_comments (live_id, id)').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS live_reactions (id SERIAL PRIMARY KEY, live_id INTEGER NOT NULL, user_email TEXT NOT NULL, emoji VARCHAR(8) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_live_reactions ON live_reactions (live_id, id)').catch(() => {});
    await pool.query("CREATE TABLE IF NOT EXISTS live_requests (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL UNIQUE, status VARCHAR(10) NOT NULL DEFAULT 'pending', purpose VARCHAR(20), message TEXT, link TEXT, channel_name TEXT, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, decided_by TEXT, note TEXT, blocked BOOLEAN NOT NULL DEFAULT FALSE)").catch(() => {});
    await pool.query('ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS display_name TEXT').catch(() => {});
    await pool.query('ALTER TABLE creator_applications ADD COLUMN IF NOT EXISTS live_blocked BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
    // two separate ways to earn: 'invited' (an admin invites the person, no requirements) and 'applied' (the person meets the requirements and applies)
    await pool.query('ALTER TABLE creator_applications ADD COLUMN IF NOT EXISTS source VARCHAR(10)').catch(() => {});
    await pool.query("UPDATE creator_applications SET source = CASE WHEN status = 'approved' THEN 'invited' ELSE 'applied' END WHERE source IS NULL").catch(() => {});
    await pool.query("CREATE TABLE IF NOT EXISTS sounds (id SERIAL PRIMARY KEY, title TEXT NOT NULL, artist TEXT, audio_url TEXT NOT NULL, cover_url TEXT, duration INTEGER NOT NULL DEFAULT 30, active BOOLEAN NOT NULL DEFAULT TRUE, uses INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())").catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS saved_sounds (user_email TEXT NOT NULL, sound_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_email, sound_id))').catch(() => {});
    await pool.query('ALTER TABLE stories ADD COLUMN IF NOT EXISTS sound_id INTEGER, ADD COLUMN IF NOT EXISTS sound_start INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS sound_len INTEGER NOT NULL DEFAULT 15').catch(() => {});
    await pool.query('ALTER TABLE stories ADD COLUMN IF NOT EXISTS overlays TEXT').catch(() => {});
    await pool.query('ALTER TABLE stories ADD COLUMN IF NOT EXISTS feed_url TEXT').catch(() => {});
    await pool.query('ALTER TABLE comments ADD COLUMN IF NOT EXISTS media_url TEXT').catch(() => {});   // a photo in a comment (deleted from storage together with the comment / post)   // small, quick-start copy of a story video (made by the feed-video job)
    await pool.query('ALTER TABLE sounds ADD COLUMN IF NOT EXISTS post_id INTEGER').catch(() => {});
    await pool.query('ALTER TABLE sounds ADD COLUMN IF NOT EXISTS audio_ready BOOLEAN DEFAULT FALSE').catch(() => {});
    await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumb_url TEXT').catch(() => {});
    await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS allow_download BOOLEAN NOT NULL DEFAULT TRUE').catch(() => {});   // ⬇️ the owner may turn off the download button
    await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS feed_url TEXT').catch(() => {});
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS sounds_post_uq ON sounds (post_id) WHERE post_id IS NOT NULL').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_stories_user ON stories (user_email, expires_at)').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories (expires_at)').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS story_views (story_id INTEGER NOT NULL, viewer_email TEXT NOT NULL, viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (story_id, viewer_email))').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS story_reactions (story_id INTEGER NOT NULL, viewer_email TEXT NOT NULL, emoji VARCHAR(12) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (story_id, viewer_email))').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS creator_settings (key VARCHAR(40) PRIMARY KEY, value TEXT)').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS creator_earn (user_email TEXT PRIMARY KEY, carry_cents NUMERIC(14,6) NOT NULL DEFAULT 0)').catch(() => {});
    await pool.query('CREATE TABLE IF NOT EXISTS post_earn (post_id INTEGER PRIMARY KEY, user_email TEXT NOT NULL, views_seen INTEGER NOT NULL DEFAULT 0, cents NUMERIC(14,6) NOT NULL DEFAULT 0)').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_post_earn_user ON post_earn (user_email)').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_email)');
    for (const col of ["status VARCHAR(20) NOT NULL DEFAULT 'progress'", 'days_done INTEGER NOT NULL DEFAULT 0', 'posts_done INTEGER NOT NULL DEFAULT 0', 'ip_hash VARCHAR(64)', 'completed_at TIMESTAMPTZ', 'rewarded_at TIMESTAMPTZ', 'note TEXT']) {
      await pool.query(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await pool.query('CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status)');
    await pool.query('CREATE TABLE IF NOT EXISTS user_active_days (user_email TEXT NOT NULL, day DATE NOT NULL, PRIMARY KEY (user_email, day))');   // joined date (accounts that existed before this get the day of the update)
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
app.use('/api', markActive);                       // remembers the days a person used CamFeed (for the invitation reward)
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
  // only the VERIFIED caller counts as active (never an email that merely appears in the query/body)
  const viewerEmail = (req.authEmail || '').toString().trim();

  if (viewerEmail && req.path !== '/api/presence/ping' && !req.path.startsWith('/api/presence')) {
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

    const data = (await require('./gemini').generate(apiKey, { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } })).data || {};   // 🤖 gemini.js
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
// Where people can message us on Telegram (set SUPPORT_TELEGRAM=yourusername in Render). Only a plain https://t.me/<username> link is ever given out.
function supportTelegramLink() {
  const v = String(process.env.SUPPORT_TELEGRAM || '').trim();
  const m = /^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(v);
  return m ? 'https://t.me/' + m[1] : '';
}
app.get('/api/auth-options', (req, res) => res.json({ success: true, telegram: tgLogin.isConfigured(), phone: PHONE_AUTH_ON && gateway.isConfigured(), telegramContact: supportTelegramLink() }));

// Phone number + a code that arrives inside the person's Telegram (Telegram Gateway)
const PHONE_AUTH_ON = process.env.PHONE_AUTH_ENABLED === '1';   // phone sign-up / reset is paused until this is set to 1 in Render
const phonePaused = (req, res, next) => PHONE_AUTH_ON ? next() : res.status(503).json({ success: false, error: 'Phone number sign-up is coming soon. Please contact the admin on Telegram @Camfeed.' });
app.use(['/api/phone/send-code', '/api/phone/verify-code'], phonePaused);
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'private', 'private', $8, $9) 
      RETURNING *
    `;
    // every $n must be used in the SQL: an unused one ("$9" before) makes Postgres refuse the whole sign-up
    const result = await pool.query(query, [email, hashed, firstName, lastName, birth, gender, country, initialRole, viaPhone ? phoneE164 : null]);
    const user = result.rows[0];
    registerLimiter.hit(req.ip);
    recordReferral(user.email, req.body && req.body.ref, req.ip);
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
// ---- video thumbnails: a small picture (JPEG, ~30-60 KB) kept next to every video post so the feed shows it at once ----
let _r2Client = null;
async function r2PutBuffer(key, buf, type) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  if (!_r2Client) _r2Client = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  await _r2Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || 'camfeed-storage', Key: key, Body: buf, ContentType: type }));
  return String(process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').replace(/\/+$/, '') + '/' + key;
}
const thumbsReady = () => !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
const thumbKey = () => 'thumbs/' + Date.now() + '-' + require('crypto').randomBytes(4).toString('hex') + '.jpg';
async function thumbFromBase64(dataUrl) {                                   // the picture the phone already made for the AI check
  try {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(dataUrl || '')); if (!m || !thumbsReady()) return null;
    const buf = Buffer.from(m[1], 'base64'); if (buf.length < 500 || buf.length > 250 * 1024) return null;
    return await r2PutBuffer(thumbKey(), buf, 'image/jpeg');
  } catch (e) { return null; }
}
async function makeVideoThumb(src) {                                        // src: a file path or an https address of a video; one frame via ffmpeg
  if (!thumbsReady()) return null;
  const fs = require('fs'), os = require('os'), path = require('path'), { execFile } = require('child_process');
  const out = path.join(os.tmpdir(), 'camfeed-th-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.jpg');
  let bin = 'ffmpeg'; try { bin = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}
  try {
    for (const ss of ['1', '0']) {
      try {
        await new Promise((ok, no) => execFile(bin, ['-y', '-ss', ss, '-i', src, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '7', out], { timeout: 40000 }, (e) => e ? no(e) : ok()));
        if (fs.existsSync(out) && fs.statSync(out).size > 500) break;
      } catch (e) { /* try the first frame */ }
    }
    if (!fs.existsSync(out)) return null;
    const buf = fs.readFileSync(out); if (buf.length < 500 || buf.length > 250 * 1024) return null;
    return await r2PutBuffer(thumbKey(), buf, 'image/jpeg');
  } catch (e) { return null; } finally { try { fs.unlinkSync(out); } catch (e) {} }
}
let thumbBusy = false;
async function backfillThumbs() {                                           // old videos get their picture a few at a time, in the background
  if (thumbBusy || !thumbsReady()) return; thumbBusy = true;
  try {
    const rows = (await pool.query("SELECT id, media_type, media_url FROM posts WHERE thumb_url IS NULL AND shared_post_id IS NULL AND (media_type = 'video' OR media_url LIKE '%\"type\":\"video\"%') ORDER BY id DESC LIMIT 2")).rows;
    for (const row of rows) {
      const v = pubMedia(row).video;
      const t = v ? await makeVideoThumb(v) : null;
      await pool.query('UPDATE posts SET thumb_url = $2 WHERE id = $1', [row.id, t || '']).catch(() => {});     // '' = tried, do not try again
    }
  } catch (e) { console.error('[thumbs] backfill:', e.message); } finally { thumbBusy = false; }
}
setTimeout(() => { backfillThumbs(); setInterval(backfillThumbs, 90 * 1000); }, 60 * 1000);

// The saved picture / video shape ("9 / 16" ...) is only a guess made when the post was written. The thumbnail has the exact shape of the video,
// so its real size is written back ("480 / 270"): the website and the phone app then draw the right box at once, before the video loads.
function jpegSize(buf) {
  if (!buf || buf.length < 12 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
let aspectBusy = false;
const aspectTried = new Set();
async function backfillAspects() {
  if (aspectBusy || typeof fetch !== 'function') return; aspectBusy = true;
  try {
    const rows = (await pool.query("SELECT id, thumb_url FROM posts WHERE thumb_url LIKE 'http%' AND shared_post_id IS NULL AND (media_aspect IS NULL OR media_aspect IN ('', '9 / 16', '16 / 9', '1 / 1')) ORDER BY id DESC LIMIT 60")).rows;
    let done = 0;
    for (const r of rows) {
      if (done >= 6) break;
      if (aspectTried.has(r.id)) continue;
      aspectTried.add(r.id); done++;
      try {
        const resp = await fetch(r.thumb_url);
        if (!resp.ok) continue;
        const sz = jpegSize(Buffer.from(await resp.arrayBuffer()));
        if (sz && sz.w > 0 && sz.h > 0) await pool.query('UPDATE posts SET media_aspect = $2 WHERE id = $1', [r.id, `${sz.w} / ${sz.h}`]);
      } catch (e) { /* tried once; tried again after the next restart */ }
    }
  } catch (e) { console.error('[aspect] backfill:', e.message); } finally { aspectBusy = false; }
}
setTimeout(() => { backfillAspects(); setInterval(backfillAspects, 60 * 1000); }, 90 * 1000);


// ---- "feed version" of every video: a small MP4 (540 px wide, ~1 Mbps, moov at the front) so the phone app starts it at once, like Facebook ----
// The original stays untouched (full screen / website). Turn on in Render: FEED_VIDEOS = on. One video at a time, newest first.
// how long a video is (seconds), read from its header by ffmpeg; null when unknown
function videoSecs(src) {
  const { execFile } = require('child_process');
  let bin = 'ffmpeg'; try { bin = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}
  return new Promise((ok) => execFile(bin, ['-hide_banner', '-i', src], { timeout: 45 * 1000, maxBuffer: 1024 * 1024 * 4 }, (e, so, se) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(se || '') + String(so || ''));
    ok(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null);
  }));
}
// 🎞️ a "fragmented" video (often downloaded from Facebook / TikTok, or from some editors) tells only its FIRST piece
// (~3 seconds) in its header when read over the internet. Its real length is found by reading it through (fast: no decoding).
function realVideoSecs(src) {
  const { execFile } = require('child_process');
  let bin = 'ffmpeg'; try { bin = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}
  return new Promise((ok) => execFile(bin, ['-hide_banner', '-nostats', '-i', src, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { timeout: 4 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 }, (e, so, se) => {
    const all = [...String(se || '').matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const m = all.length ? all[all.length - 1] : null;
    ok(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null);
  }));
}
/// the length of a video, sure: a short header length is checked by reading the video through
async function surelySecs(src) {
  const h = await videoSecs(src).catch(() => null);
  if (h !== null && h >= 15) return h;
  const r = await realVideoSecs(src).catch(() => null);
  return r !== null && (h === null || r > h + 1) ? r : h;
}
const FEED_MAX_SECS = 300;   // the small feed version holds the first 5 minutes; a longer video gets it too as a quick-start PREVIEW
                             // (the app sees it is cut at 5:00 and opens the whole original when the person taps it)

async function makeFeedVideo(src, knownSecs, previewOnly = false) {
  if (!thumbsReady()) return null;
  // short video (≤ 5 min): a light copy (720/540p ~1.2 Mbps). LONG video: a light copy of the WHOLE video (not cut) —
  // the original from a phone is 10-20 Mbps, too heavy for 4G (it stops and spins after the first seconds); the light one
  // plays smooth to the end. Over 20 min: a little lighter still (540p ~0.8 Mbps) so a 2-hour video stays under ~1 GB.
  const secs = knownSecs !== undefined ? knownSecs : await surelySecs(src).catch(() => null);
  if (secs === null) return null;
  const long = !previewOnly && secs > FEED_MAX_SECS + 1, veryLong = long && secs > 20 * 60;
  const fs = require('fs'), os = require('os'), path = require('path'), { execFile } = require('child_process');
  const out = path.join(os.tmpdir(), 'camfeed-fv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.mp4');
  let bin = 'ffmpeg'; try { bin = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}
  const scale = veryLong ? "scale='if(gt(iw,ih),min(854,iw),min(480,iw))':-2,fps=30" : "scale='if(gt(iw,ih),min(720,iw),min(540,iw))':-2,fps=30";
  const rate = veryLong ? ['-crf', '29', '-maxrate', '850k', '-bufsize', '1700k'] : ['-crf', '28', '-maxrate', '1200k', '-bufsize', '2400k'];
  const args = ['-y', '-i', src, ...(long ? [] : ['-t', '300']), '-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    ...rate, '-g', '60', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart', '-threads', '1', out];
  const timeout = Math.max(8 * 60 * 1000, Math.round(secs * 3 * 1000));       // a long video may take as long as itself (or more) to make
  try {
    await new Promise((ok, no) => execFile(bin, args, { timeout, maxBuffer: 1024 * 1024 * 8 }, (e) => e ? no(e) : ok()));
    if (!fs.existsSync(out)) return null;
    const size = fs.statSync(out).size; if (size < 2000 || size > 4 * 1024 * 1024 * 1024) return null;
    const key = (long ? 'feedfull/' : 'feed/') + Date.now() + '-' + require('crypto').randomBytes(4).toString('hex') + '.mp4';
    if (size < 60 * 1024 * 1024) return await r2PutBuffer(key, fs.readFileSync(out), 'video/mp4');
    // a big file is sent as a stream (never read whole into memory)
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await r2PutBuffer('feedfull/.probe', Buffer.from('1'), 'text/plain').catch(() => {});      // makes sure the R2 client exists
    await _r2Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || 'camfeed-storage', Key: key, Body: fs.createReadStream(out), ContentLength: size, ContentType: 'video/mp4' }));
    return String(process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').replace(/\/+$/, '') + '/' + key;
  } catch (e) { console.error('[feedvideo] ffmpeg:', String(e.message || e).slice(0, 200)); return null; } finally { try { fs.unlinkSync(out); } catch (e) {} }
}
let feedVideoBusy = false;
let cutCheckReady = false;
// the real length of every video (the Feed reads posts.video_secs): the column must exist before the first feed request
pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_secs INT').catch((e) => console.error('[feedvideo] video_secs:', e.message));
pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS no_earn BOOLEAN DEFAULT FALSE').catch(() => {});   // ©️ a copy / a post under a copyright claim earns nothing
async function fixCutFeedVideos() {
  if (!thumbsReady()) return;
  try {
    if (!cutCheckReady) { await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS feed_checked BOOLEAN DEFAULT FALSE'); await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_secs INT').catch(() => {}); cutCheckReady = true; }
    const rows = (await pool.query("SELECT id, feed_url FROM posts WHERE feed_url LIKE '%/feed/%' AND COALESCE(feed_checked, FALSE) = FALSE ORDER BY id DESC LIMIT 3")).rows;
    for (const r of rows) {
      const secs = await videoSecs(r.feed_url).catch(() => null);
      if (secs !== null && secs >= FEED_MAX_SECS - 1) {
        // a 5-minute preview of a long video: made again as a light copy of the WHOLE video (the long lane)
        // keep the preview playing; the long lane makes the full light copy and replaces it
        const real = await videoSecs(await pool.query('SELECT media_type, media_url FROM posts WHERE id = $1', [r.id]).then((q) => q.rows[0] ? pubMedia(q.rows[0]).video : null).catch(() => null)).catch(() => null);
        await pool.query('UPDATE posts SET feed_checked = TRUE, video_secs = COALESCE($2, video_secs) WHERE id = $1', [r.id, real === null ? null : Math.round(real)]);
        console.log('[feedvideo] post', r.id, 'has a 5-minute preview → full light copy queued');
      } else {
        await pool.query('UPDATE posts SET feed_checked = TRUE WHERE id = $1', [r.id]);
      }
    }
  } catch (e) { console.error('[feedvideo] check:', e.message); }
}
setTimeout(() => { fixCutFeedVideos(); setInterval(fixCutFeedVideos, 20 * 1000); }, 60 * 1000);

// 🎞️ once: videos that were measured "3 seconds" from a fragmented header get their real length, and a light copy
// (which plays with the right length everywhere) is made again for them if it failed or is missing
async function fixFragmentedVideos() {
  if (!thumbsReady()) return;
  try {
    const done = await pool.query("SELECT 1 FROM creator_settings WHERE key = 'feed:fragment_fix_v2'").catch(() => ({ rows: [1] }));
    if (done.rows.length) return;
    // v2: also videos never measured (NULL / 0), and a light copy that is shorter than the real video is made again
    const rows = (await pool.query("SELECT id, media_type, media_url, feed_url, video_secs FROM posts WHERE COALESCE(video_secs, 0) <= 6 AND shared_post_id IS NULL AND (media_type = 'video' OR media_url LIKE '%\"type\":\"video\"%') ORDER BY id DESC LIMIT 400")).rows;
    let fixed = 0;
    console.log('[feedvideo] checking', rows.length, 'short / unmeasured videos for a wrong length…');
    for (const row of rows) {
      const v = pubMedia(row).video; if (!v) continue;
      const real = await realVideoSecs(v).catch(() => null);
      if (real === null) continue;
      const light = String(row.feed_url || '').startsWith('http') ? await videoSecs(row.feed_url).catch(() => null) : null;
      const shortLight = light !== null && light < real - 1;
      if (real <= Number(row.video_secs || 0) + 1 && !shortLight) { if (!row.video_secs) await pool.query('UPDATE posts SET video_secs = $2 WHERE id = $1', [row.id, Math.round(real)]).catch(() => {}); continue; }
      console.log('[feedvideo] post', row.id, 'real length', Math.round(real), 's (was', row.video_secs, '/ light', light, ') → light copy again');
      // the light copy is remade from the whole video (an old one may be fine, but a fresh one is sure)
      await pool.query('UPDATE posts SET video_secs = $2, feed_url = NULL, feed_checked = FALSE WHERE id = $1', [row.id, Math.round(real)]).catch(() => {});
      fixed++;
    }
    await pool.query("INSERT INTO creator_settings (key, value) VALUES ('feed:fragment_fix_v2', $1) ON CONFLICT (key) DO NOTHING", [String(fixed)]).catch(() => {});
    console.log('[feedvideo] fragmented videos fixed:', fixed, 'of', rows.length, 'checked');
  } catch (e) { console.error('[feedvideo] fragment fix:', e.message); }
}
setTimeout(fixFragmentedVideos, 3 * 60 * 1000);

let longRequeued = false, longBusy = false;
const longWait = new Set();     // long videos waiting for the long lane (skipped by the quick lane)
const longFailed = new Set();   // the full light copy could not be made (until the next restart): keep the preview
async function backfillFeedVideos() {
  if (process.env.FEED_VIDEOS !== 'on' || feedVideoBusy || !thumbsReady()) return; feedVideoBusy = true;
  try {
    // once: long videos that were left without a small version (the old 5-minute rule) are queued again for their preview
    if (!longRequeued) {
      longRequeued = true;
      const done = await pool.query("SELECT 1 FROM creator_settings WHERE key = 'feed:long_full_v2'").catch(() => ({ rows: [1] }));
      if (!done.rows.length) {
        const r = await pool.query("UPDATE posts SET feed_url = NULL, feed_checked = FALSE WHERE feed_url = '' AND shared_post_id IS NULL AND (media_type = 'video' OR media_url LIKE '%\"type\":\"video\"%')").catch(() => ({ rowCount: 0 }));
        // the 5-minute previews of long videos are checked again (the checker below turns them into full light copies)
        await pool.query("UPDATE posts SET feed_checked = FALSE WHERE feed_url LIKE '%/feed/%'").catch(() => {});
        await pool.query("INSERT INTO creator_settings (key, value) VALUES ('feed:long_full_v2', '1') ON CONFLICT (key) DO NOTHING").catch(() => {});
        console.log('[feedvideo] queued again for a preview:', r.rowCount);
      }
    }
    // story videos first: they are the raw files from the phone camera (very big, slow to start) and they only live 24 hours
    const sv = (await pool.query("SELECT id, media_url FROM stories WHERE media_type = 'video' AND feed_url IS NULL AND expires_at > NOW() + INTERVAL '10 minutes' ORDER BY id DESC LIMIT 1").catch(() => ({ rows: [] }))).rows[0];
    if (sv) {
      const u = sv.media_url ? await makeFeedVideo(sv.media_url) : null;   // (makeFeedVideo finds the sure length itself)
      await pool.query('UPDATE stories SET feed_url = $2 WHERE id = $1', [sv.id, u || '']).catch(() => {});
      if (u) console.log('[feedvideo] story', sv.id, 'ready');
      return;
    }
    // waiting: videos with no light copy yet, and long videos that so far have only their 5-minute preview
    const rows = (await pool.query("SELECT id, media_type, media_url, feed_url FROM posts WHERE (feed_url IS NULL OR (feed_url LIKE '%/feed/%' AND video_secs > 301)) AND shared_post_id IS NULL AND (media_type = 'video' OR media_url LIKE '%\"type\":\"video\"%') AND NOT (id = ANY($1::int[])) ORDER BY (feed_url IS NULL) DESC, id DESC LIMIT 1", [[...longWait, ...longFailed]])).rows;   // videos with nothing light come first
    for (const row of rows) {
      const v = pubMedia(row).video;
      const secs = v ? await surelySecs(v).catch(() => null) : null;      // a fragmented video's header says ~3 s: read it through
      // the real length is kept: the app shows it (a long video's quick preview is only 5 minutes)
      if (secs !== null) await pool.query('UPDATE posts SET video_secs = $2 WHERE id = $1', [row.id, Math.round(secs)]).catch(() => {});
      if (v && secs !== null && secs > FEED_MAX_SECS + 1) {
        // a long video: made in its own lane, one at a time, in the background
        longWait.add(row.id);
        if (!longBusy) {
          longBusy = true;
          console.log('[feedvideo] long video', row.id, Math.round(secs / 60), 'min: making the light copy…');
          (async () => {
            // first a 5-minute preview (made in a minute or two: the video starts at once in the Feed meanwhile),
            // then the light copy of the WHOLE video (may take hours) replaces it
            if (!row.feed_url) {
              // every long video first gets its preview (a minute or two each); the slow full copies come after ALL previews
              const pv = await makeFeedVideo(v, secs, true);
              if (pv) { await pool.query('UPDATE posts SET feed_url = $2, feed_checked = TRUE WHERE id = $1', [row.id, pv]).catch(() => {}); console.log('[feedvideo] long post', row.id, 'preview ready'); return; }
            }
            const u = await makeFeedVideo(v, secs);
            if (u) { await pool.query('UPDATE posts SET feed_url = $2, feed_checked = TRUE WHERE id = $1', [row.id, u]).catch(() => {}); console.log('[feedvideo] long post', row.id, 'full light copy ready'); }
            else {
              longFailed.add(row.id);
              await pool.query("UPDATE posts SET feed_url = '' WHERE id = $1 AND feed_url IS NULL", [row.id]).catch(() => {});
            }
          })().catch(() => {}).finally(() => { longBusy = false; longWait.clear(); });
        }
        continue;
      }
      const u = v ? await makeFeedVideo(v, secs === null ? undefined : secs) : null;
      await pool.query('UPDATE posts SET feed_url = $2 WHERE id = $1', [row.id, u || '']).catch(() => {});      // '' = tried, do not try again
      if (u) console.log('[feedvideo] post', row.id, 'ready');
    }
  } catch (e) { console.error('[feedvideo] job:', e.message); } finally { feedVideoBusy = false; }
}
setTimeout(() => { backfillFeedVideos(); setInterval(backfillFeedVideos, 15 * 1000); }, 2 * 60 * 1000);
if (process.env.FEED_VIDEOS === 'on') console.log('[feedvideo] small feed videos are ON');


// ---- Tag friends: a post / share can tag people you follow (max 20). Stored as a comma list in posts.tagged_emails. ----
async function cleanTags(req, raw) {
  try {
    const me = String(req.authEmail || '').toLowerCase();
    const list = (Array.isArray(raw) ? raw : []).map((x) => String((x && x.email) || x || '').trim().toLowerCase()).filter((x) => x && x !== me && x.includes('@'));
    const uniq = [...new Set(list)].slice(0, 20);
    if (!uniq.length) return [];
    const r = await pool.query('SELECT following_email FROM follows WHERE follower_email = $1 AND LOWER(following_email) = ANY($2::text[])', [me, uniq]);
    return r.rows.map((x) => String(x.following_email).toLowerCase());
  } catch (e) { return []; }
}
async function notifyTagged(tags, by, postId, label) {
  try {
    const n = await pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email) = $1', [String(by).toLowerCase()]);
    const nm = `${n.rows[0]?.first_name || ''} ${n.rows[0]?.last_name || ''}`.trim();
    // People who turned on "review tags" are held as pending until they accept; everyone else is tagged straight away.
    const rv = await pool.query('SELECT LOWER(email) AS e FROM users WHERE tag_review = TRUE AND LOWER(email) = ANY($1::text[])', [tags]);
    const hold = new Set(rv.rows.map((x) => x.e));
    const ok = tags.filter((t) => !hold.has(t));
    const pend = tags.filter((t) => hold.has(t));
    await pool.query('UPDATE posts SET tagged_emails = $1, tag_pending = $2 WHERE id = $3', [ok.join(','), pend.join(','), postId]);
    for (const t of ok) {
      await pool.query('INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, $3, $4, $5, FALSE)', [t, by, postId, 'tag', `${nm} បាន Tag អ្នកក្នុង${label}`]);
    }
    for (const t of pend) {
      await pool.query('INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, $3, $4, $5, FALSE)', [t, by, postId, 'tag_review', `${nm} បាន Tag អ្នកក្នុង${label} — រង់ចាំការអនុម័តរបស់អ្នក`]);
    }
  } catch (e) { /* a failed notification never blocks the post */ }
}
const TAGGED_USERS_SQL = `(SELECT json_agg(json_build_object('email', tu.email, 'name', TRIM(COALESCE(tu.first_name,'') || ' ' || COALESCE(tu.last_name,''))))
        FROM users tu WHERE COALESCE(p.tagged_emails,'') <> '' AND LOWER(tu.email) = ANY(string_to_array(p.tagged_emails, ','))) AS tagged_users`;

app.post('/api/posts', formFields, authCore.forceActor, async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ success: false, error: 'Request body is missing' });
  }

  const email = req.body.email;
  const content = req.body.content || '';
  const aud = await audience.prepare(req.authEmail || req.body.email, req.body.privacy, req.body.audience);
  if (!aud.ok) return res.status(400).json({ success: false, error: aud.error });
  const privacy = aud.privacy;
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
    const tags = await cleanTags(req, req.body.tagged);
    const aiResult = { category: 'General', tags: '' };   // 🏷️ the AI labels it a few seconds later in the background (interests.js), posting does not wait

    const query = `
      INSERT INTO posts (user_email, content, media_type, media_url, privacy, ai_category, ai_tags, media_aspect, thumb_url, tagged_emails) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
      RETURNING *
    `;
    const thumbUrl = mediaType === 'video' ? await thumbFromBase64(thumbnailBase64) : null;
    // with chosen people: saved as "only me" first, the people are written, then it opens to them (never shown to others for a moment)
    const result = await pool.query(query, [email, content, mediaType, mediaUrl, aud.people.length ? 'private' : privacy, aiResult.category, aiResult.tags, mediaAspect, thumbUrl, '']);
    const newId = result.rows[0].id;
    if (req.body.allowDownload === false) { await pool.query('UPDATE posts SET allow_download = FALSE WHERE id = $1', [newId]); result.rows[0].allow_download = false; }
    if (aud.people.length) {
      await audience.save('post', newId, aud.people);
      await pool.query('UPDATE posts SET privacy = $1 WHERE id = $2', [privacy, newId]);
      result.rows[0].privacy = privacy;
    }
    // only the tagged people who are allowed to see the post are tagged (and told)
    const okTags = tags.length ? await audience.canSeePostList(newId, tags) : [];
    if (okTags.length) await notifyTagged(okTags, req.authEmail || email, newId, 'ការបង្ហោះ');
    result.rows[0].tagged_emails = okTags.join(',');
    if (mediaType === 'video' || String(mediaUrl || '').includes('"type":"video"')) setTimeout(() => { backfillFeedVideos().catch(() => {}); }, 4000);   // a new video gets its small feed version first
    try { interests.kick(); } catch (e) {}
    res.status(201).json({ success: true, post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ⬇️ the owner turns the download button of a post on / off (the pictures can still be seen; a screenshot can never be stopped)
app.post('/api/posts/:id/download', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    if (!me || !(id > 0)) return res.status(400).json({ success: false });
    const r = await pool.query('UPDATE posts SET allow_download = $3 WHERE id = $1 AND user_email = $2 RETURNING allow_download', [id, me, (req.body || {}).on !== false]);
    if (!r.rowCount) return res.status(403).json({ success: false, error: 'Only the owner can change this.' });
    res.json({ success: true, allow_download: r.rows[0].allow_download });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});

// Share Post to Profile
app.post('/api/posts/share', async (req, res) => {
  const { postId, email, caption } = req.body;
  try {
    if (!postId) return res.status(400).json({ success: false, error: 'Missing post.' });
    if (!(await visibility.guardPost(req, res, postId))) return;
    bumpInterest(req.authEmail, postId, 8);
    const shareTags = await cleanTags(req, req.body.tagged);
    const orig = await pool.query(
      'SELECT p.*, u.first_name, u.last_name FROM posts p JOIN users u ON p.user_email = u.email WHERE p.id = $1',
      [postId]
    );
    if (orig.rows.length === 0) return res.status(404).json({ success: false, error: 'Post not found' });

    const p = orig.rows[0];
    if (String(p.privacy || 'public') !== 'public' && String(p.user_email).toLowerCase() !== String(req.authEmail || email || '').toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Only public posts can be shared.' });
    }
    const rootPostId = p.shared_post_id ? p.shared_post_id : p.id;
    const aud = await audience.prepare(req.authEmail || email, req.body.privacy, req.body.audience);
    if (!aud.ok) return res.status(400).json({ success: false, error: aud.error });

    const result = await pool.query(
      `INSERT INTO posts (user_email, content, media_type, media_url, privacy, ai_category, ai_tags, shared_post_id, tagged_emails) 
       VALUES ($1, $2, 'shared', NULL, $7, $3, $4, $5, $6) 
       RETURNING *`,
      [email, caption || '', p.ai_category || 'General', p.ai_tags || '', rootPostId, '', aud.people.length ? 'private' : aud.privacy]
    );
    const shareId = result.rows[0].id;
    if (aud.people.length) {
      await audience.save('post', shareId, aud.people);
      await pool.query('UPDATE posts SET privacy = $1 WHERE id = $2', [aud.privacy, shareId]);
      result.rows[0].privacy = aud.privacy;
    }
    const okShareTags = shareTags.length ? await audience.canSeePostList(shareId, shareTags) : [];
    if (okShareTags.length) await notifyTagged(okShareTags, req.authEmail || email, shareId, 'ការចែករំលែក');

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
      WHERE p.shared_post_id = $1 AND ${audience.postVisibleSql('p', '$2')}
      ORDER BY p.created_at DESC
    `;
    const result = await pool.query(query, [postId, req.authEmail || '']);
    res.json({ success: true, sharers: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// The feed remembers what you have already SEEN (pictures and text too, not only videos) so it does not show the same posts again and again.
app.post('/api/feed/seen', async (req, res) => {
  try {
    const me = req.authEmail; if (!me) return res.json({ success: true });
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 40);
    if (!ids.length) return res.json({ success: true });
    await pool.query(`INSERT INTO feed_seen (viewer_email, post_id) SELECT $1, UNNEST($2::int[])
      ON CONFLICT (viewer_email, post_id) DO UPDATE SET seen_at = NOW(), times = feed_seen.times + 1`, [me, ids]);
    // seeing a share = seeing the original post too (and so its other shares)
    await pool.query(`INSERT INTO feed_seen (viewer_email, post_id) SELECT $1, shared_post_id FROM posts WHERE id = ANY($2::int[]) AND shared_post_id IS NOT NULL
      ON CONFLICT (viewer_email, post_id) DO UPDATE SET seen_at = NOW()`, [me, ids]).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.json({ success: true }); }
});

// Track Post / Video View & Country Metadata
app.post('/api/posts/:id/view', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  try {
    if (!(await visibility.guardPost(req, res, id))) return;
    bumpInterest(req.authEmail, id, 1);
    // 🔍 an older app (no watch ticket): a shown view only — once per person per day, never the owner, never paid
    const me = req.authEmail;
    if (me) {
      const vg = await viewGuard.settings();
      if (viewGuard.tooMany(String(me).toLowerCase(), vg.perHour)) viewGuard.flagViewer(String(me).toLowerCase(), vg.perHour).catch(() => {});
      else {
        const owner = (await pool.query('SELECT user_email FROM posts WHERE id = $1', [id])).rows[0];
        let viewerCountry = req.headers['cf-ipcountry'] || 'Unknown';
        const uRes = await pool.query('SELECT country FROM users WHERE email = $1', [me]);
        if (uRes.rows[0]?.country) viewerCountry = uRes.rows[0].country;
        if (owner) await viewGuard.countShown(parseInt(id, 10), me, owner.user_email, viewerCountry);
      }
    }
    const upd = await pool.query('SELECT COALESCE(views_count, 0) AS views_count FROM posts WHERE id = $1', [id]);
    res.json({ success: true, views_count: upd.rows[0]?.views_count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Report Post or Video to Admin
// "Hide post" (⋯ on a post): it disappears from MY feed only. undo: true brings it back.
app.post('/api/posts/:id/hide', async (req, res) => {
  const me = req.authEmail; const id = parseInt(req.params.id, 10) || 0;
  if (!me || !id) return res.status(400).json({ success: false });
  try {
    if (req.body && req.body.undo) await pool.query('DELETE FROM hidden_posts WHERE user_email = $1 AND post_id = $2', [me, id]);
    else await pool.query('INSERT INTO hidden_posts (user_email, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

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
    res.json({ success: true, message: 'របាយការណ៍របស់អ្នកត្រូវបានបញ្ជូនទៅកាន់ CamFeed ដើម្បីត្រួតពិនិត្យភ្លាមៗ!' });
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
    res.json({ success: true, message: 'របាយការណ៍អំពីគណនីនេះត្រូវបានបញ្ជូនទៅកាន់ CamFeed ដើម្បីត្រួតពិនិត្យភ្លាមៗ!' });
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
  const safeViewer = req.authEmail || '';      // who is looking = the logged-in person only (a guest sees public posts only)
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 15, 5), 50);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  try {
    if (!postsSchemaReady) {
      await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_aspect VARCHAR(30) DEFAULT ''").catch(() => {});
      await verify.ensure().catch(() => {});
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
        p.*, u.first_name, u.last_name, u.profile_pic, ${verify.tickSql('u')} AS author_verified, ${verify.tickSql('ou')} AS orig_author_verified,
        COALESCE(ls.likes_count, 0) AS likes_count,
        COALESCE(cs.comments_count, 0) AS comments_count,
        COALESCE(ss.shares_count, 0) AS shares_count,
        ls.user_reaction,
        ls.reaction_types,
        EXISTS (SELECT 1 FROM follows ff2 WHERE ff2.follower_email = $1 AND ff2.following_email = p.user_email) AS author_followed,
        EXISTS (SELECT 1 FROM follows ff3 WHERE ff3.follower_email = p.user_email AND ff3.following_email = $1) AS author_follows_me,
        ${TAGGED_USERS_SQL},
        (SELECT string_agg(t.rt, ',' ORDER BY t.c DESC) FROM (SELECT reaction_type AS rt, COUNT(*) AS c FROM likes l2 WHERE l2.post_id = p.id GROUP BY reaction_type ORDER BY COUNT(*) DESC LIMIT 2) t) AS top_reactions,
        op.id AS orig_id,
        op.content AS orig_content,
        op.media_type AS orig_media_type,
        op.media_url AS orig_media_url,
        op.allow_download AS orig_allow_download,
        op.thumb_url AS orig_thumb_url,
        op.feed_url AS orig_feed_url,
        op.video_secs AS orig_video_secs,
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

    if (profileEmail && req.query.tagged === '1') {
      // posts where this person is tagged (accepted tags only); others see only public ones
      const tq = `${cteAndJoins} ${baseFrom} WHERE LOWER($2) = ANY(string_to_array(COALESCE(p.tagged_emails,''), ',')) AND ${audience.postVisibleSql('p', '$1')} ORDER BY p.created_at DESC LIMIT $3 OFFSET $4`;
      const tr = await pool.query(tq, [safeViewer, profileEmail, parsedLimit, parsedOffset]);
      tr.rows.forEach((r) => visibility.scrubOriginal(r, req.authEmail));
      return res.json({ success: true, posts: tr.rows, hasMore: tr.rows.length === parsedLimit });
    }

    if (profileEmail) {
      let query = `${cteAndJoins} ${baseFrom}`;
      if (profileEmail === safeViewer) {
        query += type === 'videos'
          ? ` WHERE p.user_email = $2 AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video')`
          : ` WHERE p.user_email = $2`;
      } else {
        query += type === 'videos'
          ? ` WHERE p.user_email = $2 AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video') AND ${audience.postVisibleSql('p', '$1')} AND COALESCE(u.is_banned, FALSE) = FALSE AND p.user_email NOT IN (SELECT u_email FROM blocked)`
          : ` WHERE p.user_email = $2 AND ${audience.postVisibleSql('p', '$1')} AND COALESCE(u.is_banned, FALSE) = FALSE AND p.user_email NOT IN (SELECT u_email FROM blocked)`;
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
    // ONCE ONLY (like Facebook): posts you have not seen always come first (ranked). A post you have seen (on screen ≥ 1.5 s, or a
    // video you watched) never comes before them again; after "you're all caught up" the seen ones follow, the one seen longest
    // ago first (seen more than N days ago before seen lately, liked / commented last) — so the feed is never empty and never stuck.
    const useLatest = process.env.FEED_MODE === 'latest';
    const reshowDays = Math.max(1, Math.min(365, parseInt((appConfig.cfg().feed || {}).reshowDays, 10) || 7));
    const seenAt = "COALESCE(GREATEST(fs.seen_at, pv.at::timestamptz), 'epoch'::timestamptz)";
    const engaged = '(EXISTS (SELECT 1 FROM likes lk WHERE lk.post_id = p.id AND lk.user_email = $1) OR EXISTS (SELECT 1 FROM comments cm WHERE cm.post_id = p.id AND cm.user_email = $1))';
    // 0 = never seen (ranked) · 1 = seen more than N days ago · 2 = seen lately · 3 = liked / commented — the seen ones by "seen longest ago",
    // so nothing ever stays on top: each time a post is seen again it goes to the back of its group
    // a share of a post I have already seen counts as seen too (the same video must not come back as "new")
    const shareSeen = '(p.shared_post_id IS NOT NULL AND (EXISTS (SELECT 1 FROM feed_seen x WHERE x.viewer_email = $1 AND x.post_id = p.shared_post_id) OR EXISTS (SELECT 1 FROM post_views y WHERE y.viewer_email = $1 AND y.post_id = p.shared_post_id)))';
    // 1 = seen a while ago (more than 6 h) · 2 = seen in the last 6 h · 3 = liked / commented
    const tierExpr = `(CASE WHEN fs.post_id IS NULL AND pv.post_id IS NULL AND NOT ${shareSeen} AND NOT ${engaged} THEN 0 WHEN ${engaged} THEN 3
                           WHEN ${seenAt} < NOW() - INTERVAL '6 hours' THEN 1 ELSE 2 END)`;
    const feedOrder = useLatest ? 'feed_tier ASC, p.created_at DESC, p.id DESC' : 'feed_tier ASC, feed_rank_score DESC, p.created_at DESC';
    const newOnly = req.query.newOnly === '1';             // the app asks "anything new?" while you scroll (only never-seen posts)
    await interests.ready();
    await country.ensure().catch(() => {});
    const foreign = country.foreignSql('$1', 'u', 'f.following_email IS NOT NULL');   // 🌏 another country: lower (not for people I follow)
    const feedQuery = `
      ${cteAndJoins},
      ${tierExpr} AS feed_tier,
      (${tierExpr} > 0) AS seen_before,
      EXISTS (SELECT 1 FROM follows fb WHERE fb.follower_email = p.user_email AND fb.following_email = $1) AS author_follows_me,
      COALESCE(uis.score, 0) AS interest_score,
      (f.following_email IS NOT NULL) AS author_followed,
      CASE WHEN ${tierExpr} > 0 THEN (
        -- after "all caught up" the feed goes on like Facebook: posts of the people I follow / my friends first, popular ones,
        -- the ones seen longest ago, mixed by chance (never the same order twice)
        CASE WHEN p.user_email = $1 THEN 10 WHEN f.following_email IS NOT NULL THEN 60 ELSE 0 END
        + (LN(1.0 + COALESCE(ls.likes_count, 0) + COALESCE(cs.comments_count, 0) * 2.0 + COALESCE(ss.shares_count, 0) * 3.0 + COALESCE(p.views_count, 0) * 0.1) * 4.0)
        + (COALESCE(uis.score, 0) * 2.5)
        ${interests.feedScoreSql()}
        + LEAST(EXTRACT(EPOCH FROM (NOW() - ${seenAt})) / 3600.0 / (24.0 * ${reshowDays}), 1.0) * 30.0
        + (RANDOM() * 45.0)
        - ${foreign}
      ) ELSE (
        CASE
          WHEN p.user_email = $1 THEN 25
          WHEN f.following_email IS NOT NULL THEN 65
          ELSE 12
        END
        + LEAST(COALESCE(ls.likes_count, 0) * 3.0, 30)
        + LEAST(COALESCE(cs.comments_count, 0) * 4.5, 30)
        + LEAST(COALESCE(ss.shares_count, 0) * 6.0, 30)
        + LEAST(COALESCE(p.views_count, 0) * 0.15, 20)
        + (LN(1.0 + COALESCE(ls.likes_count, 0) + COALESCE(cs.comments_count, 0) * 2.0 + COALESCE(ss.shares_count, 0) * 3.0 + COALESCE(p.views_count, 0) * 0.1) * 3.0)
        + (COALESCE(uis.score, 0) * 2.5)
        ${interests.feedScoreSql()}
        + (60.0 / (EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0 + 2.0))
        + (RANDOM() * 35.0)
        - ${foreign}
      ) END AS feed_rank_score
      ${baseFrom}
      LEFT JOIN follows f ON f.follower_email = $1 AND f.following_email = p.user_email
      LEFT JOIN user_interest_scores uis ON uis.user_email = $1 AND uis.category = p.ai_category
      ${interests.feedJoinSql('$1')}
      LEFT JOIN (SELECT post_id, MAX(created_at) AS at FROM post_views WHERE viewer_email = $1 GROUP BY post_id) pv ON pv.post_id = p.id
      LEFT JOIN feed_seen fs ON fs.viewer_email = $1 AND fs.post_id = p.id
      WHERE ${audience.postVisibleSql('p', '$1')}
        ${videoOnlyCondition}
        ${excludeCondition}
        AND COALESCE(u.is_banned, FALSE) = FALSE
        AND p.user_email NOT IN (SELECT u_email FROM blocked)
        AND NOT EXISTS (SELECT 1 FROM hidden_posts hp WHERE hp.user_email = $1 AND hp.post_id = p.id)
        ${newOnly ? `AND ${tierExpr} = 0` : ''}
      ORDER BY ${feedOrder}
      LIMIT $2 OFFSET $3
    `;

    // the Admin's feed mix (🧩 App features): a bigger pool of ranked posts is read, then each page is filled by the Admin's percentages
    const mixCfg = (appConfig.cfg().feed || {}).mix || {};
    const useMix = !useLatest && !newOnly && (excludeIds.length > 0 || parsedOffset === 0);
    const poolSize = useMix ? Math.min(Math.max(parsedLimit * 3, 30), 90) : parsedLimit;
    const queryParams = excludeIds.length > 0
      ? [safeViewer, poolSize, 0, excludeIds]
      : [safeViewer, poolSize, parsedOffset];

    const result = await pool.query(feedQuery, queryParams);
    result.rows.forEach((r) => visibility.scrubOriginal(r, req.authEmail));   // a share never shows an original that is not public any more
    // Mix: popular + new + random. At least every 3rd post of a page is a NEW one (under 24 h) when there is one in the page.
    let rows = result.rows;
    const unseen = rows.filter((r) => !r.seen_before), seenRows = rows.filter((r) => r.seen_before);   // seen ones stay after "all caught up"
    let mixed = unseen;
    if (useMix && unseen.length > 3) {
      mixed = feedMix.mix(unseen, mixCfg, safeViewer).slice(0, parsedLimit);
    } else if (!useLatest && unseen.length > 3) {
      const isNew = (r) => Date.now() - new Date(r.created_at).getTime() < 24 * 3600 * 1000;
      const fresh = unseen.filter(isNew), old = unseen.filter((r) => !isNew(r)), out = [];
      const takeFresh = () => fresh.shift(), takeOld = () => (old.length ? old.shift() : fresh.shift());
      while (out.length < unseen.length) { const slot = out.length; out.push((slot % 3 === 2 && fresh.length) ? takeFresh() : takeOld()); }
      mixed = out;
    }
    // the feed never stops (like Facebook): after the new posts come posts of the people I follow / friends and other ones
    // seen before (ranked above). The app sends the ids it already shows (excludeIds), so nothing repeats while scrolling.
    rows = [...mixed, ...seenRows].slice(0, Math.max(parsedLimit, mixed.length));
    if (!useLatest) return res.json({ success: true, posts: rows, hasMore: rows.length >= parsedLimit });
    res.json({ success: true, posts: rows, hasMore: rows.length === parsedLimit });
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
      (SELECT string_agg(t.rt, ',' ORDER BY t.c DESC) FROM (SELECT reaction_type AS rt, COUNT(*) AS c FROM likes l2 WHERE l2.post_id = p.id GROUP BY reaction_type ORDER BY COUNT(*) DESC LIMIT 2) t) as top_reactions,
      ${TAGGED_USERS_SQL},
      op.id as orig_id,
      op.content as orig_content,
      op.media_type as orig_media_type,
      op.media_url as orig_media_url,
      op.allow_download as orig_allow_download,
      op.thumb_url as orig_thumb_url,
      op.feed_url as orig_feed_url,
      op.video_secs as orig_video_secs,
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
    const own = (await pool.query('SELECT id, privacy, content FROM posts WHERE id = $1 AND LOWER(user_email) = LOWER($2)', [parseInt(id, 10) || 0, req.authEmail || email || ''])).rows[0];
    if (!own) return res.status(403).json({ success: false, error: 'Unauthorized or post not found' });
    // the chosen people change only when the app sends them; otherwise the ones saved stay
    const sentPeople = Array.isArray(req.body.audience);
    let pv = audience.cleanPrivacy(privacy, own.privacy || 'public'), people = null;
    if ((pv === 'except' || pv === 'custom') && sentPeople) {
      const aud = await audience.prepare(req.authEmail || email, pv, req.body.audience);
      if (!aud.ok) return res.status(400).json({ success: false, error: aud.error });
      pv = aud.privacy; people = aud.people;
    } else if ((pv === 'except' || pv === 'custom') && pv !== own.privacy) {
      return res.status(400).json({ success: false, error: 'Please choose the people.' });
    }
    // first close it, then change the people, then open it with the new choice
    if (people) {
      await pool.query("UPDATE posts SET privacy = 'private' WHERE id = $1", [own.id]);
      await audience.save('post', own.id, people);
    } else if (pv !== 'except' && pv !== 'custom') {
      await audience.save('post', own.id, []);
    }
    const query = 'UPDATE posts SET content = $1, privacy = $2 WHERE id = $3 RETURNING *';
    const result = await pool.query(query, [typeof content === 'string' ? content : own.content, pv, own.id]);
    if (result.rows.length > 0) {
      res.json({ success: true, post: result.rows[0] });
    } else {
      res.status(403).json({ success: false, error: 'Unauthorized or post not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 👁 the people chosen for my post (only I can see this list)
app.get('/api/posts/:id/audience', async (req, res) => {
  try {
    const own = (await pool.query('SELECT id, privacy FROM posts WHERE id = $1 AND LOWER(user_email) = LOWER($2)', [parseInt(req.params.id, 10) || 0, req.authEmail || ''])).rows[0];
    if (!own) return res.status(404).json({ success: false });
    res.json({ success: true, privacy: own.privacy || 'public', people: await audience.list('post', own.id) });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  try {
    const owned = await pool.query('SELECT id FROM posts WHERE id = $1 AND LOWER(user_email) = LOWER($2)', [id, (email || '').trim()]);
    if (owned.rows.length > 0) {
      await cleanup.deletePostCompletely(owned.rows[0].id); // post, shares, comments, likes + photos/videos in storage
      if (typeof series !== 'undefined') series.postDeleted(owned.rows[0].id);
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
  const removeProfile = req.body.removeProfilePic === true || req.body.removeProfilePic === 'true';   // 🗑 delete the picture (no picture)
  const removeCover = req.body.removeCoverPic === true || req.body.removeCoverPic === 'true';
  try {
    let profileUrl = profilePicUrl || (req.files && req.files['profilePic'] ? req.files['profilePic'][0].path : null);
    let coverUrl = coverPicUrl || (req.files && req.files['coverPic'] ? req.files['coverPic'][0].path : null);
    const oldPics = await pool.query('SELECT profile_pic, cover_pic FROM users WHERE LOWER(email) = LOWER($1)', [email]);

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
    if (removeProfile && !profileUrl) query += ', profile_pic = NULL';
    if (removeCover && !coverUrl) query += ', cover_pic = NULL';
    query += ` WHERE LOWER(email) = LOWER($${idx}) RETURNING *`;
    params.push(email);

    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Account not found. Please log in again.' });   // nothing was changed: never say "done"
    console.log('[profile-pics]', String(email).slice(0, 3) + '…', profileUrl ? 'new picture' : '', coverUrl ? 'new cover' : '', removeProfile ? 'picture deleted' : '', removeCover ? 'cover deleted' : '');
    const oldUrls = [];
    const o = oldPics.rows[0];
    if (o) {
      if (profileUrl && o.profile_pic && o.profile_pic !== profileUrl) oldUrls.push(o.profile_pic);
      if (coverUrl && o.cover_pic && o.cover_pic !== coverUrl) oldUrls.push(o.cover_pic);
      if (removeProfile && !profileUrl && o.profile_pic) oldUrls.push(o.profile_pic);
      if (removeCover && !coverUrl && o.cover_pic) oldUrls.push(o.cover_pic);
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
  const { postId, email, replyToCommentId } = req.body;
  let content = String((req.body || {}).content || '').trim();
  // a comment can be a photo (with or without text): only a file of our own storage is accepted
  const rawMedia = String((req.body || {}).mediaUrl || '').trim();
  const mediaUrl = rawMedia && rawMedia.startsWith(storyMediaBase()) && !/[\s"'<>`\\]/.test(rawMedia) && rawMedia.length <= 500 ? rawMedia : null;
  try {
    if (!postId || (!content && !mediaUrl)) return res.status(400).json({ success: false, error: 'A comment needs a post and some text or a photo.' });
    if (!(await visibility.guardPost(req, res, postId))) return;
    bumpInterest(req.authEmail, postId, 4);
    const query = 'INSERT INTO comments (post_id, user_email, content, reply_to_id, media_url) VALUES ($1, $2, $3, $4, $5) RETURNING *';
    const result = await pool.query(query, [postId, email, content, replyToCommentId || null, mediaUrl]);
    if (!content && mediaUrl) content = '📷';
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
      if (req.authEmail) { try { interests.onProfile(req.authEmail, email); } catch (e) {} }   // 🏷️ opening a shop's / creator's profile says what I look for
    }

    const query = `
      SELECT u.*, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '100 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $2), TRUE)) AS is_online,
      CASE WHEN COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $2), TRUE) THEN u.last_active END AS last_seen,
      (SELECT COUNT(*) FROM follows f WHERE f.following_email = u.email) as followers_count,
      (SELECT COUNT(*) FROM follows f WHERE f.follower_email = u.email) as following_count,
      (SELECT COUNT(*) FROM posts p WHERE p.user_email = u.email) as posts_count,
      (SELECT COUNT(*) FROM follows f1 JOIN follows f2 ON f2.follower_email = f1.following_email AND f2.following_email = f1.follower_email WHERE f1.follower_email = u.email) as friends_count,
      (EXISTS(SELECT 1 FROM creator_applications ca WHERE LOWER(ca.user_email) = LOWER(u.email) AND ca.status = 'approved')) as is_creator,
      ${verify.tickSql('u')} AS is_verified,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = $2 AND f.following_email = u.email)) as is_following,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = u.email AND f.following_email = $2)) as is_followed_by
      FROM users u WHERE u.email = $1
    `;
    await verify.ensure().catch(() => {});
    const result = await pool.query(query, [email, viewerEmail]);
    if (result.rows.length > 0) {
      const u = result.rows[0];
      for (const internal of ['password', 'sessions_epoch', 'telegram_id', 'email_verified', 'notification_prefs', 'verified', 'verified_paused', 'verified_name', 'verified_at']) delete u[internal];
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
      // the lists (and their numbers) follow the owner's choice: public / friends / only me
      if (!isSelf) {
        for (const [col, cnt, flag] of [['friends_list_privacy', 'friends_count', 'friends_hidden'], ['followers_list_privacy', 'followers_count', 'followers_hidden'], ['following_list_privacy', 'following_count', 'following_hidden']]) {
          const pv = u[col] || 'public';
          if (pv === 'private' || (pv === 'friends' && !u.is_friend)) { u[cnt] = null; u[flag] = true; }
        }
      }
      if (!isSelf && viewerEmail) {
        const rs = await restrictedWith(viewerEmail);
        if (rs.has(String(u.email || email).toLowerCase())) { u.is_online = false; u.last_seen = null; }
      }
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
// restricted (either way) = no "active now" and no "active 5m ago" between the two people
async function restrictedWith(me) {
  try {
    const m = String(me || '').toLowerCase(); if (!m) return new Set();
    const r = await pool.query("SELECT peer AS e FROM chat_prefs WHERE user_email = $1 AND restricted = TRUE AND peer NOT LIKE 'group:%' UNION SELECT user_email AS e FROM chat_prefs WHERE peer = $1 AND restricted = TRUE", [m]);
    return new Set(r.rows.map((x) => String(x.e).toLowerCase()));
  } catch (e) { return new Set(); }
}

app.get('/api/follow-list', async (req, res) => {
  const { email, type } = req.query;
  try {
    let query = '';
    if (type === 'friends') {
      query = `
        SELECT u.email, u.first_name, u.last_name, u.profile_pic, u.last_active, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '100 seconds' AND COALESCE(u.show_active_status, TRUE)) AS is_online, TRUE AS is_following
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
    // somebody else's list: only when its owner allows it (public / friends / only me)
    const asker = String(req.authEmail || '').toLowerCase();
    if (asker && asker !== String(email || '').toLowerCase()) {
      const col = type === 'friends' ? 'friends_list_privacy' : (type === 'followers' ? 'followers_list_privacy' : 'following_list_privacy');
      const o = await pool.query(`SELECT COALESCE(${col}, 'public') AS pv,
        EXISTS (SELECT 1 FROM follows a JOIN follows b ON b.follower_email = a.following_email AND b.following_email = a.follower_email WHERE a.follower_email = users.email AND LOWER(a.following_email) = $2) AS fr
        FROM users WHERE email = $1`, [email, asker]).catch(() => ({ rows: [] }));
      const r0 = o.rows[0];
      if (r0 && (r0.pv === 'private' || (r0.pv === 'friends' && !r0.fr))) return res.status(403).json({ success: false, hidden: true, message: 'private', error: 'This list is private.' });
    }
    const result = await pool.query(query, type === 'friends' ? [email] : [email, email]);
    // fair: a person who hides their own active status does not see other people's either (like Messenger)
    if (req.authEmail) {
      const v = await pool.query('SELECT COALESCE(show_active_status, TRUE) AS on FROM users WHERE email = $1', [req.authEmail]).catch(() => ({ rows: [] }));
      if (v.rows[0] && v.rows[0].on === false) result.rows.forEach((r) => { r.is_online = false; r.last_active = null; });
      const rs = await restrictedWith(req.authEmail);
      if (rs.size) result.rows.forEach((r) => { if (rs.has(String(r.email).toLowerCase())) { r.is_online = false; r.last_active = null; } });
    }
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// my choice: who may see my lists of friends / followers / following
app.post('/api/profile/list-privacy', async (req, res) => {
  const me = req.authEmail; if (!me) return res.status(401).json({ success: false });
  const b = req.body || {}, ok = (v) => (['public', 'friends', 'private'].includes(v) ? v : null);
  try {
    const sets = [], vals = [me];
    for (const [k, col] of [['friends', 'friends_list_privacy'], ['followers', 'followers_list_privacy'], ['following', 'following_list_privacy']]) {
      const v = ok(b[k]); if (v) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
    }
    if (sets.length) await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE email = $1`, vals);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
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
      SELECT DISTINCT u.email, u.first_name, u.last_name, u.profile_pic, CASE WHEN COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE) THEN u.last_active END AS last_active, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '100 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online,
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
      
      SELECT u.email, u.first_name, u.last_name, u.profile_pic, CASE WHEN COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE) THEN u.last_active END AS last_active, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '100 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online,
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
    // conversations this person deleted "for me": hidden until a newer message arrives
    let rows = result.rows;
    try {
      const cp = await pool.query("SELECT peer, cleared_at FROM chat_prefs WHERE user_email = $1 AND cleared_at IS NOT NULL AND peer NOT LIKE 'group:%'", [String(req.authEmail || email || '').toLowerCase()]);
      if (cp.rows.length) {
        const m = new Map(cp.rows.map((x) => [x.peer, x.cleared_at]));
        rows = rows.filter((r) => { const c = m.get(String(r.email).toLowerCase()); return !c || (r.last_message !== 'Start a conversation' && new Date(r.last_time) > new Date(c)); });
      }
      // restricted either way (I restricted them, or they restricted me): no active status between us
      const hide = await restrictedWith(req.authEmail || email);
      if (hide.size) rows.forEach((r) => { if (hide.has(String(r.email).toLowerCase())) { r.is_online = false; r.last_active = null; } });
    } catch (e) { /* the table may not exist yet */ }
    res.json({ success: true, conversations: rows });
  } catch (err) {
    console.error("Error loading conversations:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Search posts / videos by words (the native search screen). Only what the viewer is allowed to see: public posts and their own.
app.get('/api/search-content', async (req, res) => {
  try {
    const me = req.authEmail || req.query.email || '';
    const kw = String(req.query.keyword || '').trim().slice(0, 80);
    if (kw.length < 1) return res.json({ success: true, posts: [] });
    const type = req.query.type === 'videos' ? 'videos' : 'posts';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const like = `%${kw.replace(/[\\%_]/g, '\\$&')}%`;
    const kwIds = req.authEmail ? await interests.onSearch(req.authEmail, kw) : await interests.searchIds(kw);   // 🏷️ "laptop" also finds posts labelled កុំព្យូទ័រយួរដៃ
    const vid = `(p.media_type = 'video' OR COALESCE(p.media_url,'') LIKE '%"type":"video"%')`;
    await country.ensure().catch(() => {});
    const r = await pool.query(`
      SELECT p.id, p.content, p.media_type, p.media_url, p.thumb_url, p.created_at, p.user_email, u.first_name, u.last_name, u.profile_pic,
             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS likes_count,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comments_count
      FROM posts p JOIN users u ON u.email = p.user_email
      WHERE p.shared_post_id IS NULL AND COALESCE(u.is_banned, FALSE) = FALSE
        AND (COALESCE(p.privacy,'public') = 'public' OR p.user_email = $1)
        AND p.user_email NOT IN (SELECT blocked_email FROM blocked_users WHERE blocker_email = $1 UNION SELECT blocker_email FROM blocked_users WHERE blocked_email = $1)
        AND (p.content ILIKE $2 OR COALESCE(p.ai_tags,'') ILIKE $2 OR p.id IN (SELECT post_id FROM post_kw WHERE kw_id = ANY($5::int[])))
        AND ${type === 'videos' ? vid : 'TRUE'}
      ORDER BY ${country.sameSql('$1', 'u')} DESC, p.created_at DESC LIMIT $3 OFFSET $4`, [me, like, limit, offset, kwIds]);
    res.json({ success: true, posts: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/search-users', async (req, res) => {
  const { email, keyword } = req.query;
  try {
    const query = `
      SELECT email, first_name, last_name, profile_pic, CASE WHEN COALESCE(show_active_status, TRUE) THEN last_active END AS last_active, (last_active IS NOT NULL AND last_active >= NOW() - INTERVAL '100 seconds' AND COALESCE(show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online 
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
      ORDER BY ${country.sameSql('$1', 'users')} DESC
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
    await country.ensure().catch(() => {});
    const result = await pool.query(query, [email, `%${likeSafe}%`, identities, e164 ? e164.slice(1) : '']);
    { const rs = await restrictedWith(req.authEmail); if (rs.size) result.rows.forEach((r) => { if (rs.has(String(r.email).toLowerCase())) { r.is_online = false; r.last_active = null; } }); }
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
    let result;
    try {
      result = await pool.query(query.replace("WHERE m.receiver_email = $1 AND m.is_read = FALSE",
        "WHERE m.receiver_email = $1 AND m.is_read = FALSE AND NOT EXISTS (SELECT 1 FROM chat_mutes cm WHERE cm.user_email = LOWER(m.receiver_email) AND cm.peer_email = LOWER(m.sender_email))" +
        " AND NOT EXISTS (SELECT 1 FROM chat_prefs cp WHERE cp.user_email = LOWER(m.receiver_email) AND cp.peer = LOWER(m.sender_email) AND (cp.restricted OR (cp.muted AND (cp.muted_until IS NULL OR cp.muted_until > NOW()))))"), [email]);
    } catch (e) { result = await pool.query(query, [email]); }
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
  // ?limit=N : only the newest N (the app opens a chat fast); &before=<id> : the N before that message (scrolling up)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 200);
  const before = parseInt(req.query.before, 10) || 0;
  try {
    let result, more = false;
    if (limit > 0) {
      result = await pool.query(`
        SELECT * FROM (
          SELECT * FROM messages
          WHERE ((sender_email = $1 AND receiver_email = $2) OR (sender_email = $2 AND receiver_email = $1)) AND ($3::int = 0 OR id < $3::int)
          ORDER BY created_at DESC, id DESC LIMIT $4
        ) t ORDER BY created_at ASC, id ASC`, [user1, user2, before, limit + 1]);
      if (result.rows.length > limit) { more = true; result.rows.shift(); }
    } else {
      const query = `
        SELECT * FROM messages 
        WHERE (sender_email = $1 AND receiver_email = $2) OR (sender_email = $2 AND receiver_email = $1)
        ORDER BY created_at ASC
      `;
      result = await pool.query(query, [user1, user2]);
    }
    // "Delete for me": the messages before that moment are not shown to this person any more
    const viewer = String(req.authEmail || user1 || '').toLowerCase();
    const other = viewer === String(user1 || '').toLowerCase() ? user2 : user1;
    const cl = await chatPrefs.clearedAt(viewer, other);
    if (cl) result.rows = result.rows.filter((r) => new Date(r.created_at) > new Date(cl));
    const hid = await chatPrefs.hiddenFor(viewer, 'dm', result.rows.map((r) => r.id));       // 🗑 single messages deleted for me
    if (hid.size) result.rows = result.rows.filter((r) => !hid.has(Number(r.id)));
    let reactions = {}, settings = null;
    try {
      reactions = await chatExtras.reactionsFor(result.rows.map((r) => r.id));
      settings = await chatExtras.settingsFor(user1, user2);
    } catch (e) { /* extras are optional; chat still loads */ }
    result.rows.forEach((r) => { r.reactions = reactions[r.id] || []; });
    res.json({ success: true, messages: result.rows, settings, more });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Real-Time Online / Offline Presence Endpoints
let presenceColReady = false;
app.post('/api/presence/ping', async (req, res) => {
  const email = req.authEmail || (req.body || {}).email;
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
    await pool.query("UPDATE users SET last_active = NOW() - INTERVAL '120 seconds' WHERE LOWER(email) = $1", [norm]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 🔐 Admin permissions by section (Super Admin decides; an admin with no list set yet keeps full access) ----
const ADMIN_SECTIONS = ['inbox', 'overview', 'audit', 'users', 'chats', 'content', 'live', 'sounds', 'ads', 'money', 'coins', 'party', 'challenges', 'stars', 'system'];
const ADMIN_LEVEL = { view: 1, edit: 2, approve: 3 };
let adminPermsReady = null, adminPermsCache = { at: 0, map: new Map() };
function ensureAdminPerms() {
  if (!adminPermsReady) adminPermsReady = pool.query('CREATE TABLE IF NOT EXISTS admin_perms (admin_email TEXT PRIMARY KEY, sections JSONB NOT NULL DEFAULT \'{}\', updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())').catch((e) => { adminPermsReady = null; throw e; });
  return adminPermsReady;
}
async function adminPermsOf(email) {
  await ensureAdminPerms();
  if (Date.now() - adminPermsCache.at > 30000) {
    const r = await pool.query('SELECT admin_email, sections FROM admin_perms');
    adminPermsCache = { at: Date.now(), map: new Map(r.rows.map((x) => [String(x.admin_email).toLowerCase(), x.sections || {}])) };
  }
  return adminPermsCache.map.get(String(email || '').toLowerCase()) || null;   // null = not limited
}
// which section a request belongs to, and how much right it needs (view / edit / approve money)
function adminNeed(path, body) {
  const p = path.replace(/^\/api\/admin\/?/, '');
  const first = p.split('/')[0];
  const sec = ({ inbox: 'inbox', dashboard: 'overview', overview: 'overview', audit: 'audit', system: 'system',
    users: 'users', 'ban-user': 'users', 'set-role': 'users', 'create-user': 'users', 'reset-password': 'users', notice: 'users',
    chat: 'chats', 'chat-reports': 'content', reports: 'content', posts: 'content', comments: 'content',
    live: 'live', sounds: 'sounds', ads: 'ads', 'ad-requests': 'ads',
    withdrawals: 'money', wallet: 'money', 'monetization-action': 'money', 'monetization-requests': 'money', 'monetization-rules': 'money',
    'creator-earning': 'money', 'creator-path': 'money', 'creator-rate': 'money', referrals: 'money',
    coins: 'coins', party: 'party', 'party-access': 'party', 'view-guard': 'money', challenges: 'challenges', stars: 'stars', 'app-config': 'system', copyright: 'content', keywords: 'content', 'tg-pay': 'money', 'ad-rules': 'ads', verify: 'users', 'ad-wallet': 'money' })[first];
  if (!sec) return null;
  const b = body || {}, act = String(b.action || '');
  const keys = Object.keys(b).filter((k) => !['adminEmail', 'adminKey', 'action'].includes(k));
  const FILTER = ['status', 'target', 'q', 'query', 'page', 'limit', 'offset', 'before', 'from', 'to', 'mode', 'kind', 'type', 'days', 'search', 'sort', 'user', 'id', 'email', 'targetEmail', 'filter'];
  const READ_PATHS = /^(inbox|dashboard|overview|audit|system$|users\/search|users\/detail|posts\/search|comments\/search|chat\/conversations|chat\/thread|chat\/status|live\/requests|live$|ads\/list|ads\/report|ad-requests\/list|withdrawals$|monetization-requests|referrals$|sounds$)/;
  const MONEY = /^(withdrawals\/decide|withdrawals\/reissue|wallet\/credit|referrals\/decide|ad-requests\/activate)/.test(p)
    || (sec === 'coins' && ['decide', 'adjust'].includes(act)) || (sec === 'stars' && act === 'bonus') || (sec === 'challenges' && act === 'pay');
  if (MONEY) return { sec, level: 'approve' };
  const single = ['coins', 'party', 'party-access', 'view-guard', 'challenges', 'stars', 'chat-reports', 'app-config', 'copyright', 'keywords', 'tg-pay', 'ad-rules', 'verify', 'ad-wallet'].includes(first);
  const read = single ? (['list', 'people', 'days', 'doc', 'search', 'detail'].includes(act) || (first === 'keywords' && act === 'posts') || (!act && keys.every((k) => FILTER.includes(k))))
    : READ_PATHS.test(p) && (p !== 'system' || keys.length === 0) && (first !== 'sounds' || keys.length === 0) && (first !== 'live' || p !== 'live' || keys.length === 0);
  return { sec, level: read ? 'view' : 'edit' };
}
app.use('/api/admin', async (req, res, next) => {
  try {
    const p = '/api/admin' + req.path;
    if (p === '/api/admin/my-perms' || p === '/api/admin/perms') return next();     // they check by themselves
    const email = String((req.body && req.body.adminEmail) || req.authEmail || '').trim().toLowerCase();
    if (!email || SUPER_ADMIN_EMAILS.includes(email)) return next();
    const u = (await pool.query('SELECT role FROM users WHERE LOWER(email) = $1', [email])).rows[0];
    if (!u || u.role !== 'admin') return next();                                     // super admins: everything; not an admin: the route says no
    const perms = await adminPermsOf(email);
    if (!perms) return next();                                                       // not limited yet
    const need = adminNeed(p, req.body);
    if (!need || need.sec === 'inbox') return next();
    const have = ADMIN_LEVEL[perms[need.sec]] || 0;
    if (have >= ADMIN_LEVEL[need.level]) return next();
    return res.status(403).json({ success: false, code: 'perm', section: need.sec, need: need.level,
      error: have ? 'You can only ' + (have === 1 ? 'look at' : 'change') + ' this section. Ask a Super Admin for more rights.' : 'You do not have the right to use this section. Ask a Super Admin.' });
  } catch (e) { console.error('[admin perms]', e.message); next(); }
});
// my own rights (the Admin page hides what I can not use)
app.post('/api/admin/my-perms', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const perms = a.isSuperAdmin ? null : await adminPermsOf(a.adminEmail);
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, limited: !!perms, sections: perms || {}, all: ADMIN_SECTIONS });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not load.' }); }
});
// 👮 Super Admin: every admin's rights by section
app.post('/api/admin/perms', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
    await ensureAdminPerms();
    if (b.set && typeof b.set === 'object') {
      const who = String(b.set.target || '').trim().toLowerCase();
      if (!who) return res.status(400).json({ success: false, error: 'Choose an admin.' });
      if (b.set.unlimited === true) {
        await pool.query('DELETE FROM admin_perms WHERE admin_email = $1', [who]);
        audit(a.adminEmail, 'admin-perms', who, 'all sections (not limited)');
      } else {
        const out = {};
        for (const [k, v] of Object.entries(b.set.sections || {})) if (ADMIN_SECTIONS.includes(k) && ADMIN_LEVEL[v]) out[k] = v;
        await pool.query(`INSERT INTO admin_perms (admin_email, sections, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
          ON CONFLICT (admin_email) DO UPDATE SET sections = $2, updated_by = $3, updated_at = NOW()`, [who, JSON.stringify(out), a.adminEmail]);
        audit(a.adminEmail, 'admin-perms', who, Object.entries(out).map(([k, v]) => k + ':' + v).join(', ') || 'no section');
      }
      adminPermsCache.at = 0;
    }
    const admins = (await pool.query(`SELECT LOWER(u.email) AS email, u.first_name, u.last_name, u.role, p.sections, p.updated_by, p.updated_at
      FROM users u LEFT JOIN admin_perms p ON p.admin_email = LOWER(u.email) WHERE u.role IN ('admin', 'super_admin') ORDER BY u.role DESC, u.first_name LIMIT 200`)).rows;
    res.json({ success: true, admins: admins.map((x) => Object.assign(x, { super: x.role === 'super_admin' || SUPER_ADMIN_EMAILS.includes(x.email), limited: !!x.sections })), sections: ADMIN_SECTIONS });
  } catch (err) { console.error('[admin perms] list:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

const push = require('./push')({ app, pool });                 // phone notifications (Firebase) - does nothing until FIREBASE_SERVICE_ACCOUNT is set
const chatExtras = require('./chat-extras')({ app, pool, cleanup, extractMediaUrls, mediaBase: () => storyMediaBase(), push, onGroupMessage: (from, members, text) => party.chatGrant(from, members, text), setting: (k, d) => ruleNum(k, d),
  restrictedBy: (to, from) => chatPrefs.isRestricted(to, from), hiddenFor: (me, kind, ids) => chatPrefs.hiddenFor(me, kind, ids) });   // a person I restricted: their calls do not ring
const chatPrefs = require('./chat-prefs')({ app, pool, cleanup, extractMediaUrls });
const series = require('./series')({ app, pool, onThumb: (id, url, me) => checkCover(id, url, me) });
// 🖼️ a cover picture chosen by the owner: the AI looks at it; 18+ / shocking → back to the automatic picture (and the owner is told)
async function checkCover(id, url, me) {
  try {
    if (!process.env.GEMINI_API_KEY) return;
    const frames = await interests.framesOfUrls([url]);
    if (!frames.length) return;
    const ans = await interests.geminiJson('This picture is the cover of a video on a family-friendly social app in Cambodia. Is it sexual / nudity, shocking violence or gore? Answer only JSON: {"bad": true|false, "why": "few words"}', frames);
    if (ans && ans.bad === true) {
      await pool.query('UPDATE posts SET thumb_url = NULL WHERE id = $1 AND thumb_url = $2', [id, url]);       // NULL = the automatic picture is made again
      sendAdminNotice('CamFeed', me, '🖼️ CamFeed បានប្ដូររូបក្របវីដេអូរបស់អ្នក ទៅជារូបស្វ័យប្រវត្តិវិញ ព្រោះរូបនោះមិនសមរម្យ។', 'admin_notice').catch(() => {});
    }
  } catch (e) { console.error('[cover] check:', e.message); }
}
const tgPay = require('./tg-pay')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a), baseUrl: () => process.env.PUBLIC_BASE_URL || 'https://camfeedkh.com',
  onDecide: (...a) => onPaymentDecision(...a) });   // 💰 the owner's ✅ / ❌ on Telegram
const country = require('./country')({ pool });
const adWallet = require('./ad-wallet')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a), baseUrl: () => process.env.PUBLIC_BASE_URL || 'https://camfeedkh.com',
  tgNotify: (lines) => tgPay.notify(lines), tgAsk: (k, id, lines, labels) => tgPay.ask(k, id, lines, labels), sendNotice: (from, to, text) => sendAdminNotice(from, to, text, 'admin_notice'), creditEnsure: () => adCreditEnsure(), balanceOf: (e) => adCreditOf(e), safeUrl: (u) => security.safeUrl(u) });   // 💳 the ad wallet (ABA PayWay)
const verify = require('./verify')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a), sendNotice: (from, to, text) => sendAdminNotice(from, to, text, 'admin_notice') });   // ✔ official accounts, 🏪 business accounts, name rules   // 🌏 each person's country: own country first in Feed / Reels / search; ads per country
const mediaReacts = require('./media-reacts')({ app, pool, visibility });   // 👍 💬 on one picture of an album
const adRules = require('./ad-rules')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a), interests: { framesOfUrls: (...a) => interests.framesOfUrls(...a), geminiJson: (...a) => interests.geminiJson(...a), lastAiError: () => interests.lastAiError() } });   // 📜 ⛔ / 🔞 rules + the AI check
const interests = require('./interests')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a), pubMedia, videoSecs });   // 🏷️ keywords: posts ↔ people ↔ ads   // 📚 videos grouped on a profile ("ស្នេហ៍អមតៈ" · ភាគ 1, 2, 3 …)
// 🚩 reports from chats (a message / picture / person) → Admin › 🚩 Reports
const chatReports = require('./chat-reports')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a),
  sendNotice: (from, to, text) => sendAdminNotice(from, to, text, 'admin_notice'), cleanup, extractMediaUrls, ensureChat: () => chatExtras.ensureSchema() });   // pin / archive / mute / restrict / delete chat / message requests
// ⭐ CamFeed Stars (Party Room hosts): applications with ID + selfie, hours, a bigger gift share, monthly bonus (Admin pays)
const appConfig = require('./app-config');
const feedMix = require('./feed-mix');
const audience = require('./audience');
appConfig.install({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a) });
const chatFiles = require('./chat-files')({ app, pool });   // 📎 files in chat
const stars = require('./stars')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a),
  sendNotice: (from, to, text) => sendAdminNotice(from, to, text, 'admin_notice') });
// ©️ copyright: claims ("this uses my work"), fingerprints that notice copies of other people's posts, strikes → no earnings
const copyright = require('./copyright')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a),
  sendNotice: (from, to, text) => sendAdminNotice(from, to, text, 'admin_notice'), pubMedia: (r) => pubMedia(r), cleanup, setting: (k, d) => ruleNum(k, d) });
const party = require('./party')({ app, pool, publicIds, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a), framesOf: (emails) => coins.framesOf(emails), badgesOf: (emails) => coins.badgesOf(emails), starsOf: (emails) => stars.starsOf(emails) });
const viewGuard = require('./view-guard')({ app, pool, guardPost: (req, res, id) => visibility.guardPost(req, res, id), adminGate, audit, sendAdminNotice: (...a) => sendAdminNotice(...a) });   // 🔍 real views only (and the paid ones)
const coins = require('./coins')({ app, pool, publicIds, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a),
  sendNotice: (from, to, text) => sendAdminNotice(from, to, text, 'admin_notice'), walletCents: (e) => walletCents(e), starShare: (e) => stars.starShare(e), starsOf: (e) => stars.starsOf(e),
  onTopup: (id, t) => pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)', [t.email]).then((r) => {
    const n = r.rows[0] ? ((r.rows[0].first_name || '') + ' ' + (r.rows[0].last_name || '')).trim() : '';
    return tgPay.ask('coin', id, ['🪙 ទិញកាក់ C' + id + ' · $' + Number(t.usd).toFixed(2) + ' → ' + t.coins + ' កាក់', '👤 ' + (n || '—'), '🏦 ' + t.method + (t.ref ? ' · 🧾 ' + t.ref : ''), t.receipt && !security.safeUrl(t.receipt) ? '🖼️ ' + t.receipt : '']
      .filter(Boolean), undefined, security.safeUrl(t.receipt || '') || undefined);
  }).catch(() => {}) });   // 🪙 coins + 🎁 gifts   // 🎉 Party Room (voice rooms, LiveKit)
const challenges = require('./challenges')({ app, pool, adminGate: (req, res) => adminGate(req, res), audit: (...a) => audit(...a),
  sendNotice: (from, to, text) => sendAdminNotice(from, to, text, 'admin_notice'), xpNowOf: (e) => coins.xpNowOf(e), badgesOf: (e) => coins.badgesOf(e),
  // the cheapest price of one coin (cents) and the receiver's share of a gift (%) — so a challenge can never pay more than CamFeed keeps
  coinMoney: async () => { const s = await coins.settings(); const st = await stars.settings().catch(() => null); const c = (s.packs || []).map((p) => (Number(p.usd) * 100) / Number(p.web)).filter((x) => x > 0);
    return { centsPerCoin: c.length ? Math.min(...c) : 1, share: Math.max(Number(s.share) || 0, st && st.on ? Number(st.share) || 0 : 0), coinCents: 1 }; } });   // 🎯 challenges
if (push.setMessageFilter) push.setMessageFilter((to, from, peerKey) => chatPrefs.shouldNotify(to, from, peerKey));

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

    const limited = await chatExtras.chatAllowed(sender, receiver);
    if (limited) return chatExtras.deny(res, limited);

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

    // A shared place: the link sits inside the text (media links must come from our own storage), the numbers must be real coordinates.
    if (messageType === 'location') {
      const loc = /^📍[^\n]{0,60}\nhttps:\/\/www\.google\.com\/maps\/search\/\?api=1&query=(-?\d{1,3}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?)$/.exec(String(req.body.message || ''));
      if (!loc || Math.abs(parseFloat(loc[1])) > 90 || Math.abs(parseFloat(loc[2])) > 180) {
        return res.status(400).json({ success: false, error: 'Invalid location' });
      }
      mediaUrl = null;
    }

    const message = req.body.message || defaultMsg;

    await chatExtras.ensureSchema();
    let replyTo = parseInt(req.body.reply_to, 10) || null;
    if (replyTo) {
      const rr = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND ((LOWER(sender_email)=LOWER($2) AND LOWER(receiver_email)=LOWER($3)) OR (LOWER(sender_email)=LOWER($3) AND LOWER(receiver_email)=LOWER($2)))', [replyTo, sender, receiver]);
      if (!rr.rows.length) replyTo = null;
    }
    if (['system', 'call'].includes(messageType)) messageType = 'text';   // only the server may write these
    let msgText = message;
    if (messageType === 'file') {                                          // 📎 a file: only from our own storage (files/ folder)
      const f = chatFiles.checkFileMessage(message, mediaUrl);
      if (!f) return res.status(400).json({ success: false, error: 'Invalid file' });
      msgText = f.message; mediaUrl = f.mediaUrl;
    }
    const query = `
      INSERT INTO messages (sender_email, receiver_email, message, media_url, message_type, is_read, reply_to) 
      VALUES ($1, $2, $3, $4, $5, FALSE, $6) 
      RETURNING *
    `;
    const result = await pool.query(query, [sender, receiver, msgText, mediaUrl, messageType, replyTo]);
    if (String(msgText || '').startsWith('PARTY_ROOM:')) await party.chatGrant(sender, [receiver], msgText);   // 🔐 a private room's card lets the receiver in
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
const NAME_CHANGE_COOLDOWN_DAYS = 15;     // default; Admin > System > App settings can change it (NAME_CHANGE_DAYS)

app.put('/api/settings/name', async (req, res) => {
  const email = req.authEmail;
  const firstName = String((req.body && req.body.firstName) || '').trim();
  const lastName = String((req.body && req.body.lastName) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const km = String(req.get('accept-language') || '').toLowerCase().startsWith('km') || req.body && req.body.lang === 'km';
  try {
    if (!firstName) {
      return res.status(400).json({ success: false, message: km ? 'សូមវាយនាមខ្លួន និងនាមត្រកូល។' : 'First and last name are required.' });
    }
    {
      const bad = await verify.checkName(email, firstName, lastName);    // ✔ / 🏪 rules: one word only for a business account, reserved names, official names
      if (bad) {
        const KM = { 'This name can not be used.': 'ឈ្មោះនេះមិនអាចប្រើបានទេ។', 'This is the name of an official account. Please choose another name.': 'នេះជាឈ្មោះរបស់គណនីផ្លូវការ។ សូមជ្រើសឈ្មោះផ្សេង។' };
        return res.status(400).json({ success: false, message: km ? (KM[bad] || 'សូមវាយនាមខ្លួន និងនាមត្រកូល។ (ឈ្មោះមួយពាក្យ បានតែគណនីអាជីវកម្ម)') : bad });
      }
    }
    const cur = await pool.query('SELECT name_changed_at, password FROM users WHERE email = $1', [email]);
    const row = cur.rows[0];
    // the owner of the account must type the password (a phone left unlocked can not rename the account)
    const check = row ? await auth.verifyPassword(password, row.password) : { ok: false };
    if (!check.ok) return res.status(400).json({ success: false, code: 'bad_password', message: km ? 'ពាក្យសម្ងាត់មិនត្រឹមត្រូវ។' : 'The password is incorrect.' });
    const days = ruleNum('NAME_CHANGE_DAYS', NAME_CHANGE_COOLDOWN_DAYS);
    const last = row && row.name_changed_at;
    if (last && days > 0) {
      const daysSince = (Date.now() - new Date(last).getTime()) / 86400000;
      if (daysSince < days) {
        const left = Math.ceil(days - daysSince);
        const when = new Date(new Date(last).getTime() + days * 86400000).toISOString().slice(0, 10);
        return res.status(400).json({ success: false, code: 'too_soon', daysLeft: left, nextDate: when,
          message: km ? `អ្នកអាចប្ដូរឈ្មោះម្ដងទៀតនៅថ្ងៃ ${when} (នៅសល់ ${left} ថ្ងៃ)។` : `You can change your name again on ${when} (${left} day(s) left).` });
      }
    }
    const upd = await pool.query(
      'UPDATE users SET first_name = $1, last_name = $2, name_changed_at = NOW() WHERE email = $3 RETURNING *',
      [firstName, lastName, email]);
    const nu = upd.rows[0]; if (nu) delete nu.password;          // never send the password hash back
    verify.afterRename(email);                                     // ✔ pauses until CamFeed checks the new name
    res.json({ success: true, user: nu });
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
  try { interests.bumpPost(email, postId, delta); } catch (e) {}   // 🏷️ the post's keywords too
}

// ---------------------------------------------------------------------------
// Settings page: privacy switches, blocked people, notification choices, log out everywhere, download my data
// ---------------------------------------------------------------------------
const PRIVACY_FIELDS = ['phone_privacy', 'email_privacy', 'location_privacy', 'birthdate_privacy', 'relationship_privacy', 'gender_privacy', 'work_privacy'];
const NOTIFICATION_GROUPS = { reactions: ['reaction', 'comment_reaction'], comments: ['comment', 'reply'], follows: ['follow'], shares: ['share'], tags: ['tag'], messages: [] };   // messages = the phone notification for new chat messages

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

// ---- Tag review: a user may require approval before a tag shows on their profile ----
app.get('/api/settings/tags', async (req, res) => {
  try {
    const r = await pool.query('SELECT tag_review FROM users WHERE email = $1', [req.authEmail]);
    res.json({ success: true, review: !!(r.rows[0] && r.rows[0].tag_review) });
  } catch (e) { res.status(500).json({ success: false, message: 'Could not load.' }); }
});
app.put('/api/settings/tags', async (req, res) => {
  try {
    if (typeof (req.body || {}).review !== 'boolean') return res.status(400).json({ success: false, message: 'Invalid value.' });
    await pool.query('UPDATE users SET tag_review = $1 WHERE email = $2', [req.body.review, req.authEmail]);
    res.json({ success: true, review: req.body.review });
  } catch (e) { res.status(500).json({ success: false, message: 'Could not save.' }); }
});
// Posts waiting for my approval (stay here until I decide)
app.get('/api/tags/pending', async (req, res) => {
  try {
    const me = String(req.authEmail || '').toLowerCase();
    const r = await pool.query(`SELECT p.id, p.content, p.media_type, p.media_url, p.thumb_url, p.created_at, u.first_name, u.last_name, u.profile_pic, u.email AS author_email
      FROM posts p JOIN users u ON u.email = p.user_email
      WHERE $1 = ANY(string_to_array(COALESCE(p.tag_pending,''), ',')) ORDER BY p.created_at DESC LIMIT 100`, [me]);
    res.json({ success: true, posts: r.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'Could not load.' }); }
});
async function resolveTag(req, res, accept) {
  try {
    const me = String(req.authEmail || '').toLowerCase();
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT tagged_emails, tag_pending FROM posts WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Not found.' });
    const split = (x) => String(x || '').split(',').filter(Boolean);
    const pend = split(r.rows[0].tag_pending).filter((x) => x !== me);
    let ok = split(r.rows[0].tagged_emails);
    if (accept && !ok.includes(me)) ok.push(me);
    await pool.query('UPDATE posts SET tagged_emails = $1, tag_pending = $2 WHERE id = $3', [ok.join(','), pend.join(','), id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: 'Could not save.' }); }
}
app.post('/api/tags/:id/accept', (req, res) => resolveTag(req, res, true));
app.post('/api/tags/:id/decline', (req, res) => resolveTag(req, res, false));
// Remove my own tag from a post
app.post('/api/tags/:id/remove', async (req, res) => {
  try {
    const me = String(req.authEmail || '').toLowerCase();
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT tagged_emails FROM posts WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).json({ success: false });
    const ok = String(r.rows[0].tagged_emails || '').split(',').filter((x) => x && x !== me);
    await pool.query('UPDATE posts SET tagged_emails = $1 WHERE id = $2', [ok.join(','), id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
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
app.post('/api/logout', async (req, res) => {
  try { if (req.sid) await authCore.revokeSession(req.authEmail, req.sid); } catch (err) { /* the phone forgets the login anyway */ }
  res.json({ success: true });
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
        FROM likes l JOIN posts p ON p.id = l.post_id JOIN users u ON u.email = p.user_email WHERE l.user_email = $1 AND ${audience.postVisibleSql('p', '$1')}
        ORDER BY ${order === 'time' ? 'l.created_at DESC NULLS LAST' : 'l.post_id DESC'} LIMIT $2 OFFSET $3`;
      try { rows = (await pool.query(base('time'), [who, limit, offset])).rows; }
      catch (e) { if (e && e.code === '42703') rows = (await pool.query(base('id'), [who, limit, offset])).rows; else throw e; }
    } else if (type === 'comments') {
      rows = (await pool.query(`SELECT c.id, c.post_id, c.content, c.reply_to_id, c.created_at AS at, p.user_email AS author_email, u.first_name AS author_first, u.last_name AS author_last
        FROM comments c JOIN posts p ON p.id = c.post_id JOIN users u ON u.email = p.user_email WHERE c.user_email = $1 AND ${audience.postVisibleSql('p', '$1')} ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`, [who, limit, offset])).rows;
    } else if (type === 'shares') {
      rows = (await pool.query(`SELECT p.id, p.content AS caption, p.created_at AS at, o.id AS post_id, o.content, o.media_type, o.user_email AS author_email, u.first_name AS author_first, u.last_name AS author_last
        FROM posts p JOIN posts o ON o.id = p.shared_post_id JOIN users u ON u.email = o.user_email WHERE p.user_email = $1 AND p.shared_post_id IS NOT NULL AND ${audience.postVisibleSql('o', '$1')} ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [who, limit, offset])).rows;
    } else if (type === 'posts') {
      rows = (await pool.query(`SELECT id, content, media_type, privacy, created_at AS at FROM posts WHERE user_email = $1 AND shared_post_id IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [who, limit, offset])).rows;
    } else return res.status(400).json({ success: false, message: 'Unknown activity.' });
    res.json({ success: true, type, items: rows, hasMore: rows.length === limit });
  } catch (err) {
    console.error('Activity error:', err.message);
    res.status(500).json({ success: false, message: 'Could not load.' });
  }
});

// ---- "People you may know": people who follow me, then people with the most mutual connections (with up to 3 of their pictures),
// plus a share chosen by chance (Admin 🧩 people.randomPct, default 15 %) so new people are met too. Never everybody.
app.get('/api/people-suggestions', async (req, res) => {
  const me = req.authEmail; if (!me) return res.json({ success: true, people: [] });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 40);
  const pct = Math.max(0, Math.min(100, Number(((appConfig.cfg() || {}).people || {}).randomPct ?? 15)));
  const nRandom = pct > 0 ? Math.max(1, Math.round(limit * pct / 100)) : 0;
  const notMine = (withDismissed) => `u.email <> $1 AND COALESCE(u.is_banned, FALSE) = FALSE
      AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = $1 AND f.following_email = u.email)
      AND u.email NOT IN (SELECT blocked_email FROM blocked_users WHERE blocker_email = $1 UNION SELECT blocker_email FROM blocked_users WHERE blocked_email = $1)
      ${withDismissed ? 'AND u.email NOT IN (SELECT dismissed_email FROM dismissed_suggestions WHERE user_email = $1)' : ''}`;
  const known = (withDismissed) => `
    WITH mine AS (SELECT following_email AS e FROM follows WHERE follower_email = $1),
    cand AS (
      SELECT f.following_email AS cand_email, f.follower_email AS via FROM follows f WHERE f.follower_email IN (SELECT e FROM mine)
      UNION
      SELECT f.follower_email, f.following_email FROM follows f WHERE f.following_email IN (SELECT e FROM mine)
    ),
    m AS (SELECT cand_email, COUNT(DISTINCT via) AS mutual FROM cand WHERE cand_email <> $1 GROUP BY cand_email)
    SELECT u.email, u.first_name, u.last_name, u.profile_pic, COALESCE(m.mutual, 0)::int AS mutual,
           EXISTS (SELECT 1 FROM follows fm WHERE fm.follower_email = u.email AND fm.following_email = $1) AS follows_me,
           (SELECT COALESCE(json_agg(json_build_object('pic', x.profile_pic, 'name', x.first_name)), '[]'::json) FROM (SELECT DISTINCT mu.email, mu.profile_pic, mu.first_name FROM cand c2 JOIN users mu ON mu.email = c2.via WHERE c2.cand_email = u.email LIMIT 3) x) AS mutual_people
    FROM users u LEFT JOIN m ON m.cand_email = u.email
    WHERE ${notMine(withDismissed)}
      AND (m.mutual IS NOT NULL OR EXISTS (SELECT 1 FROM follows fm3 WHERE fm3.follower_email = u.email AND fm3.following_email = $1))
    ORDER BY EXISTS (SELECT 1 FROM follows fm2 WHERE fm2.follower_email = u.email AND fm2.following_email = $1) DESC, ${country.sameSql('$1', 'u')} DESC, m.mutual DESC NULLS LAST, RANDOM()
    LIMIT $2`;
  // by chance: people active in the last 30 days first (a real person more likely to answer), never someone already in the list
  const chance = (withDismissed) => `
    SELECT u.email, u.first_name, u.last_name, u.profile_pic, 0 AS mutual, FALSE AS follows_me, '[]'::json AS mutual_people, TRUE AS by_chance
    FROM users u
    WHERE ${notMine(withDismissed)} AND NOT (u.email = ANY($3::text[]))
    ORDER BY ${country.sameSql('$1', 'u')} DESC, (u.last_active IS NOT NULL AND u.last_active > NOW() - INTERVAL '30 days') DESC, (COALESCE(u.profile_pic, '') <> '') DESC, RANDOM()
    LIMIT $2`;
  const run = async (sql, args) => {
    try { return (await pool.query(sql(true), args)).rows; }
    catch (e) { if (e.code === '42P01') return (await pool.query(sql(false), args)).rows; throw e; }
  };
  try {
    await country.ensure().catch(() => {});
    const a = await run(known, [me, limit - nRandom]);
    const b = await run(chance, [me, limit - a.length, a.map((x) => x.email)]);
    // the chance ones are spread through the list (not all at the end)
    const out = [...a], step = b.length ? Math.max(2, Math.floor((a.length + b.length) / b.length)) : 0;
    b.forEach((x, i) => out.splice(Math.min(out.length, (i + 1) * step - 1), 0, x));
    for (const p of out) {
      p.mutual_people = (Array.isArray(p.mutual_people) ? p.mutual_people : []).map((x) => ({ pic: x.pic || '', name: x.name || '' }));
      p.mutual_pics = p.mutual_people.map((x) => x.pic).filter(Boolean);   // older apps read this
    }
    res.json({ success: true, people: out });
  } catch (err) {
    console.error('people-suggestions:', err.message);
    res.json({ success: true, people: [] });
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
    audit(adminEmail, 'set-role', targetEmail, safeRole);
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
    audit(adminEmail, ban ? 'ban-user' : 'unban-user', targetEmail, '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---------------------------------------------------------------------------
// Accounts made / fixed BY HAND by an admin (for people who contact us on Telegram while phone codes are paused)
// ---------------------------------------------------------------------------
function makeTempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';            // no look-alike letters (l, 1, o, 0, i)
  const bytes = require('crypto').randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);

app.post('/api/admin/create-user', async (req, res) => {
  const b = req.body || {};
  try {
    const access = await verifyAdminAccess(b.adminEmail, b.adminKey);
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });
    const firstName = cleanName(b.firstName), lastName = cleanName(b.lastName);
    if (!firstName || !lastName) return res.status(400).json({ success: false, error: 'Please enter the first and the last name.' });
    const gender = ['Male', 'Female', 'Other'].includes(b.gender) ? b.gender : 'Male';
    const country = cleanName(b.country) || 'Cambodia';
    const birth = normalizeBirthdate(b.birthdate || '');
    if (birth === undefined) return res.status(400).json({ success: false, error: 'Invalid date of birth.' });
    let password = String(b.password || '');
    const generated = !password;
    if (generated) password = makeTempPassword();
    if (password.length < 6 || password.length > 128) return res.status(400).json({ success: false, error: 'The password needs 6 to 128 characters.' });

    let email, phoneE164 = null, login;
    if (String(b.kind) === 'phone') {
      phoneE164 = normalizePhone(b.phone, country);
      if (!phoneE164) return res.status(400).json({ success: false, error: 'That phone number is not valid. For a number outside Cambodia choose its country or start with + and the country code.' });
      if (await findAccountEmail(pool, phoneE164)) return res.status(409).json({ success: false, error: 'This phone number already has an account.' });
      email = phoneEmail(phoneE164); login = phoneE164;
    } else {
      email = String(b.loginEmail || '').trim();
      if (!EMAIL_RE.test(email) || email.length > 254 || isTelegramAddress(email)) return res.status(400).json({ success: false, error: 'Please enter a valid e-mail address (for example name@gmail.com).' });
      const dup = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
      if (dup.rows.length) return res.status(409).json({ success: false, error: 'This e-mail already has an account.' });
      login = email;
    }
    const hashed = await auth.hashPassword(password);
    const ins = await pool.query(
      `INSERT INTO users (email, password, first_name, last_name, birthdate, gender, country, bio, phone_privacy, email_privacy, role, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'private', 'private', 'user', $8) RETURNING email`,
      [email, hashed, firstName, lastName, birth, gender, country, phoneE164]);
    if (phoneE164 === null) pool.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [ins.rows[0].email]).catch(() => {});
    console.log('[admin] an admin created an account by hand (' + (phoneE164 ? 'phone' : 'e-mail') + ')');
    audit(b.adminEmail, 'create-account', login, kind_for_audit(phoneE164));
    res.status(201).json({ success: true, login, kind: phoneE164 ? 'phone' : 'email', name: `${firstName} ${lastName}`, tempPassword: generated ? password : undefined });
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ success: false, error: 'This login already has an account.' });
    console.error('[admin] create-user error:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/reset-password', async (req, res) => {
  const b = req.body || {};
  try {
    const access = await verifyAdminAccess(b.adminEmail, b.adminKey);
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });
    const ident = String(b.identifier || '').trim();
    if (!ident) return res.status(400).json({ success: false, error: 'Please enter the phone number or e-mail of the account.' });
    let stored = null;
    if (ident.includes('@')) {
      const r0 = await pool.query('SELECT email FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [ident]);
      stored = r0.rows[0] ? r0.rows[0].email : null;
    } else {
      const e164 = normalizePhone(ident, b.country);
      stored = e164 ? await findAccountEmail(pool, e164) : null;
    }
    if (!stored) return res.status(404).json({ success: false, error: 'No account was found for that phone number / e-mail.' });
    const t = await pool.query('SELECT email, role FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [stored]);
    const target = t.rows[0];
    // only a Super Admin may change the password of an admin
    if ((target.role === 'admin' || target.role === 'super_admin' || SUPER_ADMIN_EMAILS.includes(String(target.email).toLowerCase())) && !access.isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only a Super Admin can reset the password of an admin.' });
    }
    let password = String(b.newPassword || '');
    const generated = !password;
    if (generated) password = makeTempPassword();
    if (password.length < 6 || password.length > 128) return res.status(400).json({ success: false, error: 'The password needs 6 to 128 characters.' });
    await pool.query('UPDATE users SET password = $1 WHERE email = $2', [await auth.hashPassword(password), target.email]);
    authCore.invalidate(target.email);
    try { await authCore.revokeAll(target.email); } catch (e) { /* the old tokens carry the old password and stop working anyway */ }
    console.log('[admin] an admin reset a password by hand');
    audit(b.adminEmail, 'reset-password', target.email, generated ? 'temporary password' : 'password typed by admin');
    res.json({ success: true, login: ident, tempPassword: generated ? password : undefined });
  } catch (err) {
    console.error('[admin] reset-password error:', err.message);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});


// ---------------------------------------------------------------------------
// Admin tools: audit log, overview, user search / details / edit, content search, system check
// ---------------------------------------------------------------------------
function audit(adminEmail, action, target, details) {
  pool.query('INSERT INTO admin_audit (admin_email, action, target, details) VALUES ($1, $2, $3, $4)',
    [String(adminEmail || '').slice(0, 254), String(action).slice(0, 60), String(target === undefined || target === null ? '' : target).slice(0, 254), String(details || '').slice(0, 500)]).catch(() => {});
}
const kind_for_audit = (phoneE164) => (phoneE164 ? 'phone account' : 'e-mail account');
async function adminGate(req, res) {
  const b = req.body || {};
  const access = await verifyAdminAccess(b.adminEmail, b.adminKey);
  if (!access.allowed) { res.status(403).json({ success: false, error: access.error }); return null; }
  return Object.assign({}, access, { adminEmail: String(b.adminEmail || '').trim() });
}
const clampInt = (v, d, lo, hi) => Math.min(Math.max(parseInt(v, 10) || d, lo), hi);
const likeEsc = (v) => String(v || '').replace(/[\\%_]/g, '\\$&');
const countOf = async (sql) => { try { const r = await pool.query(sql); return Number(r.rows[0] && Object.values(r.rows[0])[0]) || 0; } catch (e) { return null; } };
const seriesOf = async (sql) => { try { return (await pool.query(sql)).rows.map((r) => ({ day: r.day, n: Number(r.n) || 0 })); } catch (e) { return []; } };
const isAdminRole = (role, email) => role === 'admin' || role === 'super_admin' || SUPER_ADMIN_EMAILS.includes(String(email || '').toLowerCase());
const loginKind = (email) => (isTelegramAddress(email) || /^\+?\d{8,15}$/.test(String(email)) ? 'phone' : 'email');
const loginContact = (u) => {
  const e = String(u.email || '');
  if (isTelegramAddress(e)) return u.phone || ('+' + e.replace(/^ph/, '').split('@')[0].replace(/\D/g, ''));
  return e;
};
const adminUserRow = (u) => ({
  email: u.email, public_id: u.public_id || '', first_name: u.first_name || '', last_name: u.last_name || '', profile_pic: u.profile_pic || '', country: u.country || '',
  role: u.role || 'user', is_banned: !!u.is_banned, login_kind: loginKind(u.email), contact: loginContact(u), created_at: u.created_at || null, last_active: u.last_active || null,
  posts_count: Number(u.posts_count) || 0, followers_count: Number(u.followers_count) || 0
});

app.post('/api/admin/overview', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const [users, usersToday, users7, users30, activeNow, active24, banned, admins, posts, videos, images, posts24, comments, reactions, follows, messages, reportsPending, openChats] = await Promise.all([
      countOf('SELECT COUNT(*) FROM users'), countOf("SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('day', NOW())"),
      countOf("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days'"), countOf("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '30 days'"),
      countOf("SELECT COUNT(*) FROM users WHERE last_active >= NOW() - INTERVAL '5 minutes'"), countOf("SELECT COUNT(*) FROM users WHERE last_active >= NOW() - INTERVAL '24 hours'"),
      countOf('SELECT COUNT(*) FROM users WHERE COALESCE(is_banned, FALSE)'), countOf("SELECT COUNT(*) FROM users WHERE role IN ('admin', 'super_admin')"),
      countOf('SELECT COUNT(*) FROM posts'), countOf("SELECT COUNT(*) FROM posts WHERE media_type = 'video'"), countOf("SELECT COUNT(*) FROM posts WHERE media_type = 'image'"),
      countOf("SELECT COUNT(*) FROM posts WHERE created_at >= NOW() - INTERVAL '24 hours'"), countOf('SELECT COUNT(*) FROM comments'), countOf('SELECT COUNT(*) FROM likes'),
      countOf('SELECT COUNT(*) FROM follows'), countOf('SELECT COUNT(*) FROM messages'), countOf("SELECT COUNT(*) FROM reports WHERE status = 'pending'"), countOf('SELECT COUNT(*) FROM blocked_users')
    ]);
    const signups = await seriesOf(`SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COUNT(u.email)::int AS n FROM generate_series((CURRENT_DATE - INTERVAL '13 days')::date, CURRENT_DATE, INTERVAL '1 day') AS g(d)
      LEFT JOIN users u ON u.created_at::date = g.d::date GROUP BY g.d ORDER BY g.d`);
    const postsSeries = await seriesOf(`SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COUNT(p.id)::int AS n FROM generate_series((CURRENT_DATE - INTERVAL '13 days')::date, CURRENT_DATE, INTERVAL '1 day') AS g(d)
      LEFT JOIN posts p ON p.created_at::date = g.d::date GROUP BY g.d ORDER BY g.d`);
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, totals: { users, usersToday, users7, users30, activeNow, active24, banned, admins, posts, videos, images, posts24, comments, reactions, follows, messages, reportsPending, blocks: openChats }, series: { signups, posts: postsSeries } });
  } catch (err) { console.error('[admin] overview error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/users/search', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const q = String(b.query || '').trim().slice(0, 100);
    const role = ['user', 'admin', 'super_admin'].includes(b.role) ? b.role : '';
    const status = ['active', 'banned'].includes(b.status) ? b.status : '';
    const limit = clampInt(b.limit, 25, 1, 50), offset = clampInt(b.offset, 0, 0, 100000);
    const ids = [q.toLowerCase()]; const phones = [];
    const e164 = q ? normalizePhone(q, b.country) : null;
    if (e164) { for (const id of phoneIdentitiesOf(e164)) ids.push(id); const d = e164.slice(1); phones.push(d); if (d.startsWith('855')) phones.push('0' + d.slice(3)); }
    const r = await pool.query(
      `SELECT u.email, u.public_id, u.first_name, u.last_name, u.profile_pic, u.country, u.role, u.is_banned, u.phone, u.created_at, u.last_active,
              (SELECT COUNT(*) FROM posts p WHERE p.user_email = u.email) AS posts_count, (SELECT COUNT(*) FROM follows f WHERE f.following_email = u.email) AS followers_count
       FROM users u
       WHERE ($1 = '' OR u.first_name ILIKE $2 OR u.last_name ILIKE $2 OR (u.first_name || ' ' || u.last_name) ILIKE $2 OR LOWER(u.email) = ANY($3::text[]) OR u.public_id = $4
              OR regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') = ANY($5::text[]))
         AND ($6 = '' OR u.role = $6) AND ($7 = '' OR ($7 = 'banned' AND COALESCE(u.is_banned, FALSE)) OR ($7 = 'active' AND NOT COALESCE(u.is_banned, FALSE)))
       ORDER BY u.created_at DESC NULLS LAST, u.first_name ASC LIMIT $8 OFFSET $9`,
      [q, `%${likeEsc(q)}%`, ids, /^\d{15}$/.test(q) ? q : '', phones, role, status, limit, offset]);
    res.json({ success: true, users: r.rows.map(adminUserRow), hasMore: r.rows.length === limit });
  } catch (err) { console.error('[admin] user search error:', err.message); res.status(500).json({ success: false, error: 'Could not search.' }); }
});

// an admin may type a phone number (any way of writing it), a Gmail, a 15-digit ID or the stored login
async function resolveIdentifier(raw) {
  const ident = String(raw || '').trim(); if (!ident) return null;
  let r;
  if (/^\d{15}$/.test(ident)) r = await pool.query('SELECT * FROM users WHERE public_id = $1 LIMIT 1', [ident]);
  else if (ident.includes('@')) r = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [ident]);
  else { const e164 = normalizePhone(ident); const stored = e164 ? await findAccountEmail(pool, e164) : null; r = stored ? await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [stored]) : { rows: [] }; }
  return r.rows[0] || null;
}
async function loadAdminTarget(b) {
  const r = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [String(b.target || '')]);
  return r.rows[0] || null;
}
const deniedForAdmin = (a, u) => isAdminRole(u.role, u.email) && !a.isSuperAdmin;

app.post('/api/admin/users/detail', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const u = await loadAdminTarget(b); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    const one = async (sql) => { try { return Number((await pool.query(sql, [u.email])).rows[0].count) || 0; } catch (e) { return null; } };
    const [posts, comments, reactionsGiven, followers, following, reportsAgainst, reportsMade, blockedBy] = await Promise.all([
      one('SELECT COUNT(*) FROM posts WHERE user_email = $1'), one('SELECT COUNT(*) FROM comments WHERE user_email = $1'), one('SELECT COUNT(*) FROM likes WHERE user_email = $1'),
      one('SELECT COUNT(*) FROM follows WHERE following_email = $1'), one('SELECT COUNT(*) FROM follows WHERE follower_email = $1'),
      one('SELECT COUNT(*) FROM reports WHERE target_user_email = $1'), one('SELECT COUNT(*) FROM reports WHERE reporter_email = $1'), one('SELECT COUNT(*) FROM blocked_users WHERE blocked_email = $1')
    ]);
    let sessions = []; try { sessions = (await authCore.listSessions(u.email)).slice(0, 10); } catch (e) {}
    let recentPosts = []; try { recentPosts = (await pool.query("SELECT id, content, media_type, privacy, created_at FROM posts WHERE user_email = $1 ORDER BY created_at DESC LIMIT 5", [u.email])).rows; } catch (e) {}
    const profile = {};
    for (const k of ['bio', 'gender', 'birthdate', 'location', 'work', 'relationship_status', 'phone', 'email_verified']) profile[k] = u[k] === undefined ? null : u[k];
    res.json({ success: true, canManage: !deniedForAdmin(a, u), isSuperAdmin: a.isSuperAdmin,
      user: Object.assign(adminUserRow(u), { profile, has_telegram: !!u.telegram_id, has_password: !!u.password, name_changed_at: u.name_changed_at || null }),
      counts: { posts, comments, reactionsGiven, followers, following, reportsAgainst, reportsMade, blockedBy }, sessions, recentPosts });
  } catch (err) { console.error('[admin] user detail error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/users/update', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const u = await loadAdminTarget(b); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    if (deniedForAdmin(a, u)) return res.status(403).json({ success: false, error: 'Only a Super Admin can edit an admin.' });
    const f = b.fields && typeof b.fields === 'object' ? b.fields : {};
    const LIMITS = { first_name: 60, last_name: 60, bio: 500, location: 150, work: 150, relationship_status: 100, country: 60, phone: 30 };
    const sets = [], vals = [], changed = [];
    for (const [k, max] of Object.entries(LIMITS)) {
      if (!(k in f)) continue;
      const v = String(f[k] === null ? '' : f[k]).replace(/\s+/g, ' ').trim().slice(0, max);
      if ((k === 'first_name' || k === 'last_name') && !v) return res.status(400).json({ success: false, error: 'The name can not be empty.' });
      vals.push(v); sets.push(`${k} = $${vals.length}`); changed.push(k);
    }
    if ('gender' in f) { if (!['Male', 'Female', 'Other'].includes(f.gender)) return res.status(400).json({ success: false, error: 'Invalid gender.' }); vals.push(f.gender); sets.push(`gender = $${vals.length}`); changed.push('gender'); }
    if ('birthdate' in f) { const bd = normalizeBirthdate(f.birthdate || ''); if (bd === undefined) return res.status(400).json({ success: false, error: 'Invalid date of birth.' }); vals.push(bd); sets.push(`birthdate = $${vals.length}`); changed.push('birthdate'); }
    if ('email_verified' in f) { vals.push(!!f.email_verified); sets.push(`email_verified = $${vals.length}`); changed.push('email_verified'); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to change.' });
    vals.push(u.email);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE email = $${vals.length}`, vals);
    authCore.invalidate(u.email);
    audit(a.adminEmail, 'edit-profile', u.email, changed.join(', '));
    res.json({ success: true, changed });
  } catch (err) { console.error('[admin] user update error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/admin/users/logout-all', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const u = await loadAdminTarget(b); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    if (deniedForAdmin(a, u)) return res.status(403).json({ success: false, error: 'Only a Super Admin can do this to an admin.' });
    await pool.query('UPDATE users SET sessions_epoch = COALESCE(sessions_epoch, 0) + 1 WHERE email = $1', [u.email]);    // also ends logins from before device tracking
    authCore.invalidate(u.email);
    let n = 0; try { n = await authCore.revokeAll(u.email); } catch (e) {}
    audit(a.adminEmail, 'force-logout', u.email, n + ' device(s)');
    res.json({ success: true, devices: n });
  } catch (err) { console.error('[admin] force logout error:', err.message); res.status(500).json({ success: false, error: 'Could not do that.' }); }
});

app.post('/api/admin/posts/search', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const q = String(b.query || '').trim().slice(0, 100);
    const type = ['text', 'image', 'video'].includes(b.type) ? b.type : '', privacy = ['public', 'private'].includes(b.privacy) ? b.privacy : '';
    const limit = clampInt(b.limit, 25, 1, 50), offset = clampInt(b.offset, 0, 0, 100000);
    const r = await pool.query(
      `SELECT p.id, p.content, p.media_type, p.privacy, p.created_at, p.views_count, p.ai_category, p.user_email, u.first_name, u.last_name,
              (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count
       FROM posts p JOIN users u ON u.email = p.user_email
       WHERE ($1 = '' OR p.content ILIKE $2 OR u.first_name ILIKE $2 OR u.last_name ILIKE $2) AND ($3 = '' OR p.media_type = $3) AND ($4 = '' OR p.privacy = $4)
       ORDER BY p.created_at DESC, p.id DESC LIMIT $5 OFFSET $6`, [q, `%${likeEsc(q)}%`, type, privacy, limit, offset]);
    res.json({ success: true, posts: r.rows, hasMore: r.rows.length === limit });
  } catch (err) { console.error('[admin] post search error:', err.message); res.status(500).json({ success: false, error: 'Could not search.' }); }
});

app.post('/api/admin/comments/search', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const q = String(b.query || '').trim().slice(0, 100); const limit = clampInt(b.limit, 25, 1, 50), offset = clampInt(b.offset, 0, 0, 100000);
    const r = await pool.query(
      `SELECT c.id, c.post_id, c.content, c.created_at, c.reply_to_id, c.user_email, u.first_name, u.last_name
       FROM comments c JOIN users u ON u.email = c.user_email WHERE ($1 = '' OR c.content ILIKE $2 OR u.first_name ILIKE $2 OR u.last_name ILIKE $2)
       ORDER BY c.created_at DESC, c.id DESC LIMIT $3 OFFSET $4`, [q, `%${likeEsc(q)}%`, limit, offset]);
    res.json({ success: true, comments: r.rows, hasMore: r.rows.length === limit });
  } catch (err) { console.error('[admin] comment search error:', err.message); res.status(500).json({ success: false, error: 'Could not search.' }); }
});

app.post('/api/admin/comments/delete', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const id = parseInt(b.commentId, 10); if (!id) return res.status(400).json({ success: false, error: 'Invalid comment.' });
    await pool.query('DELETE FROM comment_likes WHERE comment_id = $1 OR comment_id IN (SELECT id FROM comments WHERE reply_to_id = $1)', [id]);
    const d = await pool.query('DELETE FROM comments WHERE id = $1 OR reply_to_id = $1 RETURNING id', [id]);
    audit(a.adminEmail, 'delete-comment', id, d.rows.length + ' comment(s) incl. replies');
    res.json({ success: d.rows.length > 0, removed: d.rows.length });
  } catch (err) { console.error('[admin] comment delete error:', err.message); res.status(500).json({ success: false, error: 'Could not delete.' }); }
});

app.post('/api/admin/audit', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const limit = clampInt(b.limit, 50, 1, 200), offset = clampInt(b.offset, 0, 0, 100000);
    const r = await pool.query('SELECT id, at, admin_email, action, target, details FROM admin_audit ORDER BY at DESC, id DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json({ success: true, entries: r.rows, hasMore: r.rows.length === limit });
  } catch (err) { console.error('[admin] audit error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

// 📊 count every table (Super Admin): open it on the OLD site and the NEW site after moving the database — the numbers must be the same
app.post('/api/admin/system/db-count', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can do this.' });
    const t = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((x) => x.tablename);
    const out = [];
    for (const name of t) {
      if (!/^[a-z0-9_]+$/i.test(name)) continue;
      const n = (await pool.query('SELECT COUNT(*)::bigint AS n FROM "' + name + '"').catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
      out.push({ name, n: Number(n) });
    }
    const meta = (await pool.query("SELECT pg_database_size(current_database()) AS bytes, current_setting('server_version') AS version")).rows[0];
    res.json({ success: true, tables: out, total: out.reduce((x, y) => x + Math.max(0, y.n), 0), sizeMb: Math.round(Number(meta.bytes) / 1048576), version: meta.version, at: new Date().toISOString() });
  } catch (err) { console.error('[admin] db-count:', err.message); res.status(500).json({ success: false, error: 'Could not count.' }); }
});

app.post('/api/admin/system', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    let db = false, dbMs = null; const t0 = Date.now();
    try { await pool.query('SELECT 1'); db = true; dbMs = Date.now() - t0; } catch (e) {}
    const has = (k) => !!process.env[k];
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, checks: {
      database: db, databaseMs: dbMs, jwtSecret: has('JWT_SECRET'), adminPin: !!ADMIN_MASTER_KEY, emailCodes: !!(mailer && mailer.isConfigured && mailer.isConfigured()), phoneCodes: gateway.isConfigured(),
      telegramLogin: tgLogin.isConfigured(), turnstile: has('TURNSTILE_SECRET_KEY'), googlePlay: require('./google-play').on(), payway: has('PAYWAY_MERCHANT_ID') && has('PAYWAY_API_KEY') && has('PAYWAY_API_URL'), mediaStorage: has('R2_BUCKET_NAME') && has('R2_ACCESS_KEY_ID') && has('R2_SECRET_ACCESS_KEY'), aiCategories: has('GEMINI_API_KEY'),
      supportTelegram: supportTelegramLink(), feedMode: process.env.FEED_MODE === 'latest' ? 'latest' : 'ranked', videoFeedMode: process.env.VIDEO_FEED_MODE === 'latest' ? 'latest' : 'ranked',
      maskUserIds: process.env.MASK_USER_IDS !== 'false', debugErrors: process.env.DEBUG_ERRORS === 'true', cspEnforced: process.env.CSP_ENFORCE === 'true',
      uptimeMinutes: Math.round(process.uptime() / 60), memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version } });
  } catch (err) { console.error('[admin] system error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});


// ---------------------------------------------------------------------------
// Ads Manager (local advertising): goals, boosting a post, feed + video placements, interest / country targeting, a budget that is spent per 1000 views (CPM),
// a daily pace, and reports. A person approves every ad and confirms the payment by hand before it starts.
// ---------------------------------------------------------------------------
const AD_PLACEMENTS = ['feed_banner', 'video_preroll', 'both'];
const AD_OBJECTIVES = ['reach', 'traffic', 'engagement', 'messages', 'video_views', 'products'];
// 📍 the 25 provinces: [key, Khmer, English, other ways people write it]
const KH_PROVINCES = [
  ['pp', 'ភ្នំពេញ', 'Phnom Penh', 'phnompenh,pp,ភ្នំពេញ'], ['bmc', 'បន្ទាយមានជ័យ', 'Banteay Meanchey', 'banteaymeanchey,poipet,ប៉ោយប៉ែត,សិរីសោភ័ណ'],
  ['btb', 'បាត់ដំបង', 'Battambang', 'battambang,batdambang'], ['kcm', 'កំពង់ចាម', 'Kampong Cham', 'kampongcham'], ['kch', 'កំពង់ឆ្នាំង', 'Kampong Chhnang', 'kampongchhnang'],
  ['ksp', 'កំពង់ស្ពឺ', 'Kampong Speu', 'kampongspeu'], ['ktm', 'កំពង់ធំ', 'Kampong Thom', 'kampongthom'], ['kpt', 'កំពត', 'Kampot', 'kampot'],
  ['kdl', 'កណ្តាល', 'Kandal', 'kandal,តាខ្មៅ,takhmao'], ['kep', 'កែប', 'Kep', 'kep,kaeb'], ['kkg', 'កោះកុង', 'Koh Kong', 'kohkong,kaohkong'],
  ['krt', 'ក្រចេះ', 'Kratie', 'kratie,kracheh'], ['mdk', 'មណ្ឌលគិរី', 'Mondulkiri', 'mondulkiri,mondolkiri'], ['omc', 'ឧត្តរមានជ័យ', 'Oddar Meanchey', 'oddarmeanchey,otdarmeanchey'],
  ['pln', 'ប៉ៃលិន', 'Pailin', 'pailin'], ['shv', 'ព្រះសីហនុ', 'Preah Sihanouk', 'preahsihanouk,sihanoukville,kampongsom,កំពង់សោម'], ['pvh', 'ព្រះវិហារ', 'Preah Vihear', 'preahvihear'],
  ['pst', 'ពោធិ៍សាត់', 'Pursat', 'pursat,pouthisat'], ['pvg', 'ព្រៃវែង', 'Prey Veng', 'preyveng'], ['rtk', 'រតនគិរី', 'Ratanakiri', 'ratanakiri,rattanakiri,ratanakkiri'],
  ['srp', 'សៀមរាប', 'Siem Reap', 'siemreap,siemriep'], ['stt', 'ស្ទឹងត្រែង', 'Stung Treng', 'stungtreng,steungtreng'], ['svr', 'ស្វាយរៀង', 'Svay Rieng', 'svayrieng,bavet,បាវិត'],
  ['tko', 'តាកែវ', 'Takeo', 'takeo,takev'], ['tbk', 'ត្បូងឃ្មុំ', 'Tbong Khmum', 'tbongkhmum,tboungkhmum,suong,សួង'],
];
const provNorm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\u17d2\u178a/g, '\u17d2\u178f').replace(/kompong/g, 'kampong').replace(/[\s\-_.,'’]+/g, '');
const PROV_LOOKUP = KH_PROVINCES.map(([k, km, en, other]) => [k, [km, en, ...other.split(',')].map(provNorm).filter((x) => x.length >= 3 || x === 'pp')]);
function provinceOf(location) {                     // a person's province from the free "lives in" text; '' = we do not know
  const t = provNorm(location); if (!t) return '';
  for (const [k, names] of PROV_LOOKUP) if (names.some((n) => (n === 'pp' ? t === 'pp' : t.includes(n)))) return k;
  return '';
}
function ageOf(birthdate) {                         // years, or 0 = we do not know
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(birthdate || '').trim()); if (!m) return 0;
  const b = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), n = new Date();
  let a = n.getUTCFullYear() - b.getUTCFullYear(); if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a--;
  return a > 0 && a < 110 ? a : 0;
}
const adProvinces = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => KH_PROVINCES.some((p) => p[0] === x)).slice(0, 25);
const adGender = (v) => (v === 'Male' || v === 'Female' ? v : '');
const adAge = (v) => { const n = parseInt(v, 10); return n >= 13 && n <= 65 ? n : 0; };
// 🛍️ products of an ad: picture (CamFeed storage only), name, price
function adItems(v) {
  let arr = v; if (typeof arr === 'string') { try { arr = JSON.parse(arr || '[]'); } catch (e) { arr = []; } }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr.slice(0, 60)) {                // up to 60 pictures / videos; a name and a price are optional (some sellers only answer in chat)
    const url = security.safeUrl(String((it && (it.url || it.image)) || '')); if (!url) continue;
    const video = (it && it.type === 'video') || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
    out.push({ url, image: url, type: video ? 'video' : 'image', name: String((it && it.name) || '').replace(/\s+/g, ' ').trim().slice(0, 60), price: String((it && it.price) || '').replace(/\s+/g, ' ').trim().slice(0, 30) });
  }
  return out;
}
// does this person fit the ad's province / age / gender? (what we do not know about a person never keeps the ad away)
function adFits(ad, who) {
  const prov = String(ad.provinces || '').split(',').filter(Boolean);
  if (prov.length && who.prov && !prov.includes(who.prov)) return false;
  if (ad.gender && who.gender && who.gender !== ad.gender) return false;
  if (ad.adult && !(who.age >= 18)) return false;     // 🔞 18+ only: never shown when we do not know the age
  if (who.age && ((ad.age_min && who.age < ad.age_min) || (ad.age_max && who.age > ad.age_max))) return false;
  return true;
}
// the province: what the person wrote in "lives in"; if nothing, the city of their connection (Cloudflare) — a guess only, mobile data often looks like Phnom Penh
const whoOf = (u) => ({ prov: provinceOf(u && u.location) || provinceOf(u && u.ip_city), age: ageOf(u && u.birthdate), gender: u && (u.gender === 'Male' || u.gender === 'Female') ? u.gender : '' });
const AD_INTERESTS = ['Comedy', 'Music', 'Gaming', 'Food', 'Vehicles & Motorcycles', 'Technology', 'News', 'Sports', 'Education', 'Travel', 'Lifestyle'];
const AD_DEFAULT_PAYMENT_TEXT = 'ABA Bank\nលេខគណនី / Account: 002217985\nសូមសរសេរក្នុងកំណត់ចំណាំ: CamFeed Ads + ឈ្មោះអាជីវកម្មរបស់អ្នក\nPlease write in the note: CamFeed Ads + your business name';
let AD_FREQ_CAP = 3;                                                       // one person is shown the same ad at most 3 times a day (Admin › Ads › settings)
const adNum = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };
const AD_CPM = { feed: adNum(process.env.AD_CPM_FEED_USD, 0.5), video: adNum(process.env.AD_CPM_VIDEO_USD, 0.8) };   // USD per 1000 views
let AD_MIN_BUDGET_USD = adNum(process.env.AD_MIN_BUDGET_USD, 2);
// 💳 ad credit: money of an ad that ended before its budget was used comes back here, and pays (part of) the next ad
async function adCreditEnsure() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ad_credit (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, cents NUMERIC(14,4) NOT NULL, kind VARCHAR(12) NOT NULL, ref_id INTEGER, note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ad_credit_user ON ad_credit (user_email)');
  await pool.query('ALTER TABLE sponsored_ads ADD COLUMN IF NOT EXISTS credited BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
  await pool.query('ALTER TABLE ad_requests ADD COLUMN IF NOT EXISTS credit_cents INTEGER NOT NULL DEFAULT 0').catch(() => {});
}
async function adCreditOf(email) {
  try { await adCreditEnsure(); return Math.max(0, Math.floor(Number((await pool.query('SELECT COALESCE(SUM(cents), 0) AS c FROM ad_credit WHERE user_email = $1', [email])).rows[0].c) || 0)); } catch (e) { return 0; }
}
async function adLeftovers() {                    // ads whose days are over: the money not used becomes credit (once)
  try {
    await adCreditEnsure();
    const r = (await pool.query(`UPDATE sponsored_ads SET status = 'ended', credited = TRUE
      WHERE credited = FALSE AND owner_email IS NOT NULL AND budget_cents > 0 AND ends_at IS NOT NULL AND ends_at < NOW() AND status IN ('active', 'paused', 'completed')
      RETURNING id, owner_email, budget_cents, spent_cents`)).rows;
    for (const a of r) {
      const left = Math.floor(Number(a.budget_cents) - Number(a.spent_cents));
      if (left < 1) continue;
      await pool.query("INSERT INTO ad_credit (user_email, cents, kind, ref_id, note) VALUES ($1, $2, 'leftover', $3, $4)", [a.owner_email, left, a.id, 'ad #' + a.id]);
      const q = (await pool.query('SELECT id FROM ad_requests WHERE ad_id = $1', [a.id])).rows[0];
      sendAdminNotice('CamFeed', a.owner_email, '💳 ពាណិជ្ជកម្ម A' + (q ? q.id : a.id) + ' បានបញ្ចប់។ ប្រាក់ $' + (left / 100).toFixed(2) + ' ដែលមិនបានប្រើ ត្រូវបានរក្សាទុកជាឥណទាន សម្រាប់ផ្សាយលើកក្រោយ។', 'admin_notice').catch(() => {});
    }
  } catch (e) { console.error('[ads] leftovers:', e.message); }
}
setTimeout(() => { adLeftovers(); setInterval(adLeftovers, 10 * 60 * 1000); }, 60 * 1000);

// ⚙️ how ads are shown — the Admin changes these at any time (Admin › 📢 Ads › ⚙️), no new app needed
const AD_CFG = { firstAfter: 6, every: 50, sameMax: 3, gapHours: 3, totalPerDay: 20, cpmFeed: AD_CPM.feed, cpmVideo: AD_CPM.video, minBudget: AD_MIN_BUDGET_USD };
const AD_CFG_LIMITS = { firstAfter: [1, 200], every: [3, 500], sameMax: [1, 50], gapHours: [0, 48], totalPerDay: [1, 500], cpmFeed: [0.01, 100], cpmVideo: [0.01, 100], minBudget: [0.5, 1000] };
function applyAdCfg(v) {
  for (const [k, [lo, hi]] of Object.entries(AD_CFG_LIMITS)) { const n = Number(v && v[k]); if (Number.isFinite(n) && n >= lo && n <= hi) AD_CFG[k] = ['cpmFeed', 'cpmVideo', 'minBudget', 'gapHours'].includes(k) ? Number(n.toFixed(2)) : Math.round(n); }
  AD_CPM.feed = AD_CFG.cpmFeed; AD_CPM.video = AD_CFG.cpmVideo; AD_MIN_BUDGET_USD = AD_CFG.minBudget; AD_FREQ_CAP = AD_CFG.sameMax;
}
async function loadAdCfg() {
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS ad_cfg (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pool.query('ALTER TABLE ad_user_day ADD COLUMN IF NOT EXISTS last_at TIMESTAMPTZ').catch(() => {});
    const r = (await pool.query("SELECT v FROM ad_cfg WHERE k = 'main'")).rows[0];
    if (r) applyAdCfg(r.v);
  } catch (e) { console.error('[ads] settings:', e.message); }
}
setTimeout(loadAdCfg, 4000);
app.post('/api/admin/ads/settings', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const b = req.body || {};
    if (b.set && typeof b.set === 'object') {
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this. / មានតែ Super Admin ទេដែលអាចប្ដូរបាន។' });
      applyAdCfg(b.set);
      await pool.query("INSERT INTO ad_cfg (k, v, updated_by) VALUES ('main', $1, $2) ON CONFLICT (k) DO UPDATE SET v = $1, updated_by = $2, updated_at = NOW()", [JSON.stringify(AD_CFG), a.adminEmail]);
      audit(a.adminEmail, 'ads_settings', '', JSON.stringify(AD_CFG));
    }
    res.json({ success: true, settings: AD_CFG, limits: AD_CFG_LIMITS });
  } catch (err) { console.error('[ads] settings save:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});
const adLink = (v) => { const s = String(v || '').trim(); return /^https?:\/\/[^\s<>"'`]{4,480}$/i.test(s) ? s : ''; };   // only web links: never javascript:
const adInterests = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => AD_INTERESTS.includes(x)).slice(0, 6);
// 📍 where the ad shows (☑️ any of: feed, reels, story) and 📱 on which phones (☑️ any of: android, ios, web). Empty = everywhere.
const AD_PLACES = ['feed', 'reels', 'story'], AD_DEVICES = ['android', 'ios', 'web'];
const adPlaces = (v) => { const l = (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => AD_PLACES.includes(x)); return AD_PLACES.filter((x) => l.includes(x)); };
const adDevices = (v) => { const l = (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => AD_DEVICES.includes(x)); return AD_DEVICES.filter((x) => l.includes(x)); };
const placementOf = (pl) => (pl.includes('reels') && !pl.includes('feed') && !pl.includes('story') ? 'video_preroll' : !pl.includes('reels') ? 'feed_banner' : 'both');
const placesOfAd = (a) => { const l = adPlaces(a.places); return l.length ? l : a.placement === 'video_preroll' ? ['reels'] : a.placement === 'feed_banner' ? ['feed'] : ['feed', 'reels']; };
// the phone app says which phone it is (X-CamFeed-App); everything else is the website
const devOf = (req) => { const h = String((req.headers && req.headers['x-camfeed-app']) || '').toLowerCase(); return h === 'android' || h === 'ios' ? h : 'web'; };
const adPlaceFeed = (p) => p === 'feed_banner' || p === 'both';
const adPlaceVideo = (p) => p === 'video_preroll' || p === 'both';
// how many views a budget buys: the money is split over the places chosen
function adEstimate(budgetUsd, days, placement, places) {
  const cpms = [];
  if (places && places.length) places.forEach((x) => cpms.push(x === 'reels' ? AD_CPM.video : AD_CPM.feed));
  else {
    if (adPlaceFeed(placement)) cpms.push(AD_CPM.feed);
    if (adPlaceVideo(placement)) cpms.push(AD_CPM.video);
  }
  const cpm = cpms.reduce((a, b) => a + b, 0) / (cpms.length || 1);
  const views = Math.floor(budgetUsd / cpm * 1000);
  return { cpm: Number(cpm.toFixed(3)), views, perDay: Math.floor(views / Math.max(days, 1)) };
}

app.get('/api/ads/estimate', async (req, res) => {
  try {
    const budget = adNum(req.query.budget, 0), days = clampInt(req.query.days, 7, 1, 30);
    const placement = AD_PLACEMENTS.includes(req.query.placement) ? req.query.placement : 'both';
    const est = adEstimate(budget, days, placement, adPlaces(req.query.places));
    const cc = country.ccOf(req.query.country);
    await country.ensure().catch(() => {});
    const target = { provinces: cc && cc !== 'KH' ? '' : adProvinces(req.query.prov).join(','), gender: adGender(req.query.g), age_min: adAge(req.query.amin), age_max: adAge(req.query.amax) };
    const rows = (await pool.query("SELECT LOWER(email) AS email, location, birthdate, gender, (SELECT s.city FROM user_sessions s WHERE s.email = users.email AND COALESCE(s.city, '') <> '' ORDER BY s.last_seen DESC LIMIT 1) AS ip_city FROM users WHERE last_active >= NOW() - INTERVAL '30 days' AND COALESCE(is_banned, FALSE) = FALSE AND ($1 = '' OR cc = $1 OR (cc IS NULL AND $1 = 'KH')) LIMIT 200000", [cc])).rows;
    const fit = rows.filter((u) => adFits(target, whoOf(u)));
    const users = fit.length;
    const kws = await interests.resolveWords(String(req.query.kw || '').split(','));
    const interested = kws.length && users ? await interests.interestedCount(kws.map((k) => k.id), fit.map((u) => u.email)) : 0;
    const ceiling = users * AD_FREQ_CAP * days;                         // the most that real people can be shown in that time
    res.json({ success: true, cpm: est.cpm, cpmFeed: AD_CPM.feed, cpmVideo: AD_CPM.video, views: est.views, viewsPerDay: est.perDay, activeUsers: users, allActive: rows.length, interested,
      canDeliver: Math.min(est.views, ceiling), minBudget: AD_MIN_BUDGET_USD });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not calculate.' }); }
});

// what the viewer is shown: only live ads, not their own, inside budget and today's pace, matching country and interests
app.get('/api/sponsored-ads', async (req, res) => {
  try {
    const me = req.authEmail || '';
    await country.ensure().catch(() => {});
    const u = me ? (await pool.query(`SELECT country, cc, location, birthdate, gender, (SELECT s.city FROM user_sessions s WHERE s.email = users.email AND COALESCE(s.city, '') <> '' ORDER BY s.last_seen DESC LIMIT 1) AS ip_city FROM users WHERE email = $1`, [me])).rows[0] : null;
    const dev = devOf(req);
    const myInterests = me ? (await pool.query('SELECT category FROM user_interest_scores WHERE user_email = $1 AND score > 0 ORDER BY score DESC LIMIT 5', [me])).rows.map((r) => r.category) : [];
    const myKw = me ? await interests.userTop(me, 60) : new Map();
    const who = whoOf(u);
    const r = await pool.query(`SELECT a.id, a.advertiser_name, a.placement, a.objective, a.cta, COALESCE(NULLIF(a.caption, ''), p.content, '') AS caption, a.target_url, COALESCE(a.media_url, p.media_url) AS media_url, a.skip_seconds, a.post_id, a.owner_email, a.interests, a.country,
        a.items, a.kw_ids, a.provinces, a.age_min, a.age_max, a.gender, a.adult, a.places, a.devices, ou.first_name AS o_first, ou.last_name AS o_last, ou.profile_pic AS o_pic
      FROM sponsored_ads a LEFT JOIN posts p ON p.id = a.post_id LEFT JOIN ad_daily d ON d.ad_id = a.id AND d.day = CURRENT_DATE LEFT JOIN users ou ON ou.email = a.owner_email
      WHERE a.status = 'active' AND (a.ends_at IS NULL OR a.ends_at > NOW()) AND COALESCE(a.owner_email, '') <> $1
        AND NOT EXISTS (SELECT 1 FROM ad_hidden h WHERE h.user_email = $1 AND h.ad_id = a.id)
        AND (a.budget_cents = 0 OR (a.spent_cents < a.budget_cents AND COALESCE(d.spent_cents, 0) < (a.budget_cents::numeric / GREATEST(a.days, 1)) * 1.25))
      ORDER BY a.id DESC LIMIT 60`, [me]);
    const mine = (u && (u.cc || country.ccOf(u.country))) || country.ccOf(req.headers['cf-ipcountry']);
    const out = [];
    for (const a of r.rows) {
      const acc = country.ccOf(a.country);
      if (acc && mine && acc !== mine) continue;                                     // 🌏 only in the country the advertiser chose
      const devs = adDevices(a.devices); if (devs.length && !devs.includes(dev)) continue;   // 📱 only on the phones chosen
      if (!adFits(a, who)) continue;
      const wanted = String(a.interests || '').split(',').filter(Boolean);
      const kwIds = String(a.kw_ids || '').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0);
      const kwScore = kwIds.reduce((t, id) => t + (myKw.get(id) || 0), 0);       // 🏷️ the ad's keywords × what I look for now
      const catMatch = wanted.length ? wanted.filter((x) => myInterests.includes(x)).length : 0;
      if (wanted.length && myInterests.length && !catMatch && !kwScore) continue;   // we only leave an ad out when we KNOW the person is not interested
      const owner = a.owner_email ? ((a.o_first || '') + ' ' + (a.o_last || '')).trim() : '';
      out.push({ ad: { id: a.id, advertiser_name: owner || a.advertiser_name, advertiser_pic: a.owner_email ? (a.o_pic || '') : '', placement: a.placement, places: placesOfAd(a), objective: a.objective, cta: a.cta,
        caption: String(a.caption || '').slice(0, 500), target_url: a.target_url || '', media_url: a.media_url || '', skip_seconds: a.skip_seconds, post_id: a.post_id || null, owner_email: a.owner_email || null, items: adItems(a.items) },
        match: Math.min(kwScore, 50) + catMatch * 3, rnd: Math.random() });
    }
    // the limits for one person: the same ad N times a day, at least H hours apart, all ads together T a day; ads never seen come first
    let today = [], ever = new Set(), total = 0;
    if (me) {
      today = (await pool.query('SELECT ad_id, imps, last_at FROM ad_user_day WHERE user_email = $1 AND day = CURRENT_DATE', [me])).rows;
      ever = new Set((await pool.query('SELECT DISTINCT ad_id FROM ad_user_day WHERE user_email = $1 AND imps > 0', [me])).rows.map((x) => x.ad_id));
      total = today.reduce((t, x) => t + (Number(x.imps) || 0), 0);
    }
    const tm = new Map(today.map((x) => [x.ad_id, x]));
    const gapMs = AD_CFG.gapHours * 3600 * 1000;
    const ok = out.filter((x) => {
      const t = tm.get(x.ad.id); if (!t) return true;
      if ((Number(t.imps) || 0) >= AD_CFG.sameMax) return false;
      return !(t.last_at && Date.now() - new Date(t.last_at).getTime() < gapMs);
    });
    ok.forEach((x) => { x.fresh = !ever.has(x.ad.id); x.ad.seen = !x.fresh; });
    ok.sort((x, y) => (Number(y.fresh) - Number(x.fresh)) || ((y.match + y.rnd * 4) - (x.match + x.rnd * 4)));     // never seen first, then the best match
    const left = Math.max(0, AD_CFG.totalPerDay - total);
    res.json({ success: true, ads: ok.slice(0, Math.min(20, left)).map((x) => x.ad), firstAfter: AD_CFG.firstAfter, every: AD_CFG.every });
  } catch (err) { console.error('[ads] serve:', err.message); res.json({ success: true, ads: [] }); }
});

// ❓ "Why do I see this?" — only the reasons about the person asking (never about anyone else)
app.get('/api/sponsored-ads/:id/why', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    if (!me || !(id > 0)) return res.status(400).json({ success: false });
    const a = (await pool.query('SELECT kw_ids, provinces, age_min, age_max, gender, interests FROM sponsored_ads WHERE id = $1', [id])).rows[0];
    if (!a) return res.status(404).json({ success: false });
    const u = (await pool.query(`SELECT location, birthdate, gender, (SELECT s.city FROM user_sessions s WHERE s.email = users.email AND COALESCE(s.city, '') <> '' ORDER BY s.last_seen DESC LIMIT 1) AS ip_city FROM users WHERE email = $1`, [me])).rows[0] || {};
    const who = whoOf(u), myKw = await interests.userTop(me, 60);
    const kws = interests.wordsOf(a.kw_ids).filter((k) => myKw.has(k.id)).sort((x, y) => myKw.get(y.id) - myKw.get(x.id)).slice(0, 3).map((k) => k.word);
    const prov = String(a.provinces || '').split(',').filter(Boolean);
    const p = prov.length && who.prov ? KH_PROVINCES.find((x) => x[0] === who.prov) : null;
    res.json({ success: true, keywords: kws, province: p ? { km: p[1], en: p[2] } : null, age: (a.age_min || a.age_max) && who.age ? { min: a.age_min || 13, max: a.age_max || 65 } : null,
      gender: a.gender && who.gender ? a.gender : '' });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/sponsored-ads/:id/hide', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    if (!me || !(id > 0)) return res.status(400).json({ success: false });
    await pool.query('INSERT INTO ad_hidden (user_email, ad_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});
// the keyword list (for the advertiser to choose from) and 🤖 the AI's suggestion from the ad's text and pictures
app.get('/api/ads/keywords', async (req, res) => {
  try { res.json({ success: true, words: (await interests.allWords()).map((w) => ({ word: w.word, grp: w.grp, syn: w.syn })) }); } catch (err) { res.json({ success: true, words: [] }); }
});
const adSuggestHits = new Map();
app.post('/api/ads/suggest-keywords', async (req, res) => {
  try {
    const me = req.authEmail; if (!me) return res.status(401).json({ success: false, error: 'Please log in.' });
    const now = Date.now(), h = (adSuggestHits.get(me) || []).filter((t) => now - t < 3600 * 1000);
    if (h.length >= 20) return res.status(429).json({ success: false, error: 'Please wait a little and try again.' });
    h.push(now); adSuggestHits.set(me, h); if (adSuggestHits.size > 5000) adSuggestHits.clear();
    const b = req.body || {};
    const urls = (Array.isArray(b.urls) ? b.urls : []).map((x) => security.safeUrl(String(x || ''))).filter(Boolean).slice(0, 3);
    const words = await interests.suggest(String(b.text || '').slice(0, 1500), urls);
    if (!Array.isArray(words)) return res.json({ success: false, error: words.error, why: words.why || '' });   // 200: the reason reaches the page
    res.json({ success: true, words });
  } catch (err) { console.error('[ads] suggest:', err.message); res.status(500).json({ success: false, error: 'Could not do it.' }); }
});

// counting: views are capped per person per day, the cost is taken from the budget, clicks / skips are counted once per view
async function adTrack(req, res, kind) {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    if (!Number.isInteger(id) || id < 1 || !me) return res.json({ success: true });
    const ad = (await pool.query("SELECT id, budget_cents, cpm_feed_cents, cpm_video_cents FROM sponsored_ads WHERE id = $1 AND status = 'active' AND (ends_at IS NULL OR ends_at > NOW())", [id])).rows[0];
    if (!ad) return res.json({ success: true });
    if (kind === 'impression') {
      const where = (req.body && req.body.placement) === 'video' ? 'video' : 'feed';
      const up = await pool.query(`INSERT INTO ad_user_day (ad_id, user_email, day, imps) VALUES ($1, $2, CURRENT_DATE, 1)
        ON CONFLICT (ad_id, user_email, day) DO UPDATE SET imps = ad_user_day.imps + 1 WHERE ad_user_day.imps < $3 RETURNING imps`, [id, me, AD_FREQ_CAP]);
      if (up.rowCount) pool.query('UPDATE ad_user_day SET last_at = NOW() WHERE ad_id = $1 AND user_email = $2 AND day = CURRENT_DATE', [id, me]).catch(() => {});
      if (!up.rowCount) return res.json({ success: true });
      const cost = ad.budget_cents > 0 ? Number(where === 'video' ? ad.cpm_video_cents : ad.cpm_feed_cents) / 1000 : 0;   // cents for ONE view
      await pool.query(`UPDATE sponsored_ads SET impressions = impressions + 1, spent_cents = spent_cents + $2,
        status = CASE WHEN budget_cents > 0 AND spent_cents + $2 >= budget_cents THEN 'completed' ELSE status END WHERE id = $1`, [id, cost]);
      await pool.query(`INSERT INTO ad_daily (ad_id, day, feed_imps, video_imps, spent_cents) VALUES ($1, CURRENT_DATE, $2, $3, $4)
        ON CONFLICT (ad_id, day) DO UPDATE SET feed_imps = ad_daily.feed_imps + $2, video_imps = ad_daily.video_imps + $3, spent_cents = ad_daily.spent_cents + $4`,
        [id, where === 'feed' ? 1 : 0, where === 'video' ? 1 : 0, cost]);
      return res.json({ success: true });
    }
    // click / message: once per person per day. skip / complete: not more than the views they were shown.
    const col = { click: 'clicks', message: 'messages', skip: 'skips', complete: 'completes' }[kind];
    if (!col) return res.json({ success: true });
    const lim = (col === 'skips' || col === 'completes') ? `ad_user_day.${col} < ad_user_day.imps` : `ad_user_day.${col} < 1`;
    const hit = await pool.query(`UPDATE ad_user_day SET ${col} = ${col} + 1 WHERE ad_id = $1 AND user_email = $2 AND day = CURRENT_DATE AND ${lim} RETURNING 1`, [id, me]);
    if (!hit.rowCount) return res.json({ success: true });
    await pool.query(`INSERT INTO ad_daily (ad_id, day, ${col}) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (ad_id, day) DO UPDATE SET ${col} = ad_daily.${col} + 1`, [id]);
    if (kind === 'click') await pool.query('UPDATE sponsored_ads SET clicks = clicks + 1 WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: true }); }
}
app.post('/api/sponsored-ads/:id/impression', (req, res) => adTrack(req, res, 'impression'));
app.post('/api/sponsored-ads/:id/click', (req, res) => adTrack(req, res, 'click'));
app.post('/api/sponsored-ads/:id/event', (req, res) => adTrack(req, res, ['click', 'message', 'skip', 'complete'].includes((req.body || {}).type) ? req.body.type : ''));

// numbers for one ad (shared by the advertiser report and the admin view)
async function adReport(adId) {
  const a = (await pool.query('SELECT * FROM sponsored_ads WHERE id = $1', [adId])).rows[0];
  if (!a) return null;
  const t = (await pool.query(`SELECT COALESCE(SUM(feed_imps),0)::int AS feed, COALESCE(SUM(video_imps),0)::int AS video, COALESCE(SUM(clicks),0)::int AS clicks, COALESCE(SUM(skips),0)::int AS skips,
    COALESCE(SUM(completes),0)::int AS completes, COALESCE(SUM(messages),0)::int AS messages FROM ad_daily WHERE ad_id = $1`, [adId])).rows[0];
  const reach = (await pool.query('SELECT COUNT(DISTINCT user_email)::int AS n FROM ad_user_day WHERE ad_id = $1 AND imps > 0', [adId])).rows[0].n;
  const daily = (await pool.query(`SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COALESCE(x.feed_imps,0)+COALESCE(x.video_imps,0) AS views, COALESCE(x.clicks,0) AS clicks, COALESCE(x.spent_cents,0) AS spent_cents
    FROM generate_series((CURRENT_DATE - INTERVAL '13 days')::date, CURRENT_DATE, INTERVAL '1 day') g(d) LEFT JOIN ad_daily x ON x.ad_id = $1 AND x.day = g.d::date ORDER BY g.d`, [adId])).rows
    .map((r) => ({ day: r.day, views: Number(r.views), clicks: Number(r.clicks), spent: Number((Number(r.spent_cents) / 100).toFixed(2)) }));
  let engagement = null;
  if (a.post_id) {
    const p = (await pool.query(`SELECT (SELECT COUNT(*) FROM likes l WHERE l.post_id = $1)::int AS likes, (SELECT COUNT(*) FROM comments c WHERE c.post_id = $1)::int AS comments,
      (SELECT COUNT(*) FROM posts sp WHERE sp.shared_post_id = $1)::int AS shares`, [a.post_id])).rows[0];
    engagement = { reactions: Math.max(0, p.likes - (a.base_likes || 0)), comments: Math.max(0, p.comments - (a.base_comments || 0)), shares: Math.max(0, p.shares - (a.base_shares || 0)) };
    engagement.total = engagement.reactions + engagement.comments + engagement.shares;
  }
  const views = t.feed + t.video, spent = Number(a.spent_cents) / 100;
  return {
    id: a.id, status: a.status, objective: a.objective, placement: a.placement, postId: a.post_id, days: a.days, endsAt: a.ends_at,
    budget: Number(a.budget_cents) / 100, spent: Number(spent.toFixed(2)), views, feedViews: t.feed, videoViews: t.video, reach, clicks: t.clicks,
    ctr: views ? Number((t.clicks / views * 100).toFixed(2)) : 0, costPerClick: t.clicks ? Number((spent / t.clicks).toFixed(3)) : null, costPer1000: views ? Number((spent / views * 1000).toFixed(3)) : null,
    skips: t.skips, completes: t.completes, skipRate: t.video ? Number((t.skips / t.video * 100).toFixed(1)) : null, completionRate: t.video ? Number((t.completes / t.video * 100).toFixed(1)) : null,
    messages: t.messages, engagement, daily
  };
}

// a business sends a campaign; nothing is shown before a person approves it and the money arrives
app.get('/api/ads/info', (req, res) => {
  const qr = security.safeUrl(process.env.AD_PAYMENT_QR_URL || '');
  const send = (me) => res.json({ success: true, paymentText: String(process.env.AD_PAYMENT_TEXT || AD_DEFAULT_PAYMENT_TEXT).slice(0, 600), paymentQr: qr || '', contact: supportTelegramLink() || '', interests: AD_INTERESTS,
    minBudget: AD_MIN_BUDGET_USD, cpmFeed: AD_CPM.feed, cpmVideo: AD_CPM.video, provinces: KH_PROVINCES.map((p) => ({ id: p[0], km: p[1], en: p[2] })), countries: country.list(), me });
  if (!req.authEmail) return send(null);
  Promise.all([pool.query('SELECT first_name, last_name, profile_pic FROM users WHERE email = $1', [req.authEmail]), adCreditOf(req.authEmail), country.ccOfUser(req.authEmail)])
    .then(([r, credit, cc]) => { const u = r.rows[0]; send(u ? { name: ((u.first_name || '') + ' ' + (u.last_name || '')).trim(), pic: u.profile_pic || '', credit, cc: cc || 'KH' } : null); }).catch(() => send(null));
});

app.get('/api/ads/my-posts', async (req, res) => {                          // posts the person can boost (their own, public)
  try {
    if (!req.authEmail) return res.status(401).json({ success: false, error: 'Please log in.' });
    const r = await pool.query("SELECT id, content, media_type, media_url, created_at FROM posts WHERE user_email = $1 AND COALESCE(privacy, 'public') = 'public' AND shared_post_id IS NULL ORDER BY id DESC LIMIT 30", [req.authEmail]);
    res.json({ success: true, posts: r.rows.map((p) => ({ id: p.id, content: String(p.content || '').slice(0, 140), media_type: p.media_type, media_url: p.media_url, created_at: p.created_at })) });
  } catch (err) { res.json({ success: true, posts: [] }); }
});

app.post('/api/ads/request', async (req, res) => {
  try {
    const email = req.authEmail; if (!email) return res.status(401).json({ success: false, error: 'Please log in.' });
    const b = req.body || {};
    const prof = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email])).rows[0] || {};
    const name = ((prof.first_name || '') + ' ' + (prof.last_name || '')).trim().slice(0, 80) || 'CamFeed', contact = String(b.contact || '').trim().slice(0, 120);   // the ad shows the person's own profile name
    const places = adPlaces(b.places), devices = adDevices(b.devices);
    if (b.places !== undefined && !places.length) return res.status(400).json({ success: false, error: 'Please choose at least one place where the ad shows.' });
    if (b.devices !== undefined && !devices.length) return res.status(400).json({ success: false, error: 'Please choose at least one kind of phone.' });
    const placement = places.length ? placementOf(places) : (AD_PLACEMENTS.includes(b.placement) ? b.placement : 'feed_banner');
    const cc = country.ccOf(b.country) || 'KH';
    const objective = AD_OBJECTIVES.includes(b.objective) ? b.objective : 'traffic';
    const target = b.target_url ? adLink(b.target_url) : '';
    const budget = Math.round(adNum(b.budget_usd, 0) * 100), days = clampInt(b.days, 7, 1, 30);
    if (budget < AD_MIN_BUDGET_USD * 100 || budget > 100000 * 100) return res.status(400).json({ success: false, error: 'The smallest budget is $' + AD_MIN_BUDGET_USD + '.' });
    if (b.target_url && !target) return res.status(400).json({ success: false, error: 'The link must start with http:// or https://' });
    if (objective === 'traffic' && !target && !b.post_id) return res.status(400).json({ success: false, error: 'For "more visits" please add the link people should open.' });
    let items = b.post_id ? [] : adItems(b.items);
    if (!b.post_id && !items.length && b.media_url) items = adItems([{ url: b.media_url }]);
    if (!b.post_id && !items.length) return res.status(400).json({ success: false, error: 'Please add at least one picture or video.' });
    const kws = await interests.resolveWords(b.keywords);
    let postId = null, media = items.length ? items[0].url : null, caption = String(b.caption || '').slice(0, 500);
    if (b.post_id) {                                                        // boost one of my own public posts
      postId = parseInt(b.post_id, 10);
      const p = (await pool.query("SELECT id, content FROM posts WHERE id = $1 AND user_email = $2 AND COALESCE(privacy, 'public') = 'public'", [postId, email])).rows[0];
      if (!p) return res.status(400).json({ success: false, error: 'You can only boost your own public posts.' });
      if (!caption) caption = String(p.content || '').slice(0, 500);
    } else if (!items.length) {
      media = security.safeUrl(String(b.media_url || ''));
      if (!media) return res.status(400).json({ success: false, error: 'Please upload a picture or video, or choose a post to boost.' });
    }
    if (adPlaceVideo(placement) && !postId && !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(media || '') && placement === 'video_preroll') { /* a picture is shown for a few seconds: allowed */ }
    const open = await pool.query("SELECT COUNT(*)::int AS n FROM ad_requests WHERE user_email = $1 AND status IN ('pending', 'quoted', 'payment_sent')", [email]);
    if (open.rows[0].n >= 3) return res.status(429).json({ success: false, error: 'You already have 3 requests waiting. Please wait for an answer.' });
    const cta = objective === 'products' || objective === 'messages' ? 'message' : (['learn_more', 'message', 'shop', 'call', 'none'].includes(b.cta) ? b.cta : 'learn_more');
    const wallet = await adCreditOf(email);
    if (adWallet.walletOn() && wallet < budget) return res.status(402).json({ success: false, code: 'need_topup', balance: wallet, need: budget - wallet, error: 'Please add money to your ad wallet first.' });   // 💳 pay first (like Facebook)
    const useCredit = Math.min(wallet, budget);          // 💳 my wallet / credit pays first
    // the price is the budget: it goes straight to "please pay" (CamFeed checks the money and the ad together, with one ✅)
    const r = await pool.query(`INSERT INTO ad_requests (user_email, business_name, contact, placement, caption, target_url, media_url, days, budget_note, objective, post_id, interests, country, budget_cents, cta,
        items, kw_ids, provinces, age_min, age_max, gender, status, credit_cents, price_cents, places, devices)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'quoted',$22,$23,$24,$25) RETURNING id`,
      [email, name, contact, placement, caption, target || null, media, days, String(b.budget_note || '').slice(0, 120), objective, postId, adInterests(b.interests).join(','), cc, budget, cta,
        items.length ? JSON.stringify(items) : '', kws.map((k) => k.id).join(','), cc === 'KH' ? adProvinces(b.provinces).join(',') : '', adAge(b.age_min), adAge(b.age_max), adGender(b.gender), useCredit, budget - useCredit,
        places.join(','), devices.length === AD_DEVICES.length ? '' : devices.join(',')]);
    const reqId = r.rows[0].id;
    if (useCredit > 0) await pool.query("INSERT INTO ad_credit (user_email, cents, kind, ref_id, note) VALUES ($1, $2, 'used', $3, $4)", [email, -useCredit, reqId, 'A' + reqId]);
    // 🤖 the AI looks at it now. Paid all with credit: it starts at once when the AI sees no problem; otherwise the owner decides in Telegram
    adRules.check(reqId).then(async () => {
      if (budget - useCredit > 0) return;
      const q = (await pool.query("UPDATE ad_requests SET status = 'payment_sent', pay_ref = 'credit', updated_at = NOW() WHERE id = $1 AND status = 'quoted' RETURNING *", [reqId])).rows[0];
      if (!q) return;
      if (/មិនឃើញបញ្ហា/.test(q.ai_note || '')) await activateAdRequest(reqId, 'CamFeed');
      else askOwnerAboutAd(q);
    }).catch(() => {});
    res.status(201).json({ success: true, id: reqId, code: 'A' + reqId, credit: useCredit, price: budget - useCredit });
  } catch (err) { console.error('[ads] request:', err.message); res.status(500).json({ success: false, error: 'Could not send the request.' }); }
});
app.get('/api/ads/my', async (req, res) => {
  try {
    if (!req.authEmail) return res.status(401).json({ success: false, error: 'Please log in.' });
    const r = await pool.query(`SELECT q.id, q.business_name, q.placement, q.places, q.devices, q.objective, q.caption, q.days, q.status, q.budget_cents, q.price_cents, q.credit_cents, q.admin_note, q.pay_ref, q.post_id, q.ad_id, q.created_at, q.items, q.media_url,
      a.status AS ad_status, a.impressions, a.clicks, a.spent_cents, a.ends_at
      FROM ad_requests q LEFT JOIN sponsored_ads a ON a.id = q.ad_id WHERE q.user_email = $1 ORDER BY q.id DESC LIMIT 30`, [req.authEmail]);
    res.json({ success: true, requests: r.rows, credit: await adCreditOf(req.authEmail) });
  } catch (err) { res.json({ success: true, requests: [] }); }
});
app.get('/api/ads/my/:id/report', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!req.authEmail || !Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Bad request.' });
    const q = (await pool.query('SELECT ad_id FROM ad_requests WHERE id = $1 AND user_email = $2', [id, req.authEmail])).rows[0];
    if (!q || !q.ad_id) return res.status(404).json({ success: false, error: 'No report yet.' });
    res.json({ success: true, report: await adReport(q.ad_id) });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not load the report.' }); }
});
app.post('/api/ads/my/:id/paid', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), ref = String((req.body || {}).pay_ref || '').trim().slice(0, 120);
    if (!req.authEmail || !Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Bad request.' });
    const r = await pool.query("UPDATE ad_requests SET status = 'payment_sent', pay_ref = $1, updated_at = NOW() WHERE id = $2 AND user_email = $3 AND status = 'quoted' RETURNING *", [ref || ('A' + id), id, req.authEmail]);
    if (!r.rowCount) return res.status(400).json({ success: false, error: 'This request is not waiting for payment.' });
    askOwnerAboutAd(r.rows[0]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});
// 💰 to the owner's Telegram: the ad and the money to check, with ✅ / ❌
function askOwnerAboutAd(q) {
    const id = q.id, base = (process.env.PUBLIC_BASE_URL || 'https://camfeedkh.com').replace(/\/+$/, '');
    const credit = Number(q.credit_cents || 0);
    return tgPay.ask('ad', id, ['💰 ពាណិជ្ជកម្ម A' + id + ' · $' + (Number(q.price_cents || 0) / 100).toFixed(2) + (credit > 0 ? ' (+ ឥណទាន $' + (credit / 100).toFixed(2) + ')' : ''), '👤 ' + q.business_name, '📅 ' + q.days + ' ថ្ងៃ · ' + q.objective + ' · ' + (q.places || q.placement) + (q.devices ? ' · 📱 ' + q.devices : '') + (q.country ? ' · 🌏 ' + q.country : ''),
      q.caption ? '📝 ' + String(q.caption).slice(0, 300) : '', q.post_id ? '🚀 ' + base + '/p/' + q.post_id : (q.media_url ? '🖼️ ' + q.media_url : ''), adItems(q.items).length ? '🖼️ ' + adItems(q.items).length + ' រូប/វីដេអូ' : '', adItems(q.items).some((x) => x.name) ? '🛍️ ' + adItems(q.items).filter((x) => x.name).map((x) => x.name + (x.price ? ' ' + x.price : '')).join(' · ').slice(0, 300) : '',
      q.pay_ref && q.pay_ref !== 'A' + id ? '🧾 ' + q.pay_ref : '', q.ai_note || '', q.adult ? '🔞 បង្ហាញតែអ្នកអាយុ 18+' : '', '',
      Number(q.price_cents || 0) > 0 ? 'ពិនិត្យក្នុង ABA ថាបានទទួល $' + (Number(q.price_cents || 0) / 100).toFixed(2) + ' (ចំណាំ៖ A' + id + ')' : '💳 បង់ដោយឥណទានទាំងស្រុង៖ គ្រាន់តែពិនិត្យខ្លឹមសារពាណិជ្ជកម្ម'].filter((x) => x !== '')).catch(() => {});
}

// ----- admin -----
app.post('/api/admin/ads/list', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query('SELECT id, advertiser_name, placement, objective, caption, target_url, media_url, post_id, skip_seconds, status, impressions, clicks, budget_cents, spent_cents, created_at, ends_at FROM sponsored_ads ORDER BY id DESC LIMIT 200');
    res.json({ success: true, ads: r.rows });
  } catch (err) { console.error('[admin] ads list:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});
app.post('/api/admin/ads/report', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const rep = await adReport(parseInt(req.body.id, 10));
    res.json(rep ? { success: true, report: rep } : { success: false, error: 'Not found.' });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not load.' }); }
});
app.post('/api/admin/ads/create', async (req, res) => {                     // an ad made by the team itself (no budget limit)
  try {
    const a = await adminGate(req, res); if (!a) return;
    const b = req.body || {};
    const name = String(b.advertiser_name || '').trim().slice(0, 80);
    const placement = AD_PLACEMENTS.includes(b.placement) ? b.placement : 'feed_banner';
    const media = security.safeUrl(String(b.media_url || ''));
    const target = b.target_url ? adLink(b.target_url) : '';
    if (!name) return res.status(400).json({ success: false, error: 'Advertiser name is required.' });
    if (!media) return res.status(400).json({ success: false, error: 'Media link must be a file uploaded to CamFeed storage (media.camfeedkh.com).' });
    if (b.target_url && !target) return res.status(400).json({ success: false, error: 'Target link must start with http:// or https://' });
    const skip = clampInt(b.skip_seconds, 5, 3, 15);
    const r = await pool.query('INSERT INTO sponsored_ads (advertiser_name, placement, caption, target_url, media_url, skip_seconds, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [name, placement, String(b.caption || '').slice(0, 500), target || null, media, skip, a.adminEmail]);
    audit(a.adminEmail, 'ad_create', r.rows[0].id, name + ' / ' + placement);
    res.status(201).json({ success: true, id: r.rows[0].id });
  } catch (err) { console.error('[admin] ads create:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});
app.post('/api/admin/ads/status', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const id = parseInt(req.body.id, 10), status = req.body.status === 'paused' ? 'paused' : 'active';
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Bad id.' });
    await pool.query("UPDATE sponsored_ads SET status = $1 WHERE id = $2 AND status IN ('active', 'paused')", [status, id]);
    audit(a.adminEmail, 'ad_status', id, status);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});
app.post('/api/admin/ads/delete', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const id = parseInt(req.body.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Bad id.' });
    await pool.query('DELETE FROM sponsored_ads WHERE id = $1', [id]);
    await pool.query('DELETE FROM ad_events WHERE ad_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM ad_daily WHERE ad_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM ad_user_day WHERE ad_id = $1', [id]).catch(() => {});
    audit(a.adminEmail, 'ad_delete', id, '');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not delete.' }); }
});

app.post('/api/admin/ad-requests/list', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query(`SELECT q.id, q.user_email, q.business_name, q.contact, q.placement, q.objective, q.caption, q.target_url, q.media_url, q.post_id, q.days, q.budget_note, q.interests, q.country, q.budget_cents,
      q.status, q.price_cents, q.admin_note, q.pay_ref, q.ai_note, q.adult, q.ad_id, q.created_at, u.first_name, u.last_name,
      (SELECT media_type FROM posts WHERE id = q.post_id) AS post_media_type, (SELECT media_url FROM posts WHERE id = q.post_id) AS post_media_url
      FROM ad_requests q LEFT JOIN users u ON u.email = q.user_email ORDER BY (q.status IN ('pending','payment_sent')) DESC, q.id DESC LIMIT 100`);
    res.json({ success: true, requests: r.rows, isSuperAdmin: !!a.isSuperAdmin });
  } catch (err) { console.error('[admin] ad requests:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});
app.post('/api/admin/ad-requests/quote', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const id = parseInt(req.body.id, 10), price = Math.round(parseFloat(req.body.price_usd) * 100);
    if (!Number.isInteger(id) || id < 1 || !Number.isFinite(price) || price < 0 || price > 10000000) return res.status(400).json({ success: false, error: 'Enter a price in USD.' });
    const r = await pool.query("UPDATE ad_requests SET status = 'quoted', price_cents = $1, admin_note = $2, updated_at = NOW() WHERE id = $3 AND status IN ('pending', 'quoted')", [price, String(req.body.note || '').slice(0, 300), id]);
    if (!r.rowCount) return res.status(400).json({ success: false, error: 'This request can no longer be approved.' });
    audit(a.adminEmail, 'ad_quote', id, '$' + (price / 100).toFixed(2));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});
app.post('/api/admin/ad-requests/reject', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const id = parseInt(req.body.id, 10); if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Bad id.' });
    const rj = await pool.query("UPDATE ad_requests SET status = 'rejected', admin_note = $1, updated_at = NOW() WHERE id = $2 AND status IN ('pending', 'quoted', 'payment_sent') RETURNING user_email, credit_cents", [String(req.body.note || '').slice(0, 300), id]);
    if (rj.rows[0] && Number(rj.rows[0].credit_cents) > 0) await pool.query("INSERT INTO ad_credit (user_email, cents, kind, ref_id, note) VALUES ($1, $2, 'refund', $3, $4)", [rj.rows[0].user_email, Number(rj.rows[0].credit_cents), id, 'A' + id + ' not approved']);   // 💳 the credit comes back
    audit(a.adminEmail, 'ad_reject', id, '');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});
app.post('/api/admin/ad-requests/activate', async (req, res) => {          // money is confirmed by a Super Admin only
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can start a paid ad.' });
    const id = parseInt(req.body.id, 10); if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Bad id.' });
    const out = await activateAdRequest(id, a.adminEmail);
    if (!out.ok) return res.status(400).json({ success: false, error: out.error });
    res.json({ success: true, adId: out.adId });
  } catch (err) { console.error('[admin] ad activate:', err.message); res.status(500).json({ success: false, error: 'Could not start the ad.' }); }
});
async function activateAdRequest(id, by) {
  {
    const a = { adminEmail: by };
    const q = (await pool.query("SELECT * FROM ad_requests WHERE id = $1 AND status IN ('quoted', 'payment_sent')", [id])).rows[0];
    if (!q) return { ok: false, error: 'This request is not ready to start (already started or cancelled).' };
    let media = q.media_url, base = { likes: 0, comments: 0, shares: 0 };
    if (q.post_id) {                                                        // a boosted post: remember the numbers it had on day one
      const p = (await pool.query(`SELECT p.id, (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS likes, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comments,
        (SELECT COUNT(*) FROM posts sp WHERE sp.shared_post_id = p.id)::int AS shares FROM posts p WHERE p.id = $1 AND p.user_email = $2 AND COALESCE(p.privacy, 'public') = 'public'`, [q.post_id, q.user_email])).rows[0];
      if (!p) return { ok: false, error: 'The post is no longer public or was deleted.' };
      base = p; media = null;
    }
    const lock = await pool.query("UPDATE ad_requests SET status = 'starting', updated_at = NOW() WHERE id = $1 AND status IN ('quoted', 'payment_sent') RETURNING id", [id]);   // two presses at once: only one ad
    if (!lock.rowCount) return { ok: false, error: 'Already started.' };
    const undo = () => pool.query("UPDATE ad_requests SET status = $2 WHERE id = $1 AND status = 'starting'", [id, q.status]).catch(() => {});
    const ad = await pool.query(`INSERT INTO sponsored_ads (advertiser_name, placement, caption, target_url, media_url, skip_seconds, created_by, ends_at, objective, post_id, interests, country, budget_cents, days, cpm_feed_cents, cpm_video_cents, owner_email, cta, base_likes, base_comments, base_shares,
        items, kw_ids, provinces, age_min, age_max, gender, adult, places, devices)
      VALUES ($1,$2,$3,$4,$5,5,$6, NOW() + ($7 || ' days')::interval, $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
      [q.business_name, q.placement, q.caption, q.target_url, media, a.adminEmail, String(q.days), q.objective, q.post_id, q.interests || '', q.country || '', q.budget_cents || 0, q.days,
        AD_CPM.feed * 100, AD_CPM.video * 100, q.user_email, q.cta || 'learn_more', base.likes, base.comments, base.shares, q.items || '', q.kw_ids || '', q.provinces || '', q.age_min || 0, q.age_max || 0, q.gender || '', !!q.adult, q.places || '', q.devices || '']).catch(async (e) => { await undo(); throw e; });
    await pool.query("UPDATE ad_requests SET status = 'live', ad_id = $1, updated_at = NOW() WHERE id = $2", [ad.rows[0].id, id]);
    audit(a.adminEmail, 'ad_activate', id, 'ad #' + ad.rows[0].id + ' for ' + q.days + ' days, budget $' + ((q.budget_cents || 0) / 100).toFixed(2) + ', paid $' + ((q.price_cents || 0) / 100).toFixed(2));
    sendAdminNotice(a.adminEmail, q.user_email, '📢 CamFeed បានទទួលប្រាក់ $' + ((q.price_cents || 0) / 100).toFixed(2) + ' ហើយ។ ពាណិជ្ជកម្ម A' + id + ' របស់អ្នកចាប់ផ្ដើមបង្ហាញហើយ។ អរគុណ!', 'admin_notice').catch(() => {});
    return { ok: true, adId: ad.rows[0].id };
  }
}
// 💰 the owner pressed ✅ / ❌ on Telegram
async function onPaymentDecision(kind, id, ok, by) {
  if (kind === 'wd') {                                    // 💵 a withdrawal: ✅ = paid (only after the waiting time), ❌ = refused (the money goes back)
    const r = await decideWithdrawal(id, ok ? 'paid' : 'rejected', ok ? '' : 'CamFeed មិនអាចផ្ទេរបានទេ។ សូមពិនិត្យឈ្មោះ និងលេខគណនី ហើយស្នើម្ដងទៀត', by || 'telegram', '', false);
    return { ok: r.ok, text: r.ok ? (ok ? '💵 W' + id + ' បានបង់ — បានប្រាប់ម្ចាស់ហើយ' : '❌ W' + id + ' បដិសេធ — លុយត្រឡប់ចូលកាបូបវិញ') : r.error };
  }
  if (kind === 'aw') return adWallet.decideManual(id, ok, by || 'telegram');   // 💳 "I have paid" into the ad wallet
  if (kind === 'coin') return coins.decideTopup(id, ok, ok ? '' : 'CamFeed មិនទាន់ឃើញប្រាក់ចូលគណនីទេ', by);
  if (kind !== 'ad') return { ok: false, text: 'Unknown.' };
  if (ok) { const r = await activateAdRequest(id, by); return { ok: r.ok, text: r.ok ? '📢 ពាណិជ្ជកម្ម A' + id + ' ចាប់ផ្ដើមហើយ' : r.error }; }
  const r = await pool.query("UPDATE ad_requests SET status = 'quoted', admin_note = $2, updated_at = NOW() WHERE id = $1 AND status = 'payment_sent' RETURNING user_email, price_cents", [id, 'CamFeed មិនទាន់ឃើញប្រាក់ចូលទេ។ សូមពិនិត្យការផ្ទេរ ហើយចុច «ខ្ញុំបានបង់ហើយ» ម្ដងទៀត ឬទាក់ទង CamFeed។']);
  if (!r.rowCount) return { ok: false, text: 'Already decided.' };
  sendAdminNotice(by, r.rows[0].user_email, '📢 ពាណិជ្ជកម្ម A' + id + '៖ CamFeed មិនទាន់ឃើញប្រាក់ $' + (Number(r.rows[0].price_cents || 0) / 100).toFixed(2) + ' ចូលគណនីទេ។ សូមពិនិត្យ ហើយចុច «ខ្ញុំបានបង់ហើយ» ម្ដងទៀត។', 'admin_notice').catch(() => {});
  return { ok: true, text: 'បានប្រាប់អ្នកផ្សាយ' };
}

// ---------------------------------------------------------------------------
// Monetization (Creator Program): rules, wallet (a ledger of cents), withdrawals paid BY HAND, referrals.
// No money moves automatically: bonuses are added by a Super Admin and withdrawals are paid by the owner (ABA / Wing / KHQR).
// ---------------------------------------------------------------------------
// stickers on a story (emoji, small pictures, text): kept as a small list, checked and cleaned here
const OV_EMOJI = /^[\p{Extended_Pictographic}\u200d\ufe0f\u20e3\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}]{1,12}$/u;
const OV_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9 ,.]{5,30}\))$/;
function cleanOverlays(raw, mediaBase) {
  let arr = raw; if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { return []; } }
  if (!Array.isArray(arr)) return [];
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d; };
  const out = [];
  for (const o of arr.slice(0, 20)) {
    if (!o || typeof o !== 'object') continue;
    const base = { x: num(o.x, 0, 1, 0.5), y: num(o.y, 0, 1, 0.5), s: num(o.s, 0.03, 1.2, 0.15), r: num(o.r, -360, 360, 0) };
    if (o.type === 'emoji') { const e = String(o.e || ''); if (!OV_EMOJI.test(e)) continue; out.push(Object.assign({ type: 'emoji', e }, base)); }
    else if (o.type === 'text') {
      const t = String(o.t || '').replace(/\r/g, '').trim().slice(0, 120); if (!t) continue;
      out.push(Object.assign({ type: 'text', t, c: OV_COLOR.test(String(o.c || '')) ? o.c : '#ffffff', bg: OV_COLOR.test(String(o.bg || '')) ? o.bg : '' }, base));
    } else if (o.type === 'image') {
      const u = String(o.u || ''); if (!u.startsWith(mediaBase) || /[\s"'<>`\\]/.test(u) || u.length > 500) continue;
      out.push(Object.assign({ type: 'image', u }, base));
    } else if (o.type === 'mention') {
      // @ a friend: shown as "@name", tap = their profile; "user_email" is turned into the public id when sent to the apps
      const em = String(o.user_email || '').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) && !/^\+?\d{6,16}$/.test(em)) continue;
      if (out.filter((x) => x.type === 'mention').length >= 10) continue;
      out.push(Object.assign({ type: 'mention', user_email: em, n: String(o.n || '').replace(/[\r\n]/g, ' ').trim().slice(0, 40) }, base));
    }
  }
  return out;
}
// ---- Stories: a picture, a short video or a text card that disappears after 24 hours ----
const STORY_HOURS = 24, STORY_EMOJI = ['❤️', '😂', '😮', '😢', '👏', '🔥'], STORY_BG = ['blue', 'pink', 'green', 'orange', 'purple', 'dark'];
const storyMediaBase = () => String(process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').replace(/\/+$/, '') + '/';
const NOT_BLOCKED = (a, b) => `NOT EXISTS (SELECT 1 FROM blocked_users bl WHERE (bl.blocker_email = ${a} AND bl.blocked_email = ${b}) OR (bl.blocker_email = ${b} AND bl.blocked_email = ${a}))`;
// can `viewer` see story `s`? (own stories, or the author is followed and — for "friends only" — follows back)
async function canSeeStory(viewer, id) {
  const r = await pool.query(
    `SELECT s.*, u.first_name, u.last_name FROM stories s JOIN users u ON u.email = s.user_email
     WHERE s.id = $1 AND s.expires_at > NOW() AND COALESCE(u.is_banned, FALSE) = FALSE AND ${NOT_BLOCKED('s.user_email', '$2')}
       AND ${audience.storyVisibleSql('s', '$2')}`, [id, viewer || '']);
  return r.rows[0] || null;
}
app.post('/api/stories', async (req, res) => {
  const b = req.body || {}, email = req.authEmail;
  try {
    const type = ['image', 'video', 'text'].includes(b.mediaType) ? b.mediaType : '';
    if (!type) return res.status(400).json({ success: false, error: 'Please choose a picture, a video or write a text.' });
    const caption = String(b.caption || '').replace(/\r/g, '').trim().slice(0, 200);
    let url = null;
    if (type === 'text') { if (!caption) return res.status(400).json({ success: false, error: 'Please write something.' }); }
    else { url = String(b.mediaUrl || ''); if (!url.startsWith(storyMediaBase()) || /[\s"'<>`\\]/.test(url) || url.length > 500) return res.status(400).json({ success: false, error: 'Invalid file.' }); }
    const bg = STORY_BG.includes(b.bg) ? b.bg : 'blue';
    const aud = await audience.prepare(email, b.privacy, b.audience);
    if (!aud.ok) return res.status(400).json({ success: false, error: aud.error });
    const privacy = aud.people.length ? 'private' : aud.privacy;     // with chosen people: opened only after they are saved
    const active = Number((await pool.query('SELECT COUNT(*) AS n FROM stories WHERE user_email = $1 AND expires_at > NOW()', [email])).rows[0].n);
    if (active >= 30) return res.status(429).json({ success: false, error: 'You already have 30 stories today. Please wait until some of them disappear.' });
    let soundId = null, sStart = 0, sLen = 15;
    if (b.soundId) {
      const sd = (await pool.query('SELECT id, duration FROM sounds WHERE id = $1 AND active = TRUE', [parseInt(b.soundId, 10) || 0])).rows[0];
      if (!sd) return res.status(400).json({ success: false, error: 'This sound is not available any more. Please choose another.' });
      soundId = sd.id; sLen = Math.min(Math.max(parseInt(b.soundLen, 10) || 15, 5), 30); sStart = Math.min(Math.max(parseInt(b.soundStart, 10) || 0, 0), Math.max(0, sd.duration - 5));
    }
    const r = await pool.query("INSERT INTO stories (user_email, media_type, media_url, caption, bg, privacy, expires_at, sound_id, sound_start, sound_len, overlays) VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours', $7, $8, $9, $10) RETURNING id", [email, type, url, caption || null, bg, privacy, soundId, sStart, sLen, type === 'text' ? null : (cleanOverlays(b.overlays, storyMediaBase()).length ? JSON.stringify(cleanOverlays(b.overlays, storyMediaBase())) : null)]);
    if (aud.people.length) {
      await audience.save('story', r.rows[0].id, aud.people);
      await pool.query('UPDATE stories SET privacy = $1 WHERE id = $2', [aud.privacy, r.rows[0].id]);
    }
    if (soundId) pool.query('UPDATE sounds SET uses = uses + 1 WHERE id = $1', [soundId]).catch(() => {});
    if (type === 'video') setTimeout(() => { backfillFeedVideos().catch(() => {}); }, 3000);   // its small quick-start copy is made right away
    tellStoryMentions(r.rows[0].id, email, type === 'text' ? [] : cleanOverlays(b.overlays, storyMediaBase())).catch(() => {});
    res.status(201).json({ success: true, id: r.rows[0].id });
  } catch (err) { console.error('[story] create error:', err.message); res.status(500).json({ success: false, error: 'Could not post your story.' }); }
});

// 📣 the people @-mentioned in a story hear about it (only those who are allowed to see the story)
async function tellStoryMentions(storyId, by, overlays) {
  const who = [...new Set(overlays.filter((o) => o.type === 'mention').map((o) => o.user_email))].filter((e) => e !== String(by).toLowerCase());
  if (!who.length) return;
  const u = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [by])).rows[0] || {};
  const nm = `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'CamFeed';
  for (const e of who) {
    const real = (await pool.query('SELECT email FROM users WHERE LOWER(email) = $1', [e])).rows[0];
    if (!real || !(await canSeeStory(real.email, storyId))) continue;
    await pool.query('INSERT INTO notifications (recipient_email, sender_email, type, message, is_read) VALUES ($1, $2, $3, $4, FALSE)', [real.email, by, 'story_mention', `${nm} បាន Mention អ្នកក្នុង Story`]).catch(() => {});
  }
}

app.get('/api/stories/feed', async (req, res) => {
  const me = req.authEmail;
  try {
    const r = await pool.query(
      `SELECT s.id, s.user_email, s.media_type, s.media_url, s.feed_url, s.caption, s.bg, s.privacy, s.created_at, s.expires_at, u.first_name, u.last_name, u.profile_pic,
              (v.story_id IS NOT NULL) AS seen, rx.emoji AS my_reaction,
              (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.id)::int AS views, (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.id)::int AS reactions,
              sd.id AS snd_id, sd.title AS snd_title, sd.artist AS snd_artist, sd.audio_url AS snd_url, s.sound_start, s.sound_len, s.overlays
       FROM stories s JOIN users u ON u.email = s.user_email
       LEFT JOIN sounds sd ON sd.id = s.sound_id AND sd.active = TRUE
       LEFT JOIN story_views v ON v.story_id = s.id AND v.viewer_email = $1
       LEFT JOIN story_reactions rx ON rx.story_id = s.id AND rx.viewer_email = $1
       WHERE s.expires_at > NOW() AND COALESCE(u.is_banned, FALSE) = FALSE AND ${NOT_BLOCKED('s.user_email', '$1')}
         AND ${audience.storyVisibleSql('s', '$1')}
       ORDER BY s.created_at ASC LIMIT 400`, [me || '']);
    const groups = new Map();
    for (const x of r.rows) {
      let g = groups.get(x.user_email);
      if (!g) { g = { user_email: x.user_email, name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), profile_pic: x.profile_pic || '', mine: x.user_email === me, allSeen: true, latest: 0, stories: [] }; groups.set(x.user_email, g); }
      const mine = x.user_email === me;
      g.stories.push({ id: x.id, mediaType: x.media_type, mediaUrl: x.media_url || '', feedUrl: x.feed_url || '', caption: x.caption || '', bg: x.bg || 'blue', privacy: x.privacy, created_at: x.created_at, expires_at: x.expires_at, seen: !!x.seen || mine, myReaction: x.my_reaction || '', overlays: x.overlays ? cleanOverlays(x.overlays, storyMediaBase()) : [], sound: x.snd_id ? { id: x.snd_id, title: x.snd_title, artist: x.snd_artist || '', url: x.snd_url, start: x.sound_start, len: x.sound_len } : null, views: mine ? x.views : undefined, reactions: mine ? x.reactions : undefined });
      if (!x.seen && !mine) g.allSeen = false;
      g.latest = Math.max(g.latest, new Date(x.created_at).getTime());
    }
    const list = [...groups.values()].sort((a, b) => (b.mine - a.mine) || (a.allSeen - b.allSeen) || (b.latest - a.latest));
    res.json({ success: true, groups: list });
  } catch (err) { console.error('[story] feed error:', err.message); res.status(500).json({ success: false, error: 'Could not load stories.' }); }
});

app.post('/api/stories/:id/view', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail; if (!id) return res.json({ success: false });
    const st = await canSeeStory(me, id); if (!st) return res.status(404).json({ success: false });
    if (st.user_email !== me) await pool.query('INSERT INTO story_views (story_id, viewer_email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, me]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/stories/:id/viewers', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    const st = (await pool.query('SELECT user_email FROM stories WHERE id = $1', [id])).rows[0];
    if (!st || st.user_email !== me) return res.status(404).json({ success: false });
    const r = await pool.query(
      `SELECT v.viewer_email AS user_email, v.viewed_at, u.first_name, u.last_name, u.profile_pic, rx.emoji
       FROM story_views v JOIN users u ON u.email = v.viewer_email LEFT JOIN story_reactions rx ON rx.story_id = v.story_id AND rx.viewer_email = v.viewer_email
       WHERE v.story_id = $1 ORDER BY v.viewed_at DESC LIMIT 200`, [id]);
    res.json({ success: true, viewers: r.rows.map((x) => ({ user_email: x.user_email, name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), profile_pic: x.profile_pic || '', viewed_at: x.viewed_at, emoji: x.emoji || '' })) });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/stories/:id/react', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail, emoji = String((req.body || {}).emoji || '');
    if (!STORY_EMOJI.includes(emoji)) return res.status(400).json({ success: false, error: 'Invalid reaction.' });
    const st = await canSeeStory(me, id); if (!st) return res.status(404).json({ success: false });
    if (st.user_email === me) return res.status(400).json({ success: false, error: 'You cannot react to your own story.' });
    const r = await pool.query('INSERT INTO story_reactions (story_id, viewer_email, emoji) VALUES ($1, $2, $3) ON CONFLICT (story_id, viewer_email) DO UPDATE SET emoji = $3 RETURNING (xmax = 0) AS fresh', [id, me, emoji]);
    if (r.rows[0] && r.rows[0].fresh) {
      const who = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [me])).rows[0] || {};
      await pool.query("INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, NULL, 'story_reaction', $3, FALSE)", [st.user_email, me, `${who.first_name || ''} ${who.last_name || ''}`.trim() + ' បានប្រតិកម្ម ' + emoji + ' ទៅលើរឿង (Story) របស់អ្នក។']).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { console.error('[story] react error:', err.message); res.status(500).json({ success: false }); }
});

app.post('/api/stories/:id/reply', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail, text = String((req.body || {}).text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return res.status(400).json({ success: false, error: 'Please write a message.' });
    const st = await canSeeStory(me, id); if (!st) return res.status(404).json({ success: false });
    if (st.user_email === me) return res.status(400).json({ success: false, error: 'You cannot reply to your own story.' });
    const limited = await chatExtras.chatAllowed(me, st.user_email);
    if (limited) return chatExtras.deny(res, limited);
    await pool.query("INSERT INTO messages (sender_email, receiver_email, message, message_type, is_read) VALUES ($1, $2, $3, 'text', FALSE)", [me, st.user_email, '↩️ ឆ្លើយតបទៅរឿង (Story)៖ ' + text]);
    res.json({ success: true });
  } catch (err) { console.error('[story] reply error:', err.message); res.status(500).json({ success: false }); }
});

app.delete('/api/stories/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    const d = await pool.query('DELETE FROM stories WHERE id = $1 AND user_email = $2 RETURNING media_url', [id, me]);
    if (!d.rows.length) return res.status(404).json({ success: false });
    await pool.query('DELETE FROM story_views WHERE story_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM story_reactions WHERE story_id = $1', [id]).catch(() => {});
    if (d.rows[0].media_url) cleanup.purgeMediaUrls([d.rows[0].media_url]).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// every hour: remove stories that have run out (the row, the views and the file in storage)
async function sweepStories() {
  try {
    const d = await pool.query("DELETE FROM stories WHERE expires_at < NOW() - INTERVAL '5 minutes' RETURNING id, media_url, overlays");
    if (!d.rows.length) return;
    const ids = d.rows.map((x) => x.id);
    await pool.query('DELETE FROM story_views WHERE story_id = ANY($1::int[])', [ids]).catch(() => {});
    await pool.query('DELETE FROM story_reactions WHERE story_id = ANY($1::int[])', [ids]).catch(() => {});
    const urls = d.rows.map((x) => x.media_url).filter(Boolean);
    for (const x of d.rows) { try { for (const o of JSON.parse(x.overlays || '[]')) if (o && o.type === 'image' && o.u) urls.push(o.u); } catch (e) {} }   // sticker pictures go too
    if (urls.length) await cleanup.purgeMediaUrls(urls).catch(() => {});
  } catch (err) { console.error('[story] sweep error:', err.message); }
}
setTimeout(sweepStories, 2 * 60 * 1000); setInterval(sweepStories, 60 * 60 * 1000);

// ---- 🕘 Videos I watched: where I stopped, so a half-watched video can be found again and go on from there ----
let watchReady = false;
async function watchEnsure() {
  if (watchReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS watch_history (user_email TEXT NOT NULL, post_id INTEGER NOT NULL, secs INTEGER NOT NULL DEFAULT 0, duration INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_email, post_id))`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_watch_history_user ON watch_history (user_email, updated_at DESC)');
  watchReady = true;
}
let watchSwept = 0;
app.post('/api/watch', async (req, res) => {
  const me = String(req.authEmail || '').toLowerCase(); const b = req.body || {};
  const pid = parseInt(b.post_id, 10) || 0, secs = Math.max(0, Math.min(parseInt(b.secs, 10) || 0, 86400)), dur = Math.max(0, Math.min(parseInt(b.duration, 10) || 0, 86400));
  if (!me || !pid) return res.json({ success: false });
  try {
    await watchEnsure();
    const prevW = (await pool.query('SELECT secs FROM watch_history WHERE user_email = $1 AND post_id = $2', [me, pid])).rows[0];
    try { interests.onWatch(me, pid, secs, dur, prevW); } catch (e) {}
    await pool.query(`INSERT INTO watch_history (user_email, post_id, secs, duration, updated_at) VALUES ($1, $2, $3, $4, NOW())
                      ON CONFLICT (user_email, post_id) DO UPDATE SET secs = $3, duration = GREATEST(watch_history.duration, $4), updated_at = NOW()`, [me, pid, secs, dur]);
    if (Date.now() - watchSwept > 6 * 3600 * 1000) { watchSwept = Date.now(); pool.query("DELETE FROM watch_history WHERE updated_at < NOW() - ($1::text || ' days')::interval", [String(appConfig.cfg().watchHistoryDays)]).catch(() => {}); }   // kept N days (Admin > System > App features)
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});
app.get('/api/watch-history', async (req, res) => {
  const me = String(req.authEmail || '').toLowerCase(); if (!me) return res.status(401).json({ success: false });
  try {
    await watchEnsure();
    const r = await pool.query(`SELECT w.post_id, w.secs, w.duration, w.updated_at, p.content, p.media_url, p.media_type, p.thumb_url, p.feed_url, p.user_email, u.first_name, u.last_name, u.profile_pic
      FROM watch_history w JOIN posts p ON p.id = w.post_id JOIN users u ON u.email = p.user_email
      WHERE w.user_email = $1 AND ${audience.postVisibleSql('p', '$1')}
        AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_email = $1 AND b.blocked_email = p.user_email) OR (b.blocker_email = p.user_email AND b.blocked_email = $1))
      ORDER BY w.updated_at DESC LIMIT 150`, [me]);
    res.json({ success: true, videos: r.rows });
  } catch (e) { console.error('[watch] list:', e.message); res.status(500).json({ success: false, videos: [] }); }
});
app.post('/api/watch-history/clear', async (req, res) => {
  const me = String(req.authEmail || '').toLowerCase(); if (!me) return res.status(401).json({ success: false });
  try {
    await watchEnsure();
    const pid = parseInt((req.body || {}).post_id, 10) || 0;
    if (pid) await pool.query('DELETE FROM watch_history WHERE user_email = $1 AND post_id = $2', [me, pid]);
    else await pool.query('DELETE FROM watch_history WHERE user_email = $1', [me]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

// ---- Sounds (music for Stories): a library the admin fills, search, and "saved" sounds per person ----
app.get('/api/sounds', async (req, res) => {
  const me = req.authEmail, q = String(req.query.q || '').trim().slice(0, 60), tab = req.query.tab === 'saved' ? 'saved' : 'all';
  try {
    const r = await pool.query(
      `SELECT sd.id, sd.title, sd.artist, sd.audio_url, sd.cover_url, sd.duration, sd.uses, (ss.sound_id IS NOT NULL) AS saved
       FROM sounds sd LEFT JOIN saved_sounds ss ON ss.sound_id = sd.id AND ss.user_email = $1
       WHERE sd.active = TRUE AND (sd.post_id IS NULL OR ss.sound_id IS NOT NULL) AND ($2 = '' OR sd.title ILIKE '%' || $2 || '%' OR COALESCE(sd.artist, '') ILIKE '%' || $2 || '%')
         AND ($3 = 'all' OR ss.sound_id IS NOT NULL)
       ORDER BY (CASE WHEN $3 = 'saved' THEN ss.created_at ELSE sd.created_at END) DESC, sd.uses DESC, sd.id DESC LIMIT 80`, [me, likeEsc(q), tab]);
    res.json({ success: true, sounds: r.rows.map((x) => ({ id: x.id, title: x.title, artist: x.artist || '', url: x.audio_url, cover: x.cover_url || '', duration: x.duration, uses: x.uses, saved: !!x.saved })) });
  } catch (err) { res.status(500).json({ success: false, sounds: [] }); }
});
app.post('/api/sounds/:id/save', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail; if (!id) return res.status(400).json({ success: false });
    const ex = (await pool.query('SELECT 1 FROM saved_sounds WHERE user_email = $1 AND sound_id = $2', [me, id])).rows[0];
    if (ex) { await pool.query('DELETE FROM saved_sounds WHERE user_email = $1 AND sound_id = $2', [me, id]); return res.json({ success: true, saved: false }); }
    const have = Number((await pool.query('SELECT COUNT(*) AS n FROM saved_sounds WHERE user_email = $1', [me])).rows[0].n);
    if (have >= 200) return res.status(400).json({ success: false, error: 'You can save up to 200 sounds.' });
    const ok = (await pool.query('SELECT 1 FROM sounds WHERE id = $1 AND active = TRUE', [id])).rows[0]; if (!ok) return res.status(404).json({ success: false });
    await pool.query('INSERT INTO saved_sounds (user_email, sound_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, id]);
    res.json({ success: true, saved: true });
  } catch (err) { res.status(500).json({ success: false }); }
});
// "Save sound" from a video's ⋮ menu: the video's own audio becomes a sound in the person's saved list
function soundTitleOf(content) {
  const t = String(content || '').replace(/\s+/g, ' ').trim();
  return '🎬 សំឡេងពីវីដេអូ' + (t ? ' · ' + (t.length > 40 ? t.slice(0, 40) + '…' : t) : '');
}
// the sound of a video → a small audio file (AAC .m4a, starts at once): the whole video file was big and played badly in Party Rooms
const soundAudioBusy = new Set();
async function makeSoundAudio(id, src) {
  if (!thumbsReady() || soundAudioBusy.has(id)) return; soundAudioBusy.add(id);
  const fs = require('fs'), os = require('os'), path = require('path'), { execFile } = require('child_process');
  const out = path.join(os.tmpdir(), 'camfeed-snd-' + id + '-' + Date.now() + '.m4a');
  let bin = 'ffmpeg'; try { bin = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}
  try {
    await new Promise((ok, no) => execFile(bin, ['-y', '-i', src, '-vn', '-t', '1800', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-threads', '1', out],
      { timeout: 8 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 }, (e) => e ? no(e) : ok()));
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (size < 1000) { await pool.query('UPDATE sounds SET audio_ready = TRUE WHERE id = $1', [id]).catch(() => {}); return; }
    const url = await r2PutBuffer('sounds/' + Date.now() + '-' + require('crypto').randomBytes(4).toString('hex') + '.m4a', fs.readFileSync(out), 'audio/mp4');
    const secs = await videoSecs(out).catch(() => null);
    if (url) {
      await pool.query('UPDATE sounds SET audio_url = $2, audio_ready = TRUE, duration = COALESCE($3, duration) WHERE id = $1', [id, url, secs ? Math.max(1, Math.round(secs)) : null]);
      await pool.query('UPDATE party_rooms SET music_url = $2 WHERE music_id = $1', [id, url]).catch(() => {});   // a room playing it now switches to the small file
      console.log('[sounds] audio ready for sound', id);
    }
  } catch (e) {
    console.error('[sounds] ffmpeg:', String(e.message || e).slice(0, 200));
    await pool.query('UPDATE sounds SET audio_ready = TRUE WHERE id = $1', [id]).catch(() => {});   // do not try again and again
  } finally { soundAudioBusy.delete(id); try { fs.unlinkSync(out); } catch (e) {} }
}
// once: old "សំឡេងដើម · <name>" titles are renamed; sounds still using a whole video file get their small audio file (one at a time)
let soundFixReady = false;
async function fixVideoSounds() {
  try {
    if (!soundFixReady) {
      await pool.query('ALTER TABLE sounds ADD COLUMN IF NOT EXISTS audio_ready BOOLEAN DEFAULT FALSE');
      const old = (await pool.query("SELECT s.id, p.content FROM sounds s LEFT JOIN posts p ON p.id = s.post_id WHERE s.post_id IS NOT NULL AND s.title LIKE 'សំឡេងដើម%'")).rows;
      for (const o of old) {
        const t = soundTitleOf(o.content);
        await pool.query("UPDATE sounds SET title = $2, artist = '' WHERE id = $1", [o.id, t]);
        await pool.query("UPDATE party_rooms SET music_title = $2, music_artist = '' WHERE music_id = $1", [o.id, t]).catch(() => {});
      }
      soundFixReady = true;
    }
    if (!thumbsReady()) return;
    const r = (await pool.query("SELECT id, audio_url FROM sounds WHERE post_id IS NOT NULL AND COALESCE(audio_ready, FALSE) = FALSE ORDER BY id DESC LIMIT 1")).rows[0];
    if (r && r.audio_url) await makeSoundAudio(r.id, r.audio_url);
  } catch (e) { console.error('[sounds] fix:', e.message); }
}
setTimeout(() => { fixVideoSounds(); setInterval(fixVideoSounds, 30 * 1000); }, 45 * 1000);

app.post('/api/sounds/from-post/:postId', async (req, res) => {
  try {
    const me = req.authEmail, pid = parseInt(req.params.postId, 10); if (!me || !pid) return res.status(400).json({ success: false });
    if (!appConfig.cfg().features.saveSound) return res.status(403).json({ success: false, error: 'This is turned off for now.' });
    const row = (await pool.query("SELECT p.id, p.user_email, p.media_type, p.media_url, p.privacy, p.content FROM posts p WHERE p.id = $1", [pid])).rows[0];
    if (!row || (row.privacy && row.privacy !== 'public' && row.user_email !== me)) return res.status(404).json({ success: false });
    const v = pubMedia(row).video; if (!v) return res.status(400).json({ success: false, error: 'No video.' });
    let sd = (await pool.query('SELECT id FROM sounds WHERE post_id = $1', [pid])).rows[0];
    if (!sd) {
      // the person who posted the video is not always the owner of the song → no name of a person, only "sound from a video"
      sd = (await pool.query("INSERT INTO sounds (title, artist, audio_url, duration, created_by, post_id) VALUES ($1, '', $2, 30, $3, $4) ON CONFLICT (post_id) WHERE post_id IS NOT NULL DO UPDATE SET audio_url = EXCLUDED.audio_url RETURNING id", [soundTitleOf(row.content), v, row.user_email, pid])).rows[0];
      makeSoundAudio(sd.id, v);                                                    // a small sound-only file (quick to play), made in the background
    }
    const ex = (await pool.query('SELECT 1 FROM saved_sounds WHERE user_email = $1 AND sound_id = $2', [me, sd.id])).rows[0];
    if (ex) return res.json({ success: true, saved: true, already: true });
    const have = Number((await pool.query('SELECT COUNT(*) AS n FROM saved_sounds WHERE user_email = $1', [me])).rows[0].n);
    if (have >= 200) return res.status(400).json({ success: false, error: 'You can save up to 200 sounds.' });
    await pool.query('INSERT INTO saved_sounds (user_email, sound_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, sd.id]);
    res.json({ success: true, saved: true });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/admin/sounds', async (req, res) => {
  try { const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query('SELECT id, title, artist, audio_url, duration, active, uses, created_at FROM sounds ORDER BY id DESC LIMIT 200');
    res.json({ success: true, sounds: r.rows.map((x) => ({ id: x.id, title: x.title, artist: x.artist || '', url: x.audio_url, duration: x.duration, active: x.active, uses: x.uses })) });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not load.' }); }
});
app.post('/api/admin/sounds/add', async (req, res) => {
  try { const a = await adminGate(req, res); if (!a) return; const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 100), artist = String(b.artist || '').trim().slice(0, 80), url = String(b.audioUrl || ''), dur = Math.min(Math.max(parseInt(b.duration, 10) || 30, 6), 600);
    if (!title) return res.status(400).json({ success: false, error: 'Please write the song name.' });
    if (!url.startsWith(storyMediaBase()) || /[\s"'<>`\\]/.test(url) || url.length > 500) return res.status(400).json({ success: false, error: 'Please upload the audio file first.' });
    const r = await pool.query('INSERT INTO sounds (title, artist, audio_url, duration, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [title, artist || null, url, dur, a.adminEmail]);
    audit(a.adminEmail, 'sound-add', String(r.rows[0].id), title); res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});
app.post('/api/admin/sounds/toggle', async (req, res) => {
  try { const a = await adminGate(req, res); if (!a) return; const id = parseInt((req.body || {}).id, 10), on = (req.body || {}).active === true;
    const r = await pool.query('UPDATE sounds SET active = $2 WHERE id = $1 RETURNING id', [id, on]); if (!r.rows[0]) return res.status(404).json({ success: false });
    audit(a.adminEmail, on ? 'sound-on' : 'sound-off', String(id), ''); res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ---- Live video (Cloudflare Stream; only approved Creators; a finished live is saved as a video post, see live-replay.js) ----
const LIVE_EMOJI = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
const LIVE_MAX_VIEWERS = () => clampInt(process.env.LIVE_MAX_VIEWERS, 100, 1, 5000);
const LIVE_MAX_MINUTES = () => clampInt(process.env.LIVE_MAX_MINUTES, 120, 5, 600);
const LIVE_ALIVE_SECS = 45; // the host's phone says "I'm still here" every ~15 s
const liveConfigured = () => !!(process.env.CLOUDFLARE_ACCOUNT_ID && (process.env.CLOUDFLARE_STREAM_TOKEN || process.env.CLOUDFLARE_API_TOKEN));
async function cfStream(method, path, body) {
  const base = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';
  const token = process.env.CLOUDFLARE_STREAM_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${base}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/stream${path}`, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error('Cloudflare ' + r.status + ' ' + JSON.stringify(j.errors || '').slice(0, 200));
    return j.result || {};
  } finally { clearTimeout(t); }
}
const cfHost = (u) => { try { return new URL(u).origin; } catch (e) { return ''; } };
const liveReplay = require('./live-replay')({
  pool, cf: cfStream, publicBase: () => String(process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').replace(/\/+$/, ''),
  makeThumb: (file) => makeVideoThumb(file),
  ffmpegBin: (() => { try { return require('ffmpeg-static') || 'ffmpeg'; } catch (e) { return 'ffmpeg'; } })(),
  putFile: async (key, file, type) => {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'), fs = require('fs');
    const r2 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || 'camfeed-storage', Key: key, Body: fs.createReadStream(file), ContentLength: fs.statSync(file).size, ContentType: type }));
  }
});
const liveReplayOn = () => liveReplay.enabled() && !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
async function liveEnd(id, by, reason) {
  const r = await pool.query("UPDATE live_streams SET status = 'ended', ended_at = NOW(), ended_by = $2, end_reason = $3 WHERE id = $1 AND status <> 'ended' RETURNING cf_uid, host_email, started_at", [id, by || null, reason || null]);
  const row = r.rows[0]; if (!row) return null;
  // keep the recording for the saver when the live really ran; otherwise tidy Cloudflare now
  if (row.cf_uid && liveConfigured() && liveReplayOn() && row.started_at && (!by || by === row.host_email)) { await pool.query("UPDATE live_streams SET replay_status = 'pending' WHERE id = $1", [id]).catch(() => {}); row.replay = true; }
  else if (row.cf_uid && liveConfigured()) cfStream('DELETE', '/live_inputs/' + encodeURIComponent(row.cf_uid)).catch((e) => console.error('[live] cf delete:', e.message));
  pool.query('DELETE FROM live_viewers WHERE live_id = $1', [id]).catch(() => {});
  return row;
}
// may `viewer` watch live `id`? (the host, or a follower of the host; "friends only" needs the host to follow back)
async function canSeeLive(viewer, id) {
  const r = await pool.query(
    `SELECT l.*, u.first_name, u.last_name, u.profile_pic FROM live_streams l JOIN users u ON u.email = l.host_email
     WHERE l.id = $1 AND COALESCE(u.is_banned, FALSE) = FALSE AND ${NOT_BLOCKED('l.host_email', '$2')}
       AND (l.host_email = $2 OR (EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = $2 AND f.following_email = l.host_email)
            AND (l.privacy = 'public' OR EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_email = l.host_email AND f2.following_email = $2))))`, [id, viewer]);
  return r.rows[0] || null;
}
const liveIsOn = (l) => l && l.status === 'live' && l.last_ping && (Date.now() - new Date(l.last_ping).getTime()) < LIVE_ALIVE_SECS * 1000;
const viewerCount = async (id) => Number((await pool.query("SELECT COUNT(*) AS n FROM live_viewers WHERE live_id = $1 AND last_seen > NOW() - INTERVAL '25 seconds'", [id])).rows[0].n);

const LIVE_PURPOSES = ['news', 'business', 'event', 'education', 'other'];
// may this person go live? approved Live request OR approved Creator; either can be switched off by an admin
async function liveAccess(email) {
  const [lr, ca] = await Promise.all([
    pool.query('SELECT status, blocked, channel_name, note FROM live_requests WHERE user_email = $1', [email]),
    pool.query("SELECT live_blocked FROM creator_applications WHERE user_email = $1 AND status = 'approved'", [email])]);
  const a = lr.rows[0] || null, c = ca.rows[0] || null;
  const blocked = !!((a && a.blocked) || (c && c.live_blocked));
  const ok = !blocked && ((a && a.status === 'approved') || !!c);
  return { ok, blocked, status: blocked ? 'blocked' : ok ? 'approved' : (a ? a.status : 'none'), channelName: (a && a.channel_name) || '', note: (a && a.status === 'rejected' && a.note) || '' };
}
app.get('/api/live/access', async (req, res) => {
  try { const x = await liveAccess(req.authEmail); res.json({ success: true, configured: liveConfigured(), canGoLive: x.ok && liveConfigured(), status: x.status, channelName: x.channelName, note: x.note }); }
  catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/live/request', async (req, res) => {
  const me = req.authEmail, b = req.body || {};
  try {
    const purpose = LIVE_PURPOSES.includes(b.purpose) ? b.purpose : '';
    const message = String(b.message || '').replace(/\r/g, '').trim().slice(0, 600), link = String(b.link || '').trim().slice(0, 200), channel = String(b.channelName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!purpose) return res.status(400).json({ success: false, error: 'Please choose what the Live is for.' });
    if (message.length < 20) return res.status(400).json({ success: false, error: 'Please write a little more (at least 20 letters) about what you will broadcast.' });
    if (link && !/^https?:\/\/[^\s"'<>`\\]+$/i.test(link)) return res.status(400).json({ success: false, error: 'The link must start with http:// or https://' });
    const cur = await liveAccess(me);
    if (cur.ok || cur.blocked) return res.status(400).json({ success: false, error: cur.blocked ? 'Live is turned off for your account.' : 'You can already go live.' });
    if (cur.status === 'pending') return res.status(400).json({ success: false, error: 'Your request is already waiting for review.' });
    await pool.query(
      `INSERT INTO live_requests (user_email, status, purpose, message, link, channel_name, requested_at, decided_at, decided_by, note) VALUES ($1,'pending',$2,$3,$4,$5,NOW(),NULL,NULL,NULL)
       ON CONFLICT (user_email) DO UPDATE SET status = 'pending', purpose = $2, message = $3, link = $4, channel_name = $5, requested_at = NOW(), decided_at = NULL, decided_by = NULL, note = NULL`, [me, purpose, message, link || null, channel || null]);
    // tell the admins (bell) — the Live tab in Admin also shows a red number
    const who = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [me])).rows[0] || {};
    const admins = await pool.query("SELECT email FROM users WHERE role IN ('admin', 'super_admin') AND COALESCE(is_banned, FALSE) = FALSE LIMIT 50");
    for (const a of admins.rows) await pool.query("INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, NULL, 'admin_notice', $3, FALSE)", [a.email, me, `🔴 New Live request from ${`${who.first_name || ''} ${who.last_name || ''}`.trim() || 'a member'} (${purpose}). Open Admin → Live to review.`]).catch(() => {});
    res.status(201).json({ success: true });
  } catch (err) { console.error('[live] request error:', err.message); res.status(500).json({ success: false, error: 'Could not send your request.' }); }
});
app.post('/api/admin/live/requests', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query(
      `SELECT q.id, q.status, q.purpose, q.message, q.link, q.channel_name, q.requested_at, q.decided_at, q.decided_by, q.note, q.blocked, u.first_name, u.last_name, u.public_id
       FROM live_requests q JOIN users u ON u.email = q.user_email ORDER BY (q.status = 'pending') DESC, q.requested_at DESC LIMIT 80`);
    res.json({ success: true, pending: r.rows.filter((x) => x.status === 'pending').length, requests: r.rows.map((x) => ({ id: x.id, status: x.status, purpose: x.purpose, message: x.message, link: x.link || '', channelName: x.channel_name || '', requested_at: x.requested_at, decided_at: x.decided_at, note: x.note || '', blocked: x.blocked, name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), public_id: x.public_id || '' })) });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not load.' }); }
});
app.post('/api/admin/live/decide', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const id = parseInt((req.body || {}).id, 10), approve = (req.body || {}).approve === true, note = String((req.body || {}).note || '').trim().slice(0, 300);
    if (!approve && !note) return res.status(400).json({ success: false, error: 'Please write the reason for refusing.' });
    const r = await pool.query("UPDATE live_requests SET status = $2, decided_at = NOW(), decided_by = $3, note = $4 WHERE id = $1 AND status = 'pending' RETURNING user_email", [id, approve ? 'approved' : 'rejected', a.adminEmail, approve ? null : note]);
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'This request was already answered.' });
    audit(a.adminEmail, approve ? 'live-approve' : 'live-reject', r.rows[0].user_email, note);
    sendAdminNotice(a.adminEmail, r.rows[0].user_email, approve ? '✅ Your Live request was approved. You can now go live from the Upload page.' : '❌ Your Live request was not approved. Reason: ' + note + ' You may send a new request.').catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});
app.post('/api/live/start', async (req, res) => {
  const me = req.authEmail, b = req.body || {};
  try {
    if (!liveConfigured()) return res.status(503).json({ success: false, error: 'Live is not switched on yet.' });
    const acc = await liveAccess(me);
    if (acc.blocked) return res.status(403).json({ success: false, error: 'Live is turned off for your account.' });
    if (!acc.ok) return res.status(403).json({ success: false, error: 'Live needs approval first. Please send a request.', needRequest: true });
    const u = (await pool.query('SELECT is_banned FROM users WHERE email = $1', [me])).rows[0]; if (!u || u.is_banned) return res.status(403).json({ success: false, error: 'Not allowed.' });
    const old = await pool.query("SELECT id FROM live_streams WHERE host_email = $1 AND status <> 'ended'", [me]);
    for (const o of old.rows) await liveEnd(o.id, me, 'replaced');
    const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 100), privacy = b.privacy === 'friends' ? 'friends' : 'public';
    const cf = await cfStream('POST', '/live_inputs', { meta: { name: 'camfeed-' + Date.now() }, recording: { mode: liveReplayOn() ? 'automatic' : 'off' } });
    const whip = cf.webRTC && cf.webRTC.url; if (!cf.uid || !whip) throw new Error('Cloudflare gave no WebRTC address (is Stream WebRTC available on this account?)');
    const origin = cfHost(whip);
    const whep = (cf.webRTCPlayback && cf.webRTCPlayback.url) || `${origin}/${cf.uid}/webRTC/play`, iframe = `${origin}/${cf.uid}/iframe`;
    const r = await pool.query('INSERT INTO live_streams (host_email, title, privacy, cf_uid, whip_url, whep_url, iframe_url, last_ping, display_name) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8) RETURNING id', [me, title || null, privacy, cf.uid, whip, whep, iframe, (b.asChannel === true && acc.channelName) ? acc.channelName : null]);
    res.status(201).json({ success: true, id: r.rows[0].id, whipUrl: whip, maxMinutes: LIVE_MAX_MINUTES() });
  } catch (err) { console.error('[live] start error:', err.message); res.status(500).json({ success: false, error: 'Could not start the live. Please try again.' }); }
});
// the phone is connected → the live is visible; tell the followers once
app.post('/api/live/:id/go', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    const r = await pool.query("UPDATE live_streams SET status = 'live', started_at = NOW(), last_ping = NOW() WHERE id = $1 AND host_email = $2 AND status = 'created' RETURNING title, privacy", [id, me]);
    if (!r.rows[0]) return res.json({ success: true, already: true });
    const l = r.rows[0], name = ((await pool.query("SELECT first_name, last_name FROM users WHERE email = $1", [me])).rows[0]) || {};
    const who = `${name.first_name || ''} ${name.last_name || ''}`.trim() || 'Someone';
    await pool.query(
      `INSERT INTO notifications (recipient_email, sender_email, post_id, comment_id, type, message, is_read)
       SELECT f.follower_email, $1, NULL, $2, 'live', $3, FALSE FROM follows f
       WHERE f.following_email = $1 AND ($4 = 'public' OR EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_email = $1 AND f2.following_email = f.follower_email))
         AND ${NOT_BLOCKED('$1', 'f.follower_email')} LIMIT 1000`, [me, id, `${who} is live now 🔴${l.title ? ' — ' + l.title : ''}`, l.privacy]).catch((e) => console.error('[live] notify:', e.message));
    res.json({ success: true });
  } catch (err) { console.error('[live] go error:', err.message); res.status(500).json({ success: false }); }
});
app.post('/api/live/:id/ping', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), me = req.authEmail;
    const r = await pool.query("UPDATE live_streams SET last_ping = NOW() WHERE id = $1 AND host_email = $2 AND status <> 'ended' RETURNING started_at", [id, me]);
    if (!r.rows[0]) { const e = (await pool.query('SELECT ended_by, end_reason FROM live_streams WHERE id = $1 AND host_email = $2', [id, me])).rows[0]; return res.json({ success: true, ended: true, byAdmin: !!(e && e.ended_by && e.ended_by !== me), reason: (e && e.end_reason) || '' }); }
    const v = await viewerCount(id); await pool.query('UPDATE live_streams SET peak = GREATEST(peak, $2) WHERE id = $1', [id, v]);
    res.json({ success: true, ended: false, viewers: v });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/live/:id/end', async (req, res) => {
  try { const id = parseInt(req.params.id, 10); const own = (await pool.query('SELECT 1 FROM live_streams WHERE id = $1 AND host_email = $2', [id, req.authEmail])).rows[0]; if (!own) return res.status(404).json({ success: false }); await liveEnd(id, req.authEmail, 'host'); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/live/active', async (req, res) => {
  const me = req.authEmail;
  try {
    const r = await pool.query(
      `SELECT l.id, l.host_email, l.title, l.started_at, l.display_name, u.first_name, u.last_name, u.profile_pic FROM live_streams l JOIN users u ON u.email = l.host_email
       WHERE l.status = 'live' AND l.last_ping > NOW() - INTERVAL '${LIVE_ALIVE_SECS} seconds' AND COALESCE(u.is_banned, FALSE) = FALSE AND ${NOT_BLOCKED('l.host_email', '$1')}
         AND (l.host_email = $1 OR (EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = $1 AND f.following_email = l.host_email)
              AND (l.privacy = 'public' OR EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_email = l.host_email AND f2.following_email = $1))))
       ORDER BY l.started_at DESC LIMIT 30`, [me]);
    const cg = liveConfigured() ? (await liveAccess(me)).ok : false;
    res.json({ success: true, canGoLive: !!cg, lives: r.rows.map((x) => ({ id: x.id, host_email: x.host_email, name: x.display_name || `${x.first_name || ''} ${x.last_name || ''}`.trim(), profile_pic: x.profile_pic || '', title: x.title || '', mine: x.host_email === me })) });
  } catch (err) { res.status(500).json({ success: false, lives: [] }); }
});
app.get('/api/live/:id', async (req, res) => {
  const me = req.authEmail;
  try {
    const id = parseInt(req.params.id, 10), l = id && await canSeeLive(me, id);
    if (!l) return res.status(404).json({ success: false, error: 'This live is not available.' });
    const mine = l.host_email === me;
    if (l.status === 'ended') return res.json({ success: true, ended: true, name: `${l.first_name || ''} ${l.last_name || ''}`.trim() });
    if (!mine) {
      const have = (await pool.query("SELECT 1 FROM live_viewers WHERE live_id = $1 AND viewer_email = $2 AND last_seen > NOW() - INTERVAL '25 seconds'", [id, me])).rows[0];
      if (!have && (await viewerCount(id)) >= LIVE_MAX_VIEWERS()) return res.status(429).json({ success: false, full: true, error: 'This live is full right now. Please try again in a moment.' });
      const ins = await pool.query('INSERT INTO live_viewers (live_id, viewer_email) VALUES ($1, $2) ON CONFLICT (live_id, viewer_email) DO UPDATE SET last_seen = NOW() RETURNING (xmax = 0) AS fresh', [id, me]);
      if (ins.rows[0] && ins.rows[0].fresh) pool.query('UPDATE live_streams SET total_viewers = total_viewers + 1 WHERE id = $1', [id]).catch(() => {});
    }
    res.json({ success: true, ended: false, mine, on: liveIsOn(l), name: l.display_name || `${l.first_name || ''} ${l.last_name || ''}`.trim(), profile_pic: l.profile_pic || '', host_email: l.host_email, title: l.title || '', whepUrl: l.whep_url, iframeUrl: l.iframe_url, viewers: await viewerCount(id), emoji: LIVE_EMOJI });
  } catch (err) { console.error('[live] info error:', err.message); res.status(500).json({ success: false, error: 'Could not open the live.' }); }
});
app.get('/api/live/:id/feed', async (req, res) => {
  const me = req.authEmail;
  try {
    const id = parseInt(req.params.id, 10), l = id && await canSeeLive(me, id); if (!l) return res.status(404).json({ success: false });
    if (l.status === 'ended') return res.json({ success: true, ended: true, byAdmin: !!(l.ended_by && l.ended_by !== l.host_email) });
    if (l.host_email !== me) await pool.query('INSERT INTO live_viewers (live_id, viewer_email) VALUES ($1, $2) ON CONFLICT (live_id, viewer_email) DO UPDATE SET last_seen = NOW()', [id, me]);
    const sc = parseInt(req.query.c, 10) || 0, sr = parseInt(req.query.r, 10) || 0;
    const [c, rx] = await Promise.all([
      pool.query(`SELECT c.id, c.user_email, c.body, c.created_at, u.first_name, u.last_name, u.profile_pic FROM live_comments c JOIN users u ON u.email = c.user_email
                  WHERE c.live_id = $1 AND c.id > $2 AND ${NOT_BLOCKED('c.user_email', '$3')} ORDER BY c.id ASC LIMIT 50`, [id, sc, me]),
      pool.query('SELECT id, emoji FROM live_reactions WHERE live_id = $1 AND id > $2 ORDER BY id ASC LIMIT 60', [id, sr])]);
    res.json({ success: true, ended: false, on: liveIsOn(l), viewers: await viewerCount(id),
      comments: c.rows.map((x) => ({ id: x.id, name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), profile_pic: x.profile_pic || '', text: x.body, mine: x.user_email === me })),
      reactions: rx.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/live/:id/comment', async (req, res) => {
  const me = req.authEmail;
  try {
    const id = parseInt(req.params.id, 10), l = id && await canSeeLive(me, id); if (!l || l.status === 'ended') return res.status(404).json({ success: false });
    const text = String((req.body || {}).text || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!text) return res.status(400).json({ success: false });
    const recent = Number((await pool.query("SELECT COUNT(*) AS n FROM live_comments WHERE live_id = $1 AND user_email = $2 AND created_at > NOW() - INTERVAL '10 seconds'", [id, me])).rows[0].n);
    if (recent >= 4) return res.status(429).json({ success: false, error: 'Slow down a little.' });
    const r = await pool.query('INSERT INTO live_comments (live_id, user_email, body) VALUES ($1, $2, $3) RETURNING id', [id, me, text]);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/live/:id/react', async (req, res) => {
  const me = req.authEmail;
  try {
    const id = parseInt(req.params.id, 10), l = id && await canSeeLive(me, id); if (!l || l.status === 'ended') return res.status(404).json({ success: false });
    const e = String((req.body || {}).emoji || ''); if (!LIVE_EMOJI.includes(e)) return res.status(400).json({ success: false });
    const recent = Number((await pool.query("SELECT COUNT(*) AS n FROM live_reactions WHERE live_id = $1 AND user_email = $2 AND created_at > NOW() - INTERVAL '5 seconds'", [id, me])).rows[0].n);
    if (recent >= 6) return res.json({ success: true, skipped: true });
    await pool.query('INSERT INTO live_reactions (live_id, user_email, emoji) VALUES ($1, $2, $3)', [id, me, e]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});
// admin: see who is live, stop a live, allow / forbid a Creator to go live
app.post('/api/admin/live', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query(
      `SELECT l.id, l.host_email, l.title, l.status, l.started_at, l.last_ping, l.ended_at, l.ended_by, l.end_reason, l.peak, l.total_viewers, u.first_name, u.last_name, (COALESCE(ca.live_blocked, FALSE) OR COALESCE(lq.blocked, FALSE)) AS live_blocked, l.display_name
       FROM live_streams l JOIN users u ON u.email = l.host_email LEFT JOIN creator_applications ca ON ca.user_email = l.host_email LEFT JOIN live_requests lq ON lq.user_email = l.host_email
       WHERE l.status <> 'ended' OR l.ended_at > NOW() - INTERVAL '3 days' ORDER BY (l.status <> 'ended') DESC, l.id DESC LIMIT 60`);
    res.json({ success: true, configured: liveConfigured(), maxViewers: LIVE_MAX_VIEWERS(), maxMinutes: LIVE_MAX_MINUTES(), lives: r.rows.map((x) => ({ id: x.id, host_email: x.host_email, name: x.display_name || `${x.first_name || ''} ${x.last_name || ''}`.trim(), title: x.title || '', status: x.status, started_at: x.started_at, last_ping: x.last_ping, ended_at: x.ended_at, ended_by: x.ended_by, end_reason: x.end_reason, peak: x.peak, total: x.total_viewers, live_blocked: x.live_blocked })) });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not load.' }); }
});
app.post('/api/admin/live/stop', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const id = parseInt((req.body || {}).id, 10), reason = String((req.body || {}).reason || '').trim().slice(0, 200), block = (req.body || {}).block === true;
    const row = id && await liveEnd(id, a.adminEmail, reason || 'admin'); if (!row) return res.status(404).json({ success: false, error: 'This live is already over.' });
    if (block) { await pool.query('UPDATE creator_applications SET live_blocked = TRUE WHERE user_email = $1', [row.host_email]); await pool.query('UPDATE live_requests SET blocked = TRUE WHERE user_email = $1', [row.host_email]); }
    audit(a.adminEmail, 'stop-live', row.host_email, reason + (block ? ' (live blocked)' : ''));
    sendAdminNotice(a.adminEmail, row.host_email, 'Your live video was stopped by the CamFeed team.' + (reason ? ' Reason: ' + reason : '') + (block ? ' Live is now turned off for your account.' : '')).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not stop it.' }); }
});
app.post('/api/admin/live/allow', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const lid = parseInt((req.body || {}).id, 10), blocked = (req.body || {}).blocked === true;
    const email = lid ? ((await pool.query('SELECT host_email FROM live_streams WHERE id = $1', [lid])).rows[0] || {}).host_email : null;
    const u1 = await pool.query('UPDATE creator_applications SET live_blocked = $2 WHERE user_email = $1 RETURNING user_email', [email, blocked]), u2 = await pool.query('UPDATE live_requests SET blocked = $2 WHERE user_email = $1 RETURNING user_email', [email, blocked]);
    if (!u1.rows[0] && !u2.rows[0]) return res.status(404).json({ success: false, error: 'Not found.' });
    audit(a.adminEmail, blocked ? 'live-block' : 'live-allow', email, ''); res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});
// safety net: end lives whose phone went quiet, never-started ones, and anything past the time limit; tidy old chat
async function sweepLives() {
  try {
    const d = await pool.query(`SELECT id FROM live_streams WHERE status <> 'ended' AND (
        (status = 'live' AND last_ping < NOW() - INTERVAL '75 seconds') OR (status = 'created' AND created_at < NOW() - INTERVAL '3 minutes')
        OR (started_at IS NOT NULL AND started_at < NOW() - make_interval(mins => $1)))`, [LIVE_MAX_MINUTES()]);
    for (const x of d.rows) await liveEnd(x.id, null, 'timeout');
    await pool.query("DELETE FROM live_requests WHERE status = 'pending' AND requested_at < NOW() - INTERVAL '15 days' AND blocked = FALSE").catch(() => {});
    await pool.query("DELETE FROM live_comments WHERE created_at < NOW() - INTERVAL '2 days'").catch(() => {});
    await pool.query("DELETE FROM live_reactions WHERE created_at < NOW() - INTERVAL '2 days'").catch(() => {});
    await pool.query("DELETE FROM live_viewers WHERE last_seen < NOW() - INTERVAL '1 day'").catch(() => {});
  } catch (err) { console.error('[live] sweep error:', err.message); }
}
setInterval(sweepLives, 30 * 1000);
liveReplay.ensureSchema().catch(() => {}); setInterval(() => liveReplay.processAll(), 60 * 1000);

// ---- payout codes (top-up PIN / Wing cash-out code): kept sealed (AES-256-GCM) and shown only to the owner ----
const PAYOUT_METHODS = ['TopUp', 'WingCash', 'ABA', 'ACLEDA', 'Wing', 'KHQR', 'Other'], CODE_METHODS = ['TopUp', 'WingCash'], CARRIERS = ['Cellcard', 'Smart', 'Metfone'];
const payoutKey = () => { const k = process.env.PAYOUT_CODE_KEY || process.env.JWT_SECRET || ''; return String(k).length >= 16 ? require('crypto').createHash('sha256').update('camfeed-payout|' + k).digest() : null; };
function sealCode(plain) {
  const k = payoutKey(); if (!k) throw new Error('NO_KEY');
  const c = require('crypto'), iv = c.randomBytes(12), ci = c.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([ci.update(String(plain), 'utf8'), ci.final()]);
  return [iv, ci.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function openCode(sealed) {
  const k = payoutKey(); if (!k || !sealed) return null;
  try {
    const [iv, tag, enc] = String(sealed).split('.').map((x) => Buffer.from(x, 'base64')), d = require('crypto').createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
const usdText = (cents) => '$' + (cents / 100).toFixed(2);
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{2,58}[A-Za-z0-9]$/;
// ---- Pay per view: an admin-invited (approved) creator earns a small amount for each view that comes AFTER the approval / the day the rate was switched on.
//      The Super Admin sets the price ($ per 1,000 views) and a daily cap per creator; 0 = switched off.
async function earnSettings(source) {
  const r = await pool.query("SELECT key, value FROM creator_settings WHERE key IN ('rpm_usd', 'daily_cap_usd', 'rpm_usd_invited', 'daily_cap_usd_invited', 'rpm_usd_applied', 'daily_cap_usd_applied')");
  const m = {}; r.rows.forEach((x) => { if (x.value !== '' && x.value !== null) m[x.key] = Number(x.value); });
  const pick = (k, env, d) => (Number.isFinite(m[k]) && m[k] >= 0 ? m[k] : (Number.isFinite(Number(process.env[env])) && process.env[env] !== undefined && process.env[env] !== '' ? Number(process.env[env]) : d));
  const base = { rpm: pick('rpm_usd', 'CREATOR_RPM_USD', 0), dailyCap: pick('daily_cap_usd', 'CREATOR_DAILY_CAP_USD', 1) };
  // each way to earn may have its own price / daily limit (Admin > Monetization); empty = the common one
  if (source === 'invited' || source === 'applied') {
    const r2 = m['rpm_usd_' + source], c2 = m['daily_cap_usd_' + source];
    return { rpm: Number.isFinite(r2) && r2 >= 0 ? r2 : base.rpm, dailyCap: Number.isFinite(c2) && c2 >= 0 ? c2 : base.dailyCap };
  }
  return base;
}
// the switches and texts of the two ways (Admin > Monetization > each tab)
async function pathSettings() {
  const r = await pool.query("SELECT key, value FROM creator_settings WHERE key IN ('invite_accept', 'applied_open', 'text_invited', 'text_applied')").catch(() => ({ rows: [] }));
  const m = {}; r.rows.forEach((x) => { m[x.key] = x.value; });
  return { inviteAccept: m.invite_accept === '1', appliedOpen: m.applied_open !== '0', textInvited: m.text_invited || '', textApplied: m.text_applied || '' };
}
async function syncViewEarnings(email) {
  const ok = (await pool.query("SELECT decided_at, source FROM creator_applications WHERE user_email = $1 AND status = 'approved' AND earn_suspended = FALSE", [email])).rows[0]; if (!ok) return 0;
  const cfg = await earnSettings(ok.source); if (!(cfg.rpm > 0)) return 0;
  const st = (await pool.query("SELECT value FROM creator_settings WHERE key = 'earn_start'")).rows[0];
  const since = Math.max(ok.decided_at ? new Date(ok.decided_at).getTime() : 0, st ? Number(st.value) || 0 : 0);   // posts made after this moment are paid from their very first view
  // ©️ a copy of somebody else's post, or a post under a copyright claim, earns nothing (its views are passed over)
  // 🔍 paid views only (watched ≥ 10 s, one per person, checked), and only once they are older than the hold time (Admin › Views check)
  const paid = await viewGuard.paidCounts(email);
  const posts = (await pool.query("SELECT p.id, p.created_at, e.views_seen, COALESCE(p.no_earn, FALSE) AS no_earn FROM posts p LEFT JOIN post_earn e ON e.post_id = p.id WHERE p.user_email = $1 AND p.shared_post_id IS NULL", [email])).rows;
  posts.forEach((p) => { p.views = paid.get(p.id) || 0; });
  let gained = 0;
  for (const p of posts) {
    const views = Number(p.views) || 0;
    if (p.views_seen === null || p.views_seen === undefined) { await pool.query('INSERT INTO post_earn (post_id, user_email, views_seen) VALUES ($1, $2, $3) ON CONFLICT (post_id) DO NOTHING', [p.id, email, new Date(p.created_at).getTime() > since ? 0 : views]); if (new Date(p.created_at).getTime() <= since) continue; p.views_seen = 0; }   // views before the start are not paid
    const delta = views - Number(p.views_seen); if (delta <= 0) continue;
    if (p.no_earn) { await pool.query('UPDATE post_earn SET views_seen = $2 WHERE post_id = $1', [p.id, views]).catch(() => {}); continue; }
    const cents = delta * cfg.rpm * 100 / 1000;
    const u = await pool.query('UPDATE post_earn SET views_seen = $3, cents = cents + $4 WHERE post_id = $1 AND views_seen = $2 RETURNING post_id', [p.id, Number(p.views_seen), views, cents]);   // only one request can claim these views
    if (u.rows.length) gained += cents;
  }
  if (gained <= 0) return 0;
  await pool.query('INSERT INTO creator_earn (user_email, carry_cents) VALUES ($1, 0) ON CONFLICT (user_email) DO NOTHING', [email]);
  const c = await pool.query('UPDATE creator_earn SET carry_cents = carry_cents + $2 WHERE user_email = $1 RETURNING carry_cents', [email, gained]);
  const whole = Math.floor(Number(c.rows[0].carry_cents) || 0); if (whole < 1) return 0;
  const took = await pool.query('UPDATE creator_earn SET carry_cents = carry_cents - $2 WHERE user_email = $1 AND carry_cents >= $2 RETURNING carry_cents', [email, whole]); if (!took.rows.length) return 0;
  const today = Number((await pool.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM wallet_ledger WHERE user_email = $1 AND kind = 'revenue_share' AND created_at >= date_trunc('day', NOW())", [email])).rows[0].n) || 0;
  const pay = Math.min(whole, Math.max(0, Math.round(cfg.dailyCap * 100) - today));   // over the daily cap: not paid
  if (pay > 0) await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, created_by) VALUES ($1, $2, 'revenue_share', 'Earnings from views', 'system')", [email, pay]);
  return pay;
}
// ---- Rules the Super Admin can change at any time in Admin > Monetization (saved in creator_settings as 'r:<NAME>').
//      A saved value wins over the Render environment value; "empty" = back to the Render value / the default.
const RULE_KEYS = {
  creator: [['CREATOR_MIN_FOLLOWERS', 'followers', 0, 10000000], ['CREATOR_MIN_VIEWS', 'views', 0, 1000000000], ['CREATOR_MIN_POSTS', 'posts', 0, 100000], ['CREATOR_MIN_ACCOUNT_DAYS', 'ageDays', 0, 3650], ['MIN_WITHDRAW_USD', 'minWithdraw', 0, 1000], ['WITHDRAW_DAY_MAX_USD', 'wdDayMax', 0, 100000], ['WITHDRAW_MONTH_MAX_USD', 'wdMonthMax', 0, 1000000], ['WITHDRAW_HOLD_HOURS', 'wdHoldHours', 0, 168]],
  app: [['NAME_CHANGE_DAYS', 'nameDays', 0, 365], ['GROUP_CALL_MAX', 'groupCallMax', 2, 16], ['CHAT_MAX_MONTHS', 'chatMaxMonths', 1, 24], ['COPYRIGHT_MAX_STRIKES', 'copyrightStrikes', 1, 10]],
  referral: [['REFERRAL_REWARD_USD', 'reward', 0, 100], ['REFERRAL_ACTIVE_DAYS', 'days', 0, 60], ['REFERRAL_POSTS', 'posts', 0, 100], ['REFERRAL_WINDOW_DAYS', 'windowDays', 1, 90], ['REFERRAL_MAX_PER_MONTH', 'maxPerMonth', 0, 100000]],
};
let ruleOverride = {};
async function loadRuleOverrides() {
  try {
    const r = await pool.query("SELECT key, value FROM creator_settings WHERE key LIKE 'r:%'");
    const m = {}; r.rows.forEach((x) => { const v = Number(x.value); if (x.value !== '' && Number.isFinite(v) && v >= 0) m[x.key.slice(2)] = v; });
    ruleOverride = m;
  } catch (e) { /* the table may not exist yet: the Render values are used */ }
}
setTimeout(loadRuleOverrides, 4000);
setInterval(loadRuleOverrides, 60000).unref();
const ruleNum = (k, d) => {
  if (Object.prototype.hasOwnProperty.call(ruleOverride, k)) return ruleOverride[k];
  const raw = process.env[k]; const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0 ? v : d;
};
const creatorRules = () => {
  const n = ruleNum;
  return { followers: n('CREATOR_MIN_FOLLOWERS', 1000), views: n('CREATOR_MIN_VIEWS', 10000), ageDays: n('CREATOR_MIN_ACCOUNT_DAYS', 30), posts: n('CREATOR_MIN_POSTS', 5), minWithdrawCents: Math.round(n('MIN_WITHDRAW_USD', n('CREATOR_MIN_WITHDRAW_USD', 1)) * 100),
    // 🛡️ withdrawals: the most a person can take in one day / one month (0 = no limit), and how long a first withdrawal or new account details wait
    wdDayMax: n('WITHDRAW_DAY_MAX_USD', 200), wdMonthMax: n('WITHDRAW_MONTH_MAX_USD', 1000), wdHoldHours: n('WITHDRAW_HOLD_HOURS', 24) };
};
async function creatorStats(email) {
  const r = await pool.query(
    `SELECT (SELECT COUNT(*) FROM follows WHERE following_email = $1) AS followers,
            (SELECT COALESCE(SUM(views_count), 0) FROM posts WHERE user_email = $1) AS views,
            (SELECT COUNT(*) FROM posts WHERE user_email = $1 AND shared_post_id IS NULL) AS posts,
            (SELECT COALESCE(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)), 0) FROM users WHERE email = $1) AS age_days`, [email]);
  const x = r.rows[0] || {};
  return { followers: Number(x.followers) || 0, views: Number(x.views) || 0, posts: Number(x.posts) || 0, ageDays: Number(x.age_days) || 0 };
}
const expirePendingApps = () => pool.query("DELETE FROM creator_applications WHERE status = 'pending' AND requested_at < NOW() - INTERVAL '15 days'").catch(() => {});   // not approved within 15 days: back to normal, the person may ask again
const meetsRules = (st, rules) => st.followers >= rules.followers && st.views >= rules.views && st.posts >= rules.posts && st.ageDays >= rules.ageDays;
async function walletCents(email) {
  const r = await pool.query('SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM wallet_ledger WHERE user_email = $1', [email]);
  return Number(r.rows[0] && r.rows[0].cents) || 0;
}
// ---- Invitation reward: $0.20 for the person who invited a friend, paid when the friend has used CamFeed on 3 different days AND posted 3 public photos / videos.
//      (6 steps; the progress is shown step by step, the money is added to the wallet only when all steps are done)
const referralRules = () => {
  const n = ruleNum;
  return { rewardCents: Math.round(n('REFERRAL_REWARD_USD', 0.2) * 100), days: n('REFERRAL_ACTIVE_DAYS', 3), posts: n('REFERRAL_POSTS', 3), windowDays: n('REFERRAL_WINDOW_DAYS', 3), maxPerMonth: n('REFERRAL_MAX_PER_MONTH', 50) };
};
const phnomPenhDay = (ms) => new Date((ms === undefined ? Date.now() : ms) + 7 * 3600 * 1000).toISOString().slice(0, 10);   // the day in Cambodia (UTC+7)
const activeDayCache = new Map(), referralCheckAt = new Map();
function markActive(req, res, next) {
  try {
    const email = req.authEmail;
    if (email) {
      const day = phnomPenhDay();
      if (activeDayCache.get(email) !== day) {
        activeDayCache.set(email, day);
        pool.query('INSERT INTO user_active_days (user_email, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [email, day]).then(() => evaluateReferral(email)).catch(() => {});
      } else if (Date.now() - (referralCheckAt.get(email) || 0) > 10 * 60 * 1000) {
        referralCheckAt.set(email, Date.now());
        evaluateReferral(email).catch(() => {});
      }
      if (activeDayCache.size > 50000) activeDayCache.clear();
    }
  } catch (e) { /* never block a request */ }
  next();
}
function recordReferral(newEmail, ref, ip) {
  const code = String(ref || '').trim();
  if (!/^\d{15}$/.test(code)) return;
  const ipHash = require('crypto').createHash('sha256').update(String(ip || '') + '|' + (process.env.JWT_SECRET || '')).digest('hex').slice(0, 32);   // only a hash is kept: to notice many "friends" from one network
  pool.query('INSERT INTO referrals (referred_email, referrer_email, ip_hash) SELECT $1, email, $3 FROM users WHERE public_id = $2 AND email <> $1 ON CONFLICT (referred_email) DO NOTHING', [newEmail, code, ipHash]).catch(() => {});
}
async function creditReferral(referrer, cents) {
  await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, created_by) VALUES ($1, $2, 'referral', $3, 'system')", [referrer, cents, 'A friend you invited finished the challenge']);
  await sendAdminNotice(SUPER_ADMIN_EMAILS[0] || referrer, referrer, '🎁 អបអរសាទរ! មិត្តដែលអ្នកបានអញ្ជើញបានបំពេញលក្ខខណ្ឌ។ រង្វាន់ $' + (cents / 100).toFixed(2) + ' បានចូលកាបូបរបស់អ្នកហើយ។', 'wallet_notice').catch(() => {});
}
async function evaluateReferral(referredEmail) {
  const r = (await pool.query("SELECT referrer_email, created_at, ip_hash FROM referrals WHERE referred_email = $1 AND status = 'progress'", [referredEmail])).rows[0];
  if (!r) return null;
  const rules = referralRules(), created = new Date(r.created_at).getTime();
  const startDay = phnomPenhDay(created), endDay = phnomPenhDay(created + rules.windowDays * 86400000);
  const [d, p] = await Promise.all([
    pool.query('SELECT COUNT(DISTINCT day) AS n FROM user_active_days WHERE user_email = $1 AND day >= $2 AND day <= $3', [referredEmail, startDay, endDay]),
    pool.query("SELECT COUNT(*) AS n FROM posts WHERE user_email = $1 AND shared_post_id IS NULL AND media_type IN ('image', 'video') AND COALESCE(privacy, 'public') = 'public' AND created_at >= $2", [referredEmail, r.created_at])
  ]);
  const days = Math.min(Number(d.rows[0] && d.rows[0].n) || 0, rules.days), posts = Math.min(Number(p.rows[0] && p.rows[0].n) || 0, rules.posts);
  const done = days >= rules.days && posts >= rules.posts;
  if (!done && Date.now() <= created + rules.windowDays * 86400000) {
    await pool.query("UPDATE referrals SET days_done = $2, posts_done = $3 WHERE referred_email = $1 AND status = 'progress'", [referredEmail, days, posts]);
    return 'progress';
  }
  if (!done) {
    await pool.query("UPDATE referrals SET status = 'expired', days_done = $2, posts_done = $3, completed_at = NOW() WHERE referred_email = $1 AND status = 'progress'", [referredEmail, days, posts]);
    return 'expired';
  }
  // finished: pay at once, or let a person look first when something looks odd
  let verdict = 'rewarded', why = '';
  const inviter = (await pool.query('SELECT COALESCE(is_banned, FALSE) AS banned FROM users WHERE email = $1', [r.referrer_email])).rows[0];
  const friend = (await pool.query('SELECT COALESCE(is_banned, FALSE) AS banned FROM users WHERE email = $1', [referredEmail])).rows[0];
  if (!inviter || inviter.banned || !friend || friend.banned) { verdict = 'rejected'; why = 'an account is suspended'; }
  else {
    const same = r.ip_hash ? Number((await pool.query('SELECT COUNT(*) AS n FROM referrals WHERE referrer_email = $1 AND ip_hash = $2 AND referred_email <> $3', [r.referrer_email, r.ip_hash, referredEmail])).rows[0].n) : 0;
    const month = Number((await pool.query("SELECT COUNT(*) AS n FROM referrals WHERE referrer_email = $1 AND status = 'rewarded' AND rewarded_at >= date_trunc('month', NOW())", [r.referrer_email])).rows[0].n);
    if (same > 0) { verdict = 'review'; why = 'several invited accounts share one network'; } else if (month >= rules.maxPerMonth) { verdict = 'review'; why = 'monthly limit reached'; }
  }
  const upd = await pool.query("UPDATE referrals SET status = $2, days_done = $3, posts_done = $4, completed_at = NOW(), rewarded_at = CASE WHEN $6::boolean THEN NOW() ELSE NULL END, note = $5 WHERE referred_email = $1 AND status = 'progress' RETURNING referrer_email",
    [referredEmail, verdict, days, posts, why, verdict === 'rewarded']);
  if (upd.rows.length && verdict === 'rewarded') await creditReferral(r.referrer_email, rules.rewardCents);
  return verdict;
}

app.get('/api/monetization/status', async (req, res) => {
  try {
    const email = req.authEmail, rules = creatorRules();
    try { const open = (await pool.query("SELECT referred_email FROM referrals WHERE referrer_email = $1 AND status = 'progress' ORDER BY created_at DESC LIMIT 20", [email])).rows; await Promise.all(open.map((x) => evaluateReferral(x.referred_email).catch(() => {}))); } catch (e) { /* the page still opens */ }
    await expirePendingApps();
    await syncViewEarnings(email).catch((e) => console.error('[earn] sync error:', e.message));
    const [st, cents, app_, refs, me, wd, led] = await Promise.all([
      creatorStats(email), walletCents(email),
      pool.query('SELECT status, decided_at, note, earn_suspended, suspend_reason, source FROM creator_applications WHERE user_email = $1', [email]),
      pool.query('SELECT COUNT(*) AS n FROM referrals WHERE referrer_email = $1', [email]),
      pool.query('SELECT public_id FROM users WHERE email = $1', [email]),
      pool.query('SELECT id, amount_cents, method, account_name, account_number, status, created_at, decided_at, note, (payout_code IS NOT NULL) AS has_code, code_issued_at, code_viewed_at, reissue_requested_at, reissue_count FROM withdrawal_requests WHERE user_email = $1 ORDER BY created_at DESC, id DESC LIMIT 20', [email]),
      pool.query('SELECT amount_cents, kind, note, created_at FROM wallet_ledger WHERE user_email = $1 ORDER BY created_at DESC, id DESC LIMIT 50', [email])
    ]);
    const a = app_.rows[0] || null;
    const rr = referralRules(), steps = rr.days + rr.posts;
    const invited = (await pool.query(
      `SELECT r.status, r.days_done, r.posts_done, r.created_at, r.completed_at, r.note, u.first_name, u.last_name FROM referrals r JOIN users u ON u.email = r.referred_email
       WHERE r.referrer_email = $1 ORDER BY r.created_at DESC LIMIT 50`, [email])).rows;
    const earned = Number((await pool.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM wallet_ledger WHERE user_email = $1 AND kind = 'referral'", [email])).rows[0].n) || 0;
    // 💰 the native wallet page: money that still waits (Party Room gifts) and where the money came from
    const held = await coins.heldCents(email).catch(() => 0);
    const sources = (await pool.query("SELECT kind, SUM(amount_cents)::bigint AS cents FROM wallet_ledger WHERE user_email = $1 AND amount_cents > 0 AND kind NOT IN ('withdrawal_refund') GROUP BY kind ORDER BY 2 DESC", [email])).rows.map((x) => ({ kind: x.kind, amount: Number(x.cents) / 100 }));
    res.json({ success: true, creatorProgramOpen: process.env.CREATOR_PROGRAM_OPEN === 'true', walletBalance: cents / 100, referralCount: Number(refs.rows[0] && refs.rows[0].n) || 0, referralCode: (me.rows[0] && me.rows[0].public_id) || '',
      referralRules: { reward: rr.rewardCents / 100, days: rr.days, posts: rr.posts, windowDays: rr.windowDays }, referralEarned: earned / 100,
      referrals: invited.map((x) => { const done = Math.min(steps, (x.days_done || 0) + (x.posts_done || 0)); return { name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), status: x.status, daysDone: x.days_done || 0, postsDone: x.posts_done || 0, joined: x.created_at, note: x.status === 'review' || x.status === 'rejected' ? '' : '', progress: x.status === 'rewarded' ? rr.rewardCents / 100 : (x.status === 'progress' ? Math.round(rr.rewardCents * done / steps) / 100 : 0), reward: rr.rewardCents / 100 }; }),
      followersCount: st.followers, totalViews: st.views, postsCount: st.posts, accountAgeDays: st.ageDays,
      earningSuspended: !!(a && a.earn_suspended), suspendReason: a && a.earn_suspended ? (a.suspend_reason || '') : '', applicationStatus: a ? a.status : null, applicationNote: a && a.status === 'rejected' ? (a.note || '') : '', eligible: meetsRules(st, rules),
      criteria: { followers: rules.followers, views: rules.views, ageDays: rules.ageDays, posts: rules.posts }, minWithdraw: rules.minWithdrawCents / 100, payPerView: await (async () => {
        // 🔍 the rate shown = money ÷ ALL views × 1,000 (the paid-view rule stays secret, so this goes up and down by itself)
        if (!a || a.status !== 'approved') return 0;          // not a Creator yet: no rate is shown
        const t = (await pool.query("SELECT COALESCE(SUM(e.cents), 0) AS c, COALESCE(SUM(p.views_count), 0) AS v FROM posts p LEFT JOIN post_earn e ON e.post_id = p.id WHERE p.user_email = $1 AND p.shared_post_id IS NULL AND e.post_id IS NOT NULL", [email]).catch(() => ({ rows: [{ c: 0, v: 0 }] }))).rows[0];
        const v = Number(t.v) || 0; return v > 0 ? Math.round(Number(t.c) * 1000 / v) / 100 : 0;
      })(),
      creatorSource: a ? (a.source || 'applied') : null, paths: await pathSettings(),
      withdrawals: wd.rows.map((w) => ({ id: w.id, amount: w.amount_cents / 100, method: w.method, accountName: w.account_name || '', accountNumber: w.account_number || '', status: w.status, created_at: w.created_at, decided_at: w.decided_at, note: w.note || '', hasCode: !!w.has_code, usesCode: CODE_METHODS.includes(w.method), codeIssuedAt: w.code_issued_at, codeSeen: !!w.code_viewed_at, reissuePending: !!w.reissue_requested_at, reissueLeft: Math.max(0, 3 - (w.reissue_count || 0)) })),
      ledger: led.rows.map((l) => ({ amount: l.amount_cents / 100, kind: l.kind, note: l.note || '', created_at: l.created_at })),
      heldAmount: Math.min(held, cents) / 100, availableAmount: Math.max(0, cents - held) / 100, sources, payoutMethods: PAYOUT_METHODS, carriers: CARRIERS });
  } catch (err) { console.error('[monetization] status error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/monetization/apply', async (req, res) => {
  try {
    const email = req.authEmail, rules = creatorRules();
    await expirePendingApps();
    const cur = (await pool.query('SELECT status, decided_at FROM creator_applications WHERE user_email = $1', [email])).rows[0];
    if (cur && cur.status === 'approved') return res.status(409).json({ success: false, error: 'You are already in the Creator Program.' });
    if (cur && cur.status === 'pending') return res.status(409).json({ success: false, error: 'Your application is already waiting for review.' });
    if (cur && cur.status === 'rejected' && cur.decided_at && Date.now() - new Date(cur.decided_at).getTime() < 7 * 86400000) return res.status(429).json({ success: false, error: 'Please wait 7 days after a refusal before applying again.' });
    const st = await creatorStats(email);
    if (!meetsRules(st, rules)) return res.status(400).json({ success: false, error: 'You do not meet the requirements yet.', stats: st, criteria: rules });
    const message = String((req.body || {}).message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (message.length < 10) return res.status(400).json({ success: false, error: 'Please write a short request (at least 10 letters) so the admin knows you.' });
    if (!(await pathSettings()).appliedOpen) return res.status(403).json({ success: false, error: 'Applying is closed for now.' });
    if (cur && cur.status === 'invited') return res.status(409).json({ success: false, error: 'CamFeed has already invited you: please answer the invitation.' });
    await pool.query(`INSERT INTO creator_applications (user_email, status, requested_at, decided_at, decided_by, note, message, source) VALUES ($1, 'pending', NOW(), NULL, NULL, NULL, $2, 'applied')
      ON CONFLICT (user_email) DO UPDATE SET status = 'pending', requested_at = NOW(), decided_at = NULL, decided_by = NULL, note = NULL, message = $2, source = 'applied'`, [email, message]);
    res.json({ success: true });
  } catch (err) { console.error('[monetization] apply error:', err.message); res.status(500).json({ success: false, error: 'Could not send your application.' }); }
});

// the person answers CamFeed's invitation to earn
app.post('/api/monetization/invite-reply', async (req, res) => {
  try {
    const email = req.authEmail, accept = (req.body || {}).accept === true;
    const cur = (await pool.query("SELECT status FROM creator_applications WHERE user_email = $1 AND status = 'invited'", [email])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'There is no invitation.' });
    if (accept) await pool.query("UPDATE creator_applications SET status = 'approved', decided_at = NOW() WHERE user_email = $1", [email]);
    else await pool.query("DELETE FROM creator_applications WHERE user_email = $1 AND status = 'invited'", [email]);
    res.json({ success: true });
  } catch (err) { console.error('[monetization] invite reply error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

// Admin: the settings of each way to earn ('invited' / 'applied'): price per 1,000 views, daily limit, switches, the text people see
app.post('/api/admin/creator-path', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const src = b.source === 'invited' ? 'invited' : 'applied';
    if (b.set) {
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
      const put = (k, v) => (v === '' || v === null || v === undefined) ? pool.query('DELETE FROM creator_settings WHERE key = $1', [k]) : pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, String(v)]);
      const num = (v, hi) => { if (v === '' || v === null || v === undefined) return ''; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > hi) throw new Error('bad number'); return n; };
      let rpm, cap;
      try { rpm = num(b.rpm, 50); cap = num(b.dailyCap, 100); } catch (e) { return res.status(400).json({ success: false, error: 'Price must be $0–$50 and the daily limit $0–$100 (empty = the common value).' }); }
      await put('rpm_usd_' + src, rpm); await put('daily_cap_usd_' + src, cap);
      if (rpm !== '' && rpm > 0 && !(await pool.query("SELECT 1 FROM creator_settings WHERE key = 'earn_start'")).rows.length) await pool.query("INSERT INTO creator_settings (key, value) VALUES ('earn_start', $1)", [String(Date.now())]);
      if (src === 'invited' && b.mustAccept !== undefined) await put('invite_accept', b.mustAccept ? '1' : '0');
      if (src === 'applied' && b.open !== undefined) await put('applied_open', b.open ? '1' : '0');
      if (b.text !== undefined) await put('text_' + src, String(b.text || '').slice(0, 600));
      audit(a.adminEmail, 'creator-path-' + src, 'settings', 'rpm ' + rpm + ', cap ' + cap);
    }
    const r = await pool.query('SELECT key, value FROM creator_settings WHERE key = ANY($1)', [['rpm_usd_' + src, 'daily_cap_usd_' + src]]);
    const m = {}; r.rows.forEach((x) => { m[x.key] = x.value; });
    const ps = await pathSettings(), common = await earnSettings(), eff = await earnSettings(src);
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, source: src, rpm: m['rpm_usd_' + src] || '', dailyCap: m['daily_cap_usd_' + src] || '', commonRpm: common.rpm, commonCap: common.dailyCap, effRpm: eff.rpm, effCap: eff.dailyCap,
      mustAccept: ps.inviteAccept, open: ps.appliedOpen, text: src === 'invited' ? ps.textInvited : ps.textApplied });
  } catch (err) { console.error('[admin] creator path error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/monetization/withdraw', async (req, res) => {
  try {
    const email = req.authEmail, rules = creatorRules(), b = req.body || {};
    const cents = Math.round(Number(b.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ success: false, error: 'Please enter an amount.' });
    if (cents < rules.minWithdrawCents) return res.status(400).json({ success: false, error: `The smallest withdrawal is $${(rules.minWithdrawCents / 100).toFixed(2)}.` });
    const method = PAYOUT_METHODS.includes(b.method) ? b.method : '';
    let accountName = String(b.accountName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const accountNumber = String(b.accountNumber || '').replace(/[^\d+\- ]/g, '').trim().slice(0, 40), digits = accountNumber.replace(/\D/g, '').length;
    if (!method) return res.status(400).json({ success: false, error: 'Please choose how to be paid.' });
    if (method === 'TopUp') {
      accountName = CARRIERS.includes(b.carrier) ? b.carrier : '';
      if (!accountName) return res.status(400).json({ success: false, error: 'Please choose your phone company.' });
      if (digits < 8) return res.status(400).json({ success: false, error: 'Please enter your phone number.' });
    } else if (method === 'WingCash') {
      if (digits < 8) return res.status(400).json({ success: false, error: 'Please enter the phone number you will use at the Wing agent.' });
      accountName = accountName || 'Wing cash-out';
    } else if (accountName.length < 3 || !/\S+\s+\S+|\S{3,}/.test(accountName)) return res.status(400).json({ success: false, error: 'Please enter your full name exactly as it appears on the account.' });
    else if (digits < 6) return res.status(400).json({ success: false, error: 'Please enter your correct account number.' });
    const wallet = await walletCents(email);
    if (cents > wallet) return res.status(400).json({ success: false, error: 'Your balance is not enough.' });
    const held = await coins.heldCents(email);          // money from Party Room gifts waits a few days (Admin sets how many)
    if (held > 0 && cents > wallet - held) return res.status(400).json({ success: false, error: 'Gift money from Party Room can be withdrawn a few days after you receive it. You can withdraw $' + (Math.max(0, wallet - held) / 100).toFixed(2) + ' now.' });
    // 🛡️ the most in one day / one month (Admin sets; 0 = no limit). Refused requests do not count.
    const used = (await pool.query(`SELECT COALESCE(SUM(amount_cents) FILTER (WHERE created_at > NOW() - INTERVAL '1 day'), 0)::int AS d, COALESCE(SUM(amount_cents) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS m
      FROM withdrawal_requests WHERE user_email = $1 AND status <> 'rejected'`, [email])).rows[0];
    if (rules.wdDayMax > 0 && used.d + cents > Math.round(rules.wdDayMax * 100)) return res.status(400).json({ success: false, code: 'day_max', error: 'The most you can withdraw in one day is $' + Number(rules.wdDayMax).toFixed(2) + '. You can still take $' + (Math.max(0, Math.round(rules.wdDayMax * 100) - used.d) / 100).toFixed(2) + ' today.' });
    if (rules.wdMonthMax > 0 && used.m + cents > Math.round(rules.wdMonthMax * 100)) return res.status(400).json({ success: false, code: 'month_max', error: 'The most you can withdraw in 30 days is $' + Number(rules.wdMonthMax).toFixed(2) + '. You can still take $' + (Math.max(0, Math.round(rules.wdMonthMax * 100) - used.m) / 100).toFixed(2) + '.' });
    // 🛡️ a first withdrawal, or account details never paid before, waits some hours (time to notice a stolen account)
    const paidBefore = (await pool.query("SELECT 1 FROM withdrawal_requests WHERE user_email = $1 AND status = 'paid' AND method = $2 AND regexp_replace(COALESCE(account_number, ''), '\\D', '', 'g') = $3 LIMIT 1", [email, method, accountNumber.replace(/\D/g, '')])).rows.length > 0;
    const holdH = paidBefore ? 0 : Number(rules.wdHoldHours) || 0;
    // 🛡️ the name on the bank account and the name on CamFeed: the same → ✅; not the same (or Khmer vs Latin letters) → ⚠️ the Admin looks closer
    let nameCheck = '';
    if (!CODE_METHODS.includes(method)) {
      const u = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email])).rows[0] || {};
      const flat = (x) => String(x || '').toLowerCase().replace(/[^a-z\u1780-\u17ff]/g, '');
      const a1 = flat(accountName), n1 = flat((u.first_name || '') + (u.last_name || '')), n2 = flat((u.last_name || '') + (u.first_name || ''));
      nameCheck = a1 && (a1 === n1 || a1 === n2) ? 'same' : 'differ';
    }
    let id;
    try {
      const ins = await pool.query(`INSERT INTO withdrawal_requests (user_email, amount_cents, method, account_name, account_number, hold_until, name_check, new_details)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int > 0 THEN NOW() + ($6::int || ' hours')::interval ELSE NULL END, $7, $8) RETURNING id`, [email, cents, method, accountName, accountNumber, holdH, nameCheck, !paidBefore]);
      id = ins.rows[0].id;
    } catch (e) { if (e && e.code === '23505') return res.status(409).json({ success: false, error: 'You already have a withdrawal waiting to be paid.' }); throw e; }
    await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, ref_id, created_by) VALUES ($1, $2, 'withdrawal', $3, $4, $1)", [email, -cents, 'Withdrawal request #' + id, id]);   // the money is set aside at once
    res.json({ success: true, id, holdHours: holdH });
    if (!holdH) withdrawTelegram(id).catch(() => {});                            // 📲 the owner's Telegram (after the waiting time for new details)
  } catch (err) { console.error('[monetization] withdraw error:', err.message); res.status(500).json({ success: false, error: 'Could not send your request.' }); }
});


// per-post numbers for the owner (Creator Dashboard / "Post details")
app.get('/api/monetization/posts', async (req, res) => {
  try {
    const email = req.authEmail;
    await syncViewEarnings(email).catch((e) => console.error('[earn] sync error:', e.message));
    const r = await pool.query(
      `SELECT p.id, p.content, p.media_type, p.media_url, p.privacy, p.created_at, COALESCE(p.views_count, 0) AS views, COALESCE(e.cents, 0) AS earn_cents,
              (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS likes, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comments,
              (SELECT COUNT(*) FROM posts sp WHERE sp.shared_post_id = p.id)::int AS shares
       FROM posts p LEFT JOIN post_earn e ON e.post_id = p.id WHERE p.user_email = $1 AND p.shared_post_id IS NULL ORDER BY p.created_at DESC LIMIT 100`, [email]);
    const me = (await pool.query('SELECT first_name, last_name, profile_pic FROM users WHERE email = $1', [email])).rows[0] || {};
    const ca = (await pool.query("SELECT earn_suspended, suspend_reason FROM creator_applications WHERE user_email = $1 AND status = 'approved'", [email])).rows[0], isCreator = !!ca, suspended = !!(ca && ca.earn_suspended);
    const posts = r.rows.map((x) => { const m = pubMedia(x); return { id: x.id, text: String(x.content || '').slice(0, 300), mediaType: m.video ? 'video' : (m.images.length ? 'image' : ''), image: m.images[0] || '', video: m.video || '', privacy: x.privacy || 'public', created_at: x.created_at, views: Number(x.views), earnings: isCreator ? Math.round(Number(x.earn_cents)) / 100 : 0, likes: x.likes, comments: x.comments, shares: x.shares }; });
    const week = Date.now() - 7 * 86400000;
    res.json({ success: true, isCreator, suspended, suspendReason: suspended ? (ca.suspend_reason || '') : '', name: `${me.first_name || ''} ${me.last_name || ''}`.trim(), pic: me.profile_pic || '', posts,
      totals: { posts: posts.length, postsWeek: posts.filter((p) => new Date(p.created_at).getTime() > week).length, views: posts.reduce((a, p) => a + p.views, 0), engagement: posts.reduce((a, p) => a + p.likes + p.comments + p.shares, 0), earnings: Math.round(posts.reduce((a, p) => a + p.earnings, 0) * 100) / 100, wallet: (await walletCents(email)) / 100 } });
  } catch (err) { console.error('[monetization] posts error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

// the owner reads their own secret code (never sent in a notification or in the status list)
app.post('/api/monetization/withdrawals/:id/code', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10); if (!id) return res.status(400).json({ success: false, error: 'Invalid request.' });
    const r = (await pool.query("SELECT payout_code FROM withdrawal_requests WHERE id = $1 AND user_email = $2 AND status = 'paid'", [id, req.authEmail])).rows[0];
    if (!r || !r.payout_code) return res.status(404).json({ success: false, error: 'No code yet.' });
    const code = openCode(r.payout_code); if (!code) return res.status(500).json({ success: false, error: 'The code cannot be read right now.' });
    await pool.query('UPDATE withdrawal_requests SET code_viewed_at = COALESCE(code_viewed_at, NOW()) WHERE id = $1', [id]);
    res.set('Cache-Control', 'no-store'); res.json({ success: true, code });
  } catch (err) { console.error('[monetization] code error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

// the owner asks for a fresh code (for example the Wing code has expired)
app.post('/api/monetization/withdrawals/:id/reissue', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10); if (!id) return res.status(400).json({ success: false, error: 'Invalid request.' });
    const r = (await pool.query("SELECT method, reissue_count, reissue_requested_at FROM withdrawal_requests WHERE id = $1 AND user_email = $2 AND status = 'paid'", [id, req.authEmail])).rows[0];
    if (!r || !CODE_METHODS.includes(r.method)) return res.status(404).json({ success: false, error: 'Not found.' });
    if (r.reissue_requested_at) return res.status(409).json({ success: false, error: 'You already asked for a new code. Please wait.' });
    if ((r.reissue_count || 0) >= 3) return res.status(429).json({ success: false, error: 'You have used all new-code requests. Please contact CamFeed.' });
    await pool.query('UPDATE withdrawal_requests SET reissue_requested_at = NOW() WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { console.error('[monetization] reissue error:', err.message); res.status(500).json({ success: false, error: 'Could not send your request.' }); }
});

// ---- admin side ----
app.post('/api/admin/monetization-requests', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    await expirePendingApps();
    const r = await pool.query(
      `SELECT ca.user_email, ca.status, ca.source, ca.requested_at, ca.decided_at, ca.decided_by, ca.note, ca.message, ca.earn_suspended, ca.suspend_reason, u.first_name, u.last_name, u.profile_pic, u.public_id,
              (SELECT COUNT(*) FROM follows f WHERE f.following_email = ca.user_email) AS followers_count,
              (SELECT COALESCE(SUM(views_count), 0) FROM posts p WHERE p.user_email = ca.user_email) AS total_views,
              (SELECT COUNT(*) FROM posts p WHERE p.user_email = ca.user_email AND p.shared_post_id IS NULL) AS posts_count,
              COALESCE(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400)), 0) AS age_days,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_ledger w WHERE w.user_email = ca.user_email) AS balance_cents
       FROM creator_applications ca JOIN users u ON u.email = ca.user_email
       ORDER BY CASE WHEN ca.status = 'pending' THEN 0 ELSE 1 END, ca.requested_at DESC LIMIT 200`);
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, criteria: creatorRules(), requests: r.rows.map((x) => Object.assign({}, x, { followers_count: Number(x.followers_count), total_views: Number(x.total_views), posts_count: Number(x.posts_count), age_days: Number(x.age_days), balance: Number(x.balance_cents) / 100 })) });
  } catch (err) { console.error('[admin] monetization list error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/monetization-action', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const u = await resolveIdentifier(b.identifier || b.targetEmail); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    const note = String(b.note || '').slice(0, 300);
    if (b.status === 'invite') {
      // way 1: CamFeed invites this person (no requirements). With "must accept" on, the person answers the invitation first.
      const st = (await pathSettings()).inviteAccept ? 'invited' : 'approved';
      await pool.query(`INSERT INTO creator_applications (user_email, status, requested_at, decided_at, decided_by, note, source) VALUES ($1, $2, NOW(), $3, $4, $5, 'invited')
        ON CONFLICT (user_email) DO UPDATE SET status = $2, decided_at = $3, decided_by = $4, note = $5, source = 'invited'`, [u.email, st, st === 'approved' ? new Date() : null, a.adminEmail, note || 'Invited by CamFeed']);
      audit(a.adminEmail, 'creator-invite', u.email, st);
      await sendAdminNotice(a.adminEmail, u.email, st === 'invited' ? '🎉 អបអរសាទរ! លោកអ្នកទទួលបានការអញ្ជើញពី CamFeed ឲ្យរកប្រាក់ពីវីដេអូ និងរូបភាពរបស់អ្នក។ ចុចទីនេះ ដើម្បីទទួលយក។' : '🎉 អបអរសាទរ! CamFeed បានអញ្ជើញ និងបើកការរកប្រាក់ឲ្យអ្នករួចហើយ។ ឥឡូវអ្នករកប្រាក់ពីវីដេអូ និងរូបភាពរបស់អ្នកបានហើយ។', 'wallet_notice').catch(() => {});
      return res.json({ success: true, status: st });
    }
    if (b.status === 'move') {
      // move a person from one way to the other (the price / daily limit of that way is used from now on)
      const to = b.source === 'invited' ? 'invited' : 'applied';
      const up = await pool.query('UPDATE creator_applications SET source = $2 WHERE user_email = $1 RETURNING user_email', [u.email, to]);
      if (!up.rows.length) return res.status(404).json({ success: false, error: 'Not in the Creator Program.' });
      audit(a.adminEmail, 'creator-move', u.email, to);
      return res.json({ success: true });
    }
    const status = ['approved', 'rejected', 'pending'].includes(b.status) ? b.status : '';
    if (!status) return res.status(400).json({ success: false, error: 'Invalid status.' });
    await pool.query(`INSERT INTO creator_applications (user_email, status, requested_at, decided_at, decided_by, note) VALUES ($1, $2, NOW(), $3, $4, $5)
      ON CONFLICT (user_email) DO UPDATE SET status = $2, decided_at = $3, decided_by = $4, note = $5`, [u.email, status, status === 'pending' ? null : new Date(), a.adminEmail, note]);
    audit(a.adminEmail, 'creator-' + status, u.email, note);
    // tell the person (notification in the app + on the phone); tapping it opens the earning page
    if (status === 'approved') await sendAdminNotice(a.adminEmail, u.email, '🎉 អបអរសាទរ! CamFeed បានអនុម័តពាក្យសុំរកប្រាក់របស់អ្នក។ ឥឡូវអ្នករកប្រាក់ពីវីដេអូ និងរូបភាពរបស់អ្នកបានហើយ។', 'wallet_notice').catch(() => {});
    else if (status === 'rejected') await sendAdminNotice(a.adminEmail, u.email, 'ពាក្យសុំរកប្រាក់របស់អ្នកមិនទាន់ត្រូវបានអនុម័តនៅឡើយទេ។' + (note ? ' មូលហេតុ៖ ' + note + '។' : '') + ' អ្នកអាចដាក់ពាក្យម្ដងទៀតក្រោយ 7 ថ្ងៃ។', 'wallet_notice').catch(() => {});
    res.json({ success: true });
  } catch (err) { console.error('[admin] monetization action error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/admin/wallet/credit', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change a wallet.' });
    const cents = Math.round(Number(b.amount) * 100);
    const giftMax = Math.round((Number(process.env.GIFT_MAX_USD) || 100) * 100);
    if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > 100000) return res.status(400).json({ success: false, error: 'The amount must be between -$1,000 and $1,000 (not 0).' });
    if ((b.kind || 'bonus') !== 'adjustment' && cents > giftMax) return res.status(400).json({ success: false, error: 'A gift can be at most $' + (giftMax / 100) + ' at a time.' });
    const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!note) return res.status(400).json({ success: false, error: 'Please write a reason.' });
    const kind = b.kind === 'adjustment' ? 'adjustment' : 'bonus';
    const u = await resolveIdentifier(b.identifier || b.targetEmail); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    if (cents < 0 && -cents > (await walletCents(u.email))) return res.status(400).json({ success: false, error: 'That would make the wallet negative.' });
    await pool.query('INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, created_by) VALUES ($1, $2, $3, $4, $5)', [u.email, cents, kind, note, a.adminEmail]);
    audit(a.adminEmail, 'wallet-' + kind, u.email, (cents / 100).toFixed(2) + ' USD: ' + note);
    if (kind === 'bonus' && cents > 0 && b.notify !== false) {
      await sendAdminNotice(a.adminEmail, u.email, '🎁 អបអរសាទរ! អ្នកទទួលបានកាដូលើកទឹកចិត្តសម្រាប់ការផលិតមាតិកា ' + usdText(cents) + ' ពី CamFeed។ សូមបន្តផលិតមាតិកាល្អៗ!', 'wallet_notice').catch((e) => console.error('[wallet] notice error:', e.message));
    }
    res.json({ success: true, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), balance: (await walletCents(u.email)) / 100 });
  } catch (err) { console.error('[admin] wallet error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

// One place that shows everything waiting for an admin: withdrawals, creator applications, reports, ads, live requests
app.post('/api/admin/inbox', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const q = (sql) => pool.query(sql).catch(() => ({ rows: [] }));
    const [wd, ri, cr, rp, ad, lv, ct, pr] = await Promise.all([
      q("SELECT w.id, w.amount_cents, w.method, w.created_at AS at, u.first_name, u.last_name FROM withdrawal_requests w JOIN users u ON u.email = w.user_email WHERE w.status = 'pending' ORDER BY w.created_at DESC LIMIT 15"),
      q("SELECT w.id, w.reissue_requested_at AS at, u.first_name, u.last_name FROM withdrawal_requests w JOIN users u ON u.email = w.user_email WHERE w.status = 'paid' AND w.reissue_requested_at IS NOT NULL ORDER BY w.reissue_requested_at DESC LIMIT 15"),
      q("SELECT ca.user_email AS id, ca.requested_at AS at, u.first_name, u.last_name FROM creator_applications ca JOIN users u ON u.email = ca.user_email WHERE ca.status = 'pending' ORDER BY ca.requested_at DESC LIMIT 15"),
      q("SELECT r.id, r.target_type, r.reason, r.created_at::timestamptz AS at FROM reports r WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 15"),
      q("SELECT ar.id, ar.business_name, ar.created_at AS at FROM ad_requests ar WHERE ar.status = 'pending' ORDER BY ar.created_at DESC LIMIT 15"),
      q("SELECT lr.id, lr.purpose, lr.requested_at AS at, u.first_name, u.last_name FROM live_requests lr JOIN users u ON u.email = lr.user_email WHERE lr.status = 'pending' ORDER BY lr.requested_at DESC LIMIT 15"),
      q("SELECT t.id, t.usd, t.method, t.created_at AS at, u.first_name, u.last_name FROM coin_topups t LEFT JOIN users u ON LOWER(u.email) = t.user_email WHERE t.status = 'pending' ORDER BY t.created_at DESC LIMIT 15"),
      q("SELECT p.room_id AS id, p.reason, p.created_at AS at FROM party_reports p WHERE p.handled = FALSE ORDER BY p.created_at DESC LIMIT 15")]);
    const crp = await q("SELECT c.id, c.reason, c.kind, c.created_at AS at, u.first_name, u.last_name FROM chat_reports c LEFT JOIN users u ON LOWER(u.email) = c.target_email WHERE c.status = 'pending' ORDER BY c.created_at DESC LIMIT 15");
    const sta = await q("SELECT s.applied_at AS at, s.real_name, u.first_name, u.last_name FROM party_stars s LEFT JOIN users u ON LOWER(u.email) = s.user_email WHERE s.status = 'pending' ORDER BY s.applied_at DESC LIMIT 15");
    const chr = await q("SELECT r.reward, r.created_at AS at, c.title_km, u.first_name, u.last_name FROM challenge_rewards r JOIN challenges c ON c.id = r.challenge_id LEFT JOIN users u ON LOWER(u.email) = r.user_email WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 15");
    const stb = await q("SELECT b.month, b.amount_cents, b.created_at AS at, u.first_name, u.last_name FROM star_bonus b LEFT JOIN users u ON LOWER(u.email) = b.user_email WHERE b.status = 'pending' ORDER BY b.created_at DESC LIMIT 15");
    const cnt = async (sql) => { try { return Number((await pool.query(sql)).rows[0].n); } catch (e) { return 0; } };
    const counts = {
      withdrawals: await cnt("SELECT COUNT(*) AS n FROM withdrawal_requests WHERE status = 'pending'"),
      reissue: await cnt("SELECT COUNT(*) AS n FROM withdrawal_requests WHERE status = 'paid' AND reissue_requested_at IS NOT NULL"),
      creators: await cnt("SELECT COUNT(*) AS n FROM creator_applications WHERE status = 'pending'"),
      reports: await cnt("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"),
      ads: await cnt("SELECT COUNT(*) AS n FROM ad_requests WHERE status IN ('pending', 'payment_sent')"),
      live: await cnt("SELECT COUNT(*) AS n FROM live_requests WHERE status = 'pending'"),
      coins: await cnt("SELECT COUNT(*) AS n FROM coin_topups WHERE status = 'pending'"),
      party: await cnt("SELECT COUNT(*) AS n FROM party_reports WHERE handled = FALSE"),
      chatReports: await cnt("SELECT COUNT(*) AS n FROM chat_reports WHERE status = 'pending'"),
      stars: await cnt("SELECT COUNT(*) AS n FROM party_stars WHERE status = 'pending'"),
      starBonus: await cnt("SELECT COUNT(*) AS n FROM star_bonus WHERE status = 'pending'"),
      challengeRewards: await cnt("SELECT COUNT(*) AS n FROM challenge_rewards WHERE status = 'pending'"),
      copyrightClaims: await cnt("SELECT COUNT(*) AS n FROM copyright_claims WHERE status = 'pending'"),
      copyrightDups: await cnt("SELECT COUNT(*) AS n FROM dup_flags WHERE status = 'pending'"),
      viewReviews: await cnt("SELECT COUNT(*) AS n FROM view_reviews WHERE status = 'open'")
    };
    const nm = (x) => ((x.first_name || '') + ' ' + (x.last_name || '')).trim() || 'User';
    const items = [].concat(
      wd.rows.map((x) => ({ kind: 'withdrawal', tab: 'monetization', title: nm(x) + ' · $' + (x.amount_cents / 100).toFixed(2), sub: 'Withdrawal request (' + x.method + ')', at: x.at })),
      ri.rows.map((x) => ({ kind: 'reissue', tab: 'monetization', title: nm(x), sub: 'Asked for a new payout code', at: x.at })),
      cr.rows.map((x) => ({ kind: 'creator', tab: 'monetization', title: nm(x), sub: 'Creator (monetization) application', at: x.at })),
      rp.rows.map((x) => ({ kind: 'report', tab: 'reports', title: String(x.target_type || 'report'), sub: String(x.reason || '').slice(0, 90), at: x.at })),
      ad.rows.map((x) => ({ kind: 'ad', tab: 'ads', title: String(x.business_name || 'Ad'), sub: 'Advertising request', at: x.at })),
      lv.rows.map((x) => ({ kind: 'live', tab: 'live', title: nm(x), sub: 'Live video request' + (x.purpose ? ' (' + x.purpose + ')' : ''), at: x.at })),
      ct.rows.map((x) => ({ kind: 'coins', tab: 'coins', title: nm(x) + ' · $' + Number(x.usd).toFixed(2), sub: 'Coin top-up (' + x.method + ')', at: x.at })),
      pr.rows.map((x) => ({ kind: 'party', tab: 'party', title: 'Party Room #' + x.id, sub: 'Room report: ' + String(x.reason || '').slice(0, 80), at: x.at })),
      crp.rows.map((x) => ({ kind: 'report', tab: 'reports', title: '💬 ' + nm(x), sub: 'Chat report (' + x.kind + '): ' + x.reason, at: x.at })),
      sta.rows.map((x) => ({ kind: 'star', tab: 'stars', title: '⭐ ' + nm(x), sub: 'Star application' + (x.real_name ? ' (real name: ' + x.real_name + ')' : ''), at: x.at })),
      chr.rows.map((x) => ({ kind: 'challenge', tab: 'challenges', title: '🎯 ' + nm(x) + ' · $' + (Number((x.reward || {}).amount || 0) / 100).toFixed(2), sub: 'Challenge reward to pay: ' + x.title_km, at: x.at })),
      stb.rows.map((x) => ({ kind: 'star', tab: 'stars', title: '💵 ' + nm(x) + ' · $' + (Number(x.amount_cents || 0) / 100).toFixed(2), sub: 'Star bonus to pay (' + x.month + ')', at: x.at })),
      (counts.copyrightClaims ? [{ kind: 'report', tab: 'copyright', title: '©️ ' + counts.copyrightClaims + ' copyright claim(s)', sub: 'Somebody says a post uses their work', at: new Date() }] : []),
      (counts.copyrightDups ? [{ kind: 'report', tab: 'copyright', title: '🔁 ' + counts.copyrightDups + ' possible copies', sub: 'Posts that look like somebody else\'s older post', at: new Date() }] : []),
      (counts.viewReviews ? [{ kind: 'report', tab: 'views', title: '🔍 ' + counts.viewReviews + ' views to check', sub: 'Views that jumped in a strange way, or a person counting too many views', at: new Date() }] : [])
    ).sort((p, q2) => new Date(q2.at) - new Date(p.at)).slice(0, 40);
    res.json({ success: true, counts, total: Object.values(counts).reduce((n, v) => n + v, 0), items });
  } catch (err) { console.error('[admin] inbox error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/withdrawals', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query(
      `SELECT w.id, w.user_email, w.amount_cents, w.method, w.account_name, w.hold_until, w.name_check, w.new_details, w.account_number, w.status, w.created_at, w.decided_at, w.decided_by, w.note, (w.payout_code IS NOT NULL) AS has_code, w.code_viewed_at, w.reissue_requested_at, w.reissue_count, u.first_name, u.last_name, u.public_id
       FROM withdrawal_requests w JOIN users u ON u.email = w.user_email ORDER BY CASE WHEN w.status = 'pending' THEN 0 WHEN w.reissue_requested_at IS NOT NULL THEN 1 ELSE 2 END, w.created_at DESC LIMIT 100`);
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, withdrawals: r.rows.map((x) => Object.assign({}, x, { amount: x.amount_cents / 100 })) });
  } catch (err) { console.error('[admin] withdrawals error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/withdrawals/decide', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can decide a withdrawal.' });
    const status = ['paid', 'rejected'].includes(b.status) ? b.status : ''; const id = parseInt(b.id, 10);
    if (!status || !id) return res.status(400).json({ success: false, error: 'Invalid request.' });
    const r = await decideWithdrawal(id, status, String(b.note || '').slice(0, 300), a.adminEmail, b.code, b.force === true);
    if (!r.ok) return res.status(r.http || 400).json({ success: false, error: r.error });
    res.json({ success: true });
  } catch (err) { console.error('[admin] withdrawal decide error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

// 💵 pay / refuse a withdrawal (from Admin or from the owner's Telegram)
async function decideWithdrawal(id, status, note, by, codeIn, force) {
  {
    const cur = (await pool.query("SELECT method, hold_until FROM withdrawal_requests WHERE id = $1 AND status = 'pending'", [id])).rows[0];
    if (!cur) return { ok: false, http: 409, error: 'This request was already decided.' };
    if (status === 'paid' && !force && cur.hold_until && new Date(cur.hold_until).getTime() > Date.now()) return { ok: false, http: 400, code: 'hold', error: 'New account details: please wait until ' + new Date(cur.hold_until).toISOString().slice(0, 16).replace('T', ' ') + ' UTC before paying (or tick "pay now").' };
    let sealed = null;
    if (status === 'paid' && CODE_METHODS.includes(cur.method)) {
      const code = String(codeIn || '').trim();
      if (!CODE_RE.test(code)) return { ok: false, http: 400, error: 'Please enter the code (letters, numbers, spaces or dashes).' };
      try { sealed = sealCode(code); } catch (e) { return { ok: false, http: 500, error: 'Server key is missing: set PAYOUT_CODE_KEY (or JWT_SECRET) on Render first.' }; }
    }
    if (status === 'rejected' && !note) return { ok: false, http: 400, error: 'Please write the reason.' };
    const upd = await pool.query("UPDATE withdrawal_requests SET status = $1, decided_at = NOW(), decided_by = $2, note = $3, payout_code = $5, code_issued_at = CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END WHERE id = $4 AND status = 'pending' RETURNING user_email, amount_cents, method", [status, by, note, id, sealed]);
    if (!upd.rows.length) return { ok: false, http: 409, error: 'This request was already decided.' };
    if (status === 'rejected') await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, ref_id, created_by) VALUES ($1, $2, 'withdrawal_refund', $3, $4, $5)", [upd.rows[0].user_email, upd.rows[0].amount_cents, 'Withdrawal #' + id + ' was refused' + (note ? ': ' + note : ''), id, by]);
    const amt = usdText(upd.rows[0].amount_cents), m = upd.rows[0].method;
    const text = status === 'rejected' ? '❌ សំណើដកប្រាក់ ' + amt + ' មិនត្រូវបានអនុម័ត៖ ' + note + '។ ទឹកប្រាក់ត្រូវបានប្រគល់ទៅកាបូបរបស់អ្នកវិញ។'
      : m === 'TopUp' ? '✅ ការដកប្រាក់ ' + amt + ' ជោគជ័យ! សូមចុចដើម្បីមើលកូដបញ្ចូលទឹកប្រាក់ទូរស័ព្ទរបស់អ្នក។'
      : m === 'WingCash' ? '✅ ការដកប្រាក់ ' + amt + ' ជោគជ័យ! សូមចុចដើម្បីមើលកូដសម្រាប់ដកប្រាក់នៅភ្នាក់ងារ Wing។'
      : '✅ ការដកប្រាក់ជោគជ័យ សូមពិនិត្យមើលទឹកប្រាក់ក្នុងគណនីធនាគាររបស់អ្នក (' + amt + ')។';
    await sendAdminNotice(by, upd.rows[0].user_email, text, 'wallet_notice').catch((e) => console.error('[withdraw] notice error:', e.message));
    audit(by, 'withdrawal-' + status, upd.rows[0].user_email, '#' + id + ' ' + (upd.rows[0].amount_cents / 100).toFixed(2) + ' USD');
    return { ok: true, user: upd.rows[0].user_email };
  }
}

// 📲 a new withdrawal on the owner's Telegram: bank / KHQR → ✅ paid / ❌ refuse right there; Wing cash-out / phone top-up need a code → open Admin
async function withdrawTelegram(id) {
  const w = (await pool.query(`SELECT w.*, u.first_name, u.last_name, (SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_ledger l WHERE l.user_email = w.user_email)::int AS left_cents
    FROM withdrawal_requests w JOIN users u ON u.email = w.user_email WHERE w.id = $1 AND w.status = 'pending' AND w.tg_sent = FALSE`, [id])).rows[0];
  if (!w) return;
  const lines = ['💵 ដកប្រាក់ W' + id + ' · ' + usdText(w.amount_cents), '👤 ' + ((w.first_name || '') + ' ' + (w.last_name || '')).trim(),
    '🏦 ' + w.method + (CODE_METHODS.includes(w.method) ? ' · ' + (w.account_name || '') : '') + ' · ' + (w.account_number || ''),
    CODE_METHODS.includes(w.method) ? '' : '🪪 ' + (w.account_name || '') + (w.name_check === 'same' ? ' ✅ ឈ្មោះដូច CamFeed' : ' ⚠️ ឈ្មោះមិនដូច CamFeed — សូមពិនិត្យ'),
    w.new_details ? '🆕 លេខគណនីថ្មី (មិនដែលបង់ពីមុន)' : '', '💰 នៅសល់ក្នុងកាបូប ' + usdText(w.left_cents)].filter(Boolean);
  let sent;
  if (CODE_METHODS.includes(w.method)) sent = await tgPay.notify(lines.concat(['🔑 ត្រូវដាក់លេខកូដ៖ សូមបើក Admin › 💰 ការរកប្រាក់ › 💵 ការដកប្រាក់']));
  else sent = await tgPay.ask('wd', id, lines.concat(['ផ្ទេរលុយរួច ទើបចុច ✅']), ['✅ បានផ្ទេររួច', '❌ បដិសេធ']);
  if (sent) await pool.query('UPDATE withdrawal_requests SET tg_sent = TRUE WHERE id = $1', [id]);
}
// requests that waited (new account details) go to Telegram when their time is over
setInterval(async () => {
  try { for (const r of (await pool.query("SELECT id FROM withdrawal_requests WHERE status = 'pending' AND tg_sent = FALSE AND (hold_until IS NULL OR hold_until <= NOW()) ORDER BY id LIMIT 10")).rows) await withdrawTelegram(r.id); } catch (e) {}
}, 10 * 60 * 1000).unref();


app.post('/api/admin/withdrawals/reissue', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can issue a code.' });
    const id = parseInt(b.id, 10), code = String(b.code || '').trim();
    if (!id || !CODE_RE.test(code)) return res.status(400).json({ success: false, error: 'Please enter the new code.' });
    let sealed; try { sealed = sealCode(code); } catch (e) { return res.status(500).json({ success: false, error: 'Server key is missing: set PAYOUT_CODE_KEY (or JWT_SECRET) on Render first.' }); }
    const upd = await pool.query("UPDATE withdrawal_requests SET payout_code = $2, code_issued_at = NOW(), code_viewed_at = NULL, reissue_requested_at = NULL, reissue_count = reissue_count + 1 WHERE id = $1 AND status = 'paid' AND method IN ('TopUp', 'WingCash') RETURNING user_email", [id, sealed]);
    if (!upd.rows.length) return res.status(409).json({ success: false, error: 'This request cannot get a new code.' });
    audit(a.adminEmail, 'withdrawal-reissue', upd.rows[0].user_email, '#' + id);
    await sendAdminNotice(a.adminEmail, upd.rows[0].user_email, '🔑 កូដថ្មីរបស់អ្នកត្រៀមរួចរាល់ហើយ។ សូមចុចដើម្បីមើលកូដ។', 'wallet_notice').catch((e) => console.error('[withdraw] notice error:', e.message));
    res.json({ success: true });
  } catch (err) { console.error('[admin] reissue error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

// the admin stops (or restores) a creator's earning, e.g. when the views are not real
app.post('/api/admin/creator-earning', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can do this.' });
    const u = await resolveIdentifier(b.identifier || b.targetEmail); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    const suspend = b.suspend !== false, reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (suspend && !reason) return res.status(400).json({ success: false, error: 'Please write the reason.' });
    const upd = await pool.query("UPDATE creator_applications SET earn_suspended = $2, suspend_reason = $3 WHERE user_email = $1 AND status = 'approved' RETURNING user_email", [u.email, suspend, suspend ? reason : null]);
    if (!upd.rows.length) return res.status(404).json({ success: false, error: 'This person is not an approved Creator.' });
    if (!suspend) {                                         // views made while stopped are never paid
      const paidNow = await viewGuard.paidCounts(u.email).catch(() => new Map());
      for (const [pid, n] of paidNow) await pool.query('UPDATE post_earn SET views_seen = GREATEST(views_seen, $2) WHERE post_id = $1', [pid, n]).catch(() => {});
    }   // views made while stopped are never paid later
    audit(a.adminEmail, suspend ? 'creator-earning-stop' : 'creator-earning-resume', u.email, reason);
    await sendAdminNotice(a.adminEmail, u.email, suspend ? '⚠️ សិទ្ធិរកលុយរបស់អ្នកត្រូវបានផ្អាកជាបណ្តោះអាសន្ន៖ ' + reason + '។ ប្រាក់ដែលមានស្រាប់ក្នុងកាបូបនៅដដែល។' : '✅ សិទ្ធិរកលុយរបស់អ្នកត្រូវបានស្តារឡើងវិញ។', 'wallet_notice').catch(() => {});
    res.json({ success: true });
  } catch (err) { console.error('[admin] creator earning error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/admin/creator-rate', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (b.set) {
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change the price.' });
      const rpm = Number(b.rpm), cap = Number(b.dailyCap);
      if (!Number.isFinite(rpm) || rpm < 0 || rpm > 50) return res.status(400).json({ success: false, error: 'Price per 1,000 views must be between $0 and $50.' });
      if (!Number.isFinite(cap) || cap < 0 || cap > 100) return res.status(400).json({ success: false, error: 'Daily cap must be between $0 and $100.' });
      if (rpm > 0 && !(await pool.query("SELECT 1 FROM creator_settings WHERE key = 'earn_start'")).rows.length) await pool.query("INSERT INTO creator_settings (key, value) VALUES ('earn_start', $1)", [String(Date.now())]);
      await pool.query("INSERT INTO creator_settings (key, value) VALUES ('rpm_usd', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(rpm)]);
      await pool.query("INSERT INTO creator_settings (key, value) VALUES ('daily_cap_usd', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [String(cap)]);
      audit(a.adminEmail, 'creator-rate', 'settings', '$' + rpm + ' per 1000 views, cap $' + cap + '/day');
    }
    const cfg = await earnSettings();
    const t = (await pool.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM wallet_ledger WHERE kind = 'revenue_share'")).rows[0];
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, rpm: cfg.rpm, dailyCap: cfg.dailyCap, paidTotal: (Number(t.n) || 0) / 100 });
  } catch (err) { console.error('[admin] rate error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

// The rules of the Creator Program (who may ask to earn) and — SEPARATELY — the rules of the invitation reward.
// Any admin can see them; a Super Admin can change them at any time (no Render change, no restart needed).
// settings the app / website show to people (set by the Super Admin in Admin > System > App settings)
app.get('/api/app-settings', (req, res) => {
  res.json({ success: true, nameDays: ruleNum('NAME_CHANGE_DAYS', NAME_CHANGE_COOLDOWN_DAYS), groupCallMax: ruleNum('GROUP_CALL_MAX', 8) });
});

app.post('/api/admin/monetization-rules', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    const group = b.group === 'referral' ? 'referral' : b.group === 'app' ? 'app' : 'creator';
    if (b.set && typeof b.set === 'object') {
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change the rules.' });
      const changed = [];
      for (const [k, , lo, hi] of RULE_KEYS[group]) {
        if (!Object.prototype.hasOwnProperty.call(b.set, k)) continue;
        const raw = String(b.set[k] === null || b.set[k] === undefined ? '' : b.set[k]).trim();
        if (raw === '') { await pool.query('DELETE FROM creator_settings WHERE key = $1', ['r:' + k]); changed.push(k + '=default'); continue; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v < lo || v > hi) return res.status(400).json({ success: false, error: k + ' must be a number from ' + lo + ' to ' + hi + '.' });
        await pool.query('INSERT INTO creator_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['r:' + k, String(v)]);
        changed.push(k + '=' + v);
      }
      await loadRuleOverrides();
      if (changed.length) audit(a.adminEmail, group === 'referral' ? 'referral-rules' : group === 'app' ? 'app-settings' : 'creator-rules', 'settings', changed.join(', ').slice(0, 300));
    }
    const cur = group === 'referral' ? referralRules() : group === 'app' ? { nameDays: ruleNum('NAME_CHANGE_DAYS', NAME_CHANGE_COOLDOWN_DAYS), groupCallMax: ruleNum('GROUP_CALL_MAX', 8), chatMaxMonths: ruleNum('CHAT_MAX_MONTHS', parseInt(process.env.CHAT_MAX_MONTHS || '12', 10) || 12) } : creatorRules();
    const val = (field) => field === 'minWithdraw' ? cur.minWithdrawCents / 100 : field === 'reward' ? cur.rewardCents / 100 : cur[field];
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, group,
      rules: RULE_KEYS[group].map(([k, field, lo, hi]) => ({ key: k, field, value: val(field), min: lo, max: hi, saved: Object.prototype.hasOwnProperty.call(ruleOverride, k) })) });
  } catch (err) { console.error('[admin] rules error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/admin/referrals', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query(
      `SELECT r.referred_email, r.referrer_email, r.status, r.days_done, r.posts_done, r.created_at, r.completed_at, r.note,
              f.first_name AS friend_first, f.last_name AS friend_last, i.first_name AS inviter_first, i.last_name AS inviter_last, i.public_id AS inviter_id
       FROM referrals r JOIN users f ON f.email = r.referred_email JOIN users i ON i.email = r.referrer_email
       ORDER BY CASE WHEN r.status = 'review' THEN 0 WHEN r.status = 'progress' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 200`);
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, rules: referralRules(), referrals: r.rows });
  } catch (err) { console.error('[admin] referrals error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});
app.post('/api/admin/referrals/decide', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can decide an invitation reward.' });
    const status = ['rewarded', 'rejected'].includes(b.status) ? b.status : ''; const friend = String(b.referredEmail || '');
    if (!status || !friend) return res.status(400).json({ success: false, error: 'Invalid request.' });
    const upd = await pool.query("UPDATE referrals SET status = $2, rewarded_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END, note = $3 WHERE referred_email = $1 AND status = 'review' RETURNING referrer_email", [friend, status, String(b.note || '').slice(0, 300), status === 'rewarded']);
    if (!upd.rows.length) return res.status(409).json({ success: false, error: 'This invitation is not waiting for a decision.' });
    if (status === 'rewarded') await creditReferral(upd.rows[0].referrer_email, referralRules().rewardCents);
    audit(a.adminEmail, 'referral-' + status, upd.rows[0].referrer_email, friend);
    res.json({ success: true });
  } catch (err) { console.error('[admin] referral decide error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
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
    audit(adminEmail, 'delete-account', targetEmail, '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- a notice from the CamFeed team: shows in the person's notification bell (never the admin's own name)
const noticeText = (kind, what, reason, note) => {
  const head = kind === 'removed' ? `🚫 CamFeed៖ ${what}របស់អ្នកត្រូវបានលុប។` : kind === 'warning' ? `⚠️ CamFeed៖ ការព្រមាន — ${what}របស់អ្នកខុសលក្ខខណ្ឌ។` : '📢 CamFeed៖';
  return [head, reason ? `មូលហេតុ៖ ${reason}` : '', note || ''].filter(Boolean).join(' ').slice(0, 700);
};
const mediaWord = (t) => (t === 'video' ? 'វីដេអូ' : t === 'image' ? 'រូបភាព' : 'ប្រកាស');
async function sendAdminNotice(adminEmail, toEmail, text, type) {
  await pool.query("INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, NULL, $3, $4, FALSE)", [toEmail, adminEmail, type === 'wallet_notice' ? 'wallet_notice' : 'admin_notice', text]);
}

app.delete('/api/admin/posts/:postId', async (req, res) => {
  const { postId } = req.params;
  const { adminEmail, adminKey } = req.body;
  const reason = String((req.body || {}).reason || '').trim().slice(0, 300), note = String((req.body || {}).note || '').trim().slice(0, 400), notify = (req.body || {}).notify === true;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed) return res.status(403).json({ success: false, error: auth.error });

    let owner = null;
    if (notify) owner = (await pool.query('SELECT user_email, media_type FROM posts WHERE id = $1', [postId])).rows[0] || null;
    await cleanup.deletePostCompletely(postId); // also marks its reports as resolved_deleted
    audit(adminEmail, 'delete-post', postId, reason);
    let notified = false;
    if (owner && owner.user_email) { try { await sendAdminNotice(String(adminEmail).trim(), owner.user_email, noticeText('removed', mediaWord(owner.media_type), reason, note)); notified = true; } catch (e) { /* the post is deleted anyway */ } }
    res.json({ success: true, notified });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---- Chat safety tools for the team: limit who may start chats, review chats (reason required + logged), remove messages
const CHAT_LIMITS = ['', 'reply_only', 'banned'];
const chatReviewAllowed = (a) => !!a.isSuperAdmin;     // chat limits / chat review: Super Admin only
const superOnlyChat = (a, res) => { if (a.isSuperAdmin) return true; res.status(403).json({ success: false, error: 'Only a Super Admin can use the chat safety tools.' }); return false; };
const reasonOf = (b) => String(b.reason || '').trim().slice(0, 300);

app.post('/api/admin/chat/limit', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!superOnlyChat(a, res)) return;
    const b = req.body || {};
    const u = await loadAdminTarget(b); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    const limit = String(b.limit || '');
    if (!CHAT_LIMITS.includes(limit)) return res.status(400).json({ success: false, error: 'Bad limit.' });
    const reason = reasonOf(b);
    if (limit && reason.length < 3) return res.status(400).json({ success: false, error: 'Please write a reason.' });
    await chatExtras.ensureSchema();
    await pool.query('UPDATE users SET chat_limit = $1 WHERE email = $2', [limit, u.email]);
    audit(a.adminEmail, 'chat-limit-' + (limit || 'off'), u.email, reason);
    if (b.notify !== false) {
      const text = limit === 'banned' ? `🚫 CamFeed៖ គណនីរបស់អ្នកត្រូវបានរឹតត្បិតមិនឱ្យជជែក ឬហៅ។${reason ? ' មូលហេតុ៖ ' + reason : ''}`
        : limit === 'reply_only' ? `⚠️ CamFeed៖ អ្នកអាចឆ្លើយតបសារបានតែពេលគេផ្ញើមកមុន អ្នកមិនអាចចាប់ផ្តើមជជែកជាមួយអ្នកផ្សេងមុនបានទេ។${reason ? ' មូលហេតុ៖ ' + reason : ''}`
        : '✅ CamFeed៖ ការរឹតត្បិតការជជែករបស់អ្នកត្រូវបានដកចេញ។';
      await sendAdminNotice(a.adminEmail, u.email, text.slice(0, 700)).catch(() => {});
    }
    res.json({ success: true, limit });
  } catch (err) { console.error('[admin] chat limit error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/admin/chat/status', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!superOnlyChat(a, res)) return;
    if (!(req.body || {}).target) return res.json({ success: true, limit: '', reviewAllowed: true });
    const u = await loadAdminTarget(req.body || {}); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    await chatExtras.ensureSchema();
    const r = await pool.query('SELECT chat_limit FROM users WHERE email = $1', [u.email]);
    res.json({ success: true, limit: (r.rows[0] && r.rows[0].chat_limit) || '', reviewAllowed: chatReviewAllowed(a) });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/chat/conversations', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!chatReviewAllowed(a)) return res.status(403).json({ success: false, error: 'Only a Super Admin may review chats.' });
    const b = req.body || {};
    const u = await loadAdminTarget(b); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    const reason = reasonOf(b);
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'Please write the reason for reviewing (at least 5 letters).' });
    await chatExtras.ensureSchema();
    audit(a.adminEmail, 'chat-review', u.email, reason);
    const me = u.email.toLowerCase();
    const peers = await pool.query(
      `SELECT t.peer, COUNT(*)::int AS n, MAX(t.created_at) AS last_at, x.first_name, x.last_name, x.profile_pic
       FROM (SELECT CASE WHEN LOWER(sender_email) = $1 THEN LOWER(receiver_email) ELSE LOWER(sender_email) END AS peer, created_at
             FROM messages WHERE (LOWER(sender_email) = $1 OR LOWER(receiver_email) = $1) AND COALESCE(message_type, 'text') NOT IN ('system')) t
       LEFT JOIN users x ON LOWER(x.email) = t.peer GROUP BY t.peer, x.first_name, x.last_name, x.profile_pic ORDER BY last_at DESC LIMIT 100`, [me]);
    const groups = await pool.query(
      `SELECT g.id, g.name, (SELECT COUNT(*)::int FROM chat_group_members x WHERE x.group_id = g.id) AS members,
              (SELECT COUNT(*)::int FROM group_messages gm WHERE gm.group_id = g.id) AS n
       FROM chat_groups g JOIN chat_group_members m ON m.group_id = g.id WHERE m.user_email = $1 ORDER BY g.id DESC LIMIT 100`, [me]);
    res.json({ success: true, peers: peers.rows, groups: groups.rows });
  } catch (err) { console.error('[admin] chat conversations error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/chat/thread', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!chatReviewAllowed(a)) return res.status(403).json({ success: false, error: 'Only a Super Admin may review chats.' });
    const b = req.body || {};
    const u = await loadAdminTarget(b); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    const reason = reasonOf(b);
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'Please write the reason for reviewing (at least 5 letters).' });
    await chatExtras.ensureSchema();
    const me = u.email.toLowerCase();
    if (b.groupId) {
      const gid = parseInt(b.groupId, 10) || 0;
      const mem = await pool.query('SELECT 1 FROM chat_group_members WHERE group_id = $1 AND user_email = $2', [gid, me]);
      if (!mem.rows.length) return res.status(404).json({ success: false, error: 'Not in this group.' });
      audit(a.adminEmail, 'chat-review-group', `${u.email} #${gid}`, reason);
      const r = await pool.query(`SELECT * FROM (SELECT gm.id, gm.sender_email, gm.message, gm.media_url, gm.message_type, gm.created_at, x.first_name, x.last_name
          FROM group_messages gm LEFT JOIN users x ON LOWER(x.email) = gm.sender_email WHERE gm.group_id = $1 ORDER BY gm.id DESC LIMIT 300) t ORDER BY id ASC`, [gid]);
      return res.json({ success: true, kind: 'group', messages: r.rows });
    }
    const peer = String(b.peer || '').trim().toLowerCase();
    if (!peer) return res.status(400).json({ success: false, error: 'Who?' });
    audit(a.adminEmail, 'chat-review-dm', `${u.email} ↔ ${peer}`, reason);
    const r = await pool.query(`SELECT * FROM (SELECT id, sender_email, receiver_email, message, media_url, message_type, created_at FROM messages
        WHERE (LOWER(sender_email) = $1 AND LOWER(receiver_email) = $2) OR (LOWER(sender_email) = $2 AND LOWER(receiver_email) = $1) ORDER BY id DESC LIMIT 300) t ORDER BY id ASC`, [me, peer]);
    res.json({ success: true, kind: 'dm', messages: r.rows });
  } catch (err) { console.error('[admin] chat thread error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/admin/chat/delete-message', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!superOnlyChat(a, res)) return;
    const b = req.body || {}; const id = parseInt(b.id, 10) || 0; const reason = reasonOf(b);
    if (!id || reason.length < 3) return res.status(400).json({ success: false, error: 'Please write a reason.' });
    await chatExtras.ensureSchema();
    const group = b.kind === 'group';
    const cur = (await pool.query(group ? 'SELECT sender_email, media_url FROM group_messages WHERE id = $1' : 'SELECT sender_email, media_url FROM messages WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Message not found.' });
    await pool.query(group ? "UPDATE group_messages SET message = '__CAMFEED_MSG_DELETED__', media_url = NULL, message_type = 'deleted' WHERE id = $1"
      : "UPDATE messages SET message = '__CAMFEED_MSG_DELETED__', media_url = NULL, message_type = 'deleted' WHERE id = $1", [id]);
    if (cur.media_url) cleanup.purgeMediaUrls(extractMediaUrls(cur.media_url)).catch(() => {});
    audit(a.adminEmail, group ? 'chat-delete-group-msg' : 'chat-delete-dm', `${cur.sender_email} #${id}`, reason);
    if (b.notify === true && cur.sender_email) await sendAdminNotice(a.adminEmail, cur.sender_email, noticeText('removed', 'សារ', reason, '')).catch(() => {});
    res.json({ success: true });
  } catch (err) { console.error('[admin] chat delete error:', err.message); res.status(500).json({ success: false, error: 'Could not delete.' }); }
});

// warn / message the owner of a post (or any person) without deleting anything
app.post('/api/admin/notice', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const b = req.body || {};
    const reason = String(b.reason || '').trim().slice(0, 300), note = String(b.note || '').trim().slice(0, 400);
    if (!reason && !note) return res.status(400).json({ success: false, error: 'Write a reason or a message.' });
    let to = String(b.targetEmail || '').trim(), what = 'ប្រកាស';
    if (b.postId) {
      const p = (await pool.query('SELECT user_email, media_type FROM posts WHERE id = $1', [parseInt(b.postId, 10) || 0])).rows[0];
      if (!p) return res.status(404).json({ success: false, error: 'Post not found.' });
      to = p.user_email; what = mediaWord(p.media_type);
    }
    if (!to) return res.status(400).json({ success: false, error: 'Who should receive it?' });
    const kind = b.kind === 'warning' ? 'warning' : 'message';
    await sendAdminNotice(a.adminEmail, to, noticeText(kind, what, reason, note));
    audit(a.adminEmail, 'admin-notice-' + kind, to, reason || note);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/reports/:reportId/status', async (req, res) => {
  const { reportId } = req.params;
  const { adminEmail, adminKey, status } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed) return res.status(403).json({ success: false, error: auth.error });

    await pool.query('UPDATE reports SET status = $1 WHERE id = $2', [status || 'dismissed', reportId]);
    audit(adminEmail, 'report-' + (status || 'dismissed'), reportId, '');
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