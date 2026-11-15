// Saves a finished Live as a normal video post, cheaply:
//   Cloudflare Stream records the live -> we download the MP4 -> shrink it to <=720p (ffmpeg) -> keep it in R2 ->
//   post it on the host's profile -> delete it from Stream (Stream charges per minute stored, R2 is ~30x cheaper).
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), { execFile } = require('child_process');
const { Readable } = require('stream'), { pipeline } = require('stream/promises');

module.exports = function createLiveReplay(deps) {
  const { pool, cf, putFile, publicBase, ffmpegBin, fetchFn } = deps;
  const doFetch = fetchFn || fetch;
  const MAX_WAIT_MS = 45 * 60 * 1000;          // give up (and clean Stream) after this long
  const MIN_SECS = 15;                          // shorter lives are not worth saving
  let running = false;

  const enabled = () => String(process.env.LIVE_SAVE_REPLAY || 'on').toLowerCase() !== 'off';

  async function ensureSchema() {
    await pool.query("ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS replay_status VARCHAR(10)").catch(() => {});
    await pool.query("ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS replay_post_id INTEGER").catch(() => {});
    await pool.query("ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS replay_tries INTEGER NOT NULL DEFAULT 0").catch(() => {});
  }

  function run(bin, args, timeout) {
    return new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => e ? reject(new Error(String(se || e.message).slice(-300))) : resolve(so)));
  }

  async function cleanStream(row, videoUid) {
    if (videoUid) await cf('DELETE', '/' + encodeURIComponent(videoUid)).catch(() => {});
    if (row.cf_uid) await cf('DELETE', '/live_inputs/' + encodeURIComponent(row.cf_uid)).catch(() => {});
  }

  async function finish(row, status) {
    await pool.query('UPDATE live_streams SET replay_status = $2 WHERE id = $1', [row.id, status]).catch(() => {});
  }

  async function processOne(row) {
    const age = Date.now() - new Date(row.ended_at).getTime();
    if (age < 20 * 1000) return;
    let list = [];
    try { list = await cf('GET', '/live_inputs/' + encodeURIComponent(row.cf_uid) + '/videos'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = list && Array.isArray(list.videos) ? list.videos : [];
    const vids = list.filter((v) => v && v.uid);
    const video = vids.sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0))[0];
    if (!video) { if (age > MAX_WAIT_MS) { await cleanStream(row, null); await finish(row, 'failed'); } return; }
    const state = video.status && video.status.state;
    if (state === 'error') { await cleanStream(row, video.uid); await finish(row, 'failed'); return; }
    if (state !== 'ready') { if (age > MAX_WAIT_MS) { await cleanStream(row, video.uid); await finish(row, 'failed'); } return; }
    if (!(Number(video.duration) >= MIN_SECS)) { await cleanStream(row, video.uid); await finish(row, 'skipped'); return; }

    // ask Cloudflare for an MP4 and wait for it
    let dl = null;
    try { dl = await cf('POST', '/' + encodeURIComponent(video.uid) + '/downloads', {}); } catch (e) { try { dl = await cf('GET', '/' + encodeURIComponent(video.uid) + '/downloads'); } catch (e2) { dl = null; } }
    let d = dl && dl.default;
    if (!d || d.status !== 'ready') { try { const g = await cf('GET', '/' + encodeURIComponent(video.uid) + '/downloads'); d = g && g.default; } catch (e) {} }
    if (!d || d.status !== 'ready' || !d.url) { if (age > MAX_WAIT_MS) { await cleanStream(row, video.uid); await finish(row, 'failed'); } return; }

    const tmp = path.join(os.tmpdir(), 'camfeed-replay-' + row.id + '-' + crypto.randomBytes(4).toString('hex'));
    const src = tmp + '-src.mp4', out = tmp + '-out.mp4';
    try {
      const r = await doFetch(d.url); if (!r.ok || !r.body) throw new Error('download ' + r.status);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(src));
      const size = fs.statSync(src).size, dur = Number(video.duration) || 1, kbps = size * 8 / dur / 1000;
      let final = src;
      if (String(process.env.LIVE_REPLAY_TRANSCODE || 'on').toLowerCase() !== 'off' && kbps > 1800) {
        await run(ffmpegBin, ['-y', '-i', src, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '1500k', '-bufsize', '3000k', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], 55 * 60 * 1000);
        if (fs.existsSync(out) && fs.statSync(out).size > 0 && fs.statSync(out).size < size) final = out;
      }
      const key = 'videos/live-' + row.id + '-' + Date.now() + '.mp4';
      await putFile(key, final, 'video/mp4');
      const url = publicBase() + '/' + key;
      const title = String(row.title || '').trim();
      const content = '🔴 Live' + (title ? ' · ' + title : '');
      let thumb = null; try { thumb = deps.makeThumb ? await deps.makeThumb(final) : null; } catch (e) {}
      const p = await pool.query("INSERT INTO posts (user_email, content, media_type, media_url, privacy, thumb_url) VALUES ($1, $2, 'video', $3, $4, $5) RETURNING id", [row.host_email, content, url, row.privacy === 'friends' ? 'friends' : 'public', thumb]);
      // the chat of the live becomes the comments of the saved video (like Facebook)
      try {
        await pool.query("INSERT INTO comments (post_id, user_email, content, created_at) SELECT $2, user_email, body, created_at FROM live_comments WHERE live_id = $1 ORDER BY id LIMIT 5000", [row.id, p.rows[0].id]);
      } catch (e1) {
        try { await pool.query("INSERT INTO comments (post_id, user_email, content) SELECT $2, user_email, body FROM live_comments WHERE live_id = $1 ORDER BY id LIMIT 5000", [row.id, p.rows[0].id]); } catch (e2) { console.error('[live-replay] comments copy:', e2.message); }
      }
      await pool.query("UPDATE live_streams SET replay_status = 'done', replay_post_id = $2 WHERE id = $1", [row.id, p.rows[0].id]);
      await cleanStream(row, video.uid);
    } catch (e) {
      console.error('[live-replay] job', row.id, e.message);
      const tries = (row.replay_tries || 0) + 1;
      await pool.query('UPDATE live_streams SET replay_tries = $2 WHERE id = $1', [row.id, tries]).catch(() => {});
      if (tries >= 4 || age > MAX_WAIT_MS) { await cleanStream(row, video.uid); await finish(row, 'failed'); }
    } finally { for (const f of [src, out]) { try { fs.unlinkSync(f); } catch (e) {} } }
  }

  async function processAll() {
    if (running || !enabled()) return; running = true;
    try {
      const r = await pool.query("SELECT id, host_email, title, privacy, cf_uid, ended_at, replay_tries FROM live_streams WHERE replay_status = 'pending' AND cf_uid IS NOT NULL ORDER BY ended_at LIMIT 3");
      for (const row of r.rows) await processOne(row);
    } catch (e) { console.error('[live-replay] error:', e.message); } finally { running = false; }
  }
  return { enabled, ensureSchema, processAll, processOne };
};
