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
        await pool.query('ALTER TABLE series ADD COLUMN IF NOT EXISTS pos INTEGER DEFAULT 0');
        // ➕ more tabs on the profile (the first one is users.series_tab, tab_id NULL); 4 more at most
        await pool.query(`CREATE TABLE IF NOT EXISTS series_tabs (
          id SERIAL PRIMARY KEY,
          owner_email VARCHAR(255) NOT NULL,
          name VARCHAR(40) NOT NULL,
          pos INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW())`);
        await pool.query('ALTER TABLE series ADD COLUMN IF NOT EXISTS tab_id INTEGER DEFAULT NULL');
        // 🎬 single videos put straight in the tab (not in a folder), mixed with the folders
        await pool.query(`CREATE TABLE IF NOT EXISTS shelf_items (
          post_id INTEGER PRIMARY KEY,
          owner_email VARCHAR(255) NOT NULL,
          pos INTEGER DEFAULT 0,
          added_at TIMESTAMP DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS shelf_owner_idx ON shelf_items (LOWER(owner_email))');
        await pool.query('ALTER TABLE shelf_items ADD COLUMN IF NOT EXISTS tab_id INTEGER DEFAULT NULL');
        // 📌 videos pinned at the top of the profile's video tab (3 at most)
        await pool.query(`CREATE TABLE IF NOT EXISTS profile_pins (
          owner_email VARCHAR(255) NOT NULL,
          post_id INTEGER NOT NULL,
          pinned_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (owner_email, post_id))`);
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  setTimeout(() => ensure().catch((e) => console.error('[series] setup:', e.message)), 4000);

  // the smallest place number - 1 (new things go on top)
  async function topPos(me) {
    const r = await pool.query(`SELECT LEAST(
        COALESCE((SELECT MIN(pos) FROM series WHERE LOWER(owner_email) = $1), 0),
        COALESCE((SELECT MIN(pos) FROM shelf_items WHERE LOWER(owner_email) = $1), 0)) - 1 AS p`, [norm(me)]);
    return r.rows[0].p;
  }
  async function myVideos(ids, me) {
    if (!ids.length) return [];
    const r = await pool.query(`SELECT id FROM posts WHERE id = ANY($1::int[]) AND LOWER(user_email) = $2
      AND (media_type = 'video' OR media_url LIKE '%"type":"video"%' OR media_url ~* '\\.(mp4|mov|m4v|webm)')`, [ids, norm(me)]);
    return r.rows.map((x) => x.id);
  }
  // a tab id of mine, or null (= the first tab)
  async function myTab(v, me) {
    const id = parseInt(v, 10);
    if (!(id > 0)) return null;
    const r = await pool.query('SELECT id FROM series_tabs WHERE id = $1 AND LOWER(owner_email) = $2', [id, norm(me)]);
    return r.rows.length ? id : null;
  }
  const intList = (a, n) => (Array.isArray(a) ? a : []).map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, n);

  async function owned(id, me) {
    if (!(id > 0)) return null;
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
      const tabs = await pool.query('SELECT id, name FROM series_tabs WHERE LOWER(owner_email) = $1 ORDER BY pos, id', [email]);
      const tid = parseInt(req.query.tab, 10) > 0 ? parseInt(req.query.tab, 10) : null;   // none = the first tab
      const r = await pool.query(`SELECT s.id, s.title, s.description, s.unit, s.cover_url, s.updated_at, s.pos,
          COUNT(p.id)::int AS count,
          (SELECT COALESCE(p2.thumb_url, '') FROM series_items i2 JOIN posts p2 ON p2.id = i2.post_id
             WHERE i2.series_id = s.id ORDER BY i2.ep LIMIT 1) AS first_thumb,
          (SELECT p3.media_url FROM series_items i3 JOIN posts p3 ON p3.id = i3.post_id
             WHERE i3.series_id = s.id ORDER BY i3.ep LIMIT 1) AS first_media
        FROM series s
        LEFT JOIN series_items i ON i.series_id = s.id
        LEFT JOIN posts p ON p.id = i.post_id
        WHERE LOWER(s.owner_email) = $1 AND s.tab_id IS NOT DISTINCT FROM $2::int
        GROUP BY s.id
        ORDER BY s.pos, s.updated_at DESC
        LIMIT 200`, [email, tid]);
      const v = await pool.query(`SELECT h.pos, p.id, p.content, p.media_type, p.media_url, p.feed_url, p.thumb_url, p.video_secs,
          COALESCE(p.views_count, 0) AS views_count
        FROM shelf_items h JOIN posts p ON p.id = h.post_id
        WHERE LOWER(h.owner_email) = $1 AND h.tab_id IS NOT DISTINCT FROM $2::int ORDER BY h.pos, h.added_at DESC LIMIT 300`, [email, tid]);
      const items = [
        ...r.rows.map((x) => ({ kind: 'folder', pos: x.pos || 0, ...x })),
        ...v.rows.map((x) => ({ kind: 'video', ...x })),
      ].sort((a, b) => (a.pos || 0) - (b.pos || 0));
      res.json({ success: true, tab: (u.rows[0] && u.rows[0].series_tab) || '', tabs: tabs.rows, series: r.rows, items });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // one series with its videos in order
  app.get('/api/series/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!(id > 0)) return res.status(404).json({ success: false });
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
  app.get('/api/series/of-post/:id', async (req, res) => {
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
      const top = await topPos(me);
      const tab = await myTab(b.tabId, me);
      const r = await pool.query('INSERT INTO series (owner_email, title, description, unit, cover_url, pos, tab_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [norm(me), title, clip(b.description, 1000), clip(b.unit, 30), /^https:\/\//.test(String(b.cover || '')) ? String(b.cover).slice(0, 600) : null, top, tab]);
      res.json({ success: true, series: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // change its name / words / picture
  app.post('/api/series/:id', async (req, res) => {
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
  app.delete('/api/series/:id', async (req, res) => {
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
  app.post('/api/series/:id/items', async (req, res) => {
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
      await pool.query('DELETE FROM shelf_items WHERE post_id = ANY($1::int[])', [[...ok]]);
      await pool.query('UPDATE series SET updated_at = NOW() WHERE id = $1', [id]);
      res.json({ success: true, added });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // new order: postIds from episode 1 to the last
  app.post('/api/series/:id/order', async (req, res) => {
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
  app.delete('/api/series/:id/items/:post', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await ensure();
      if (!(await owned(id, req.authEmail))) return res.status(403).json({ success: false });
      await pool.query('DELETE FROM series_items WHERE series_id = $1 AND post_id = $2', [id, parseInt(req.params.post, 10)]);
      await renumber(id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // 🎬 put my videos straight in the tab (out of any folder), on top
  app.post('/api/shelf/add', async (req, res) => {
    const me = req.authEmail;
    if (!me) return res.status(401).json({ success: false });
    try {
      await ensure();
      const ids = await myVideos(intList((req.body || {}).postIds, 300), me);
      const olds = ids.length ? await pool.query('DELETE FROM series_items WHERE post_id = ANY($1::int[]) RETURNING series_id', [ids]) : { rows: [] };
      for (const sid of new Set(olds.rows.map((x) => x.series_id))) await renumber(sid);
      let p = await topPos(me);
      const tab = await myTab((req.body || {}).tabId, me);
      for (const id of ids) {
        await pool.query(`INSERT INTO shelf_items (post_id, owner_email, pos, tab_id) VALUES ($1, $2, $3, $4)
          ON CONFLICT (post_id) DO UPDATE SET pos = EXCLUDED.pos, tab_id = EXCLUDED.tab_id`, [id, norm(me), p, tab]);
        p--;
      }
      res.json({ success: true, added: ids.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.delete('/api/shelf/:post', async (req, res) => {
    const me = req.authEmail;
    if (!me) return res.status(401).json({ success: false });
    try {
      await ensure();
      await pool.query('DELETE FROM shelf_items WHERE post_id = $1 AND LOWER(owner_email) = $2', [parseInt(req.params.post, 10), norm(me)]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // the whole tab in a new order: [{kind:'folder'|'video', id}, …] from the top
  app.post('/api/shelf/order', async (req, res) => {
    const me = req.authEmail;
    if (!me) return res.status(401).json({ success: false });
    const list = Array.isArray((req.body || {}).order) ? req.body.order.slice(0, 600) : [];
    try {
      await ensure();
      let n = 0;
      for (const x of list) {
        n++;
        const id = parseInt(x && x.id, 10) || 0;
        if (!id) continue;
        if (x.kind === 'folder') await pool.query('UPDATE series SET pos = $3 WHERE id = $1 AND LOWER(owner_email) = $2', [id, norm(me), n]);
        else await pool.query('UPDATE shelf_items SET pos = $3 WHERE post_id = $1 AND LOWER(owner_email) = $2', [id, norm(me), n]);
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ➕ a new tab (5 in all, with the first one)
  app.post('/api/series-tabs', async (req, res) => {
    const me = req.authEmail;
    const name = clip((req.body || {}).name, 40);
    if (!me) return res.status(401).json({ success: false });
    if (!name) return res.status(400).json({ success: false, error: 'name' });
    try {
      await ensure();
      const n = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(MAX(pos), 0)::int AS m FROM series_tabs WHERE LOWER(owner_email) = $1', [norm(me)]);
      if (n.rows[0].n >= 4) return res.status(400).json({ success: false, error: 'At most 5 tabs.', errorKm: 'បានច្រើនបំផុត 5' });
      const r = await pool.query('INSERT INTO series_tabs (owner_email, name, pos) VALUES ($1, $2, $3) RETURNING id, name', [norm(me), name, n.rows[0].m + 1]);
      res.json({ success: true, tab: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/series-tabs/:id', async (req, res) => {
    const me = req.authEmail;
    const id = parseInt(req.params.id, 10);
    const name = clip((req.body || {}).name, 40);
    if (!me || !(id > 0) || !name) return res.status(400).json({ success: false });
    try {
      await ensure();
      await pool.query('UPDATE series_tabs SET name = $3 WHERE id = $1 AND LOWER(owner_email) = $2', [id, norm(me), name]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // delete a tab: what was in it goes back to the first tab (nothing is lost)
  app.delete('/api/series-tabs/:id', async (req, res) => {
    const me = req.authEmail;
    const id = parseInt(req.params.id, 10);
    if (!me || !(id > 0)) return res.status(400).json({ success: false });
    try {
      await ensure();
      const t = await pool.query('DELETE FROM series_tabs WHERE id = $1 AND LOWER(owner_email) = $2 RETURNING id', [id, norm(me)]);
      if (t.rows.length) {
        await pool.query('UPDATE series SET tab_id = NULL WHERE tab_id = $1', [id]);
        await pool.query('UPDATE shelf_items SET tab_id = NULL WHERE tab_id = $1', [id]);
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // 📌 pinned posts of a profile (any kind: photo, video, text; newest pin first)
  app.get('/api/pins', async (req, res) => {
    const email = norm(req.query.email);
    if (!email) return res.status(400).json({ success: false });
    try {
      await ensure();
      // only the ids: the app opens each one through /api/posts/:id, which checks who may see it
      const r = await pool.query(`SELECT x.post_id FROM profile_pins x JOIN posts p ON p.id = x.post_id
        WHERE LOWER(x.owner_email) = $1 ORDER BY x.pinned_at DESC LIMIT 3`, [email]);
      res.json({ success: true, ids: r.rows.map((x) => x.post_id) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/pins/:post', async (req, res) => {
    const me = req.authEmail;
    if (!me) return res.status(401).json({ success: false });
    const id = parseInt(req.params.post, 10);
    try {
      await ensure();
      if ((req.body || {}).on === false) {
        await pool.query('DELETE FROM profile_pins WHERE LOWER(owner_email) = $1 AND post_id = $2', [norm(me), id]);
        return res.json({ success: true, pinned: false });
      }
      const own = await pool.query('SELECT id FROM posts WHERE id = $1 AND LOWER(user_email) = $2', [id, norm(me)]);
      if (!own.rows.length) return res.status(403).json({ success: false });
      await pool.query(`INSERT INTO profile_pins (owner_email, post_id) VALUES ($1, $2) ON CONFLICT (owner_email, post_id) DO UPDATE SET pinned_at = NOW()`, [norm(me), id]);
      // 3 at most: the oldest pin goes
      await pool.query(`DELETE FROM profile_pins WHERE LOWER(owner_email) = $1 AND post_id NOT IN (
        SELECT post_id FROM profile_pins WHERE LOWER(owner_email) = $1 ORDER BY pinned_at DESC LIMIT 3)`, [norm(me)]);
      res.json({ success: true, pinned: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // 🖼️ my own picture on my video (the "thumbnail" people see before they tap)
  app.post('/api/posts/:id/thumb', async (req, res) => {
    const me = req.authEmail;
    const id = parseInt(req.params.id, 10);
    const url = String((req.body || {}).thumbnailUrl || '');
    if (!me || !(id > 0)) return res.status(400).json({ success: false });
    if (!/^https:\/\//.test(url)) return res.status(400).json({ success: false, error: 'url' });
    try {
      const r = await pool.query('UPDATE posts SET thumb_url = $3 WHERE id = $1 AND LOWER(user_email) = $2 RETURNING id', [id, norm(me), url.slice(0, 600)]);
      if (!r.rows.length) return res.status(403).json({ success: false });
      res.json({ success: true, thumb_url: url });
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
        await pool.query('DELETE FROM shelf_items WHERE post_id = $1', [postId]);
        await pool.query('DELETE FROM profile_pins WHERE post_id = $1', [postId]);
        for (const x of r.rows) await renumber(x.series_id);
      } catch (e) { /* not important */ }
    },
  };
};
