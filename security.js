// =============================================================================
// CamFeed security layer (no extra packages)
//   * security headers + Content-Security-Policy      (clickjacking, sniffing, referrer leaks, no caching of private API data)
//   * input guard: every text / link / id / choice that a person sends is checked or cleaned BEFORE it reaches the database
//        - "<" and ">" in text become look-alike characters, so nobody can plant HTML in names, posts, comments, chats
//        - links must be https and from our own media storage (no quotes/spaces: nobody can break out of an HTML attribute)
//        - privacy / media type / reaction / ids only accept the real values
//   * post visibility: private posts, banned authors and blocked people are never served (comments, reactions, shares ...)
//   * errors: the browser never sees database error texts (they are logged with a short reference instead)
//   * rate limits: per person and per network, with a stricter limit for creating things
// Switches (Render environment): DEBUG_ERRORS=true shows real error texts again; CSP_ENFORCE=true enforces the full policy.
// =============================================================================
const crypto = require('crypto');

// ---------------------------------------------------------------- text
const LT = '\uFF1C', GT = '\uFF1E';                           // "＜" "＞": look like < > but can not start a tag
function neutralize(s) {
  return String(s)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/</g, LT).replace(/>/g, GT);
}

const TEXT_LIMITS = {
  content: 10000, message: 5000, bio: 1000, caption: 1000, location: 150, work: 150, relationship_status: 100, gender: 30,
  firstName: 60, lastName: 60, first_name: 60, last_name: 60, reason: 1000, text: 5000, tombstone: 100, title: 200, description: 2000, phone: 30
};
const NAME_FIELDS = new Set(['firstName', 'lastName', 'first_name', 'last_name']);
const ID_FIELDS = ['postId', 'commentId', 'notificationId', 'replyToCommentId', 'video_id', 'reportId', 'id'];
const PRIVACY_VALUES = new Set(['public', 'private']);
const MEDIA_TYPES = new Set(['text', 'image', 'video', 'carousel', 'styled_text', 'shared', 'shared_profile', 'audio']);
const REACTIONS = ['👍', '❤️', '🥰', '😆', '😮', '😢', '😡'];
const REACTION_SET = new Set(REACTIONS.concat(REACTIONS.map((r) => r.replace(/\uFE0F/g, ''))));
const ENUM_RE = /^[a-z_]{1,20}$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

