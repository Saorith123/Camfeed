/**
 * CamFeed (camfeedkh.com) - Unified R2 Upload, AI Visual/Text Classification & Recommendation Routes
 * Compatible with existing PostgreSQL schema (user_email, SERIAL PRIMARY KEY)
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let ffmpegBin = 'ffmpeg';
try {
  ffmpegBin = require('ffmpeg-static') || 'ffmpeg';
} catch (e) {
  ffmpegBin = 'ffmpeg';
}

function compressVideoBufferOnServer(inputBuffer, originalName) {
  return new Promise((resolve) => {
    if (!inputBuffer || inputBuffer.length <= 15 * 1024 * 1024) {
      return resolve({ buffer: inputBuffer, contentType: null, compressed: false });
    }

    const tmpDir = os.tmpdir();
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = path.extname(originalName || '.mp4') || '.mp4';
    const inPath = path.join(tmpDir, `camfeed-in-${uid}${ext}`);
    const outPath = path.join(tmpDir, `camfeed-out-${uid}.mp4`);

    fs.writeFile(inPath, inputBuffer, (writeErr) => {
      if (writeErr) {
        return resolve({ buffer: inputBuffer, contentType: null, compressed: false });
      }

      const args = [
        '-y',
        '-threads', '1',
        '-i', inPath,
        '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '27',
        '-maxrate', '1800k',
        '-bufsize', '2000k',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-c:a', 'aac',
        '-b:a', '96k',
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

// ---------------------------------------------------------------------------
// Upload safety: only pictures, videos and voice messages. Never web pages, scripts, SVG or programs
// (a web page stored on our media address would be shown under our name).
// ---------------------------------------------------------------------------
const ALLOWED_UPLOAD = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v', 'video/3gpp': '3gp',
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac'
};
const EXT_TO_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac' };
// -> the real kind of file, or null when it is not allowed. A phone that does not name the type is accepted only when the file ending is a known one.
function resolveUploadType(fileName, contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();       // "audio/webm;codecs=opus" -> "audio/webm"
  if (ALLOWED_UPLOAD[base]) return base;
  if (!base || base === 'application/octet-stream') {
    const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
    return EXT_TO_MIME[ext] || null;
  }
  return null;
}
const R2_KEY_RE = /^(images|videos)\/\d{10,16}-(?:[0-9a-f]{8}-)?[A-Za-z0-9._-]{1,200}$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
let directUploadsRunning = 0;                                                       // direct uploads are held in memory: only a few at once
const MAX_DIRECT_UPLOADS = 3;

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => cb(null, !!resolveUploadType(file.originalname, file.mimetype)),
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
  // ---------------------------------------------------------------------------
  router.post('/upload-url', async (req, res) => {
    try {
      const { user_email, file_name, content_type } = req.body;
      if (!user_email || !file_name || !content_type) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (typeof file_name !== 'string' || typeof content_type !== 'string' || file_name.length > 300 || content_type.length > 100) {
        return res.status(400).json({ error: 'Invalid file information' });
      }
      const kind = resolveUploadType(file_name, content_type);
      if (!kind) {
        return res.status(400).json({ success: false, error: 'This file type is not allowed. You can upload pictures, videos and voice messages.' });
      }

      // the file ending is always the one that belongs to the real kind of file (never .html, .svg, .js ...)
      const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[A-Za-z0-9]{1,6}$/, '').slice(-100) + '.' + ALLOWED_UPLOAD[kind];
      const folder = kind.startsWith('image/') ? 'images' : 'videos';
      const r2Key = `${folder}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;

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
  // 1B. Direct Server-to-R2 Media Upload (Images & Videos)
  // ---------------------------------------------------------------------------
  async function handleDirectServerR2Upload(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No media file, or this file type is not allowed. You can upload pictures, videos and voice messages.' });
      }
      const kind = resolveUploadType(req.file.originalname, req.file.mimetype);
      if (!kind) return res.status(400).json({ success: false, error: 'This file type is not allowed.' });
      if (kind.startsWith('image/') && req.file.size > MAX_IMAGE_BYTES) return res.status(413).json({ success: false, error: 'This picture is too large (15 MB at most).' });
      if (directUploadsRunning >= MAX_DIRECT_UPLOADS) return res.status(503).json({ success: false, error: 'The server is busy. Please try again in a moment.' });
      directUploadsRunning++;
      try {

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

      const r2Key = `${folder}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;

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
      } finally {
        directUploadsRunning--;
      }
    } catch (err) {
      console.error('Direct R2 media upload error:', err);
      res.status(500).json({ error: 'Failed to upload media.' });
    }
  }

  router.post('/upload-image', memUpload.single('file'), handleDirectServerR2Upload);
  router.post('/upload-direct', memUpload.single('file'), handleDirectServerR2Upload);

  // ---------------------------------------------------------------------------
  // 2. Save Video Metadata & Trigger AI Moderation + Auto-Classification
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
      // the stored file name must be one of ours and must be the file behind the link (nobody can point a video at someone else's file)
      if (!R2_KEY_RE.test(String(r2_key)) || !String(video_url).endsWith('/' + r2_key)) {
        return res.status(400).json({ error: 'Invalid video file' });
      }

      const insertResult = await pool.query(
        `INSERT INTO videos (user_email, title, description, r2_key, video_url, thumbnail_url, moderation_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved')
         RETURNING *`,
        [user_email, title, description, r2_key, video_url, thumbnail_url]
      );

      const video = insertResult.rows[0];

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

      await pool.query(
        `INSERT INTO user_video_logs (user_email, video_id, watch_duration_sec, video_duration_sec, completed, interaction_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user_email, video_id, watch_duration_sec, video_duration_sec, completed, interaction_type]
      );

      if (interaction_type === 'view') {
        await pool.query(`UPDATE videos SET views_count = views_count + 1 WHERE id = $1`, [video_id]);
      } else if (interaction_type === 'like') {
        await pool.query(`UPDATE videos SET likes_count = likes_count + 1 WHERE id = $1`, [video_id]);
      }

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
  // ---------------------------------------------------------------------------
  router.get('/feed', async (req, res) => {
    try {
      const { user_email = '', limit = 20, offset = 0 } = req.query;
      const parsedLimit = Math.min(parseInt(limit, 10) || 20, 50);
      const parsedOffset = parseInt(offset, 10) || 0;

      // first page = newest videos first; further pages = the mixed recommendation stream (VIDEO_FEED_MODE=latest / ranked forces one way)
      const useLatest = process.env.VIDEO_FEED_MODE === 'latest' || (process.env.VIDEO_FEED_MODE !== 'ranked' && parsedOffset === 0);
      const videoOrder = useLatest ? 'v.created_at DESC, v.id DESC' : 'recommendation_score DESC, v.created_at DESC';
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
        ORDER BY ${videoOrder}
        LIMIT $2 OFFSET $3
      `;

      const result = await pool.query(feedQuery, [user_email, parsedLimit, parsedOffset]);
      res.json({ success: true, videos: result.rows });
    } catch (err) {
      console.error('Feed error:', err);
      res.status(500).json({ error: 'Failed to fetch recommendation feed' });
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Auto-Delete Media Files from Cloudflare R2 Storage
  // ---------------------------------------------------------------------------
  async function deleteR2ObjectsFromMedia(mediaUrlRaw) {
    if (!mediaUrlRaw || typeof mediaUrlRaw !== 'string') return;
    const publicBase = (process.env.R2_PUBLIC_URL || 'https://media.camfeedkh.com').replace(/\/$/, '');
    const bucket = process.env.R2_BUCKET_NAME || 'camfeed-storage';
    const urls = [];

    const trimmed = mediaUrlRaw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          arr.forEach(it => { if (it && it.url) urls.push(it.url); });
        }
      } catch (e) {}
    } else if (trimmed.startsWith('http')) {
      urls.push(trimmed);
    }

    for (const u of urls) {
      try {
        const cleanUrl = u.split('#')[0].split('?')[0];
        let key = '';
        if (cleanUrl.startsWith(publicBase + '/')) {
          key = cleanUrl.slice((publicBase + '/').length);
        } else {
          const parsed = new URL(cleanUrl);
          if (parsed.hostname.includes('camfeedkh.com') || parsed.hostname.includes('r2.dev') || parsed.hostname.includes('r2.cloudflarestorage.com')) {
            key = parsed.pathname.replace(/^\//, '');
          }
        }
        if (key && (key.startsWith('videos/') || key.startsWith('images/') || key.startsWith('audio/'))) {
          await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: decodeURIComponent(key) }));
          if (key.startsWith('videos/')) {
            await pool.query('DELETE FROM videos WHERE r2_key = $1 OR video_url LIKE $2', [key, `%${key}%`]).catch(() => {});
          }
          console.log('[R2 Storage] Deleted file:', key);
        }
      } catch (err) {
        console.error('[R2 Storage] Delete skipped/error:', err.message);
      }
    }
  }

  router.deleteR2ObjectsFromMedia = deleteR2ObjectsFromMedia;

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

module.exports.resolveUploadType = resolveUploadType;
module.exports.R2_KEY_RE = R2_KEY_RE;
