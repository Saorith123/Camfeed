// 🔍 Views that are real. Two kinds:
//   • a shown view (the number under a video): watched ≥ 3 s, the owner never counts, one person = 1 view per post per 24 h.
//   • a PAID view (Creator earnings): watched ≥ 10 s (a short video: half of it, at least 5 s), one person = 1 paid view per post for ever,
//     the viewer's account ≥ 7 days old and not banned, one phone / one IP ≤ 3 paid views per post per day.
// The app asks for a ticket when a video starts (/view/start) and reports the watched time (/view/end). The server only believes
// the time that really passed since the ticket, so a tool can not say "watched 60 s" after 2 s.
// A person counting more than 300 views an hour is stopped and shown to the Admin. A post whose views jump in an unusual way
// (mostly new accounts, one IP, almost no likes / comments) is put on hold: its new paid views wait until the Admin decides.
// Paid views are paid only after 7 days (time to find a cheat before the money leaves).
// Every number: Admin › Monetization › 🔍 Views check (creator_settings 'viewguard').
const crypto = require('crypto');
const norm = (e) => String(e || '').trim().toLowerCase();

const DEFAULTS = {
  shownSec: 3, shownHours: 24,
  paidSec: 10, shortPct: 50, shortMinSec: 5,
  minAgeDays: 7, perDevice: 3, perHour: 300, holdDays: 7,
  spike: { minHour: 200, newPct: 60, ipPct: 30, engagePct: 0.5 },
};