// ---------------------------------------------------------------- links
function allowedHosts() {
  const hosts = new Set(['res.cloudinary.com']);
  try { hosts.add(new URL(process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').host.toLowerCase()); } catch (e) { hosts.add('media.camfeedkh.com'); }
  String(process.env.ALLOWED_MEDIA_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).forEach((h) => hosts.add(h));
  return hosts;
}
const URL_RE = /^https:\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]*)?$/;
function safeUrl(u) {
  if (typeof u !== 'string') return null;
  const v = u.trim();
  if (!v || v.length > 2048) return null;
  const m = URL_RE.exec(v);
  if (!m) return null;
  return allowedHosts().has(m[1].toLowerCase()) ? v : null;
}

const CSS_VALUE_RE = /^[#0-9A-Za-z(),.%\s\-+/]{0,200}$/;
const CSS_BAD_RE = /url\s*\(|expression|javascript|@import|var\s*\(/i;
function safeStyled(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  if (o.styleId !== undefined) { if (typeof o.styleId !== 'string' || !/^[\w-]{1,40}$/.test(o.styleId)) return null; out.styleId = o.styleId; }
  for (const k of ['bg', 'color', 'shadow']) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'string' || !CSS_VALUE_RE.test(o[k]) || CSS_BAD_RE.test(o[k])) return null;
    out[k] = o[k];
  }
  if (o.icon !== undefined) { if (typeof o.icon !== 'string' || o.icon.length > 16 || /[<>"'`\\&]/.test(o.icon)) return null; out.icon = o.icon; }
  return out;
}

function safeItem(it) {
  if (typeof it === 'string') return safeUrl(it);
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  const url = safeUrl(it.url); if (!url) return null;
  const out = { url };
  if (it.type !== undefined) { if (typeof it.type !== 'string' || !ENUM_RE.test(it.type)) return null; out.type = it.type; }
  return out;
}
function safeItems(arr) {
  if (!Array.isArray(arr) || arr.length > 20) return null;
  const out = [];
  for (const it of arr) { const c = safeItem(it); if (c === null) return null; out.push(c); }
  return out;
}

// media_url style fields hold a link, a JSON list of links, or (styled posts) a small style object
function safeMediaField(v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: v };
  if (typeof v !== 'string') return { ok: false };
  const s = v.trim();
  if (s[0] === '[' || s[0] === '{') {
    let parsed; try { parsed = JSON.parse(s); } catch (e) { return { ok: false }; }
    if (Array.isArray(parsed)) { const items = safeItems(parsed); return items ? { ok: true, value: JSON.stringify(items) } : { ok: false }; }
    if (parsed && typeof parsed === 'object') {
      if ('url' in parsed) { const it = safeItem(parsed); return it ? { ok: true, value: JSON.stringify(it) } : { ok: false }; }
      const st = safeStyled(parsed);
      if (st) return { ok: true, value: JSON.stringify(st) };
      // shared profile cards: a small object of plain values
      if (parsed.type === 'profile' || parsed.email || parsed.name) return { ok: true, value: JSON.stringify(sharedProfile(parsed)) };
    }
    return { ok: false };
  }
  const url = safeUrl(s);
  return url ? { ok: true, value: url } : { ok: false };
}
function sharedProfile(p) {
  const out = {};
  for (const k of Object.keys(p).slice(0, 12)) {
    const v = p[k];
    if (typeof v === 'string') out[k] = /(pic|photo|avatar|cover|url|image)/i.test(k) ? (safeUrl(v) || '') : neutralize(v).slice(0, 300);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- the guard
const URL_FIELDS = ['mediaUrl', 'media_url', 'profilePicUrl', 'coverPicUrl', 'thumbnail_url', 'thumbnailUrl', 'video_url', 'videoUrl'];
const bad = (field) => ({ error: 'Invalid ' + field, field });

function checkBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (!(field in body) || body[field] === undefined || body[field] === null) continue;
    if (typeof body[field] !== 'string') return bad(field);
    let v = neutralize(body[field]);
    if (NAME_FIELDS.has(field)) v = v.replace(/\s+/g, ' ').trim();
    if (v.length > max) return { error: 'Too long: ' + field, field, tooLong: true };
    body[field] = v;
  }
  for (const f of ID_FIELDS) {
    if (!(f in body) || body[f] === null || body[f] === '' || body[f] === undefined) continue;
    if (typeof body[f] !== 'string' && typeof body[f] !== 'number') return bad(f);          // an array like [1] is not an id
    const s = String(body[f]);
    if (!/^\d{1,10}$/.test(s) || Number(s) < 1 || Number(s) > 2147483647) return bad(f);
  }
  for (const f of ['privacy', 'location_privacy', 'birthdate_privacy', 'relationship_privacy', 'gender_privacy', 'work_privacy', 'phone_privacy', 'email_privacy']) {
    if (f in body && body[f] !== null && body[f] !== undefined && body[f] !== '' && !PRIVACY_VALUES.has(body[f])) return bad(f);
  }
  for (const f of ['mediaType', 'media_type', 'orig_media_type']) {
    if (f in body && body[f] !== null && body[f] !== undefined && body[f] !== '' && !MEDIA_TYPES.has(body[f])) return bad(f);
  }
  if ('message_type' in body && body.message_type !== null && body.message_type !== undefined && !ENUM_RE.test(String(body.message_type))) return bad('message_type');
  for (const f of ['reactionType', 'reaction_type']) {
    if (f in body && body[f] !== null && body[f] !== undefined && body[f] !== '' && !REACTION_SET.has(body[f])) return bad(f);
  }
  if ('targetLang' in body && body.targetLang !== undefined && !LANG_RE.test(String(body.targetLang))) return bad('targetLang');
  if ('mediaAspect' in body && body.mediaAspect !== undefined && body.mediaAspect !== null && !/^[0-9.:/ xX-]{0,30}$/.test(String(body.mediaAspect))) return bad('mediaAspect');
  if ('thumbnailBase64' in body && body.thumbnailBase64 !== undefined && body.thumbnailBase64 !== null) {
    const t = body.thumbnailBase64;
    if (typeof t !== 'string' || t.length > 4 * 1024 * 1024 || !/^(data:image\/[a-z+]+;base64,)?[A-Za-z0-9+/=\s]*$/.test(t)) return bad('thumbnailBase64');
  }
  for (const f of URL_FIELDS) {
    if (!(f in body)) continue;
    const r = safeMediaField(body[f]);
    if (!r.ok) return bad(f);
    body[f] = r.value;
  }
  if ('mediaItems' in body && body.mediaItems !== undefined && body.mediaItems !== null) {
    let items = body.mediaItems;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { return bad('mediaItems'); } }
    const clean = safeItems(items); if (!clean) return bad('mediaItems');
    body.mediaItems = clean;
  }
  return null;
}

function inputGuard(req, res, next) {
  try {
    const err = checkBody(req.body);
    if (err) return res.status(400).json({ success: false, error: err.tooLong ? 'This text is too long.' : 'Some of the information is not valid.', field: err.field });
    if (req.query && typeof req.query.keyword === 'string' && req.query.keyword.length > 100) {
      return res.status(400).json({ success: false, error: 'Search text is too long.' });
    }
  } catch (e) { return res.status(400).json({ success: false, error: 'Invalid request.' }); }
  next();
}

// numeric ids inside the URL (/api/posts/12)
function idParam(req, res, next, value) {
  if (!/^\d{1,10}$/.test(String(value)) || Number(value) < 1 || Number(value) > 2147483647) return res.status(400).json({ success: false, error: 'Invalid id.' });
  next();
}

// ---------------------------------------------------------------- headers
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  const media = [...allowedHosts()].map((h) => 'https://' + h).join(' ');
  const full = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://translate.google.com https://translate.googleapis.com https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://www.gstatic.com https://translate.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src 'self' data: blob: ${media} https://via.placeholder.com https://tile.openstreetmap.org https://www.gstatic.com https://translate.google.com https://translate.googleapis.com`,
    `media-src 'self' blob: ${media}`,
    `connect-src 'self' ${media} https://*.r2.cloudflarestorage.com https://translate.googleapis.com`,
    'frame-src https://challenges.cloudflare.com https://translate.google.com',
    "worker-src 'self'", "manifest-src 'self'"
  ].join('; ');
  const always = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
  if (String(process.env.CSP_ENFORCE || '').toLowerCase() === 'true') {
    res.setHeader('Content-Security-Policy', always + '; ' + full + '; report-uri /api/csp-report');
  } else {
    res.setHeader('Content-Security-Policy', always);                                            // always on: framing, plugins, base tag, forms
    res.setHeader('Content-Security-Policy-Report-Only', full + '; report-uri /api/csp-report');   // the strict rest: only reported (see Render logs) until switched on
  }
  if (String(req.originalUrl || req.url || '').startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

// ---------------------------------------------------------------- never show server error texts
function hideServerErrors(req, res, next) {
  const original = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 500 && body && typeof body === 'object' && String(process.env.DEBUG_ERRORS || '').toLowerCase() !== 'true') {
      const ref = crypto.randomBytes(4).toString('hex');
      console.error(`[error] ref=${ref} ${req.method} ${String(req.originalUrl || req.url).split('?')[0]} status=${res.statusCode}:`, body.error || body.message || '');
      body = Object.assign({}, body);
      for (const k of ['error', 'message']) if (typeof body[k] === 'string') body[k] = 'Something went wrong on our side. Please try again.';
      if (!('error' in body) && !('message' in body)) body.error = 'Something went wrong on our side. Please try again.';
      body.ref = ref;
    }
    return original(body);
  };
  next();
}

// ---------------------------------------------------------------- rate limits
function createRateLimits(makeLimiter) {
  const TEN = 10 * 60 * 1000;
  const perNetwork = makeLimiter(6000, TEN);       // generous: many phones share one mobile-network address
  const perPerson = makeLimiter(3000, TEN);
  const creating = makeLimiter(150, TEN);          // posts, comments, shares, reports
  const chatting = makeLimiter(600, TEN);          // chat messages
  const tooMany = (res) => { res.setHeader('Retry-After', '60'); return res.status(429).json({ success: false, error: 'Too many requests. Please slow down and try again in a minute.', errorKm: 'សំណើច្រើនពេក។ សូមរង់ចាំមួយភ្លែត ហើយព្យាយាមម្តងទៀត។' }); };
  const CREATE_RE = /^\/api\/(posts|posts\/share|comments|users\/report|comments\/report|posts\/\d+\/report|follow|block)$/;
  function network(req, res, next) { if (perNetwork.isLimited(req.ip)) return tooMany(res); perNetwork.hit(req.ip); next(); }
  function person(req, res, next) {
    const who = req.authEmail; if (!who) return next();
    if (perPerson.isLimited(who)) return tooMany(res); perPerson.hit(who);
    if (req.method === 'POST') {
      const p = String(req.originalUrl || req.url).split('?')[0];
      if (CREATE_RE.test(p)) { if (creating.isLimited(who)) return tooMany(res); creating.hit(who); }
      else if (p === '/api/messages') { if (chatting.isLimited(who)) return tooMany(res); chatting.hit(who); }
    }
    next();
  }
  return { network, person };
}

// ---------------------------------------------------------------- who may see a post
function createVisibility(pool) {
  async function canViewPost(viewerEmail, postId) {
    const r = await pool.query(
      `SELECT p.privacy, p.user_email, COALESCE(u.is_banned, FALSE) AS banned,
              EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_email = $2 AND b.blocked_email = p.user_email)
                                                       OR (b.blocker_email = p.user_email AND b.blocked_email = $2)) AS blocked
       FROM posts p JOIN users u ON u.email = p.user_email WHERE p.id = $1`, [postId, viewerEmail]);
    const row = r.rows[0];
    if (!row) return false;
    if (String(row.user_email).toLowerCase() === String(viewerEmail || '').toLowerCase()) return true;
    return row.privacy !== 'private' && !row.banned && !row.blocked;
  }
  // returns true when the person may continue; otherwise it has already answered "not found"
  async function guardPost(req, res, postId) {
    if (await canViewPost(req.authEmail, postId)) return true;
    res.status(404).json({ success: false, error: 'Post not found' });
    return false;
  }
  async function postIdOfComment(commentId) {
    const r = await pool.query('SELECT post_id FROM comments WHERE id = $1', [commentId]);
    return r.rows[0] ? r.rows[0].post_id : null;
  }
  // a shared post must not reveal an original that its author made private afterwards
  function scrubOriginal(post, viewerEmail) {
    if (!post || !post.orig_id) return post;
    const mine = String(post.orig_author_email || '').toLowerCase() === String(viewerEmail || '').toLowerCase();
    if (post.orig_privacy === 'private' && !mine) {
      post.orig_id = null; post.orig_content = ''; post.orig_media_url = null; post.orig_media_type = null; post.orig_media_aspect = '';
    }
    return post;
  }
  return { canViewPost, guardPost, postIdOfComment, scrubOriginal };
}

// ---------------------------------------------------------------- the browser's own CSP violation reports (kept short, no personal data)
function cspReport(limiter) {
  return (req, res) => {
    try {
      if (limiter.isLimited(req.ip)) return res.status(204).end(); limiter.hit(req.ip);
      const r = (req.body && (req.body['csp-report'] || req.body)) || {};
      const cut = (v) => String(v || '').split('?')[0].slice(0, 120);
      console.warn(`[csp] ${cut(r['violated-directive'] || r.effectiveDirective)} blocked=${cut(r['blocked-uri'] || r.blockedURL)} page=${cut(r['document-uri'] || r.documentURL)}`);
    } catch (e) { /* ignore */ }
    res.status(204).end();
  };
}

// ---------------------------------------------------------------- clean up data that was saved before this protection existed
async function neutralizeExistingData(pool) {
  const jobs = [
    ['users', ['first_name', 'last_name', 'bio', 'location', 'work', 'relationship_status', 'phone', 'gender']],
    ['posts', ['content']], ['comments', ['content']], ['messages', ['message']], ['notifications', ['message']]
  ];
  let changed = 0;
  for (const [table, cols] of jobs) {
    for (const col of cols) {
      try {
        const r = await pool.query(`UPDATE ${table} SET ${col} = REPLACE(REPLACE(${col}, '<', '${LT}'), '>', '${GT}') WHERE ${col} LIKE '%<%' OR ${col} LIKE '%>%'`);
        changed += r.rowCount || 0;
      } catch (e) { /* column or table not there yet */ }
    }
  }
  try { const rp = await pool.query("UPDATE posts SET privacy = 'public' WHERE privacy IS NULL OR privacy NOT IN ('public','private')"); changed += rp.rowCount || 0; } catch (e) { /* table not ready */ }
  try {   // picture links that could break out of an HTML attribute
    const r1 = await pool.query(`UPDATE users SET profile_pic = NULL WHERE profile_pic ~ '["''<>\`\\s]'`); changed += r1.rowCount || 0;
    const r2 = await pool.query(`UPDATE users SET cover_pic = NULL WHERE cover_pic ~ '["''<>\`\\s]'`); changed += r2.rowCount || 0;
    const r3 = await pool.query(`UPDATE posts SET media_url = NULL, media_type = 'text' WHERE media_type IN ('image','video') AND media_url ~ '["''<>\`\\s]'`); changed += r3.rowCount || 0;
    const rows = (await pool.query(`SELECT id, media_url FROM posts WHERE media_type IN ('carousel','styled_text','shared_profile') AND media_url IS NOT NULL LIMIT 20000`)).rows;
    for (const row of rows) {
      const r = safeMediaField(row.media_url);
      if (!r.ok) { await pool.query(`UPDATE posts SET media_url = NULL, media_type = 'text' WHERE id = $1`, [row.id]); changed++; }
      else if (r.value !== row.media_url) { await pool.query('UPDATE posts SET media_url = $1 WHERE id = $2', [r.value, row.id]); changed++; }
    }
  } catch (e) { /* tables not ready */ }
  if (changed) console.log(`[security] cleaned ${changed} stored value(s) from before the protection`);
  return changed;
}

module.exports = {
  neutralize, safeUrl, safeStyled, safeMediaField, safeItems, checkBody, inputGuard, idParam,
  securityHeaders, hideServerErrors, createRateLimits, createVisibility, cspReport, neutralizeExistingData,
  TEXT_LIMITS, REACTIONS, LT, GT
};
