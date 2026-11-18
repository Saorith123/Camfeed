// 🚩 Reports from chats (1:1 and groups): a message / picture / video / voice message, or a person
//  • the person who reports chooses a reason; the reported message is copied with 10 messages before and after (so CamFeed
//    sees what happened without reading the whole chat), and the picture / video stays kept as proof even if the sender
//    deletes it
//  • Admin › 🚩 Reports: look, delete at once (for both sides), send the person a message, limit their chat, suspend the
//    account, see every report about the same person (watch them) — every step is written in the Activity Log
//  • the person who reported hears "CamFeed checked your report"
module.exports = function installChatReports({ app, pool, adminGate, audit, sendNotice, cleanup, extractMediaUrls, ensureChat }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const REASONS = ['sexual', 'scam', 'harass', 'violence', 'child', 'spam', 'other'];
  const REASON_KM = { sexual: 'អាសអាភាស ឬផ្លូវភេទ', scam: 'បោកប្រាស់', harass: 'ជេរប្រមាថ ឬរំលោភ', violence: 'ហិង្សា ឬគំរាមកំហែង', child: 'ពាក់ព័ន្ធកុមារ', spam: 'Spam', other: 'ផ្សេងៗ' };

  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        if (ensureChat) await ensureChat().catch(() => {});
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_reports (
          id SERIAL PRIMARY KEY, reporter_email TEXT NOT NULL, target_email TEXT NOT NULL, kind VARCHAR(10) NOT NULL DEFAULT 'message',
          group_id INTEGER, message_id INTEGER, reason VARCHAR(20) NOT NULL, note TEXT,
          message TEXT, media_url TEXT, message_type VARCHAR(20), context JSONB,
          status VARCHAR(12) NOT NULL DEFAULT 'pending', action TEXT, handled_by TEXT, handled_at TIMESTAMPTZ,
          media_purge_after TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('CREATE INDEX IF NOT EXISTS chat_reports_status_idx ON chat_reports (status, created_at)');
        await pool.query('CREATE INDEX IF NOT EXISTS chat_reports_target_idx ON chat_reports (target_email)');
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  setTimeout(() => ensure().catch((e) => console.error('[chat-reports] schema:', e.message)), 7000);

  const me = (req, res) => { const e = norm(req.authEmail); if (!e) res.status(401).json({ success: false, error: 'Please log in.' }); return e; };
  const cols = 'id, sender_email, message, media_url, message_type, created_at';

  // ---- the person reports ----
  app.post('/api/chat/report', async (req, res) => {
    const e = me(req, res); if (!e) return;
    try {
      await ensure();
      const b = req.body || {};
      const reason = REASONS.includes(b.reason) ? b.reason : 'other';
      const note = String(b.note || '').trim().slice(0, 500);
      const today = Number((await pool.query("SELECT COUNT(*)::int AS n FROM chat_reports WHERE reporter_email = $1 AND created_at > NOW() - INTERVAL '1 day'", [e])).rows[0].n);
      if (today >= 30) return res.status(429).json({ success: false, error: 'Too many reports today.' });
      const mid = parseInt(b.message_id, 10) || 0, gid = parseInt(b.group_id, 10) || 0;
      let target = '', snap = null, context = [];
      if (mid && gid) {                                            // a message in a group
        const inG = (await pool.query('SELECT 1 FROM chat_group_members WHERE group_id = $1 AND LOWER(user_email) = $2', [gid, e])).rows.length;
        if (!inG) return res.status(404).json({ success: false, error: 'Not found.' });
        snap = (await pool.query(`SELECT ${cols} FROM group_messages WHERE id = $1 AND group_id = $2`, [mid, gid])).rows[0];
        if (!snap) return res.status(404).json({ success: false, error: 'Not found.' });
        context = (await pool.query(`(SELECT ${cols} FROM group_messages WHERE group_id = $1 AND id < $2 ORDER BY id DESC LIMIT 10)
                                     UNION ALL (SELECT ${cols} FROM group_messages WHERE group_id = $1 AND id >= $2 ORDER BY id ASC LIMIT 11) ORDER BY id`, [gid, mid])).rows;
        target = norm(snap.sender_email);
      } else if (mid) {                                            // a message in a 1:1 chat (I must be in it)
        snap = (await pool.query(`SELECT ${cols}, receiver_email FROM messages WHERE id = $1 AND (LOWER(sender_email) = $2 OR LOWER(receiver_email) = $2)`, [mid, e])).rows[0];
        if (!snap) return res.status(404).json({ success: false, error: 'Not found.' });
        target = norm(snap.sender_email);
        const peer = target === e ? norm(snap.receiver_email) : target;
        context = (await pool.query(`(SELECT ${cols} FROM messages WHERE ((LOWER(sender_email) = $1 AND LOWER(receiver_email) = $2) OR (LOWER(sender_email) = $2 AND LOWER(receiver_email) = $1)) AND id < $3 ORDER BY id DESC LIMIT 10)
                                     UNION ALL (SELECT ${cols} FROM messages WHERE ((LOWER(sender_email) = $1 AND LOWER(receiver_email) = $2) OR (LOWER(sender_email) = $2 AND LOWER(receiver_email) = $1)) AND id >= $3 ORDER BY id ASC LIMIT 11) ORDER BY id`, [e, peer, mid])).rows;
      } else {                                                     // a person (their last messages to me as context)
        target = norm(b.target_email);
        if (!target) return res.status(400).json({ success: false, error: 'Who?' });
        context = (await pool.query(`SELECT * FROM (SELECT ${cols} FROM messages WHERE (LOWER(sender_email) = $1 AND LOWER(receiver_email) = $2) OR (LOWER(sender_email) = $2 AND LOWER(receiver_email) = $1)
                                     ORDER BY id DESC LIMIT 20) t ORDER BY id`, [e, target])).rows;
      }
      if (!target || target === e) return res.status(400).json({ success: false, error: 'You can not report your own message.' });
      if (mid && (await pool.query("SELECT 1 FROM chat_reports WHERE reporter_email = $1 AND message_id = $2 AND COALESCE(group_id, 0) = $3", [e, mid, gid])).rows.length) {
        return res.status(409).json({ success: false, code: 'already', error: 'You already reported this message.' });
      }
      await pool.query(`INSERT INTO chat_reports (reporter_email, target_email, kind, group_id, message_id, reason, note, message, media_url, message_type, context)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [e, target, mid ? 'message' : 'person', gid || null, mid || null, reason, note || null, snap ? snap.message : null, snap ? snap.media_url : null, snap ? snap.message_type : null, JSON.stringify(context)]);
      if (b.block === true) {
        const t = (await pool.query('SELECT email FROM users WHERE LOWER(email) = $1', [target])).rows[0];
        if (t) {
          await pool.query('INSERT INTO blocked_users (blocker_email, blocked_email) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM blocked_users WHERE LOWER(blocker_email) = $3 AND LOWER(blocked_email) = $4)', [req.authEmail, t.email, e, target]).catch(() => {});
        }
      }
      res.json({ success: true });
    } catch (err) { console.error('[chat-reports] report:', err.message); res.status(500).json({ success: false, error: 'Could not send.' }); }
  });

  // ---- Admin ----
  async function deleteMessage(r) {
    if (!r.message_id) return false;
    const t = r.group_id ? 'group_messages' : 'messages';
    const u = await pool.query(`UPDATE ${t} SET message = '__CAMFEED_MSG_DELETED__', media_url = NULL, message_type = 'deleted' WHERE id = $1 RETURNING id`, [r.message_id]);
    // the picture / video file itself is kept as proof for a while (removed later by the sweep below)
    await pool.query("UPDATE chat_reports SET media_purge_after = NOW() + INTERVAL '60 days' WHERE id = $1 AND media_url IS NOT NULL", [r.id]);
    return u.rows.length > 0;
  }
  const tellReporter = (adminEmail, r) => sendNotice(adminEmail, r.reporter_email, '🚩 CamFeed បានពិនិត្យការរាយការណ៍របស់អ្នកហើយ។ អរគុណដែលជួយឲ្យ CamFeed មានសុវត្ថិភាព!').catch(() => {});

  app.post('/api/admin/chat-reports', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const act = String(b.action || 'list');
      const id = parseInt(b.id, 10) || 0;
      const r = id ? (await pool.query('SELECT * FROM chat_reports WHERE id = $1', [id])).rows[0] : null;
      const why = String(b.reason || '').trim().slice(0, 300);
      const close = async (status, action) => {
        await pool.query("UPDATE chat_reports SET status = $2, action = COALESCE($3, action), handled_by = $4, handled_at = NOW() WHERE id = $1", [r.id, status, action, a.adminEmail]);
        // the other open reports about the same message are closed with it
        if (r.message_id) await pool.query("UPDATE chat_reports SET status = $2, action = COALESCE($3, action), handled_by = $4, handled_at = NOW() WHERE message_id = $1 AND COALESCE(group_id, 0) = $5 AND status = 'pending'", [r.message_id, status, action, a.adminEmail, r.group_id || 0]);
        await tellReporter(a.adminEmail, r);
      };
      if (act !== 'list' && act !== 'history' && !r) return res.status(404).json({ success: false, error: 'Report not found.' });
      if (act === 'delete') {                                      // 🗑 delete at once, for both sides
        await deleteMessage(r);
        audit(a.adminEmail, 'chat-report-delete', r.target_email + ' #' + r.message_id, why || r.reason);
        if (b.notify !== false) await sendNotice(a.adminEmail, r.target_email, '🚫 CamFeed បានលុបសាររបស់អ្នក ព្រោះរំលោភច្បាប់សហគមន៍ (' + (REASON_KM[r.reason] || r.reason) + ')' + (why ? '។ ' + why : '។') + ' បើធ្វើម្ដងទៀត គណនីរបស់អ្នកអាចត្រូវផ្អាក។').catch(() => {});
        await close('resolved', 'deleted');
      } else if (act === 'notice') {                               // ✉️ a message to the person (the report stays open unless "close")
        const text = String(b.text || '').trim().slice(0, 700);
        if (!text) return res.status(400).json({ success: false, error: 'Write the message.' });
        await sendNotice(a.adminEmail, r.target_email, '📩 CamFeed៖ ' + text);
        audit(a.adminEmail, 'chat-report-notice', r.target_email, text);
        if (b.close === true) await close('resolved', 'notice');
      } else if (act === 'limit') {                                // 🔒 limit the person's chat
        const lim = ['reply_only', 'banned'].includes(b.limit) ? b.limit : 'reply_only';
        if (why.length < 3) return res.status(400).json({ success: false, error: 'Please write a reason.' });
        await pool.query('UPDATE users SET chat_limit = $1 WHERE LOWER(email) = $2', [lim, norm(r.target_email)]);
        await sendNotice(a.adminEmail, r.target_email, (lim === 'banned' ? '🚫 CamFeed៖ គណនីរបស់អ្នកត្រូវបានរឹតត្បិតមិនឲ្យជជែក ឬហៅ។ ' : '⚠️ CamFeed៖ អ្នកអាចឆ្លើយតបសារបានតែពេលគេផ្ញើមកមុន។ ') + 'មូលហេតុ៖ ' + why).catch(() => {});
        audit(a.adminEmail, 'chat-report-limit-' + lim, r.target_email, why);
        await close('resolved', 'limit:' + lim);
      } else if (act === 'suspend') {                              // ⛔ suspend the whole account
        if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can suspend an account.' });
        if (why.length < 3) return res.status(400).json({ success: false, error: 'Please write a reason.' });
        await pool.query('UPDATE users SET is_banned = TRUE WHERE LOWER(email) = $1', [norm(r.target_email)]);
        audit(a.adminEmail, 'chat-report-suspend', r.target_email, why);
        await close('resolved', 'suspended');
      } else if (act === 'dismiss') {                              // ✔ nothing wrong
        audit(a.adminEmail, 'chat-report-dismiss', r.target_email + ' #' + r.id, why);
        await close('dismissed', 'none');
      }
      // the list: waiting first; with every person's other reports (to watch people who do it again)
      const status = b.status === 'done' ? 'done' : 'pending';
      const rows = (await pool.query(`SELECT cr.*, ru.first_name AS r_first, ru.last_name AS r_last, tu.first_name AS t_first, tu.last_name AS t_last, tu.profile_pic AS t_pic,
                                        COALESCE(tu.is_banned, FALSE) AS t_banned, tu.chat_limit AS t_limit,
                                        (SELECT COUNT(*)::int FROM chat_reports x WHERE x.target_email = cr.target_email) AS t_reports,
                                        (SELECT COUNT(*)::int FROM chat_reports x WHERE x.target_email = cr.target_email AND x.status = 'resolved') AS t_resolved,
                                        (SELECT name FROM chat_groups g WHERE g.id = cr.group_id) AS group_name
                                      FROM chat_reports cr LEFT JOIN users ru ON LOWER(ru.email) = cr.reporter_email LEFT JOIN users tu ON LOWER(tu.email) = cr.target_email
                                      WHERE ${status === 'pending' ? "cr.status = 'pending'" : "cr.status <> 'pending'"}
                                        ${b.target ? 'AND cr.target_email = $1' : ''}
                                      ORDER BY cr.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 100`, b.target ? [norm(b.target)] : []).catch((e) => { console.error('[chat-reports] list:', e.message); return { rows: [] }; })).rows;
      const pending = Number((await pool.query("SELECT COUNT(*)::int AS n FROM chat_reports WHERE status = 'pending'")).rows[0].n);
      res.json({ success: true, isSuperAdmin: a.isSuperAdmin, pending, reasons: REASON_KM, reports: rows });
    } catch (err) { console.error('[chat-reports] admin:', err.message); if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  // proof files of deleted messages are removed after their time
  async function sweep() {
    try {
      await ensure();
      const r = await pool.query('SELECT id, media_url FROM chat_reports WHERE media_purge_after IS NOT NULL AND media_purge_after < NOW() LIMIT 50');
      for (const x of r.rows) {
        if (x.media_url && cleanup && extractMediaUrls) await cleanup.purgeMediaUrls(extractMediaUrls(x.media_url)).catch(() => {});
        await pool.query('UPDATE chat_reports SET media_url = NULL, media_purge_after = NULL WHERE id = $1', [x.id]);
      }
    } catch (e) { console.error('[chat-reports] sweep:', e.message); }
  }
  setTimeout(() => { sweep(); setInterval(sweep, 6 * 3600 * 1000); }, 120 * 1000);

  async function pendingCount() { try { await ensure(); return Number((await pool.query("SELECT COUNT(*)::int AS n FROM chat_reports WHERE status = 'pending'")).rows[0].n); } catch (e) { return 0; } }
  return { pendingCount };
};
