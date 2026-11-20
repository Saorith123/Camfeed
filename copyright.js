// ©️ Copyright on CamFeed: (1) people report "this uses my work", the owner of the post can answer, CamFeed decides;
// (2) every new video / photo gets a small "fingerprint" (8 tiny frames of the video), so a copy of somebody else's post
// (re-uploaded, re-encoded, made smaller) is noticed by itself; (3) a copy or an upheld claim earns no money, and too many
// upheld claims stop the person's earnings. Admin › 🛡️ Content & safety › ©️ Copyright.
'use strict';

module.exports = function createCopyright({ app, pool, adminGate, audit, sendNotice, pubMedia, cleanup, setting }) {
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS no_earn BOOLEAN DEFAULT FALSE');
        await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS fp_done BOOLEAN DEFAULT FALSE');
        await pool.query(`CREATE TABLE IF NOT EXISTS media_fp (post_id INTEGER PRIMARY KEY, owner_email TEXT NOT NULL, kind VARCHAR(8) NOT NULL,
          secs INTEGER NOT NULL DEFAULT 0, hashes TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS media_fp_kind_secs ON media_fp (kind, secs)');
        await pool.query(`CREATE TABLE IF NOT EXISTS dup_flags (id SERIAL PRIMARY KEY, post_id INTEGER UNIQUE NOT NULL, orig_post_id INTEGER NOT NULL,
          owner_email TEXT NOT NULL, orig_owner TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, status VARCHAR(12) NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW(), decided_at TIMESTAMP, decided_by TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS copyright_claims (id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, claimant_email TEXT NOT NULL,
          owner_email TEXT NOT NULL, original TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', status VARCHAR(12) NOT NULL DEFAULT 'pending',
          counter_note TEXT, created_at TIMESTAMP DEFAULT NOW(), decided_at TIMESTAMP, decided_by TEXT, admin_note TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS copyright_strikes (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, claim_id INTEGER,
          dup_id INTEGER, post_id INTEGER, created_at TIMESTAMP DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS copyright_strikes_user ON copyright_strikes (LOWER(user_email))');
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  ensure().catch((e) => console.error('[copyright] schema:', e.message));

  const norm = (s) => String(s || '').trim().toLowerCase();
  const km = (n) => String(n).replace(/\d/g, (d) => '០១២៣៤៥៦៧៨៩'[d]);      // Khmer digits inside Khmer sentences
  const maxStrikes = () => Math.max(1, Math.min(10, Number(setting ? setting('COPYRIGHT_MAX_STRIKES', 3) : 3) || 3));
  const nameOf = async (email) => {
    const u = (await pool.query('SELECT first_name, last_name FROM users WHERE LOWER(email) = LOWER($1)', [email]).catch(() => ({ rows: [] }))).rows[0] || {};
    return `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'CamFeed';
  };
  const note = (to, postId, text) => pool.query(
    "INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, 'system', $2, 'admin_notice', $3, FALSE)",
    [to, postId || null, text]).catch(() => {});

  // ---------------------------------------------------------------- fingerprints
  let bin = 'ffmpeg'; try { bin = require('ffmpeg-static') || 'ffmpeg'; } catch (e) { /* the system ffmpeg */ }
  const { execFile } = require('child_process');
  // one tiny grey frame (9×8) at second t → a 64-bit "difference hash" (16 hex): the same picture after re-encoding,
  // resizing or a little colour change gives (almost) the same hash
  function frameHash(url, t) {
    return new Promise((ok) => {
      const args = ['-hide_banner', '-loglevel', 'error', ...(t > 0 ? ['-ss', String(t)] : []), '-i', url, '-frames:v', '1', '-vf', 'scale=9:8,format=gray', '-f', 'rawvideo', '-'];
      execFile(bin, args, { timeout: 40 * 1000, encoding: 'buffer', maxBuffer: 1024 * 64 }, (e, out) => {
        if (e || !out || out.length < 72) return ok(null);
        let h = 0n;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { h = (h << 1n) | (out[y * 9 + x] < out[y * 9 + x + 1] ? 1n : 0n); }
        ok(h.toString(16).padStart(16, '0'));
      });
    });
  }
  const pop = (h) => { let n = 0, v = BigInt('0x' + h); while (v) { n += Number(v & 1n); v >>= 1n; } return n; };
  const ham = (a, b) => pop((BigInt('0x' + a) ^ BigInt('0x' + b)).toString(16));
  const useful = (h) => { const n = pop(h); return n >= 6 && n <= 58; };      // a plain black / white frame says nothing
  function secsOf(url) {
    return new Promise((ok) => execFile(bin, ['-hide_banner', '-i', url], { timeout: 40 * 1000, maxBuffer: 1024 * 1024 * 4 }, (e, so, se) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(se || '') + String(so || ''));
      ok(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null);
    }));
  }

  // is this post a copy of an OLDER post of somebody else? → { orig, score } or null
  async function findOriginal(postId, owner, kind, secs, hashes) {
    if (kind === 'video') {
      const lo = Math.floor(secs * 0.9) - 1, hi = Math.ceil(secs * 1.1) + 1;
      const c = (await pool.query("SELECT post_id, hashes FROM media_fp WHERE kind = 'video' AND secs BETWEEN $1 AND $2 AND post_id < $3 AND LOWER(owner_email) <> LOWER($4) ORDER BY post_id LIMIT 3000", [lo, hi, postId, owner])).rows;
      let best = null;
      for (const r of c) {
        const hs = r.hashes.split(',');
        let ok = 0, n = 0;
        for (let i = 0; i < Math.min(hs.length, hashes.length); i++) {
          if (!useful(hs[i]) || !useful(hashes[i])) continue;
          n++; if (ham(hs[i], hashes[i]) <= 10) ok++;
        }
        if (n >= 4 && ok >= Math.ceil(n * 0.75) && (!best || ok > best.score)) best = { orig: r.post_id, score: Math.round(ok * 100 / n) };
      }
      return best;
    }
    if (!useful(hashes[0])) return null;
    const c = (await pool.query("SELECT post_id, hashes FROM media_fp WHERE kind = 'image' AND post_id < $1 AND LOWER(owner_email) <> LOWER($2) ORDER BY post_id DESC LIMIT 20000", [postId, owner])).rows;
    for (const r of c) { const d = ham(r.hashes.split(',')[0], hashes[0]); if (d <= 5) return { orig: r.post_id, score: 100 - d * 4 }; }
    return null;
  }

  let busy = false;
  async function sweep() {
    if (busy) return;
    busy = true;
    try {
      await ensure();
      const row = (await pool.query("SELECT id, user_email, media_type, media_url, video_secs FROM posts WHERE COALESCE(fp_done, FALSE) = FALSE AND shared_post_id IS NULL AND COALESCE(media_url, '') <> '' ORDER BY id DESC LIMIT 1")).rows[0];
      if (!row) return;
      await pool.query('UPDATE posts SET fp_done = TRUE WHERE id = $1', [row.id]);      // tried once, never again (even when it fails)
      const m = pubMedia(row);
      let kind = null, secs = 0, hashes = [];
      if (m.video) {
        secs = Number(row.video_secs) || Math.round((await secsOf(m.video)) || 0);
        if (secs < 2) return;
        kind = 'video';
        for (let i = 0; i < 8; i++) hashes.push(await frameHash(m.video, +(secs * (i + 0.5) / 8).toFixed(2)));
      } else if (m.images.length) {
        kind = 'image';
        hashes.push(await frameHash(m.images[0], 0));
      }
      if (!kind || hashes.filter(Boolean).length < (kind === 'video' ? 4 : 1)) return;
      hashes = hashes.map((h) => h || '0000000000000000');
      await pool.query('INSERT INTO media_fp (post_id, owner_email, kind, secs, hashes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (post_id) DO NOTHING', [row.id, row.user_email, kind, secs, hashes.join(',')]);
      const f = await findOriginal(row.id, row.user_email, kind, secs, hashes);
      if (!f) return;
      const o = (await pool.query('SELECT user_email FROM posts WHERE id = $1', [f.orig])).rows[0];
      if (!o) return;
      const ins = await pool.query("INSERT INTO dup_flags (post_id, orig_post_id, owner_email, orig_owner, score) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (post_id) DO NOTHING RETURNING id", [row.id, f.orig, row.user_email, o.user_email, f.score]);
      if (!ins.rows.length) return;
      await pool.query('UPDATE posts SET no_earn = TRUE WHERE id = $1', [row.id]);       // a copy earns nothing (until CamFeed says it is fine)
      console.log('[copyright] post', row.id, 'looks like a copy of', f.orig, '(' + f.score + '%)');
    } catch (e) { console.error('[copyright] sweep:', e.message); }
    finally { busy = false; }
  }
  setTimeout(() => { sweep(); setInterval(sweep, 15 * 1000).unref(); }, 60 * 1000);

  async function strike(email, ref) {
    await pool.query('INSERT INTO copyright_strikes (user_email, claim_id, dup_id, post_id) VALUES ($1, $2, $3, $4)', [email, ref.claim || null, ref.dup || null, ref.post || null]);
    const n = Number((await pool.query("SELECT COUNT(*) AS n FROM copyright_strikes WHERE LOWER(user_email) = LOWER($1) AND created_at > NOW() - INTERVAL '365 days'", [email])).rows[0].n) || 0;
    const max = maxStrikes();
    if (n >= max) {
      await pool.query("UPDATE creator_applications SET earn_suspended = TRUE, suspend_reason = 'copyright' WHERE LOWER(user_email) = LOWER($1)", [email]).catch(() => {});
      await note(email, null, `⛔ អ្នកបានរំលោភកម្មសិទ្ធិអ្នកដទៃ ${km(n)} ដងក្នុងមួយឆ្នាំ។ ការរកប្រាក់ពីវីដេអូរបស់អ្នកត្រូវបានផ្អាក។ សូមបង្ហោះតែស្នាដៃរបស់អ្នកផ្ទាល់។`);
    }
    return { strikes: n, max };
  }

  // ---------------------------------------------------------------- people
  // "this post uses my work" (the app's ⋯ on a post, the website)
  app.post('/api/copyright/claim', async (req, res) => {
    const me = req.authEmail; const b = req.body || {};
    if (!me) return res.status(401).json({ success: false });
    const postId = parseInt(b.post_id, 10);
    const original = String(b.original || '').trim().slice(0, 500), text = String(b.note || '').trim().slice(0, 1000);
    if (!postId || b.agree !== true) return res.status(400).json({ success: false, error: 'bad' });
    if (original.length < 3 && text.length < 10) return res.status(400).json({ success: false, error: 'proof' });
    try {
      await ensure();
      const p = (await pool.query('SELECT id, user_email FROM posts WHERE id = $1', [postId])).rows[0];
      if (!p) return res.status(404).json({ success: false, error: 'gone' });
      if (norm(p.user_email) === norm(me)) return res.status(400).json({ success: false, error: 'own' });
      const today = Number((await pool.query("SELECT COUNT(*) AS n FROM copyright_claims WHERE LOWER(claimant_email) = LOWER($1) AND created_at > NOW() - INTERVAL '1 day'", [me])).rows[0].n) || 0;
      if (today >= 10) return res.status(429).json({ success: false, error: 'limit' });
      const dup = await pool.query("SELECT 1 FROM copyright_claims WHERE post_id = $1 AND LOWER(claimant_email) = LOWER($2) AND status = 'pending'", [postId, me]);
      if (dup.rows.length) return res.status(409).json({ success: false, error: 'already' });
      const r = await pool.query('INSERT INTO copyright_claims (post_id, claimant_email, owner_email, original, note) VALUES ($1, $2, $3, $4, $5) RETURNING id', [postId, me, p.user_email, original, text]);
      await pool.query('UPDATE posts SET no_earn = TRUE WHERE id = $1', [postId]);      // no money while CamFeed checks
      // the owner may answer (only their side is shown to CamFeed, never the claimant's contact)
      await note(p.user_email, postId, '©️ មានអ្នកប្រាប់ CamFeed ថាការបង្ហោះមួយរបស់អ្នក ប្រើស្នាដៃរបស់គេដោយគ្មានការអនុញ្ញាត។ CamFeed កំពុងពិនិត្យ។ បើវាជាស្នាដៃរបស់អ្នកផ្ទាល់ អ្នកអាចឆ្លើយពន្យល់បាន ពី ⋯ លើការបង្ហោះនោះ។');
      res.json({ success: true, id: r.rows[0].id });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  // the owner of a post answers a claim against it ("it is my own work, here is why")
  app.post('/api/copyright/answer', async (req, res) => {
    const me = req.authEmail; const b = req.body || {};
    if (!me) return res.status(401).json({ success: false });
    const postId = parseInt(b.post_id, 10), text = String(b.note || '').trim().slice(0, 1000);
    if (!postId || text.length < 5) return res.status(400).json({ success: false });
    try {
      await ensure();
      const r = await pool.query("UPDATE copyright_claims SET counter_note = $3 WHERE post_id = $1 AND LOWER(owner_email) = LOWER($2) AND status = 'pending' RETURNING id", [postId, me, text]);
      res.json({ success: true, answered: r.rows.length });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  // is there a claim waiting against MY post? (the app shows "Answer" in the post's ⋯)
  app.get('/api/copyright/pending/:postId', async (req, res) => {
    const me = req.authEmail; if (!me) return res.json({ success: true, pending: false });
    try {
      await ensure();
      const r = await pool.query("SELECT 1 FROM copyright_claims WHERE post_id = $1 AND LOWER(owner_email) = LOWER($2) AND status = 'pending' LIMIT 1", [parseInt(req.params.postId, 10) || 0, me]);
      res.json({ success: true, pending: r.rows.length > 0 });
    } catch (e) { res.json({ success: true, pending: false }); }
  });

  // ---------------------------------------------------------------- Admin › ©️ Copyright
  app.post('/api/admin/copyright', async (req, res) => {
    const a = await adminGate(req, res); if (!a) return;
    const b = req.body || {}, act = String(b.action || 'list');
    try {
      await ensure();
      if (act === 'list') {
        const done = b.status === 'done';
        const claims = (await pool.query(`SELECT c.*, p.content, p.media_type, p.media_url, p.thumb_url, p.created_at AS post_at,
            uc.first_name AS c_first, uc.last_name AS c_last, uo.first_name AS o_first, uo.last_name AS o_last,
            (SELECT COUNT(*) FROM copyright_strikes s WHERE LOWER(s.user_email) = LOWER(c.owner_email) AND s.created_at > NOW() - INTERVAL '365 days') AS strikes
          FROM copyright_claims c LEFT JOIN posts p ON p.id = c.post_id
          LEFT JOIN users uc ON LOWER(uc.email) = LOWER(c.claimant_email) LEFT JOIN users uo ON LOWER(uo.email) = LOWER(c.owner_email)
          WHERE ${done ? "c.status <> 'pending'" : "c.status = 'pending'"} ORDER BY c.created_at DESC LIMIT 60`)).rows;
        const dups = (await pool.query(`SELECT d.*, p.content, p.media_type, p.media_url, p.thumb_url, p.created_at AS post_at,
            o.content AS o_content, o.media_type AS o_media_type, o.media_url AS o_media_url, o.thumb_url AS o_thumb_url, o.created_at AS o_post_at,
            uc.first_name AS c_first, uc.last_name AS c_last, uo.first_name AS o_first, uo.last_name AS o_last,
            (SELECT COUNT(*) FROM copyright_strikes s WHERE LOWER(s.user_email) = LOWER(d.owner_email) AND s.created_at > NOW() - INTERVAL '365 days') AS strikes
          FROM dup_flags d LEFT JOIN posts p ON p.id = d.post_id LEFT JOIN posts o ON o.id = d.orig_post_id
          LEFT JOIN users uc ON LOWER(uc.email) = LOWER(d.owner_email) LEFT JOIN users uo ON LOWER(uo.email) = LOWER(d.orig_owner)
          WHERE ${done ? "d.status <> 'pending'" : "d.status = 'pending'"} ORDER BY d.created_at DESC LIMIT 60`)).rows;
        const fp = (await pool.query("SELECT COUNT(*) AS done, (SELECT COUNT(*) FROM posts WHERE COALESCE(fp_done, FALSE) = FALSE AND shared_post_id IS NULL AND COALESCE(media_url, '') <> '') AS waiting FROM media_fp")).rows[0];
        return res.json({ success: true, claims, dups, maxStrikes: maxStrikes(), checked: Number(fp.done) || 0, waiting: Number(fp.waiting) || 0 });
      }
      const id = parseInt(b.id, 10); if (!id) return res.status(400).json({ success: false, error: 'Missing id.' });
      const msg = String(b.note || '').trim().slice(0, 300);
      if (act === 'claim_uphold' || act === 'claim_reject') {
        const c = (await pool.query("SELECT * FROM copyright_claims WHERE id = $1 AND status = 'pending'", [id])).rows[0];
        if (!c) return res.status(409).json({ success: false, error: 'already' });
        if (act === 'claim_reject') {
          await pool.query("UPDATE copyright_claims SET status = 'rejected', decided_at = NOW(), decided_by = $2, admin_note = $3 WHERE id = $1", [id, a.adminEmail, msg]);
          const other = await pool.query("SELECT 1 FROM copyright_claims WHERE post_id = $1 AND status = 'pending'", [c.post_id]);
          if (!other.rows.length) await pool.query('UPDATE posts SET no_earn = FALSE WHERE id = $1 AND id NOT IN (SELECT post_id FROM dup_flags WHERE status <> \'ok\')', [c.post_id]).catch(() => {});
          await note(c.claimant_email, null, '©️ CamFeed បានពិនិត្យការរាយការណ៍កម្មសិទ្ធិរបស់អ្នក ហើយមិនឃើញការរំលោភទេ។' + (msg ? ' ' + msg : ''));
          audit(a.adminEmail, 'copyright-reject', 'claim ' + id, msg);
          return res.json({ success: true });
        }
        await pool.query("UPDATE copyright_claims SET status = 'upheld', decided_at = NOW(), decided_by = $2, admin_note = $3 WHERE id = $1", [id, a.adminEmail, msg]);
        await pool.query("UPDATE copyright_claims SET status = 'upheld', decided_at = NOW(), decided_by = $2 WHERE post_id = $1 AND status = 'pending'", [c.post_id, a.adminEmail]);
        await cleanup.deletePostCompletely(c.post_id).catch(() => {});
        const s = await strike(c.owner_email, { claim: id, post: c.post_id });
        await note(c.owner_email, null, `©️ ការបង្ហោះមួយរបស់អ្នកត្រូវបានដកចេញ ព្រោះវាប្រើស្នាដៃរបស់អ្នកដទៃដោយគ្មានការអនុញ្ញាត (ការរំលោភទី ${km(s.strikes)} ក្នុងចំណោម ${km(s.max)})។` + (msg ? ' ' + msg : ''));
        await note(c.claimant_email, null, '©️ CamFeed បានដកការបង្ហោះដែលអ្នករាយការណ៍ចេញហើយ។ សូមអរគុណ។');
        audit(a.adminEmail, 'copyright-uphold', 'claim ' + id + ' post ' + c.post_id, msg);
        return res.json({ success: true, strikes: s.strikes });
      }
      if (act === 'dup_ok' || act === 'dup_noearn' || act === 'dup_remove') {
        const d = (await pool.query("SELECT * FROM dup_flags WHERE id = $1 AND status = 'pending'", [id])).rows[0];
        if (!d) return res.status(409).json({ success: false, error: 'already' });
        const st = { dup_ok: 'ok', dup_noearn: 'noearn', dup_remove: 'removed' }[act];
        await pool.query('UPDATE dup_flags SET status = $2, decided_at = NOW(), decided_by = $3 WHERE id = $1', [id, st, a.adminEmail]);
        if (act === 'dup_ok') await pool.query("UPDATE posts SET no_earn = FALSE WHERE id = $1 AND id NOT IN (SELECT post_id FROM copyright_claims WHERE status = 'pending')", [d.post_id]);
        if (act === 'dup_noearn') await note(d.owner_email, d.post_id, '©️ ការបង្ហោះមួយរបស់អ្នក ដូចនឹងស្នាដៃដែលមនុស្សម្នាក់ទៀតបានបង្ហោះមុន។ វានៅលើ CamFeed តែមិនរាប់ការរកប្រាក់ទេ។' + (msg ? ' ' + msg : ''));
        if (act === 'dup_remove') {
          await cleanup.deletePostCompletely(d.post_id).catch(() => {});
          const s = await strike(d.owner_email, { dup: id, post: d.post_id });
          await note(d.owner_email, null, `©️ ការបង្ហោះមួយរបស់អ្នកត្រូវបានដកចេញ ព្រោះវាជាការចម្លងស្នាដៃរបស់អ្នកដទៃ (ការរំលោភទី ${km(s.strikes)} ក្នុងចំណោម ${km(s.max)})។` + (msg ? ' ' + msg : ''));
          await note(d.orig_owner, d.orig_post_id, '©️ CamFeed បានដកការចម្លងស្នាដៃរបស់អ្នកចេញហើយ។');
        }
        audit(a.adminEmail, 'copyright-' + act, 'dup ' + id + ' post ' + d.post_id, msg);
        return res.json({ success: true });
      }
      res.status(400).json({ success: false, error: 'Unknown action.' });
    } catch (e) { console.error('[copyright] admin:', e.message); res.status(500).json({ success: false, error: e.message }); }
  });

  const counts = async () => {
    try {
      await ensure();
      const r = (await pool.query("SELECT (SELECT COUNT(*) FROM copyright_claims WHERE status = 'pending') AS c, (SELECT COUNT(*) FROM dup_flags WHERE status = 'pending') AS d")).rows[0];
      return { claims: Number(r.c) || 0, dups: Number(r.d) || 0 };
    } catch (e) { return { claims: 0, dups: 0 }; }
  };
  return { counts, nameOf };
};
