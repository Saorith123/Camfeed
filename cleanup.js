// =============================================================================
// CamFeed cleanup: when something is deleted, delete EVERYTHING that belongs to it
// (database rows + the big files in Cloudflare R2 / Cloudinary), so storage never fills up.
//
// Safety rule: a file is only removed from storage if no other row in the database
// still points at it (e.g. the same photo used as both a post and a profile picture).
// =============================================================================

const NON_FILE_POST_TYPES = new Set(['shared_profile', 'styled_text', 'shared']);

// ---------- URL helpers (pure functions) ----------
function httpOnly(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim().split('#')[0] : null;
}

// Accepts a single URL, a JSON array of media items, or a JSON object; returns every file URL inside.
function extractMediaUrls(raw) {
  if (!raw) return [];
  const out = [];
  const addItem = (it) => {
    if (!it) return;
    if (typeof it === 'string') { const h = httpOnly(it); if (h) out.push(h); return; }
    for (const k of ['url', 'thumbnail', 'thumbnail_url', 'thumb', 'poster']) {
      const h = httpOnly(it[k]); if (h) out.push(h);
    }
  };
  if (Array.isArray(raw)) { raw.forEach(addItem); return [...new Set(out)]; }
  const t = String(raw).trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const parsed = JSON.parse(t);
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(addItem);
    } catch (e) { /* not JSON, ignore */ }
  } else {
    addItem(t);
  }
  return [...new Set(out)];
}

function isCloudinaryUrl(url) { return /^https?:\/\/res\.cloudinary\.com\//i.test(url || ''); }

// https://res.cloudinary.com/<cloud>/video/upload/v123/camfeed_uploads/abc.mp4 -> { resourceType:'video', publicId:'camfeed_uploads/abc' }
function cloudinaryRef(url) {
  const clean = String(url).split('#')[0].split('?')[0];
  const m = /res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)$/i.exec(clean);
  if (!m) return null;
  const resourceType = m[1].toLowerCase();
  let publicId = decodeURIComponent(m[2]);
  if (resourceType !== 'raw') publicId = publicId.replace(/\.[A-Za-z0-9]+$/, '');
  return { resourceType, publicId };
}

