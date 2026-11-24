// 📲 The Android app for testers and family: Admin uploads the .apk, people download it from camfeedkh.com/apk.html.
// Only the Super Admin can upload or remove (an app file goes onto people's phones). The file is stored in our own storage (R2).
'use strict';
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports = function ({ app, pool, adminGate, audit }) {
  const pub = () => String(process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').replace(/\/+$/, '');
  let r2 = null;
  const client = () => r2 || (r2 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } }));
  const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
  const okUrl = (u) => typeof u === 'string' && u.startsWith(pub() + '/apk/') && /^[A-Za-z0-9:/._-]{10,300}$/.test(u) && /\.apk$/.test(u);

  let ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_apk (id SERIAL PRIMARY KEY, url TEXT NOT NULL, version VARCHAR(30), build INTEGER, note TEXT,
        size_bytes BIGINT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE TABLE IF NOT EXISTS app_apk_cfg (k VARCHAR(20) PRIMARY KEY, v TEXT NOT NULL)');
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  ensure().catch((e) => console.error('[apk]', e.message));
  const isOn = async () => { const r = await pool.query("SELECT v FROM app_apk_cfg WHERE k = 'on'"); return !r.rows.length || r.rows[0].v !== '0'; };
  const view = (x) => ({ id: x.id, url: x.url, version: x.version || '', build: x.build || null, note: x.note || '', sizeMb: x.size_bytes ? Math.round(Number(x.size_bytes) / 104857.6) / 10 : null, at: x.created_at });

  // the download page (anyone, no login)
  app.get('/api/apk', async (req, res) => {
    try {
      await ensure();
      res.setHeader('Cache-Control', 'no-store');
      if (!(await isOn())) return res.json({ success: true, on: false });
      const rows = (await pool.query('SELECT * FROM app_apk ORDER BY id DESC LIMIT 4')).rows;
      res.json({ success: true, on: true, latest: rows[0] ? view(rows[0]) : null, older: rows.slice(1).map(view) });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  // Admin › ⚙️ System › 📲 Android app (APK)
  app.post('/api/admin/apk', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const b = req.body || {}, act = String(b.action || 'list');
      if (act === 'list') {
        const rows = (await pool.query('SELECT * FROM app_apk ORDER BY id DESC LIMIT 20')).rows;
        return res.json({ success: true, on: await isOn(), list: rows.map(view), isSuperAdmin: !!a.isSuperAdmin });
      }
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only the Super Admin can change the app file.' });
      if (act === 'upload-url') {                  // a one-time address to put the .apk straight into storage
        const build = parseInt(b.build, 10) > 0 ? parseInt(b.build, 10) : 0;
        const key = 'apk/CamFeed' + (build ? '-' + build : '') + '-' + crypto.randomBytes(4).toString('hex') + '.apk';
        const uploadUrl = await getSignedUrl(client(), new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || 'camfeed-storage', Key: key, ContentType: 'application/vnd.android.package-archive' }), { expiresIn: 1800 });
        return res.json({ success: true, uploadUrl, publicUrl: pub() + '/' + key });
      }
      if (act === 'save') {
        if (!okUrl(b.url)) return res.status(400).json({ success: false, error: 'Upload the .apk here first.' });
        const build = parseInt(b.build, 10) > 0 ? Math.min(parseInt(b.build, 10), 1000000) : null;
        const r = await pool.query('INSERT INTO app_apk (url, version, build, note, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [b.url, clean(b.version, 30) || null, build, clean(b.note, 1000) || null, Math.max(0, Math.min(Number(b.size) || 0, 2e9)) || null, a.adminEmail]);
        audit(a.adminEmail, 'apk_upload', '', 'BUILD ' + (build || '?') + ' ' + b.url);
        return res.json({ success: true, id: r.rows[0].id });
      }
      if (act === 'remove') {
        const r = await pool.query('DELETE FROM app_apk WHERE id = $1 RETURNING url', [parseInt(b.id, 10)]);
        if (r.rows.length) audit(a.adminEmail, 'apk_remove', '', r.rows[0].url);
        return res.json({ success: true });
      }
      if (act === 'settings') {
        await pool.query("INSERT INTO app_apk_cfg (k, v) VALUES ('on', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [b.on ? '1' : '0']);
        audit(a.adminEmail, 'apk_page', '', b.on ? 'on' : 'off');
        return res.json({ success: true });
      }
      res.status(400).json({ success: false });
    } catch (e) { console.error('[apk] admin:', e.message); res.status(500).json({ success: false, error: 'Could not do it.' }); }
  });
};
