/**
 * CamFeed (camfeedkh.com) - Unified R2 Upload, AI Visual/Text Classification & Recommendation Routes
 * Compatible with existing PostgreSQL schema (user_email, SERIAL PRIMARY KEY)
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let ffmpegBin = 'ffmpeg';
try {
  ffmpegBin = require('ffmpeg-static') || 'ffmpeg';
} catch (e) {
  ffmpegBin = 'ffmpeg';
}

function compressVideoBufferOnServer(inputBuffer, originalName) {
  return new Promise((resolve) => {
    const tmpDir = os.tmpdir();
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = path.extname(originalName || '.mp4') || '.mp4';
    const inPath = path.join(tmpDir, `camfeed-in-${uid}${ext}`);
    const outPath = path.join(tmpDir, `camfeed-out-${uid}.mp4`);

    fs.writeFile(inPath, inputBuffer, (writeErr) => {
      if (writeErr) {
        return resolve({ buffer: inputBuffer, contentType: null, compressed: false });
      }

      // Scale max dimension to 720p, H.264 CRF 26 (high visual clarity, ~60-80% smaller size), AAC 128k audio, +faststart for instant streaming
      const args = [
        '-y',
        '-i', inPath,
        '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-c:a', 'aac',
        '-b:a', '128k',
        outPath
      ];

      execFile(ffmpegBin, args, { timeout: 120000 }, (err) => {
        fs.unlink(inPath, () => {});
        if (err || !fs.existsSync(outPath)) {
          fs.unlink(outPath, () => {});
          return resolve({ buffer: inputBuffer, contentType: null, compressed: false });
        }

        fs.readFile(outPath, (readErr, outBuffer) => {
          fs.unlink(outPath, () => {});
          if (readErr || !outBuffer || outBuffer.length === 0 || outBuffer.length >= inputBuffer.length) {
            return resolve({ buffer: inputBuffer, contentType: null, compressed: false });
          }
          resolve({ buffer: outBuffer, contentType: 'video/mp4', compressed: true });
        });
      });
    });
  });
}

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

module.exports = function createVideoRouter(pool) {
  const router = express.Router();

  // 1. Initialize Cloudflare R2 S3 Client
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  // ---------------------------------------------------------------------------
  // 1. Generate Presigned Upload URL (Supports both Images & Videos to R2)
  // POST /api/videos/upload-url
  // Body: { user_email, file_name, content_type }
  // ---------------------------------------------------------------------------
  router.post('/upload-url', async (req, res) => {
    try {
      const { user_email, file_name, content_type } = req.body;
      if (!user_email || !file_name || !content_type) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const folder = content_type.startsWith('image/') ? 'images' : 'videos';
      const r2Key = `${folder}/${Date.now()}-${safeName}`;

      const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME || 'camfeed-storage',
        Key: r2Key,
        ContentType: content_type,
      });

      const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 300 });
      const publicUrl = `${process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com'}/${r2Key}`;

      res.json({ uploadUrl, publicUrl, r2Key });
    } catch (err) {
      console.error('Presigned URL error:', err);
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  });

  // ---------------------------------------------------------------------------
  // 1B. Direct Server-to-R2 Media Upload (Images & Videos - Bypasses Mobile Browser CORS Issues)
  // POST /api/videos/upload-image  &  POST /api/videos/upload-direct
  // ---------------------------------------------------------------------------
  async function handleDirectServerR2Upload(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No media file provided' });
      }

      let mime = req.file.mimetype || 'application/octet-stream';
      const isVideo = mime.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi)$/i.test(req.file.originalname || '');
      const folder = isVideo ? 'videos' : 'images';
      const defaultName = isVideo ? 'video.mp4' : 'photo.jpg';
      let safeName = (req.file.originalname || defaultName).replace(/[^a-zA-Z0-9._-]/g, '_');
      let uploadBuffer = req.file.buffer;
      let wasCompressed = false;

      if (isVideo) {
        const comp = await compressVideoBufferOnServer(req.file.buffer, safeName);
        if (comp.compressed) {
          uploadBuffer = comp.buffer;
          mime = comp.contentType || 'video/mp4';
          safeName = safeName.replace(/\.[^/.]+$/, '') + '.mp4';
          wasCompressed = true;
        }
      }

      const r2Key = `${folder}/${Date.now()}-${safeName}`;

      await r2.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME || 'camfeed-storage',
          Key: r2Key,
          Body: uploadBuffer,
          ContentType: mime,
        })
      );

      const publicUrl = `${process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com'}/${r2Key}`;
      res.json({
        success: true,
        publicUrl,
        r2Key,
        type: isVideo ? 'video' : 'image',
        compressed: wasCompressed,
        finalSize: uploadBuffer.length
      });
    } catch (err) {
      console.error('Direct R2 media upload error:', err);
      res.status(500).json({ error: 'Failed to upload media to R2: ' + err.message });
    }
  }

  router.post('/upload-image', memUpload.single('file'), handleDirectServerR2Upload);
  router.post('/upload-direct', memUpload.single('file'), handleDirectServerR2Upload);

  // ---------------------------------------------------------------------------
  // 2. Save Video Metadata & Trigger AI Moderation + Auto-Classification
  // POST /api/videos/complete
  // Body: { user_email, title, description, r2_key, video_url, thumbnail_url, thumbnailBase64 }
  // ---------------------------------------------------------------------------
  router.post('/complete', async (req, res) => {
    try {
      const {
        user_email,
        title,
        description = '',
        r2_key,
        video_url,
        thumbnail_url = null,
        thumbnailBase64 = null
      } = req.body;

      if (!user_email || !title || !r2_key || !video_url) {
        return res.status(400).json({ error: 'Missing required video fields' });
      }

      const insertResult = await pool.query(
        `INSERT INTO videos (user_email, title, description, r2_key, video_url, thumbnail_url, moderation_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved')
         RETURNING *`,
        [user_email, title, description, r2_key, video_url, thumbnail_url]
      );

      const video = insertResult.rows[0];

      // Run AI classification & safety moderation asynchronously (with visual thumbnail if provided)
      classifyAndModerateVideo(pool, video, thumbnailBase64).catch((err) =>
        console.error(`AI classification failed for video ${video.id}:`, err)
      );

      res.status(201).json({ message: 'Video saved and queued for AI classification', video });
    } catch (err) {
      console.error('Save video error:', err);
      res.status(500).json({ error: 'Failed to save video' });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Track User Behavior & Update Interest Profile
  // POST /api/videos/track
  // Body: { user_email, video_id, watch_duration_sec, video_duration_sec, completed, interaction_type }
  // ---------------------------------------------------------------------------
  router.post('/track', async (req, res) => {
    try {
      const {
        user_email,
        video_id,
        watch_duration_sec = 0,
        video_duration_sec = 0,
        completed = false,
        interaction_type = 'view',
      } = req.body;

      if (!user_email || !video_id) {
        return res.status(400).json({ error: 'user_email and video_id are required' });
      }

      // Log raw interaction
      await pool.query(
        `INSERT INTO user_video_logs (user_email, video_id, watch_duration_sec, video_duration_sec, completed, interaction_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user_email, video_id, watch_duration_sec, video_duration_sec, completed, interaction_type]
      );

      // Update video counters
      if (interaction_type === 'view') {
        await pool.query(`UPDATE videos SET views_count = views_count + 1 WHERE id = $1`, [video_id]);
      } else if (interaction_type === 'like') {
        await pool.query(`UPDATE videos SET likes_count = likes_count + 1 WHERE id = $1`, [video_id]);
      }

      // Calculate interest weight
      const videoRes = await pool.query(`SELECT category FROM videos WHERE id = $1`, [video_id]);
      if (videoRes.rows.length > 0) {
        const category = videoRes.rows[0].category;
        const retention = video_duration_sec > 0 ? watch_duration_sec / video_duration_sec : 0;

        let delta = 0;
        if (interaction_type === 'like') delta = 5;
        else if (interaction_type === 'save' || interaction_type === 'share') delta = 8;
        else if (interaction_type === 'skip' || (interaction_type === 'view' && watch_duration_sec < 2 && video_duration_sec > 5)) {
          delta = -3;
        } else if (completed || retention >= 0.7) {
          delta = 4;
        } else if (interaction_type === 'view') {
          delta = 1;
        }

        if (delta !== 0 && category) {
          await pool.query(
            `INSERT INTO user_interest_scores (user_email, category, score, updated_at)
             VALUES ($1, $2, GREATEST(0, $3), NOW())
             ON CONFLICT (user_email, category)
             DO UPDATE SET
               score = GREATEST(0, user_interest_scores.score + $3),
               updated_at = NOW()`,
            [user_email, category, delta]
          );
        }
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Track interaction error:', err);
      res.status(500).json({ error: 'Failed to track interaction' });
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Personalized Recommendation Feed
  // GET /api/videos/feed?user_email=...&limit=20&offset=0
  // ---------------------------------------------------------------------------
  router.get('/feed', async (req, res) => {
    try {
      const { user_email = '', limit = 20, offset = 0 } = req.query;
      const parsedLimit = Math.min(parseInt(limit, 10) || 20, 50);
      const parsedOffset = parseInt(offset, 10) || 0;

      const feedQuery = `
        SELECT
          v.*,
          u.first_name,
          u.last_name,
          u.profile_pic AS author_profile_pic,
          COALESCE(uis.score, 0) AS category_affinity,
          CASE WHEN f.id IS NOT NULL THEN 15 ELSE 0 END AS following_boost,
          (
            (COALESCE(uis.score, 0) * 2.5)
            + (CASE WHEN f.id IS NOT NULL THEN 15 ELSE 0 END)
            + (LN(GREATEST(v.likes_count, 1)) * 3.0)
            + (LN(GREATEST(v.views_count, 1)) * 1.5)
            + (10.0 / (EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600.0 + 2.0))
            + (RANDOM() * 6.0)
          ) AS recommendation_score
        FROM videos v
        LEFT JOIN users u ON u.email = v.user_email
        LEFT JOIN user_interest_scores uis
          ON uis.user_email = $1 AND uis.category = v.category
        LEFT JOIN follows f
          ON f.follower_email = $1 AND f.following_email = v.user_email
        WHERE v.moderation_status = 'approved'
        ORDER BY recommendation_score DESC, v.created_at DESC
        LIMIT $2 OFFSET $3
      `;

      const result = await pool.query(feedQuery, [user_email, parsedLimit, parsedOffset]);
      res.json({ success: true, videos: result.rows });
    } catch (err) {
      console.error('Feed error:', err);
      res.status(500).json({ error: 'Failed to fetch recommendation feed' });
    }
  });

  return router;
};

// =============================================================================
// Helper: Gemini AI Moderation & Auto-Classification (Text + Visual Frame)
// =============================================================================
async function classifyAndModerateVideo(pool, video, thumbnailBase64) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    await pool.query(
      `UPDATE videos SET moderation_status = 'approved', category = 'General' WHERE id = $1`,
      [video.id]
    );
    return;
  }

  const prompt = `Analyze this video post for a Cambodian social video platform (CamFeed).
Title: "${video.title}"
Description: "${video.description || ''}"

Tasks:
1. Content Moderation: Check if the content promotes explicit pornography, severe violence, or illegal content. Set status to "rejected" if unsafe, otherwise "approved".
2. Category: Classify into ONE primary category from:
   ["Comedy", "Music", "Gaming", "Food", "Vehicles & Motorcycles", "Technology", "News", "Sports", "Education", "Travel", "Lifestyle", "General"]
3. Tags: Extract 3 to 5 concise lowercase tags (English or Khmer).

Respond ONLY with valid JSON:
{"moderation_status": "approved", "category": "...", "tags": ["...", "..."]}`;

  const parts = [{ text: prompt }];
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
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) return;

  const parsed = JSON.parse(rawText);
  const status = parsed.moderation_status === 'rejected' ? 'rejected' : 'approved';
  const category = parsed.category || 'General';
  const tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [];

  await pool.query(
    `UPDATE videos
     SET moderation_status = $1, category = $2, tags = $3
     WHERE id = $4`,
    [status, category, tags, video.id]
  );
}