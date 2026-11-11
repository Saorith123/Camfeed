const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

// នាំចូល Cloudinary configurations ពី file cloudinary.js របស់យើង
const { cloudinary, upload: cloudinaryUpload } = require('./cloudinary');

const app = express();
app.use(express.json());

// កំណត់ Path សម្រាប់ public folder និង Root Route យ៉ាងសុវត្ថិភាព
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) return console.error('Error connecting to Database:', err.stack);
  console.log('Database connected successfully to Supabase for Camfeed!');
  release();
});

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, firstName, lastName, birthdate, gender, country } = req.body;
  try {
    const query = `
      INSERT INTO users (email, password, first_name, last_name, birthdate, gender, country, bio, phone_privacy, email_privacy) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'public', 'public') 
      RETURNING *
    `;
    const result = await pool.query(query, [email, password, firstName, lastName, birthdate, gender, country]);
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
      res.json({ success: true, user: result.rows[0] });
    } else {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Post (ភ្ជាប់ជាមួយ Cloudinary ຜ່ານ cloudinaryUpload)
app.post('/api/posts', cloudinaryUpload.single('mediaFile'), async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ success: false, error: 'Request body is missing' });
  }

  const email = req.body.email;
  const content = req.body.content || '';
  const privacy = req.body.privacy || 'public';
  
  const mediaUrl = req.file ? req.file.path : (req.body.mediaUrl || null);
  const mediaType = req.file ? (req.file.mimetype && req.file.mimetype.startsWith('video') ? 'video' : 'image') : (req.body.mediaType || 'text');

  try {
    const query = 'INSERT INTO posts (user_email, content, media_type, media_url, privacy) VALUES ($1, $2, $3, $4, $5) RETURNING *';
    const result = await pool.query(query, [email, content, mediaType, mediaUrl, privacy]);
    res.status(201).json({ success: true, post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Feed & Profile Posts
app.get('/api/posts', async (req, res) => {
  const { email, profileEmail, type } = req.query;
  try {
    let query = `
      SELECT p.*, u.first_name, u.last_name, u.profile_pic,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comments_count,
      (SELECT reaction_type FROM likes l WHERE l.post_id = p.id AND l.user_email = $1) as user_reaction
      FROM posts p 
      JOIN users u ON p.user_email = u.email
    `;
    let params = [email];

    if (profileEmail) {
      if (profileEmail === email) {
        if (type === 'videos') {
          query += ` WHERE p.user_email = $2 AND p.media_type = 'video'`;
        } else {
          query += ` WHERE p.user_email = $2`;
        }
      } else {
        if (type === 'videos') {
          query += ` WHERE p.user_email = $2 AND p.media_type = 'video' AND p.privacy = 'public'`;
        } else {
          query += ` WHERE p.user_email = $2 AND p.privacy = 'public'`;
        }
      }
      params.push(profileEmail);
    } else {
      query += ` WHERE p.privacy = 'public' OR p.user_email = $1 OR p.user_email IN (SELECT following_email FROM follows WHERE follower_email = $1)`;
    }

    query += ` ORDER BY p.created_at DESC`;
    const result = await pool.query(query, params);
    res.json({ success: true, posts: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Single Post by ID
app.get('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  const { email } = req.query;
  try {
    const query = `
      SELECT p.*, u.first_name, u.last_name, u.profile_pic,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comments_count,
      (SELECT reaction_type FROM likes l WHERE l.post_id = p.id AND l.user_email = $2) as user_reaction
      FROM posts p 
      JOIN users u ON p.user_email = u.email
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

// Edit Post
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

// Delete Post
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

// Update Profile & Cover Pictures & Bio
app.post('/api/update-profile-pics', cloudinaryUpload.fields([{ name: 'profilePic', maxCount: 1 }, { name: 'coverPic', maxCount: 1 }]), async (req, res) => {
  const { email, bio } = req.body;
  try {
    let profileUrl = req.files && req.files['profilePic'] ? req.files['profilePic'][0].path : null;
    let coverUrl = req.files && req.files['coverPic'] ? req.files['coverPic'][0].path : null;

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

// Update Profile Details (Dob, Location, Privacy)
app.post('/api/update-profile-details', async (req, res) => {
  const { email, birthdate, location, phone_privacy, email_privacy } = req.body;
  try {
    const query = `
      UPDATE users 
      SET birthdate = $1, location = $2, phone_privacy = $3, email_privacy = $4 
      WHERE email = $5 
      RETURNING *
    `;
    const result = await pool.query(query, [birthdate, location, phone_privacy, email_privacy, email]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reaction / Like API
app.post('/api/reaction', async (req, res) => {
  const { postId, email, reactionType } = req.body;
  try {
    const check = await pool.query('SELECT * FROM likes WHERE post_id = $1 AND user_email = $2', [postId, email]);
    const postInfo = await pool.query('SELECT p.user_email, u.first_name, u.last_name FROM posts p JOIN users u ON u.email = $2 WHERE p.id = $1', [postId, email]);
    const ownerEmail = postInfo.rows[0]?.user_email;
    const likerName = `${postInfo.rows[0]?.first_name} ${postInfo.rows[0]?.last_name}`;

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
        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, post_id, type, message) VALUES ($1, $2, $3, $4, $5)',
          [ownerEmail, email, postId, 'reaction', `${likerName} reacted ${reactionType || '👍'} to your post.`]
        );
      }
    }

    const countRes = await pool.query('SELECT COUNT(*) FROM likes WHERE post_id = $1', [postId]);
    res.json({ success: true, reacted, likes_count: countRes.rows[0].count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API ទាញយកបញ្ជីរាយនាម Reactors
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

// Get Comments for Post
app.get('/api/comments/:postId', async (req, res) => {
  const { postId } = req.params;
  try {
    const query = `
      SELECT c.*, u.first_name, u.last_name, u.profile_pic 
      FROM comments c 
      JOIN users u ON c.user_email = u.email 
      WHERE c.post_id = $1 
      ORDER BY c.created_at ASC
    `;
    const result = await pool.query(query, [postId]);
    res.json({ success: true, comments: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add Comment or Reply
app.post('/api/comments', async (req, res) => {
  const { postId, email, content, replyToCommentId } = req.body;
  try {
    const query = 'INSERT INTO comments (post_id, user_email, content, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING *';
    const result = await pool.query(query, [postId, email, content, replyToCommentId || null]);
    const newComment = result.rows[0];

    const userInfo = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [email]);
    const commenterName = `${userInfo.rows[0]?.first_name} ${userInfo.rows[0]?.last_name}`;

    if (replyToCommentId) {
      const parentCommentInfo = await pool.query('SELECT user_email FROM comments WHERE id = $1', [replyToCommentId]);
      const parentAuthorEmail = parentCommentInfo.rows[0]?.user_email;

      if (parentAuthorEmail && parentAuthorEmail !== email) {
        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, post_id, comment_id, type, message) VALUES ($1, $2, $3, $4, $5, $6)',
          [parentAuthorEmail, email, postId, newComment.id, 'reply', `${commenterName} replied to your comment: "${content}"`]
        );
      }
    } else {
      const postInfo = await pool.query('SELECT user_email FROM posts WHERE id = $1', [postId]);
      const ownerEmail = postInfo.rows[0]?.user_email;

      if (ownerEmail && ownerEmail !== email) {
        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, post_id, comment_id, type, message) VALUES ($1, $2, $3, $4, $5, $6)',
          [ownerEmail, email, postId, newComment.id, 'comment', `${commenterName} commented on your post: "${content}"`]
        );
      }
    }

    res.json({ success: true, comment: newComment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Notifications
app.get('/api/notifications', async (req, res) => {
  const { email } = req.query;
  try {
    const query = `
      SELECT n.*, u.first_name, u.last_name, u.profile_pic 
      FROM notifications n 
      JOIN users u ON n.sender_email = u.email 
      WHERE n.recipient_email = $1 
      ORDER BY n.created_at DESC
    `;
    const result = await pool.query(query, [email]);
    res.json({ success: true, notifications: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🎯 API សម្រាប់ទាញយក Profile របស់ User ផ្ទាល់ខ្លួន ឬមិត្តភក្តិដោយចំគោលដៅ
app.get('/api/user-profile', async (req, res) => {
  const { email, viewerEmail } = req.query;
  try {
    const query = `
      SELECT u.email, u.first_name, u.last_name, u.profile_pic, u.cover_pic, u.bio, u.birthdate, u.location, u.phone, u.phone_privacy, u.email_privacy,
      (SELECT COUNT(*) FROM follows f WHERE f.following_email = u.email) as followers_count,
      (SELECT COUNT(*) FROM follows f WHERE f.follower_email = u.email) as following_count,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = $2 AND f.following_email = u.email)) as is_following,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = u.email AND f.following_email = $2)) as is_followed_by
      FROM users u WHERE u.email = $1
    `;
    const result = await pool.query(query, [email, viewerEmail]);
    if (result.rows.length > 0) {
      const u = result.rows[0];
      u.is_friend = u.is_following && u.is_followed_by;
      res.json({ success: true, user: u });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get All Users with Followers, Following counts & Mutual Friend status
app.get('/api/users', async (req, res) => {
  const { email } = req.query;
  try {
    const query = `
      SELECT u.email, u.first_name, u.last_name, u.profile_pic, u.cover_pic, u.bio, u.birthdate, u.location, u.phone_privacy, u.email_privacy,
      (SELECT COUNT(*) FROM follows f WHERE f.following_email = u.email) as followers_count,
      (SELECT COUNT(*) FROM follows f WHERE f.follower_email = u.email) as following_count,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = $1 AND f.following_email = u.email)) as is_following,
      (EXISTS(SELECT 1 FROM follows f WHERE f.follower_email = u.email AND f.following_email = $1)) as is_followed_by
      FROM users u WHERE u.email != $1
    `;
    const result = await pool.query(query, [email]);
    
    const usersWithFriendship = result.rows.map(u => ({
      ...u,
      is_friend: u.is_following && u.is_followed_by
    }));

    res.json({ success: true, users: usersWithFriendship });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Followers or Following List
app.get('/api/follow-list', async (req, res) => {
  const { email, type } = req.query; // type = 'followers' ឬ 'following'
  try {
    let query = '';
    if (type === 'followers') {
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
    const result = await pool.query(query, [email, email]);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Follow / Unfollow with Notification
app.post('/api/follow', async (req, res) => {
  const { followerEmail, followingEmail, action } = req.body;
  try {
    const userInfo = await pool.query('SELECT first_name, last_name FROM users WHERE email = $1', [followerEmail]);
    const followerName = `${userInfo.rows[0]?.first_name} ${userInfo.rows[0]?.last_name}`;

    if (action === 'follow') {
      await pool.query('INSERT INTO follows (follower_email, following_email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [followerEmail, followingEmail]);
      if (followerEmail !== followingEmail) {
        await pool.query(
          'INSERT INTO notifications (recipient_email, sender_email, type, message) VALUES ($1, $2, $3, $4)',
          [followingEmail, followerEmail, 'follow', `${followerName} started following you.`]
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

// Messages / Chat APIs
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

app.post('/api/messages', async (req, res) => {
  const { sender, receiver, message } = req.body;
  try {
    const query = 'INSERT INTO messages (sender_email, receiver_email, message) VALUES ($1, $2, $3) RETURNING *';
    const result = await pool.query(query, [sender, receiver, message]);
    res.status(201).json({ success: true, message: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Camfeed server is running on port ${PORT}`);
});