module.exports = function installViewGuard({ app, pool, guardPost, adminGate, audit, sendAdminNotice }) {
  const SECRET = String(process.env.VIEW_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
  let ready = null, cfg = null, cfgAt = 0;

  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query('CREATE TABLE IF NOT EXISTS creator_settings (key VARCHAR(40) PRIMARY KEY, value TEXT)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_post_views_seen ON post_views (post_id, viewer_email, created_at)').catch(() => {});
        // one paid view per person per post (for ever); status ok / held (waits for the Admin) / removed (fake)
        await pool.query(`CREATE TABLE IF NOT EXISTS paid_views (post_id INTEGER NOT NULL, viewer_email TEXT NOT NULL, owner_email TEXT NOT NULL,
          device TEXT, ip TEXT, watched_ms INTEGER NOT NULL DEFAULT 0, status VARCHAR(8) NOT NULL DEFAULT 'ok',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (post_id, viewer_email))`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_paid_views_owner ON paid_views (owner_email, status, created_at)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_paid_views_post_day ON paid_views (post_id, created_at)');
        // things the Admin should look at: a post whose views jumped, or a person counting too many views
        await pool.query(`CREATE TABLE IF NOT EXISTS view_reviews (id SERIAL PRIMARY KEY, kind VARCHAR(8) NOT NULL, post_id INTEGER, user_email TEXT,
          reason TEXT NOT NULL DEFAULT '', facts JSONB, status VARCHAR(10) NOT NULL DEFAULT 'open', decided_by TEXT, decided_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_view_reviews_open ON view_reviews (status, kind)');
        // posts the Admin said are fine: not put on hold again for a while
        await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS views_trusted_until TIMESTAMPTZ');
        // once: earnings start counting the new paid views from today (the old counts are not mixed in)
        const done = await pool.query("SELECT 1 FROM creator_settings WHERE key = 'viewguard:start'");
        if (!done.rows.length) {
          await pool.query('UPDATE post_earn SET views_seen = 0').catch(() => {});
          await pool.query("INSERT INTO creator_settings (key, value) VALUES ('viewguard:start', $1) ON CONFLICT (key) DO NOTHING", [String(Date.now())]);
        }
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  function clean(raw) {
    const r = raw && typeof raw === 'object' ? raw : {}, o = JSON.parse(JSON.stringify(DEFAULTS)), s = r.spike || {};
    o.shownSec = num(r.shownSec, 1, 60, 3); o.shownHours = num(r.shownHours, 1, 720, 24);
    o.paidSec = num(r.paidSec, 3, 600, 10); o.shortPct = num(r.shortPct, 10, 100, 50); o.shortMinSec = num(r.shortMinSec, 1, 60, 5);
    o.minAgeDays = num(r.minAgeDays, 0, 365, 7); o.perDevice = num(r.perDevice, 1, 100, 3); o.perHour = num(r.perHour, 10, 10000, 300); o.holdDays = num(r.holdDays, 0, 60, 7);
    o.spike = { minHour: num(s.minHour, 10, 1000000, 200), newPct: num(s.newPct, 1, 100, 60), ipPct: num(s.ipPct, 1, 100, 30), engagePct: num(s.engagePct, 0, 100, 0.5) };
    return o;
  }
  async function settings(fresh) {
    if (!fresh && cfg && Date.now() - cfgAt < 30000) return cfg;
    await ensure();
    const r = await pool.query("SELECT value FROM creator_settings WHERE key = 'viewguard'").catch(() => ({ rows: [] }));
    let raw = {}; try { raw = r.rows[0] ? JSON.parse(r.rows[0].value) : {}; } catch (e) { raw = {}; }
    cfg = clean(raw); cfgAt = Date.now();
    return cfg;
  }

  const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 32);
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim().slice(0, 64);

  // ⏱️ views counted by one person in the last hour (kept in memory; a restart starts again)
  const perHour = new Map();
  function tooMany(email, limit) {
    const now = Date.now(), list = (perHour.get(email) || []).filter((t) => now - t < 3600000);
    if (list.length >= limit) { perHour.set(email, list); return true; }
    list.push(now); perHour.set(email, list);
    if (perHour.size > 50000) for (const [k, v] of perHour) if (!v.length || now - v[v.length - 1] > 3600000) perHour.delete(k);
    return false;
  }
  const flaggedViewer = new Map();
  async function flagViewer(email, n) {
    const last = flaggedViewer.get(email) || 0; if (Date.now() - last < 3600000) return; flaggedViewer.set(email, Date.now());
    const open = await pool.query("SELECT 1 FROM view_reviews WHERE kind = 'viewer' AND user_email = $1 AND status = 'open'", [email]);
    if (!open.rows.length) await pool.query("INSERT INTO view_reviews (kind, user_email, reason, facts) VALUES ('viewer', $1, 'too_many', $2)", [email, JSON.stringify({ perHour: n })]);
  }

  // 📈 a post whose paid views jumped in a strange way → hold its new paid views for the Admin
  const spikeChecked = new Map();
  async function checkSpike(postId, owner) {
    const last = spikeChecked.get(postId) || 0; if (Date.now() - last < 300000) return; spikeChecked.set(postId, Date.now());
    const s = (await settings()).spike;
    const t = (await pool.query(`SELECT COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE u.created_at > NOW() - INTERVAL '30 days')::int AS new_n,
        (SELECT COUNT(*) FROM paid_views x WHERE x.post_id = $1 AND x.created_at > NOW() - INTERVAL '1 hour' GROUP BY x.ip ORDER BY COUNT(*) DESC LIMIT 1)::int AS top_ip
      FROM paid_views v LEFT JOIN users u ON LOWER(u.email) = v.viewer_email WHERE v.post_id = $1 AND v.created_at > NOW() - INTERVAL '1 hour'`, [postId])).rows[0];
    if (!t || t.n < s.minHour) return;
    const p = (await pool.query(`SELECT COALESCE(views_count, 0) AS views, views_trusted_until > NOW() AS trusted,
        (SELECT COUNT(*) FROM likes WHERE post_id = $1)::int + (SELECT COUNT(*) FROM comments WHERE post_id = $1)::int AS eng FROM posts WHERE id = $1`, [postId])).rows[0];
    if (!p || p.trusted) return;
    const newPct = t.new_n * 100 / t.n, ipPct = (t.top_ip || 0) * 100 / t.n, engPct = p.views > 0 ? p.eng * 100 / p.views : 100;
    const why = [];
    if (newPct >= s.newPct) why.push('new_accounts');
    if (ipPct >= s.ipPct) why.push('one_ip');
    if (engPct < s.engagePct) why.push('no_engagement');
    if (!why.length) return;
    const open = await pool.query("SELECT 1 FROM view_reviews WHERE kind = 'post' AND post_id = $1 AND status = 'open'", [postId]);
    if (open.rows.length) return;
    await pool.query("INSERT INTO view_reviews (kind, post_id, user_email, reason, facts) VALUES ('post', $1, $2, $3, $4)",
      [postId, owner, why.join(','), JSON.stringify({ hour: t.n, newPct: Math.round(newPct), ipPct: Math.round(ipPct), engagePct: Math.round(engPct * 100) / 100, views: p.views })]);
    // the paid views of the last day wait too (not only the ones after now)
    await pool.query("UPDATE paid_views SET status = 'held' WHERE post_id = $1 AND status = 'ok' AND created_at > NOW() - INTERVAL '1 day'", [postId]);
  }

  async function underReview(postId) {
    const r = await pool.query("SELECT 1 FROM view_reviews WHERE kind = 'post' AND post_id = $1 AND status = 'open'", [postId]);
    return r.rows.length > 0;
  }

  // shown view: once per person per post per `shownHours`, never the owner
  async function countShown(postId, viewer, owner, country) {
    const c = await settings();
    if (!viewer || norm(viewer) === norm(owner)) return false;
    const seen = await pool.query(`SELECT 1 FROM post_views WHERE post_id = $1 AND viewer_email = $2 AND created_at > NOW() - ($3 || ' hours')::interval LIMIT 1`, [postId, viewer, String(c.shownHours)]);
    if (seen.rows.length) return false;
    await pool.query('INSERT INTO post_views (post_id, viewer_email, country) VALUES ($1, $2, $3)', [postId, viewer, country || 'Unknown']);
    await pool.query('UPDATE posts SET views_count = COALESCE(views_count, 0) + 1 WHERE id = $1', [postId]);
    return true;
  }

  // ---- the app ------------------------------------------------------------------------------------------------------
  app.post('/api/posts/:id/view/start', async (req, res) => {
    const me = norm(req.authEmail), id = parseInt(req.params.id, 10) || 0;
    if (!me || !id) return res.status(400).json({ success: false });
    try {
      if (!(await guardPost(req, res, id))) return;
      const ts = Date.now(), body = id + '.' + ts;
      res.json({ success: true, ticket: body + '.' + sign(body + '|' + me) });
    } catch (e) { res.status(500).json({ success: false }); }
  });

  app.post('/api/posts/:id/view/end', async (req, res) => {
    const me = norm(req.authEmail), id = parseInt(req.params.id, 10) || 0, b = req.body || {};
    if (!me || !id) return res.status(400).json({ success: false });
    try {
      const c = await settings();
      const parts = String(b.ticket || '').split('.');
      if (parts.length !== 3 || parseInt(parts[0], 10) !== id) return res.status(400).json({ success: false, code: 'ticket' });
      const ts = parseInt(parts[1], 10), want = sign(parts[0] + '.' + parts[1] + '|' + me);
      if (!ts || parts[2].length !== want.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(want))) return res.status(400).json({ success: false, code: 'ticket' });
      const passed = Date.now() - ts;
      if (passed > 6 * 3600000 || passed < 0) return res.status(400).json({ success: false, code: 'ticket' });
      // the time believed: what the app says, never more than really passed since the ticket
      const watched = Math.max(0, Math.min(Number(b.watched_ms) || 0, passed + 1500));
      const dur = Math.max(0, Number(b.duration_ms) || 0);
      const post = (await pool.query('SELECT user_email, COALESCE(no_earn, FALSE) AS no_earn FROM posts WHERE id = $1', [id])).rows[0];
      if (!post) return res.status(404).json({ success: false });
      const owner = norm(post.user_email);
      if (owner === me) return res.json({ success: true, shown: false, paid: false });
      if (!(await guardPost(req, res, id))) return;
      const out = { success: true, shown: false, paid: false };
      // shown view
      if (watched >= c.shownSec * 1000) {
        // the speed limit is counted once per video watched (the first report), not again at the 10 s report
        if (b.stage !== 'paid' && tooMany(me, c.perHour)) { flagViewer(me, c.perHour).catch(() => {}); return res.json(out); }
        const country = (await pool.query('SELECT country FROM users WHERE LOWER(email) = $1', [me]).catch(() => ({ rows: [] }))).rows[0]?.country || req.headers['cf-ipcountry'] || 'Unknown';
        out.shown = await countShown(id, me, owner, country);
      }
      // paid view
      const short = dur > 0 && dur < c.paidSec * 2000;
      const need = short ? Math.max(c.shortMinSec * 1000, dur * c.shortPct / 100) : c.paidSec * 1000;
      if (watched >= Math.min(need, c.paidSec * 1000) && !post.no_earn) {
        const u = (await pool.query('SELECT created_at, COALESCE(is_banned, FALSE) AS banned FROM users WHERE LOWER(email) = $1', [me])).rows[0];
        const oldEnough = u && !u.banned && (!c.minAgeDays || (u.created_at && Date.now() - new Date(u.created_at).getTime() >= c.minAgeDays * 86400000));
        if (oldEnough) {
          const device = String(b.device || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null, ip = ipOf(req) || null;
          const same = (await pool.query(`SELECT COUNT(*)::int AS n FROM paid_views WHERE post_id = $1 AND created_at > NOW() - INTERVAL '1 day'
                                          AND ((device IS NOT NULL AND device = $2) OR (ip IS NOT NULL AND ip = $3))`, [id, device, ip])).rows[0].n;
          if (same < c.perDevice) {
            const status = (await underReview(id)) ? 'held' : 'ok';
            const r = await pool.query(`INSERT INTO paid_views (post_id, viewer_email, owner_email, device, ip, watched_ms, status) VALUES ($1, $2, $3, $4, $5, $6, $7)
                                        ON CONFLICT (post_id, viewer_email) DO NOTHING RETURNING post_id`, [id, me, owner, device, ip, Math.round(watched), status]);
            out.paid = r.rows.length > 0;
            if (out.paid) checkSpike(id, owner).catch((e) => console.error('[views] spike:', e.message));
          }
        }
      }
      res.json(out);
    } catch (e) { console.error('[views] end:', e.message); res.status(500).json({ success: false }); }
  });

  // ---- for the earnings (server.js syncViewEarnings): paid views that are ok and older than the hold time ----
  async function paidCounts(owner) {
    const c = await settings();
    const r = await pool.query(`SELECT post_id, COUNT(*)::int AS n FROM paid_views WHERE owner_email = $1 AND status = 'ok'
                                AND created_at < NOW() - ($2 || ' days')::interval GROUP BY post_id`, [norm(owner), String(c.holdDays)]);
    const m = new Map(); r.rows.forEach((x) => m.set(x.post_id, x.n)); return m;
  }
  async function pendingCounts(owner) {
    const c = await settings();
    const r = await pool.query(`SELECT post_id, COUNT(*) FILTER (WHERE status = 'ok' AND created_at >= NOW() - ($2 || ' days')::interval)::int AS waiting,
                                COUNT(*) FILTER (WHERE status = 'held')::int AS held FROM paid_views WHERE owner_email = $1 GROUP BY post_id`, [norm(owner), String(c.holdDays)]);
    const m = new Map(); r.rows.forEach((x) => m.set(x.post_id, { waiting: x.waiting, held: x.held })); return m;
  }

  // ---- Admin ------------------------------------------------------------------------------------------------------
  app.post('/api/admin/view-guard', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      if (b.set && typeof b.set === 'object') {
        if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change this.' });
        await pool.query("INSERT INTO creator_settings (key, value) VALUES ('viewguard', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(clean(b.set))]);
        cfgAt = 0;
        if (audit) audit(a.adminEmail, 'view-guard', 'settings', '');
      }
      if (b.decide && typeof b.decide === 'object') {
        const id = parseInt(b.decide.id, 10) || 0, ok = b.decide.ok === true, stop = b.decide.stopEarning === true;
        const rv = (await pool.query("SELECT * FROM view_reviews WHERE id = $1 AND status = 'open'", [id])).rows[0];
        if (!rv) return res.status(404).json({ success: false, error: 'Already decided.' });
        if (rv.kind === 'post') {
          if (ok) {
            await pool.query("UPDATE paid_views SET status = 'ok' WHERE post_id = $1 AND status = 'held'", [rv.post_id]);
            await pool.query("UPDATE posts SET views_trusted_until = NOW() + INTERVAL '7 days' WHERE id = $1", [rv.post_id]);
          } else {
            const gone = await pool.query("UPDATE paid_views SET status = 'removed' WHERE post_id = $1 AND status = 'held' RETURNING viewer_email", [rv.post_id]);
            // the fake ones are taken off the number under the post too
            await pool.query('UPDATE posts SET views_count = GREATEST(0, COALESCE(views_count, 0) - $2) WHERE id = $1', [rv.post_id, gone.rowCount || 0]);
            if (stop && rv.user_email) {
              await pool.query("UPDATE creator_applications SET earn_suspended = TRUE, suspend_reason = $2 WHERE user_email = $1 AND status = 'approved'", [rv.user_email, 'Fake views']);
              if (sendAdminNotice) await sendAdminNotice(a.adminEmail, rv.user_email, '⚠️ សិទ្ធិរកលុយរបស់អ្នកត្រូវបានផ្អាក ព្រោះ CamFeed រកឃើញ view មិនពិតលើការបង្ហោះរបស់អ្នក។').catch(() => {});
            }
          }
        } else if (!ok) {
          // a person who counted too many views: their paid views not paid yet are taken away
          await pool.query("UPDATE paid_views SET status = 'removed' WHERE viewer_email = $1 AND status IN ('ok', 'held') AND created_at > NOW() - INTERVAL '30 days'", [rv.user_email]);
        }
        await pool.query("UPDATE view_reviews SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1", [id, ok ? 'ok' : 'removed', a.adminEmail]);
        if (audit) audit(a.adminEmail, 'view-review', String(rv.post_id || rv.user_email), ok ? 'ok' : (stop ? 'removed+stop' : 'removed'));
      }
      const s = await settings(true);
      const open = (await pool.query(`SELECT r.id, r.kind, r.post_id, r.user_email, r.reason, r.facts, r.created_at, u.first_name, u.last_name, u.profile_pic,
          p.content, p.media_type, COALESCE(p.views_count, 0) AS views,
          (SELECT COUNT(*) FROM paid_views pv WHERE pv.post_id = r.post_id AND pv.status = 'held')::int AS held
        FROM view_reviews r LEFT JOIN users u ON LOWER(u.email) = LOWER(r.user_email) LEFT JOIN posts p ON p.id = r.post_id
        WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 200`)).rows;
      const stats = (await pool.query(`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS day,
          COUNT(*) FILTER (WHERE status = 'held')::int AS held, COUNT(*) FILTER (WHERE status = 'removed')::int AS removed FROM paid_views`)).rows[0];
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, settings: s, defaults: DEFAULTS, open, stats });
    } catch (err) { console.error('[views] admin:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  ensure().catch((e) => console.error('[views] schema:', e.message));
  return { countShown, paidCounts, pendingCounts, settings, tooMany, flagViewer };
};
