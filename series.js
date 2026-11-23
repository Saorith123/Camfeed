// 📚 "Series" on a person's profile: their videos grouped under a name they choose ("ស្នេហ៍អមតៈ", "ម្ហូបខ្មែរងាយៗ" …),
// in order (episode 1, 2, 3 … — the word "ភាគ" / "មេរៀន" … is theirs to choose too). Everybody can make them.
// The tab on the profile has a name the owner chooses ("រឿង", "មេរៀន" …; empty = the app's default).
// A video is in ONE series at most. The videos stay ordinary posts (Feed, Reels …): a series only groups them.
module.exports = function installSeries({ app, pool }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS series (
          id SERIAL PRIMARY KEY,
          owner_email VARCHAR(255) NOT NULL,
          title VARCHAR(120) NOT NULL,
          description TEXT DEFAULT '',
          unit VARCHAR(30) DEFAULT '',
          cover_url TEXT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS series_owner_idx ON series (LOWER(owner_email))');
        await pool.query(`CREATE TABLE IF NOT EXISTS series_items (
          post_id INTEGER PRIMARY KEY,
          series_id INTEGER NOT NULL,
          ep INTEGER NOT NULL DEFAULT 1,
          added_at TIMESTAMP DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS series_items_idx ON series_items (series_id, ep)');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS series_tab VARCHAR(40) DEFAULT NULL');
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  setTimeout(() => ensure().catch((e) => console.error('[series] setup:', e.message)), 4000);

  async function owned(id, me) {
    const r = await pool.query('SELECT * FROM series WHERE id = $1 AND LOWER(owner_email) = $2', [id, norm(me)]);
    return r.rows[0] || null;
  }
  // renumber 1, 2, 3 … in the present order (after a removal)
  async function renumber(id) {
    await pool.query(`UPDATE series_items s SET ep = x.n FROM (
      SELECT post_id, ROW_NUMBER() OVER (ORDER BY ep, added_at, post_id) AS n FROM series_items WHERE series_id = $1) x
      WHERE s.post_id = x.post_id`, [id]);
  }

  // the list on a profile
  app.get('/api/series', async (req, res) => {
    const email = norm(req.query.email);
    if (!email) return res.status(400).json({ success: false });
    try {
      await ensure();
      const u = await pool.query('SELECT series_tab FROM users WHERE LOWER(email) = $1', [email]);
      const r = await pool.query(`SELECT s.id, s.title, s.description, s.unit, s.cover_url, s.updated_at,
          COUNT(p.id)::int AS count,
          (SELECT COALESCE(p2.thumb_url, '') FROM series_items i2 JOIN posts p2 ON p2.id = i2.post_id
             WHERE i2.series_id = s.id ORDER BY i2.ep LIMIT 1) AS first_thumb,
          (SELECT p3.media_url FROM series_items i3 JOIN posts p3 ON p3.id = i3.post_id
             WHERE i3.series_id = s.id ORDER BY i3.ep LIMIT 1) AS first_media
        FROM series s
        LEFT JOIN series_items i ON i.series_id = s.id
        LEFT JOIN posts p ON p.id = i.post_id
        WHERE LOWER(s.owner_email) = $1
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT 200`, [email]);
      res.json({ success: true, tab: (u.rows[0] && u.rows[0].series_tab) || '', series: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // one series with its videos in order
  app.get('/api/series/:id(\\d+)', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await ensure();
      const s = await pool.query('SELECT * FROM series WHERE id = $1', [id]);
      if (!s.rows.length) return res.status(404).json({ success: false, error: 'not found' });
      const it = await pool.query(`SELECT i.ep, p.id, p.user_email, p.content, p.media_type, p.media_url, p.feed_url, p.thumb_url,
          p.video_secs, p.media_aspect, p.created_at
        FROM series_items i JOIN posts p ON p.id = i.post_id
        WHERE i.series_id = $1 ORDER BY i.ep, i.added_at`, [id]);
      res.json({ success: true, series: s.rows[0], items: it.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // which series a video is in (for a small "📚 name · ep 3" label)
  app.get('/api/series/of-post/:id(\\d+)', async (req, res) => {
    try {
      await ensure();
      const r = await pool.query(`SELECT s.id, s.title, s.unit, i.ep,
          (SELECT COUNT(*)::int FROM series_items x WHERE x.series_id = s.id) AS count
        FROM series_items i JOIN series s ON s.id = i.series_id WHERE i.post_id = $1`, [parseInt(req.params.id, 10)]);
      res.json({ success: true, series: r.rows[0] || null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // make one
  app.post('/api/series', async (req, res) => {
    const me = req.authEmail;
    const b = req.body || {};
    const title = clip(b.title, 120);
    if (!me) return res.status(401).json({ success: false });
    if (!title) return res.status(400).json({ success: false, error: 'title' });
    try {
      await ensure();
      const n = await pool.query('SELECT COUNT(*)::int AS n FROM series WHERE LOWER(owner_email) = $1', [norm(me)]);
      if (n.rows[0].n >= 200) return res.status(400).json({ success: false, error: 'too many' });
      const r = await pool.query('INSERT INTO series (owner_email, title, description, unit, cover_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [norm(me), title, clip(b.description, 1000), clip(b.unit, 30), /^https:\/\//.test(String(b.cover || '')) ? String(b.cover).slice(0, 600) : null]);
      res.json({ success: true, series: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // change its name / words / picture
  app.post('/api/series/:id(\\d+)', async (req, res) => {
    const me = req.authEmail;
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    try {
      await ensure();
      const s = await owned(id, me);
      if (!s) return res.status(403).json({ success: false });
      const title = b.title === undefined ? s.title : (clip(b.title, 120) || s.title);
      const cover = b.cover === undefined ? s.cover_url : (/^https:\/\//.test(String(b.cover || '')) ? String(b.cover).slice(0, 600) : null);
      const r = await pool.query('UPDATE series SET title = $2, description = $3, unit = $4, cover_url = $5, updated_at = NOW() WHERE id = $1 RETURNING *',
        [id, title, b.description === undefined ? s.description : clip(b.description, 1000), b.unit === undefined ? s.unit : clip(b.unit, 30), cover]);
      res.json({ success: true, series: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // delete the series (the videos stay)
  app.delete('/api/series/:id(\\d+)', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await ensure();
      if (!(await owned(id, req.authEmail))) return res.status(403).json({ success: false });
      await pool.query('DELETE FROM series_items WHERE series_id = $1', [id]);
      await pool.query('DELETE FROM series WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // add videos (own videos only; a video in another series moves here), at the end
  app.post('/api/series/:id(\\d+)/items', async (req, res) => {
    const me = req.authEmail;
    const id = parseInt(req.params.id, 10);
    const ids = (Array.isArray((req.body || {}).postIds) ? req.body.postIds : []).map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 300);
    try {
      await ensure();
      if (!(await owned(id, me))) return res.status(403).json({ success: false });
      if (!ids.length) return res.json({ success: true, added: 0 });
      const mine = await pool.query(`SELECT id FROM posts WHERE id = ANY($1::int[]) AND LOWER(user_email) = $2
        AND (media_type = 'video' OR media_url LIKE '%"type":"video"%' OR media_url ~* '\\.(mp4|mov|m4v|webm)')`, [ids, norm(me)]);
      const ok = new Set(mine.rows.map((r) => r.id));
      const olds = await pool.query('SELECT DISTINCT series_id FROM series_items WHERE post_id = ANY($1::int[]) AND series_id <> $2', [ids, id]);
      const mx = await pool.query('SELECT COALESCE(MAX(ep), 0)::int AS m FROM series_items WHERE series_id = $1', [id]);
      let ep = mx.rows[0].m;
      let added = 0;
      for (const p of ids) {
        if (!ok.has(p)) continue;
        const r = await pool.query(`INSERT INTO series_items (post_id, series_id, ep) VALUES ($1, $2, $3)
          ON CONFLICT (post_id) DO UPDATE SET series_id = EXCLUDED.series_id, ep = EXCLUDED.ep, added_at = NOW()
          WHERE series_items.series_id <> EXCLUDED.series_id RETURNING post_id`, [p, id, ep + 1]);
        if (r.rows.length) { ep++; added++; }
      }
      for (const o of olds.rows) await renumber(o.series_id);
      await pool.query('UPDATE series SET updated_at = NOW() WHERE id = $1', [id]);
      res.json({ success: true, added });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // new order: postIds from episode 1 to the last
  app.post('/api/series/:id(\\d+)/order', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const ids = (Array.isArray((req.body || {}).postIds) ? req.body.postIds : []).map((x) => parseInt(x, 10)).filter((x) => x > 0);
    try {
      await ensure();
      if (!(await owned(id, req.authEmail))) return res.status(403).json({ success: false });
      let n = 0;
      for (const p of ids) { n++; await pool.query('UPDATE series_items SET ep = $3 WHERE series_id = $1 AND post_id = $2', [id, p, n]); }
      await renumber(id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // take a video out (it stays a normal post)
  app.delete('/api/series/:id(\\d+)/items/:post(\\d+)', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await ensure();
      if (!(await owned(id, req.authEmail))) return res.status(403).json({ success: false });
      await pool.query('DELETE FROM series_items WHERE series_id = $1 AND post_id = $2', [id, parseInt(req.params.post, 10)]);
      await renumber(id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // the name of the tab on my profile ("" = the app's own word)
  app.post('/api/series-tab', async (req, res) => {
    const me = req.authEmail;
    if (!me) return res.status(401).json({ success: false });
    try {
      await ensure();
      const t = clip((req.body || {}).label, 40);
      await pool.query('UPDATE users SET series_tab = $2 WHERE LOWER(email) = $1', [norm(me), t || null]);
      res.json({ success: true, tab: t });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // a deleted video leaves its series by itself
  return {
    async postDeleted(postId) {
      try {
        await ensure();
        const r = await pool.query('DELETE FROM series_items WHERE post_id = $1 RETURNING series_id', [postId]);
        for (const x of r.rows) await renumber(x.series_id);
      } catch (e) { /* not important */ }
    },
  };
};
