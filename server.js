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
<link rel="icon" type="image/png" href="/icons/favicon-48.png"><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Khmer:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;background:#f0f2f5;color:#050505;font-family:'Noto Sans Khmer',system-ui,sans-serif}
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
      <a class="b b1" href="/index.html?next=${pubEsc('/p/' + id)}">ចូល / ចុះឈ្មោះ</a></div>
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
      CREATE TABLE IF NOT EXISTS feed_seen (viewer_email TEXT NOT NULL, post_id INTEGER NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), times INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (viewer_email, post_id));
      CREATE INDEX IF NOT EXISTS idx_feed_seen_time ON feed_seen(viewer_email, seen_at DESC);
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
    await pool.query('CREATE TABLE IF NOT EXISTS referrals (referred_email TEXT PRIMARY KEY, referrer_email TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
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
// Where people can message us on Telegram (set SUPPORT_TELEGRAM=yourusername in Render). Only a plain https://t.me/<username> link is ever given out.
function supportTelegramLink() {
  const v = String(process.env.SUPPORT_TELEGRAM || '').trim();
  const m = /^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(v);
  return m ? 'https://t.me/' + m[1] : '';
}
app.get('/api/auth-options', (req, res) => res.json({ success: true, telegram: tgLogin.isConfigured(), phone: gateway.isConfigured(), telegramContact: supportTelegramLink() }));

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

// The feed remembers what you have already SEEN (pictures and text too, not only videos) so it does not show the same posts again and again.
app.post('/api/feed/seen', async (req, res) => {
  try {
    const me = req.authEmail; if (!me) return res.json({ success: true });
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 40);
    if (!ids.length) return res.json({ success: true });
    await pool.query(`INSERT INTO feed_seen (viewer_email, post_id) SELECT $1, UNNEST($2::int[])
      ON CONFLICT (viewer_email, post_id) DO UPDATE SET seen_at = NOW(), times = feed_seen.times + 1`, [me, ids]);
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
        + (CASE WHEN fs.post_id IS NOT NULL AND fs.seen_at > NOW() - INTERVAL '24 hours' THEN -90
                WHEN fs.post_id IS NOT NULL THEN -35
                WHEN pv.post_id IS NOT NULL THEN -25
                ELSE 18 END)
        + (60.0 / (EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0 + 2.0))
        + (RANDOM() * 35.0)
      ) AS feed_rank_score
      ${baseFrom}
      LEFT JOIN follows f ON f.follower_email = $1 AND f.following_email = p.user_email
      LEFT JOIN user_interest_scores uis ON uis.user_email = $1 AND uis.category = p.ai_category
      LEFT JOIN (SELECT DISTINCT post_id FROM post_views WHERE viewer_email = $1) pv ON pv.post_id = p.id
      LEFT JOIN feed_seen fs ON fs.viewer_email = $1 AND fs.post_id = p.id
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
    // Mix: popular + new + random. At least every 3rd post of a page is a NEW one (under 24 h) when there is one in the page.
    let rows = result.rows;
    if (!useLatest && rows.length > 3) {
      const isNew = (r) => Date.now() - new Date(r.created_at).getTime() < 24 * 3600 * 1000;
      const fresh = rows.filter(isNew), old = rows.filter((r) => !isNew(r)), out = [];
      const takeFresh = () => fresh.shift(), takeOld = () => (old.length ? old.shift() : fresh.shift());
      while (out.length < rows.length) { const slot = out.length; out.push((slot % 3 === 2 && fresh.length) ? takeFresh() : takeOld()); }
      rows = out;
    }
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
      SELECT u.*, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '40 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $2), TRUE)) AS is_online,
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
      SELECT DISTINCT u.email, u.first_name, u.last_name, u.profile_pic, CASE WHEN COALESCE(u.show_active_status, TRUE) THEN u.last_active END AS last_active, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '40 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online,
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
      
      SELECT u.email, u.first_name, u.last_name, u.profile_pic, CASE WHEN COALESCE(u.show_active_status, TRUE) THEN u.last_active END AS last_active, (u.last_active IS NOT NULL AND u.last_active >= NOW() - INTERVAL '40 seconds' AND COALESCE(u.show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online,
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
      SELECT email, first_name, last_name, profile_pic, CASE WHEN COALESCE(show_active_status, TRUE) THEN last_active END AS last_active, (last_active IS NOT NULL AND last_active >= NOW() - INTERVAL '40 seconds' AND COALESCE(show_active_status, TRUE) AND COALESCE((SELECT v.show_active_status FROM users v WHERE v.email = $1), TRUE)) AS is_online 
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

    // A shared place: the link sits inside the text (media links must come from our own storage), the numbers must be real coordinates.
    if (messageType === 'location') {
      const loc = /^📍[^\n]{0,60}\nhttps:\/\/www\.google\.com\/maps\/search\/\?api=1&query=(-?\d{1,3}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?)$/.exec(String(req.body.message || ''));
      if (!loc || Math.abs(parseFloat(loc[1])) > 90 || Math.abs(parseFloat(loc[2])) > 180) {
        return res.status(400).json({ success: false, error: 'Invalid location' });
      }
      mediaUrl = null;
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

app.post('/api/admin/system', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    let db = false, dbMs = null; const t0 = Date.now();
    try { await pool.query('SELECT 1'); db = true; dbMs = Date.now() - t0; } catch (e) {}
    const has = (k) => !!process.env[k];
    res.json({ success: true, isSuperAdmin: a.isSuperAdmin, checks: {
      database: db, databaseMs: dbMs, jwtSecret: has('JWT_SECRET'), adminPin: !!ADMIN_MASTER_KEY, emailCodes: !!(mailer && mailer.isConfigured && mailer.isConfigured()), phoneCodes: gateway.isConfigured(),
      telegramLogin: tgLogin.isConfigured(), turnstile: has('TURNSTILE_SECRET_KEY'), mediaStorage: has('R2_BUCKET_NAME') && has('R2_ACCESS_KEY_ID') && has('R2_SECRET_ACCESS_KEY'), aiCategories: has('GEMINI_API_KEY'),
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
const AD_OBJECTIVES = ['reach', 'traffic', 'engagement', 'messages', 'video_views'];
const AD_INTERESTS = ['Comedy', 'Music', 'Gaming', 'Food', 'Vehicles & Motorcycles', 'Technology', 'News', 'Sports', 'Education', 'Travel', 'Lifestyle'];
const AD_DEFAULT_PAYMENT_TEXT = 'ABA Bank\nលេខគណនី / Account: 002217985\nសូមសរសេរក្នុងកំណត់ចំណាំ: CamFeed Ads + ឈ្មោះអាជីវកម្មរបស់អ្នក\nPlease write in the note: CamFeed Ads + your business name';
const AD_FREQ_CAP = 3;                                                     // one person is shown the same ad at most 3 times a day
const adNum = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };
const AD_CPM = { feed: adNum(process.env.AD_CPM_FEED_USD, 0.5), video: adNum(process.env.AD_CPM_VIDEO_USD, 0.8) };   // USD per 1000 views
const AD_MIN_BUDGET_USD = adNum(process.env.AD_MIN_BUDGET_USD, 2);
const adLink = (v) => { const s = String(v || '').trim(); return /^https?:\/\/[^\s<>"'`]{4,480}$/i.test(s) ? s : ''; };   // only web links: never javascript:
const adInterests = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => AD_INTERESTS.includes(x)).slice(0, 6);
const adPlaceFeed = (p) => p === 'feed_banner' || p === 'both';
const adPlaceVideo = (p) => p === 'video_preroll' || p === 'both';
// how many views a budget buys: the money is split over the places chosen
function adEstimate(budgetUsd, days, placement) {
  const cpms = [];
  if (adPlaceFeed(placement)) cpms.push(AD_CPM.feed);
  if (adPlaceVideo(placement)) cpms.push(AD_CPM.video);
  const cpm = cpms.reduce((a, b) => a + b, 0) / (cpms.length || 1);
  const views = Math.floor(budgetUsd / cpm * 1000);
  return { cpm: Number(cpm.toFixed(3)), views, perDay: Math.floor(views / Math.max(days, 1)) };
}

app.get('/api/ads/estimate', async (req, res) => {
  try {
    const budget = adNum(req.query.budget, 0), days = clampInt(req.query.days, 7, 1, 30);
    const placement = AD_PLACEMENTS.includes(req.query.placement) ? req.query.placement : 'both';
    const est = adEstimate(budget, days, placement);
    const country = String(req.query.country || '').trim().slice(0, 60);
    const users = (await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE last_active >= NOW() - INTERVAL '30 days' AND ($1 = '' OR LOWER(country) = LOWER($1))", [country])).rows[0].n;
    const ceiling = users * AD_FREQ_CAP * days;                         // the most that real people can be shown in that time
    res.json({ success: true, cpm: est.cpm, cpmFeed: AD_CPM.feed, cpmVideo: AD_CPM.video, views: est.views, viewsPerDay: est.perDay, activeUsers: users, canDeliver: Math.min(est.views, ceiling), minBudget: AD_MIN_BUDGET_USD });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not calculate.' }); }
});

// what the viewer is shown: only live ads, not their own, inside budget and today's pace, matching country and interests
app.get('/api/sponsored-ads', async (req, res) => {
  try {
    const me = req.authEmail || '';
    const u = me ? (await pool.query('SELECT country FROM users WHERE email = $1', [me])).rows[0] : null;
    const myInterests = me ? (await pool.query('SELECT category FROM user_interest_scores WHERE user_email = $1 AND score > 0 ORDER BY score DESC LIMIT 5', [me])).rows.map((r) => r.category) : [];
    const r = await pool.query(`SELECT a.id, a.advertiser_name, a.placement, a.objective, a.cta, COALESCE(NULLIF(a.caption, ''), p.content, '') AS caption, a.target_url, COALESCE(a.media_url, p.media_url) AS media_url, a.skip_seconds, a.post_id, a.owner_email, a.interests, a.country
      FROM sponsored_ads a LEFT JOIN posts p ON p.id = a.post_id LEFT JOIN ad_daily d ON d.ad_id = a.id AND d.day = CURRENT_DATE
      WHERE a.status = 'active' AND (a.ends_at IS NULL OR a.ends_at > NOW()) AND COALESCE(a.owner_email, '') <> $1
        AND (a.budget_cents = 0 OR (a.spent_cents < a.budget_cents AND COALESCE(d.spent_cents, 0) < (a.budget_cents::numeric / GREATEST(a.days, 1)) * 1.25))
      ORDER BY a.id DESC LIMIT 60`, [me]);
    const mine = String((u && u.country) || '').toLowerCase();
    const out = [];
    for (const a of r.rows) {
      if (a.country && mine && String(a.country).toLowerCase() !== mine) continue;
      const wanted = String(a.interests || '').split(',').filter(Boolean);
      const match = wanted.length ? wanted.filter((x) => myInterests.includes(x)).length : 0;
      if (wanted.length && myInterests.length && !match) continue;       // we only leave an ad out when we KNOW the person is not interested
      out.push({ ad: { id: a.id, advertiser_name: a.advertiser_name, placement: a.placement, objective: a.objective, cta: a.cta, caption: String(a.caption || '').slice(0, 500), target_url: a.target_url || '', media_url: a.media_url || '', skip_seconds: a.skip_seconds, post_id: a.post_id || null, owner_email: a.owner_email || null }, match, rnd: Math.random() });
    }
    out.sort((x, y) => (y.match - x.match) || (x.rnd - y.rnd));
    res.json({ success: true, ads: out.slice(0, 20).map((x) => x.ad) });
  } catch (err) { console.error('[ads] serve:', err.message); res.json({ success: true, ads: [] }); }
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
  res.json({ success: true, paymentText: String(process.env.AD_PAYMENT_TEXT || AD_DEFAULT_PAYMENT_TEXT).slice(0, 600), paymentQr: qr || '', contact: supportTelegramLink() || '', interests: AD_INTERESTS, minBudget: AD_MIN_BUDGET_USD, cpmFeed: AD_CPM.feed, cpmVideo: AD_CPM.video });
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
    const name = String(b.business_name || '').trim().slice(0, 80), contact = String(b.contact || '').trim().slice(0, 120);
    const placement = AD_PLACEMENTS.includes(b.placement) ? b.placement : 'feed_banner';
    const objective = AD_OBJECTIVES.includes(b.objective) ? b.objective : 'traffic';
    const target = b.target_url ? adLink(b.target_url) : '';
    const budget = Math.round(adNum(b.budget_usd, 0) * 100), days = clampInt(b.days, 7, 1, 30);
    if (!name || !contact) return res.status(400).json({ success: false, error: 'Business name and a phone / Telegram contact are required.' });
    if (budget < AD_MIN_BUDGET_USD * 100 || budget > 100000 * 100) return res.status(400).json({ success: false, error: 'The smallest budget is $' + AD_MIN_BUDGET_USD + '.' });
    if (b.target_url && !target) return res.status(400).json({ success: false, error: 'The link must start with http:// or https://' });
    if (objective === 'traffic' && !target && !b.post_id) return res.status(400).json({ success: false, error: 'For "more visits" please add the link people should open.' });
    let postId = null, media = null, caption = String(b.caption || '').slice(0, 500);
    if (b.post_id) {                                                        // boost one of my own public posts
      postId = parseInt(b.post_id, 10);
      const p = (await pool.query("SELECT id, content FROM posts WHERE id = $1 AND user_email = $2 AND COALESCE(privacy, 'public') = 'public'", [postId, email])).rows[0];
      if (!p) return res.status(400).json({ success: false, error: 'You can only boost your own public posts.' });
      if (!caption) caption = String(p.content || '').slice(0, 500);
    } else {
      media = security.safeUrl(String(b.media_url || ''));
      if (!media) return res.status(400).json({ success: false, error: 'Please upload a picture or video, or choose a post to boost.' });
    }
    if (adPlaceVideo(placement) && !postId && !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(media || '') && placement === 'video_preroll') { /* a picture is shown for a few seconds: allowed */ }
    const open = await pool.query("SELECT COUNT(*)::int AS n FROM ad_requests WHERE user_email = $1 AND status IN ('pending', 'quoted', 'payment_sent')", [email]);
    if (open.rows[0].n >= 3) return res.status(429).json({ success: false, error: 'You already have 3 requests waiting. Please wait for an answer.' });
    const cta = ['learn_more', 'message', 'shop', 'call', 'none'].includes(b.cta) ? b.cta : (objective === 'messages' ? 'message' : 'learn_more');
    const r = await pool.query(`INSERT INTO ad_requests (user_email, business_name, contact, placement, caption, target_url, media_url, days, budget_note, objective, post_id, interests, country, budget_cents, price_cents, cta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15) RETURNING id`,
      [email, name, contact, placement, caption, target || null, media, days, String(b.budget_note || '').slice(0, 120), objective, postId, adInterests(b.interests).join(','), String(b.country || '').trim().slice(0, 60), budget, cta]);
    res.status(201).json({ success: true, id: r.rows[0].id });
  } catch (err) { console.error('[ads] request:', err.message); res.status(500).json({ success: false, error: 'Could not send the request.' }); }
});
app.get('/api/ads/my', async (req, res) => {
  try {
    if (!req.authEmail) return res.status(401).json({ success: false, error: 'Please log in.' });
    const r = await pool.query(`SELECT q.id, q.business_name, q.placement, q.objective, q.caption, q.days, q.status, q.budget_cents, q.price_cents, q.admin_note, q.pay_ref, q.post_id, q.ad_id, q.created_at,
      a.status AS ad_status, a.impressions, a.clicks, a.spent_cents, a.ends_at
      FROM ad_requests q LEFT JOIN sponsored_ads a ON a.id = q.ad_id WHERE q.user_email = $1 ORDER BY q.id DESC LIMIT 30`, [req.authEmail]);
    res.json({ success: true, requests: r.rows });
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
    if (ref.length < 3) return res.status(400).json({ success: false, error: 'Please write the payment reference (transaction number or the name you paid from).' });
    const r = await pool.query("UPDATE ad_requests SET status = 'payment_sent', pay_ref = $1, updated_at = NOW() WHERE id = $2 AND user_email = $3 AND status = 'quoted'", [ref, id, req.authEmail]);
    if (!r.rowCount) return res.status(400).json({ success: false, error: 'This request is not waiting for payment.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});

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
      q.status, q.price_cents, q.admin_note, q.pay_ref, q.ad_id, q.created_at, u.first_name, u.last_name,
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
    await pool.query("UPDATE ad_requests SET status = 'rejected', admin_note = $1, updated_at = NOW() WHERE id = $2 AND status IN ('pending', 'quoted', 'payment_sent')", [String(req.body.note || '').slice(0, 300), id]);
    audit(a.adminEmail, 'ad_reject', id, '');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Could not save.' }); }
});
app.post('/api/admin/ad-requests/activate', async (req, res) => {          // money is confirmed by a Super Admin only
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can start a paid ad.' });
    const id = parseInt(req.body.id, 10); if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Bad id.' });
    const q = (await pool.query("SELECT * FROM ad_requests WHERE id = $1 AND status IN ('quoted', 'payment_sent')", [id])).rows[0];
    if (!q) return res.status(400).json({ success: false, error: 'This request is not ready to start.' });
    let media = q.media_url, base = { likes: 0, comments: 0, shares: 0 };
    if (q.post_id) {                                                        // a boosted post: remember the numbers it had on day one
      const p = (await pool.query(`SELECT p.id, (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS likes, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comments,
        (SELECT COUNT(*) FROM posts sp WHERE sp.shared_post_id = p.id)::int AS shares FROM posts p WHERE p.id = $1 AND p.user_email = $2 AND COALESCE(p.privacy, 'public') = 'public'`, [q.post_id, q.user_email])).rows[0];
      if (!p) return res.status(400).json({ success: false, error: 'The post is no longer public or was deleted.' });
      base = p; media = null;
    }
    const ad = await pool.query(`INSERT INTO sponsored_ads (advertiser_name, placement, caption, target_url, media_url, skip_seconds, created_by, ends_at, objective, post_id, interests, country, budget_cents, days, cpm_feed_cents, cpm_video_cents, owner_email, cta, base_likes, base_comments, base_shares)
      VALUES ($1,$2,$3,$4,$5,5,$6, NOW() + ($7 || ' days')::interval, $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [q.business_name, q.placement, q.caption, q.target_url, media, a.adminEmail, String(q.days), q.objective, q.post_id, q.interests || '', q.country || '', q.budget_cents || 0, q.days,
        AD_CPM.feed * 100, AD_CPM.video * 100, q.user_email, q.cta || 'learn_more', base.likes, base.comments, base.shares]);
    await pool.query("UPDATE ad_requests SET status = 'live', ad_id = $1, updated_at = NOW() WHERE id = $2", [ad.rows[0].id, id]);
    audit(a.adminEmail, 'ad_activate', id, 'ad #' + ad.rows[0].id + ' for ' + q.days + ' days, budget $' + ((q.budget_cents || 0) / 100).toFixed(2) + ', paid $' + ((q.price_cents || 0) / 100).toFixed(2));
    res.json({ success: true, adId: ad.rows[0].id });
  } catch (err) { console.error('[admin] ad activate:', err.message); res.status(500).json({ success: false, error: 'Could not start the ad.' }); }
});

// ---------------------------------------------------------------------------
// Monetization (Creator Program): rules, wallet (a ledger of cents), withdrawals paid BY HAND, referrals.
// No money moves automatically: bonuses are added by a Super Admin and withdrawals are paid by the owner (ABA / Wing / KHQR).
// ---------------------------------------------------------------------------
const creatorRules = () => {
  const n = (k, d) => { const raw = process.env[k]; const v = Number(raw); return raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0 ? v : d; };
  return { followers: n('CREATOR_MIN_FOLLOWERS', 1000), views: n('CREATOR_MIN_VIEWS', 10000), ageDays: n('CREATOR_MIN_ACCOUNT_DAYS', 30), posts: n('CREATOR_MIN_POSTS', 5), minWithdrawCents: Math.round(n('MIN_WITHDRAW_USD', n('CREATOR_MIN_WITHDRAW_USD', 5)) * 100) };
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
const meetsRules = (st, rules) => st.followers >= rules.followers && st.views >= rules.views && st.posts >= rules.posts && st.ageDays >= rules.ageDays;
async function walletCents(email) {
  const r = await pool.query('SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM wallet_ledger WHERE user_email = $1', [email]);
  return Number(r.rows[0] && r.rows[0].cents) || 0;
}
// ---- Invitation reward: $0.20 for the person who invited a friend, paid when the friend has used CamFeed on 3 different days AND posted 3 public photos / videos.
//      (6 steps; the progress is shown step by step, the money is added to the wallet only when all steps are done)
const referralRules = () => {
  const n = (k, d) => { const raw = process.env[k]; const v = Number(raw); return raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0 ? v : d; };
  return { rewardCents: Math.round(n('REFERRAL_REWARD_USD', 0.2) * 100), days: n('REFERRAL_ACTIVE_DAYS', 3), posts: n('REFERRAL_POSTS', 3), windowDays: n('REFERRAL_WINDOW_DAYS', 14), maxPerMonth: n('REFERRAL_MAX_PER_MONTH', 50) };
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
    const [st, cents, app_, refs, me, wd, led] = await Promise.all([
      creatorStats(email), walletCents(email),
      pool.query('SELECT status, decided_at, note FROM creator_applications WHERE user_email = $1', [email]),
      pool.query('SELECT COUNT(*) AS n FROM referrals WHERE referrer_email = $1', [email]),
      pool.query('SELECT public_id FROM users WHERE email = $1', [email]),
      pool.query('SELECT id, amount_cents, method, status, created_at, note FROM withdrawal_requests WHERE user_email = $1 ORDER BY created_at DESC, id DESC LIMIT 5', [email]),
      pool.query('SELECT amount_cents, kind, note, created_at FROM wallet_ledger WHERE user_email = $1 ORDER BY created_at DESC, id DESC LIMIT 10', [email])
    ]);
    const a = app_.rows[0] || null;
    const rr = referralRules(), steps = rr.days + rr.posts;
    const invited = (await pool.query(
      `SELECT r.status, r.days_done, r.posts_done, r.created_at, r.completed_at, r.note, u.first_name, u.last_name FROM referrals r JOIN users u ON u.email = r.referred_email
       WHERE r.referrer_email = $1 ORDER BY r.created_at DESC LIMIT 50`, [email])).rows;
    const earned = Number((await pool.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM wallet_ledger WHERE user_email = $1 AND kind = 'referral'", [email])).rows[0].n) || 0;
    res.json({ success: true, creatorProgramOpen: process.env.CREATOR_PROGRAM_OPEN === 'true', walletBalance: cents / 100, referralCount: Number(refs.rows[0] && refs.rows[0].n) || 0, referralCode: (me.rows[0] && me.rows[0].public_id) || '',
      referralRules: { reward: rr.rewardCents / 100, days: rr.days, posts: rr.posts, windowDays: rr.windowDays }, referralEarned: earned / 100,
      referrals: invited.map((x) => { const done = Math.min(steps, (x.days_done || 0) + (x.posts_done || 0)); return { name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), status: x.status, daysDone: x.days_done || 0, postsDone: x.posts_done || 0, joined: x.created_at, note: x.status === 'review' || x.status === 'rejected' ? '' : '', progress: x.status === 'rewarded' ? rr.rewardCents / 100 : (x.status === 'progress' ? Math.round(rr.rewardCents * done / steps) / 100 : 0), reward: rr.rewardCents / 100 }; }),
      followersCount: st.followers, totalViews: st.views, postsCount: st.posts, accountAgeDays: st.ageDays,
      applicationStatus: a ? a.status : null, applicationNote: a && a.status === 'rejected' ? (a.note || '') : '', eligible: meetsRules(st, rules),
      criteria: { followers: rules.followers, views: rules.views, ageDays: rules.ageDays, posts: rules.posts }, minWithdraw: rules.minWithdrawCents / 100,
      withdrawals: wd.rows.map((w) => ({ id: w.id, amount: w.amount_cents / 100, method: w.method, status: w.status, created_at: w.created_at, note: w.note || '' })),
      ledger: led.rows.map((l) => ({ amount: l.amount_cents / 100, kind: l.kind, note: l.note || '', created_at: l.created_at })) });
  } catch (err) { console.error('[monetization] status error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
});

app.post('/api/monetization/apply', async (req, res) => {
  try {
    if (process.env.CREATOR_PROGRAM_OPEN !== 'true') return res.status(403).json({ success: false, comingSoon: true, error: 'Earning money from videos is coming soon.' });
    const email = req.authEmail, rules = creatorRules();
    const cur = (await pool.query('SELECT status, decided_at FROM creator_applications WHERE user_email = $1', [email])).rows[0];
    if (cur && cur.status === 'approved') return res.status(409).json({ success: false, error: 'You are already in the Creator Program.' });
    if (cur && cur.status === 'pending') return res.status(409).json({ success: false, error: 'Your application is already waiting for review.' });
    if (cur && cur.status === 'rejected' && cur.decided_at && Date.now() - new Date(cur.decided_at).getTime() < 7 * 86400000) return res.status(429).json({ success: false, error: 'Please wait 7 days after a refusal before applying again.' });
    const st = await creatorStats(email);
    if (!meetsRules(st, rules)) return res.status(400).json({ success: false, error: 'You do not meet the requirements yet.', stats: st, criteria: rules });
    await pool.query(`INSERT INTO creator_applications (user_email, status, requested_at, decided_at, decided_by, note) VALUES ($1, 'pending', NOW(), NULL, NULL, NULL)
      ON CONFLICT (user_email) DO UPDATE SET status = 'pending', requested_at = NOW(), decided_at = NULL, decided_by = NULL, note = NULL`, [email]);
    res.json({ success: true });
  } catch (err) { console.error('[monetization] apply error:', err.message); res.status(500).json({ success: false, error: 'Could not send your application.' }); }
});

app.post('/api/monetization/withdraw', async (req, res) => {
  try {
    const email = req.authEmail, rules = creatorRules(), b = req.body || {};
    const cents = Math.round(Number(b.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ success: false, error: 'Please enter an amount.' });
    if (cents < rules.minWithdrawCents) return res.status(400).json({ success: false, error: `The smallest withdrawal is $${(rules.minWithdrawCents / 100).toFixed(2)}.` });
    const method = ['ABA', 'Wing', 'KHQR', 'Other'].includes(b.method) ? b.method : '';
    const accountName = String(b.accountName || '').replace(/\s+/g, ' ').trim().slice(0, 80), accountNumber = String(b.accountNumber || '').replace(/[^\d+\- ]/g, '').trim().slice(0, 40);
    if (!method || !accountName || accountNumber.replace(/\D/g, '').length < 4) return res.status(400).json({ success: false, error: 'Please choose how to be paid and enter the account name and number.' });
    if (cents > (await walletCents(email))) return res.status(400).json({ success: false, error: 'Your balance is not enough.' });
    let id;
    try {
      const ins = await pool.query('INSERT INTO withdrawal_requests (user_email, amount_cents, method, account_name, account_number) VALUES ($1, $2, $3, $4, $5) RETURNING id', [email, cents, method, accountName, accountNumber]);
      id = ins.rows[0].id;
    } catch (e) { if (e && e.code === '23505') return res.status(409).json({ success: false, error: 'You already have a withdrawal waiting to be paid.' }); throw e; }
    await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, ref_id, created_by) VALUES ($1, $2, 'withdrawal', $3, $4, $1)", [email, -cents, 'Withdrawal request #' + id, id]);   // the money is set aside at once
    res.json({ success: true, id });
  } catch (err) { console.error('[monetization] withdraw error:', err.message); res.status(500).json({ success: false, error: 'Could not send your request.' }); }
});

// ---- admin side ----
app.post('/api/admin/monetization-requests', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query(
      `SELECT ca.user_email, ca.status, ca.requested_at, ca.decided_at, ca.decided_by, ca.note, u.first_name, u.last_name, u.profile_pic, u.public_id,
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
    const status = ['approved', 'rejected', 'pending'].includes(b.status) ? b.status : '';
    if (!status) return res.status(400).json({ success: false, error: 'Invalid status.' });
    const u = await resolveIdentifier(b.identifier || b.targetEmail); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    const note = String(b.note || '').slice(0, 300);
    await pool.query(`INSERT INTO creator_applications (user_email, status, requested_at, decided_at, decided_by, note) VALUES ($1, $2, NOW(), $3, $4, $5)
      ON CONFLICT (user_email) DO UPDATE SET status = $2, decided_at = $3, decided_by = $4, note = $5`, [u.email, status, status === 'pending' ? null : new Date(), a.adminEmail, note]);
    audit(a.adminEmail, 'creator-' + status, u.email, note);
    res.json({ success: true });
  } catch (err) { console.error('[admin] monetization action error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/admin/wallet/credit', async (req, res) => {
  const b = req.body || {};
  try {
    const a = await adminGate(req, res); if (!a) return;
    if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change a wallet.' });
    const cents = Math.round(Number(b.amount) * 100);
    if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > 100000) return res.status(400).json({ success: false, error: 'The amount must be between -$1,000 and $1,000 (not 0).' });
    const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!note) return res.status(400).json({ success: false, error: 'Please write a reason.' });
    const kind = b.kind === 'adjustment' ? 'adjustment' : 'bonus';
    const u = await resolveIdentifier(b.identifier || b.targetEmail); if (!u) return res.status(404).json({ success: false, error: 'User not found.' });
    if (cents < 0 && -cents > (await walletCents(u.email))) return res.status(400).json({ success: false, error: 'That would make the wallet negative.' });
    await pool.query('INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, created_by) VALUES ($1, $2, $3, $4, $5)', [u.email, cents, kind, note, a.adminEmail]);
    audit(a.adminEmail, 'wallet-' + kind, u.email, (cents / 100).toFixed(2) + ' USD: ' + note);
    res.json({ success: true, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), balance: (await walletCents(u.email)) / 100 });
  } catch (err) { console.error('[admin] wallet error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
});

app.post('/api/admin/withdrawals', async (req, res) => {
  try {
    const a = await adminGate(req, res); if (!a) return;
    const r = await pool.query(
      `SELECT w.id, w.user_email, w.amount_cents, w.method, w.account_name, w.account_number, w.status, w.created_at, w.decided_at, w.decided_by, w.note, u.first_name, u.last_name, u.public_id
       FROM withdrawal_requests w JOIN users u ON u.email = w.user_email ORDER BY CASE WHEN w.status = 'pending' THEN 0 ELSE 1 END, w.created_at DESC LIMIT 100`);
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
    const note = String(b.note || '').slice(0, 300);
    const upd = await pool.query("UPDATE withdrawal_requests SET status = $1, decided_at = NOW(), decided_by = $2, note = $3 WHERE id = $4 AND status = 'pending' RETURNING user_email, amount_cents", [status, a.adminEmail, note, id]);
    if (!upd.rows.length) return res.status(409).json({ success: false, error: 'This request was already decided.' });
    if (status === 'rejected') await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, ref_id, created_by) VALUES ($1, $2, 'withdrawal_refund', $3, $4, $5)", [upd.rows[0].user_email, upd.rows[0].amount_cents, 'Withdrawal #' + id + ' was refused' + (note ? ': ' + note : ''), id, a.adminEmail]);
    audit(a.adminEmail, 'withdrawal-' + status, upd.rows[0].user_email, '#' + id + ' ' + (upd.rows[0].amount_cents / 100).toFixed(2) + ' USD');
    res.json({ success: true });
  } catch (err) { console.error('[admin] withdrawal decide error:', err.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
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

app.delete('/api/admin/posts/:postId', async (req, res) => {
  const { postId } = req.params;
  const { adminEmail, adminKey } = req.body;
  try {
    const auth = await verifyAdminAccess(adminEmail, adminKey);
    if (!auth.allowed) return res.status(403).json({ success: false, error: auth.error });

    await cleanup.deletePostCompletely(postId); // also marks its reports as resolved_deleted
    audit(adminEmail, 'delete-post', postId, '');
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