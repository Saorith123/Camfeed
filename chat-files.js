// 📎 Files in chat (like Telegram): PDF, Word, Excel, PowerPoint, ZIP, music ...
// The app asks here for a one-time upload link, sends the file straight to the storage (R2), then sends a chat message
// of type 'file': message = "📎 <file name>", media_url = "<public link>#size=<bytes>".
// CamFeed sets everything in Admin › ⚙️ Settings › 🧩 App features & lists: on/off, biggest size, files a day, blocked endings.
// Safety: program files (.apk, .exe ...) and web pages (.html, .svg, .js ...) are refused; every other file is stored as a
// plain download type (never a web page) under files/, so a file can never run on camfeedkh.com.
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const appCfg = require('./app-config');

const TYPES = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf', epub: 'application/epub+zip',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
};
// never stored, whatever the Admin list says: files that open as a web page on our own address
const ALWAYS_BLOCKED = ['html', 'htm', 'xhtml', 'svg', 'svgz', 'xml', 'js', 'mjs', 'php', 'shtml', 'xht'];

const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const publicBase = () => (process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').replace(/\/$/, '');

module.exports = function installChatFiles({ app, pool }) {
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  let ready = null;
  function ensure() {
    if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS chat_file_uploads (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, r2_key TEXT NOT NULL,
        name TEXT, size BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
      .then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_chat_file_uploads_user ON chat_file_uploads (user_email, created_at)'))
      .catch((e) => { ready = null; throw e; });
    return ready;
  }

  function rules() {
    const c = appCfg.cfg();
    const f = c.files || {};
    return { on: c.features.chatFiles !== false, maxMB: f.maxMB || 50, perDay: f.perDay || 50, blocked: Array.isArray(f.blocked) ? f.blocked : [] };
  }

  // what the app shows before picking (biggest size, blocked endings)
  app.get('/api/chat/file-rules', (req, res) => {
    const r = rules();
    res.json({ success: true, on: r.on, maxMB: r.maxMB, blocked: [...new Set([...r.blocked, ...ALWAYS_BLOCKED])] });
  });

  app.post('/api/chat/file-url', async (req, res) => {
    const me = String(req.authEmail || '').toLowerCase();
    if (!me) return res.status(401).json({ success: false });
    try {
      const b = req.body || {};
      const r = rules();
      if (!r.on) return res.status(403).json({ success: false, code: 'off', error: 'Sending files is turned off for now.' });
      const name = String(b.name || '').replace(/[\u0000-\u001f\\/]/g, '_').trim().slice(0, 180) || 'file';
      const size = Number(b.size) || 0;
      const ext = extOf(name);
      if ([...r.blocked, ...ALWAYS_BLOCKED].includes(ext)) return res.status(400).json({ success: false, code: 'type', error: 'This kind of file can not be sent.' });
      if (size <= 0) return res.status(400).json({ success: false, code: 'empty', error: 'The file is empty.' });
      if (size > r.maxMB * 1024 * 1024) return res.status(400).json({ success: false, code: 'big', maxMB: r.maxMB, error: `The file is too big (${r.maxMB} MB at most).` });
      await ensure();
      const n = await pool.query("SELECT COUNT(*)::int AS n FROM chat_file_uploads WHERE user_email = $1 AND created_at > NOW() - INTERVAL '1 day'", [me]);
      if (n.rows[0].n >= r.perDay) return res.status(429).json({ success: false, code: 'day', error: 'Too many files today. Please try again tomorrow.' });
      const safe = name.replace(/\.[A-Za-z0-9]{1,8}$/, '').normalize('NFKD').replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').slice(-80) || 'file';
      const key = `files/${Date.now()}-${crypto.randomBytes(5).toString('hex')}/${safe}${ext ? '.' + ext : ''}`;
      const contentType = TYPES[ext] || 'application/octet-stream';
      const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || 'camfeed-storage', Key: key, ContentType: contentType }), { expiresIn: 900 });
      await pool.query('INSERT INTO chat_file_uploads (user_email, r2_key, name, size) VALUES ($1, $2, $3, $4)', [me, key, name, Math.round(size)]);
      res.json({ success: true, uploadUrl, contentType, publicUrl: `${publicBase()}/${key}`, mediaUrl: `${publicBase()}/${key}#size=${Math.round(size)}`, name });
    } catch (e) {
      console.error('[chat-files]', e.message);
      res.status(500).json({ success: false, error: 'Could not prepare the upload.' });
    }
  });

  // a chat message of type 'file' must point to a file uploaded here (our own storage, files/ folder)
  function checkFileMessage(message, mediaUrl) {
    const url = String(mediaUrl || '');
    if (!url.startsWith(publicBase() + '/files/') || url.length > 600) return null;
    let text = String(message || '').trim();
    if (!text.startsWith('📎')) text = '📎 ' + text;
    return { message: text.slice(0, 220), mediaUrl: url };
  }

  return { checkFileMessage };
};