// The part of the URL that identifies the file (used to check "is anything else still using it?")
function fileFingerprint(url) {
  if (isCloudinaryUrl(url)) { const r = cloudinaryRef(url); return r ? r.publicId : null; }
  try {
    const p = new URL(String(url).split('#')[0].split('?')[0]).pathname.replace(/^\//, '');
    return p || null;
  } catch (e) { return null; }
}

// ---------- factory ----------
function createCleanup({ pool, cloudinary, deleteR2 }) {
  const MISSING = new Set(['42P01', '42703']); // table / column does not exist -> nothing can reference the file there

  async function referencedElsewhere(fingerprint) {
    const pattern = `%${fingerprint}%`; // "_" in LIKE can over-match; that only keeps a file, never deletes one by mistake
    const checks = [
      'SELECT 1 FROM posts WHERE media_url LIKE $1 LIMIT 1',
      'SELECT 1 FROM users WHERE profile_pic LIKE $1 OR cover_pic LIKE $1 LIMIT 1',
      'SELECT 1 FROM messages WHERE media_url LIKE $1 LIMIT 1',
      'SELECT 1 FROM videos WHERE video_url LIKE $1 OR thumbnail_url LIKE $1 LIMIT 1'
    ];
    for (const sql of checks) {
      try {
        const r = await pool.query(sql, [pattern]);
        if (r.rows.length > 0) return true;
      } catch (e) {
        if (!MISSING.has(e.code)) return true; // unknown problem -> be safe, keep the file
      }
    }
    return false;
  }

  // Delete files from storage (call this AFTER the database rows are gone).
  async function purgeMediaUrls(urls) {
    const unique = [...new Set((urls || []).map(httpOnly).filter(Boolean))];
    const result = { deleted: 0, kept: 0, failed: 0 };
    for (const url of unique) {
      try {
        const fp = fileFingerprint(url);
        if (!fp) { result.kept++; continue; }
        if (await referencedElsewhere(fp)) { result.kept++; continue; }
        if (isCloudinaryUrl(url)) {
          const ref = cloudinaryRef(url);
          if (ref && cloudinary && cloudinary.uploader) {
            await cloudinary.uploader.destroy(ref.publicId, { resource_type: ref.resourceType, invalidate: true });
            result.deleted++;
          } else result.kept++;
        } else {
          await deleteR2(url);
          result.deleted++;
        }
      } catch (e) {
        result.failed++;
        console.error('[cleanup] could not delete file:', url, e.message);
      }
    }
    // remove watch-history rows that point to videos which no longer exist
    await pool.query('DELETE FROM user_video_logs l WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.id = l.video_id)').catch(() => {});
    return result;
  }

  // Delete posts (and shares of them) with every dependent row. Returns the file URLs to purge afterwards.
  async function deletePostsCascade(client, postIds) {
    const ids0 = (postIds || []).map(Number).filter(Number.isInteger);
    if (!ids0.length) return [];
    const found = await client.query(
      'SELECT id, media_type, media_url FROM posts WHERE id = ANY($1::int[]) OR shared_post_id = ANY($1::int[])', [ids0]);
    const ids = found.rows.map(r => r.id);
    if (!ids.length) return [];
    const urls = [];
    found.rows.forEach(r => {
      if (r.media_url && !NON_FILE_POST_TYPES.has(r.media_type)) urls.push(...extractMediaUrls(r.media_url));
    });
    await client.query('DELETE FROM likes WHERE post_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ANY($1::int[]))', [ids]);
    await client.query('DELETE FROM notifications WHERE post_id = ANY($1::int[]) OR comment_id IN (SELECT id FROM comments WHERE post_id = ANY($1::int[]))', [ids]);
    await client.query('DELETE FROM comments WHERE post_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM post_views WHERE post_id = ANY($1::int[])', [ids]);
    await client.query("UPDATE reports SET status = 'resolved_deleted' WHERE target_post_id = ANY($1::int[])", [ids]);
    await client.query('DELETE FROM posts WHERE id = ANY($1::int[])', [ids]);
    return urls;
  }

  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // Delete one post completely (rows + files).
  async function deletePostCompletely(postId) {
    const urls = await inTransaction(client => deletePostsCascade(client, [postId]));
    return purgeMediaUrls(urls);
  }

  // Delete a comment and all its replies, likes and notifications.
  async function deleteCommentCompletely(commentId) {
    return inTransaction(async (client) => {
      const tree = await client.query(
        `WITH RECURSIVE tree AS (
           SELECT id FROM comments WHERE id = $1
           UNION ALL
           SELECT c.id FROM comments c JOIN tree t ON c.reply_to_id = t.id
         ) SELECT id FROM tree`, [commentId]);
      const ids = tree.rows.map(r => r.id);
      if (!ids.length) return 0;
      await client.query('DELETE FROM comment_likes WHERE comment_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM notifications WHERE comment_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM comments WHERE id = ANY($1::int[])', [ids]);
      return ids.length;
    });
  }

  // Delete an account and everything it ever created or took part in (posts, videos, comments, likes, follows,
  // notifications, chats in both directions with their voice/photo files, profile & cover pictures).
  async function deleteUserCompletely(email) {
    const urls = await inTransaction(async (client) => {
      const out = [];
      const posts = await client.query('SELECT id FROM posts WHERE user_email = $1', [email]);
      out.push(...await deletePostsCascade(client, posts.rows.map(r => r.id)));

      const mine = await client.query('SELECT id FROM comments WHERE user_email = $1', [email]);
      const cids = mine.rows.map(r => r.id);
      if (cids.length) {
        await client.query('UPDATE comments SET reply_to_id = NULL WHERE reply_to_id = ANY($1::int[])', [cids]);
        await client.query('DELETE FROM comment_likes WHERE comment_id = ANY($1::int[])', [cids]);
        await client.query('DELETE FROM notifications WHERE comment_id = ANY($1::int[])', [cids]);
        await client.query('DELETE FROM comments WHERE id = ANY($1::int[])', [cids]);
      }
      await client.query('DELETE FROM comment_likes WHERE user_email = $1', [email]);
      await client.query('DELETE FROM likes WHERE user_email = $1', [email]);
      await client.query('DELETE FROM follows WHERE follower_email = $1 OR following_email = $1', [email]);
      await client.query('DELETE FROM blocked_users WHERE blocker_email = $1 OR blocked_email = $1', [email]);
      await client.query('DELETE FROM notifications WHERE recipient_email = $1 OR sender_email = $1', [email]);
      await client.query('DELETE FROM post_views WHERE viewer_email = $1', [email]);
      await client.query('DELETE FROM reports WHERE reporter_email = $1 OR target_user_email = $1', [email]);
      // optional table: never let it break the account deletion if it does not exist yet
      await client.query('SAVEPOINT dismissed_sp');
      try {
        await client.query('DELETE FROM dismissed_suggestions WHERE user_email = $1 OR dismissed_email = $1', [email]);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT dismissed_sp');
      }

      // chats: every message sent OR received, with their files
      const msgs = await client.query(
        'SELECT media_url FROM messages WHERE (sender_email = $1 OR receiver_email = $1) AND media_url IS NOT NULL', [email]);
      msgs.rows.forEach(m => out.push(...extractMediaUrls(m.media_url)));
      await client.query('DELETE FROM messages WHERE sender_email = $1 OR receiver_email = $1', [email]);

      // short videos
      const vids = await client.query('SELECT id, video_url, thumbnail_url FROM videos WHERE user_email = $1', [email]);
      const vids_ids = vids.rows.map(v => v.id);
      vids.rows.forEach(v => { [v.video_url, v.thumbnail_url].forEach(u => { const h = httpOnly(u); if (h) out.push(h); }); });
      if (vids_ids.length) await client.query('DELETE FROM user_video_logs WHERE video_id = ANY($1::int[])', [vids_ids]);
      await client.query('DELETE FROM user_video_logs WHERE user_email = $1', [email]);
      await client.query('DELETE FROM user_interest_scores WHERE user_email = $1', [email]);
      if (vids_ids.length) await client.query('DELETE FROM videos WHERE id = ANY($1::int[])', [vids_ids]);

      // profile / cover pictures
      const u = await client.query('SELECT profile_pic, cover_pic FROM users WHERE email = $1', [email]);
      if (u.rows[0]) [u.rows[0].profile_pic, u.rows[0].cover_pic].forEach(x => { const h = httpOnly(x); if (h) out.push(h); });

      await client.query('DELETE FROM users WHERE email = $1', [email]);
      return out;
    });
    return purgeMediaUrls(urls);
  }

  return { purgeMediaUrls, deletePostsCascade, deletePostCompletely, deleteCommentCompletely, deleteUserCompletely };
}

module.exports = { createCleanup, extractMediaUrls, cloudinaryRef, isCloudinaryUrl, fileFingerprint };
