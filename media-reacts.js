// 👍 💬 on ONE picture / video inside a post's album. They belong to that picture only and are never added to the post's own numbers.
// A picture is known by its link (kept as a short hash), so its likes stay with it even when the owner removes other pictures.
'use strict';
const crypto = require('crypto');

module.exports = function ({ app, pool, visibility, pubMedia }) {
  const keyOf = (url) => crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 16);
  let ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS media_reacts (post_id INTEGER NOT NULL, item_key VARCHAR(16) NOT NULL, user_email TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (post_id, item_key, user_email))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS media_comments (id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, item_key VARCHAR(16) NOT NULL, user_email TEXT NOT NULL,
        text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_media_comments_item ON media_comments (post_id, item_key, id)');
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  ensure().catch(() => {});
  // the post's pictures / videos in order (a share: the original's)
  async function itemsOf(postId) {
    const p = (await pool.query('SELECT id, media_url, media_type, user_email FROM posts WHERE id = $1', [postId])).rows[0];
    if (!p) return null;
    let list = [];
    const raw = String(p.media_url || '').trim();
    if (raw[0] === '[') { try { list = JSON.parse(raw).map((x) => x && x.url).filter(Boolean); } catch (e) { list = []; } }
    else if (raw) list = [raw];
    return { owner: p.user_email, urls: list };
  }
  const idOf = (req) => { const n = parseInt(req.params.id, 10); return n > 0 ? n : 0; };

  // numbers for every picture of a post: [{url, likes, comments, mine}]
  app.get('/api/posts/:id/media-stats', async (req, res) => {
    try {
      const id = idOf(req); if (!id) return res.status(400).json({ success: false });
      if (!(await visibility.guardPost(req, res, id))) return;
      await ensure();
      const it = await itemsOf(id); if (!it) return res.status(404).json({ success: false });
      const me = String(req.authEmail || '');
      const l = (await pool.query('SELECT item_key, COUNT(*)::int AS n, BOOL_OR(user_email = $2) AS mine FROM media_reacts WHERE post_id = $1 GROUP BY item_key', [id, me])).rows;
      const c = (await pool.query('SELECT item_key, COUNT(*)::int AS n FROM media_comments WHERE post_id = $1 GROUP BY item_key', [id])).rows;
      const lm = new Map(l.map((x) => [x.item_key, x])), cm = new Map(c.map((x) => [x.item_key, x.n]));
      res.json({ success: true, items: it.urls.map((u) => { const k = keyOf(u), x = lm.get(k); return { url: u, likes: x ? x.n : 0, mine: !!(x && x.mine), comments: cm.get(k) || 0 }; }) });
    } catch (e) { console.error('[media-reacts] stats:', e.message); res.status(500).json({ success: false }); }
  });

  // 👍 on / off for one picture
  app.post('/api/posts/:id/media-react', async (req, res) => {
    try {
      const id = idOf(req), me = req.authEmail, url = String((req.body || {}).url || '');
      if (!id || !me || !url) return res.status(400).json({ success: false });
      if (!(await visibility.guardPost(req, res, id))) return;
      await ensure();
      const it = await itemsOf(id); if (!it || !it.urls.includes(url)) return res.status(404).json({ success: false, error: 'This picture is not in the post.' });
      const k = keyOf(url);
      if ((req.body || {}).on === false) await pool.query('DELETE FROM media_reacts WHERE post_id = $1 AND item_key = $2 AND user_email = $3', [id, k, me]);
      else await pool.query('INSERT INTO media_reacts (post_id, item_key, user_email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, k, me]);
      const n = (await pool.query('SELECT COUNT(*)::int AS n FROM media_reacts WHERE post_id = $1 AND item_key = $2', [id, k])).rows[0].n;
      res.json({ success: true, likes: n, mine: (req.body || {}).on !== false });
    } catch (e) { console.error('[media-reacts] react:', e.message); res.status(500).json({ success: false }); }
  });

  // 💬 the comments of one picture
  app.get('/api/posts/:id/media-comments', async (req, res) => {
    try {
      const id = idOf(req), url = String(req.query.url || '');
      if (!id || !url) return res.status(400).json({ success: false });
      if (!(await visibility.guardPost(req, res, id))) return;
      await ensure();
      const r = await pool.query(`SELECT c.id, c.text, c.created_at, c.user_email, u.first_name, u.last_name, u.profile_pic FROM media_comments c JOIN users u ON u.email = c.user_email
        WHERE c.post_id = $1 AND c.item_key = $2 AND COALESCE(u.is_banned, FALSE) = FALSE ORDER BY c.id LIMIT 300`, [id, keyOf(url)]);
      const me = String(req.authEmail || '');
      res.json({ success: true, comments: r.rows.map((x) => Object.assign(x, { mine: x.user_email === me })) });
    } catch (e) { console.error('[media-reacts] list:', e.message); res.status(500).json({ success: false, comments: [] }); }
  });
  app.post('/api/posts/:id/media-comments', async (req, res) => {
    try {
      const id = idOf(req), me = req.authEmail, b = req.body || {}, url = String(b.url || ''), text = String(b.text || '').trim().slice(0, 2000);
      if (!id || !me || !url || !text) return res.status(400).json({ success: false, error: 'Write something.' });
      if (!(await visibility.guardPost(req, res, id))) return;
      await ensure();
      const it = await itemsOf(id); if (!it || !it.urls.includes(url)) return res.status(404).json({ success: false, error: 'This picture is not in the post.' });
      const r = await pool.query('INSERT INTO media_comments (post_id, item_key, user_email, text) VALUES ($1, $2, $3, $4) RETURNING id, created_at', [id, keyOf(url), me, text]);
      if (it.owner && it.owner !== me) {
        const who = (await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [me])).rows[0] || {};
        pool.query("INSERT INTO notifications (recipient_email, sender_email, post_id, type, message, is_read) VALUES ($1, $2, $3, 'comment', $4, FALSE)",
          [it.owner, me, id, ((who.first_name || '') + ' ' + (who.last_name || '')).trim() + ' បានបញ្ចេញមតិលើរូបភាពមួយក្នុងការបង្ហោះរបស់អ្នក']).catch(() => {});
      }
      res.json({ success: true, id: r.rows[0].id, created_at: r.rows[0].created_at });
    } catch (e) { console.error('[media-reacts] add:', e.message); res.status(500).json({ success: false, error: 'Could not send.' }); }
  });
  app.delete('/api/posts/:id/media-comments/:cid', async (req, res) => {
    try {
      const id = idOf(req), cid = parseInt(req.params.cid, 10), me = req.authEmail;
      if (!id || !(cid > 0) || !me) return res.status(400).json({ success: false });
      await ensure();
      // my own comment, or any comment on my post
      const r = await pool.query('DELETE FROM media_comments c USING posts p WHERE c.id = $1 AND c.post_id = $2 AND p.id = c.post_id AND (c.user_email = $3 OR p.user_email = $3)', [cid, id, me]);
      res.json({ success: r.rowCount > 0 });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  return { keyOf };
};
