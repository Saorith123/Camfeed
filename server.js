const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const { cloudinary, upload: cloudinaryUpload } = require('./cloudinary');
const createVideoRouter = require('./videoRecommendationRoutes');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

const ADMIN_MASTER_KEY = process.env.ADMIN_SECRET_KEY || 'CAMFEED2026';

pool.connect(async (err, client, release) => {
  if (err) return console.error('Error connecting to Database:', err.stack);
  console.log('Database connected successfully to Supabase for Camfeed!');
  try {
    // 1. Posts columns
    await client.query(`
      ALTER TABLE posts 
      ADD COLUMN IF NOT EXISTS ai_category VARCHAR(100) DEFAULT 'General',
      ADD COLUMN IF NOT EXISTS ai_tags TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shared_post_id INTEGER DEFAULT NULL
    `);

    // 2. Users columns for Per-Field Privacy, Admin Roles & Ban Status
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
      ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE
    `);

    if (SUPER_ADMIN_EMAILS.length > 0) {
      await client.query(
        `UPDATE users SET role = 'super_admin' WHERE LOWER(email) = ANY($1::text[])`,
        [SUPER_ADMIN_EMAILS]
      );
    }

    // 3. Notifications read-status & comment_id columns
    await client.query(`
      ALTER TABLE notifications
      ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS comment_id INTEGER DEFAULT NULL
    `);

    // 4. Comments reply_to_id column & Comment Reactions table
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

    // 5. Views analytics table
    await client.query(`
      CREATE TABLE IF NOT EXISTS post_views (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL,
        viewer_email VARCHAR(255),
        country VARCHAR(100) DEFAULT 'Unknown',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 6. Blocked users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        id SERIAL PRIMARY KEY,
        blocker_email VARCHAR(255) NOT NULL,
        blocked_email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(blocker_email, blocked_email)
      )
    `);

    // 7. Moderation Reports table
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
  release();
});

// Mount Cloudflare R2 Video/Media Upload, AI Classification & Recommendation Routes
app.use('/api/videos', createVideoRouter(pool));

async function verifyAdminAccess(email, secretKey) {
  if (!email) return { allowed: false, error: 'Missing admin email' };
  const normalized = email.trim().toLowerCase();
  const isSuper = SUPER_ADMIN_EMAILS.includes(normalized);

  const userRes = await pool.query('SELECT email, role, is_banned FROM users WHERE LOWER(email) = $1', [normalized]);
  const dbUser = userRes.rows[0];

  if (!isSuper && (!dbUser || dbUser.is_banned || (dbUser.role !== 'admin' && dbUser.role !== 'super_admin'))) {
    return { allowed: false, error: 'Access Denied: You do not have Admin permission.' };
  }

  if (secretKey !== ADMIN_MASTER_KEY) {
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
app.post('/api/register', async (req, res) => {
  const { email, password, firstName, lastName, birthdate, gender, country } = req.body;
  try {
    const isSuper = SUPER_ADMIN_EMAILS.includes((email || '').trim().toLowerCase());
    const initialRole = isSuper ? 'super_admin' : 'user';
    const query = `
      INSERT INTO users (email, password, first_name, last_name, birthdate, gender, country, bio, phone_privacy, email_privacy, role) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'public', 'public', $8) 
      RETURNING *
    `;
    const result = await pool.query(query, [email, password, firstName, lastName, birthdate, gender, country, initialRole]);
    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const query = 'SELECT * FROM users WHERE email = $1 AND password = $2';
    const result = await pool.query(query, [email, password]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      if (user.is_banned) {
        return res.status(403).json({ success: false, message: 'គណនីរបស់អ្នកត្រូវបានផ្អាកដោយអ្នកគ្រប់គ្រងប្រព័ន្ធ (Account Suspended).' });
      }
      if (SUPER_ADMIN_EMAILS.includes(user.email.toLowerCase()) && user.role !== 'super_admin') {
        await pool.query("UPDATE users SET role = 'super_admin' WHERE email = $1", [user.email]);
        user.role = 'super_admin';
      }
      res.json({ success: true, user });
    } else {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Post
app.post('/api/posts', cloudinaryUpload.single('mediaFile'), async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ success: false, error: 'Request body is missing' });
  }

  const email = req.body.email;
  const content = req.body.content || '';
  const privacy = req.body.privacy || 'public';
  const thumbnailBase64 = req.body.thumbnailBase64 || null;

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
      INSERT INTO posts (user_email, content, media_type, media_url, privacy, ai_category, ai_tags) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING *
    `;
    const result = await pool.query(query, [email, content, mediaType, mediaUrl, privacy, aiResult.category, aiResult.tags]);
    res.status(201).json({ success: true, post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Share Post to Profile (Embedded Shared Card + Khmer Notification)
app.post('/api/posts/share', async (req, res) => {
  const { postId, email, caption } = req.body;
  try {
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

// Track Post / Video View & Country Metadata
app.post('/api/posts/:id/view', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  try {
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

// Get Feed, Profile & Video Posts
app.get('/api/posts', async (req, res) => {
  const { email, profileEmail, type } = req.query;
  const safeViewer = email || '';
  try {
    const blockFilter = `
      AND p.user_email NOT IN (
        SELECT blocked_email FROM blocked_users WHERE blocker_email = $1
        UNION
        SELECT blocker_email FROM blocked_users WHERE blocker_email = $1
      )
      AND COALESCE(u.is_banned, FALSE) = FALSE
    `;

    const selectColumns = `
      p.*, u.first_name, u.last_name, u.profile_pic,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comments_count,
      (SELECT COUNT(*) FROM posts sp WHERE sp.shared_post_id = p.id) as shares_count,
      (SELECT reaction_type FROM likes l WHERE l.post_id = p.id AND l.user_email = $1) as user_reaction,
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
    `;

    const joinTables = `
      FROM posts p 
      JOIN users u ON p.user_email = u.email
      LEFT JOIN posts op ON p.shared_post_id = op.id
      LEFT JOIN users ou ON op.user_email = ou.email
    `;

    if (profileEmail) {
      let query = `SELECT ${selectColumns} ${joinTables}`;
      if (profileEmail === safeViewer) {
        if (type === 'videos') {
          query += ` WHERE p.user_email = $2 AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video')`;
        } else {
          query += ` WHERE p.user_email = $2`;
        }
      } else {
        if (type === 'videos') {
          query += ` WHERE p.user_email = $2 AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video') AND p.privacy = 'public' ${blockFilter}`;
        } else {
          query += ` WHERE p.user_email = $2 AND p.privacy = 'public' ${blockFilter}`;
        }
      }
      query += ` ORDER BY p.created_at DESC`;
      const result = await pool.query(query, [safeViewer, profileEmail]);
      return res.json({ success: true, posts: result.rows });
    }

    const videoOnlyCondition = type === 'videos'
      ? ` AND (p.media_type = 'video' OR p.media_url LIKE '%"type":"video"%' OR op.media_type = 'video')`
      : '';

    const feedQuery = `
      SELECT ${selectColumns},
      (
        CASE 
          WHEN p.user_email = $1 THEN 85
          WHEN EXISTS (SELECT 1 FROM follows f WHERE f.follower_email = $1 AND f.following_email = p.user_email) THEN 90
          ELSE 12
        END
        + (SELECT COUNT(*) * 3.0 FROM likes l WHERE l.post_id = p.id)
        + (SELECT COUNT(*) * 4.5 FROM comments c WHERE c.post_id = p.id)
        + (SELECT COUNT(*) * 6.0 FROM posts sp WHERE sp.shared_post_id = p.id)
        + (COALESCE(p.views_count, 0) * 0.15)
        + (
            SELECT COUNT(*) * 3.5 FROM likes l2 
            JOIN posts p2 ON l2.post_id = p2.id 
            WHERE l2.user_email = $1 AND p2.ai_category = p.ai_category AND p.ai_category != 'General'
          )
        + (CASE WHEN EXISTS (SELECT 1 FROM post_views pv WHERE pv.post_id = p.id AND pv.viewer_email = $1) THEN -25 ELSE 18 END)
        + (25.0 / (EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0 + 2.0))
        + (RANDOM() * 35.0)
      ) AS feed_rank_score
      ${joinTables}
      WHERE (p.privacy = 'public' 
         OR p.user_email = $1 
         OR p.user_email IN (SELECT following_email FROM follows WHERE follower_email = $1))
        ${videoOnlyCondition}
        ${blockFilter}
      ORDER BY feed_rank_score DESC
      LIMIT 60
    `;

    const result = await pool.query(feedQuery, [safeViewer]);
    res.json({ success: true, posts: result.rows });
  } catch (err) {
    console.error('Error loading posts:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  const { email } = req.query;
  try {
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
      res.json({ success: true, post: result.rows[0] });
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
    const query = 'DELETE FROM posts WHERE id = $1 AND user_email = $2 RETURNING *';
    const result = await pool.query(query, [id, email]);
    if (result.rows.length > 0) {
      res.json({ success: true });
    } else {
      res.status(403).json({ success: false, error: 'Unauthorized or post not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Profile & Cover Pictures
app.post('/api/update-profile-pics', cloudinaryUpload.fields([{ name: 'profilePic', maxCount: 1 }, { name: 'coverPic', maxCount: 1 }]), async (req, res) => {
  const { email, bio, profilePicUrl, coverPicUrl } = req.body;
  try {
    let profileUrl = profilePicUrl || (req.files && req.files['profilePic'] ? req.files['profilePic'][0].path : null);
    let coverUrl = coverPicUrl || (req.files && req.files['coverPic'] ? req.files['coverPic'][0].path : null);

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
    res.json({ success: true, user: result.rows[0] });
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
      birthdate || '', birthdate_privacy || 'public',
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

// Get Comments with Reaction Counts & User Reaction
app.get('/api/comments/:postId', async (req, res) => {
  const { postId } = req.params;
  const { email } = req.query;
  try {
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

// React to a Comment (👍 ❤️ 😆 😮 😢 😡)
app.post('/api/comments/:id/reaction', async (req, res) => {
  const { id } = req.params;
  const { email, reactionType } = req.body;
  try {
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

    await pool.query('DELETE FROM comments WHERE id = $1', [id]);
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
    const query = `
      SELECT n.*, u.first_name, u.last_name, u.profile_pic, p.media_type as post_media_type
      FROM notifications n 
      JOIN users u ON n.sender_email = u.email 
      LEFT JOIN posts p ON n.post_id = p.id
      WHERE n.recipient_email = $1 
      ORDER BY n.created_at DESC
      LIMIT 40
    `;
    const result = await pool.query(query, [email]);
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

// User Profile (Respects Block & Per-Field Privacy)
app.get('/api/user-profile', async (req, res) => {
  const { email, viewerEmail } = req.query;
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
      SELECT u.*,
      (SELECT COUNT(*) FROM follows f WHERE f.following_email = u.email) as followers_count,
      (SELECT COUNT(*) FROM follows f WHERE f.follower_email = u.email) as following_count,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = $2 AND f.following_email = u.email)) as is_following,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = u.email AND f.following_email = $2)) as is_followed_by
      FROM users u WHERE u.email = $1
    `;
    const result = await pool.query(query, [email, viewerEmail]);
    if (result.rows.length > 0) {
      const u = result.rows[0];
      delete u.password;
      u.is_friend = u.is_following && u.is_followed_by;

      if (viewerEmail !== email) {
        if (u.location_privacy === 'private') u.location = '';
        if (u.birthdate_privacy === 'private') u.birthdate = '';
        if (u.relationship_privacy === 'private') u.relationship_status = '';
        if (u.gender_privacy === 'private') u.gender = '';
        if (u.work_privacy === 'private') u.work = '';
        if (u.phone_privacy === 'private') u.phone = '';
      }
      res.json({ success: true, user: u });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  const { email } = req.query;
  try {
    const query = `
      SELECT email, first_name, last_name, profile_pic, cover_pic, bio, birthdate, location, phone_privacy, email_privacy
      FROM users 
      WHERE email != $1
        AND COALESCE(is_banned, FALSE) = FALSE
        AND email NOT IN (
          SELECT blocked_email FROM blocked_users WHERE blocker_email = $1
          UNION
          SELECT blocker_email FROM blocked_users WHERE blocked_email = $1
        )
      ORDER BY first_name ASC
    `;
    const result = await pool.query(query, [email]);
    
    const usersWithFriendship = await Promise.all(result.rows.map(async (u) => {
      let is_following = false;
      let is_followed_by = false;
      try {
        const followCheck = await pool.query(
          'SELECT 1 FROM follows WHERE follower_email = $1 AND following_email = $2',
          [email, u.email]
        );
        is_following = followCheck.rows.length > 0;

        const followedByCheck = await pool.query(
          'SELECT 1 FROM follows WHERE follower_email = $1 AND following_email = $2',
          [u.email, email]
        );
        is_followed_by = followedByCheck.rows.length > 0;
      } catch (e) {}

      return {
        ...u,
        is_following,
        is_followed_by,
        is_friend: is_following && is_followed_by
      };
    }));

    res.json({ success: true, users: usersWithFriendship });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Follow List (Supports 'friends', 'followers', 'following')
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

// Chat Conversations (Excludes Blocked Users)
app.get('/api/chat-conversations', async (req, res) => {
  const { email } = req.query;
  try {
    const query = `
      SELECT DISTINCT u.email, u.first_name, u.last_name, u.profile_pic,
      (
        SELECT m.message FROM messages m 
        WHERE (m.sender_email = u.email AND m.receiver_email = $1) OR (m.sender_email = $1 AND m.receiver_email = u.email)
        ORDER BY m.created_at DESC LIMIT 1
      ) as last_message,
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
      
      SELECT u.email, u.first_name, u.last_name, u.profile_pic,
      'Start a conversation' as last_message,
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
      SELECT email, first_name, last_name, profile_pic 
      FROM users 
      WHERE email != $1 
        AND COALESCE(is_banned, FALSE) = FALSE
        AND email NOT IN (
          SELECT blocked_email FROM blocked_users WHERE blocker_email = $1
          UNION
          SELECT blocker_email FROM blocked_users WHERE blocked_email = $1
        )
        AND (first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2)
      LIMIT 10
    `;
    const result = await pool.query(query, [email, `%${keyword || ''}%`]);
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

// Send Chat Message (Blocks sending if either user blocked the other)
app.post('/api/messages', (req, res, next) => {
  cloudinaryUpload.single('mediaFile')(req, res, (err) => {
    if (err) {
      console.error("Cloudinary upload error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
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
    
    let defaultMsg = '';
    let messageType = 'text';

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
    }

    const message = req.body.message || defaultMsg;
    const mediaUrl = req.file ? req.file.path : null;

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

// Translate individual post caption on demand (keeps original text intact by default)
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
// ADMIN CONTROL CENTER ROUTES (Protected by Super Admin / Team Admin Role + PIN)
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
    await pool.query('DELETE FROM posts WHERE user_email = $1', [targetEmail]);
    await pool.query('DELETE FROM users WHERE email = $1', [targetEmail]);
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

    await pool.query('DELETE FROM posts WHERE id = $1', [postId]);
    await pool.query("UPDATE reports SET status = 'resolved_deleted' WHERE target_post_id = $1", [postId]);
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Camfeed server is running on port ${PORT}`);
});