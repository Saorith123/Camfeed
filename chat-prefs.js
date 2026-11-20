// Per-person choices about each conversation (like Messenger): pin, archive, mute, restrict, mark as unread,
// "delete for me" (hide the old messages from me only) and "delete for both" (remove the messages and their photos /
// videos / voice from the database AND the storage, to free space). Plus the "Message requests" switch:
// off by default (anybody can write to you); when a person turns it on, messages from people they do not follow
// wait in ⋮ > Message requests and do not ring.
//
// peer = the other person's e-mail (lower case), or 'group:<id>' for a group chat.
module.exports = function installChatPrefs({ app, pool, cleanup, extractMediaUrls }) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_prefs (
          user_email VARCHAR(255) NOT NULL,
          peer VARCHAR(255) NOT NULL,
          pinned BOOLEAN DEFAULT FALSE,
          archived_at TIMESTAMP DEFAULT NULL,
          muted BOOLEAN DEFAULT FALSE,
          restricted BOOLEAN DEFAULT FALSE,
          marked_unread BOOLEAN DEFAULT FALSE,
          cleared_at TIMESTAMP DEFAULT NULL,
          accepted BOOLEAN DEFAULT FALSE,
          PRIMARY KEY (user_email, peer))`);
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS msg_requests_on BOOLEAN DEFAULT FALSE');
        await pool.query('ALTER TABLE chat_prefs ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP DEFAULT NULL');   // mute for 1 h / 8 h / 24 h … (NULL = until turned back on)
        // 🗑 "Delete for me" of ONE message (somebody else's photo / video / voice / text too): hidden for this person only
        await pool.query(`CREATE TABLE IF NOT EXISTS message_hides (user_email VARCHAR(255) NOT NULL, kind VARCHAR(8) NOT NULL,
          message_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (user_email, kind, message_id))`);
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }
  setTimeout(() => ensure().catch(() => {}), 3000);

  const peerOf = (b) => {
    const g = String(b.peer || '');
    if (/^group:\d+$/.test(g)) return g;
    return norm(b.peer_email || '');
  };
  // a mute with an end time is over by itself
  const mutedNow = (r) => !!(r && r.muted && (!r.muted_until || new Date(r.muted_until) > new Date()));
  const out = (r) => {
    const o = {
      pinned: !!r.pinned, archived_at: r.archived_at, muted: mutedNow(r), muted_until: r.muted && r.muted_until ? r.muted_until : null, restricted: !!r.restricted,
      unread: !!r.marked_unread, cleared_at: r.cleared_at, accepted: !!r.accepted,
    };
    if (String(r.peer).startsWith('group:')) o.peer = r.peer; else o.peer_email = r.peer;
    return o;
  };

  // everything about my conversations at once (the Chats page reads this together with the list)
  app.get('/api/chat-prefs', async (req, res) => {
    const me = norm(req.authEmail); if (!me) return res.status(401).json({ success: false });
    try {
      await ensure();
      const r = await pool.query('SELECT * FROM chat_prefs WHERE user_email = $1', [me]);
      const u = await pool.query('SELECT COALESCE(msg_requests_on, FALSE) AS on, COALESCE(show_active_status, TRUE) AS active FROM users WHERE LOWER(email) = $1', [me]);
      // people I follow, and people I have written to: never "requests"
      const known = await pool.query(`SELECT LOWER(following_email) AS e FROM follows WHERE LOWER(follower_email) = $1
                                      UNION SELECT DISTINCT LOWER(receiver_email) FROM messages WHERE LOWER(sender_email) = $1`, [me]);
      res.json({
        success: true,
        requestsOn: !!(u.rows[0] && u.rows[0].on),
        activeStatus: !(u.rows[0] && u.rows[0].active === false),
        prefs: r.rows.map(out),
        known: known.rows.map((x) => ({ email: x.e })),
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // change one conversation: { peer_email | peer, pinned?, archived?, muted?, restricted?, unread?, accepted? }
  app.post('/api/chat-prefs', async (req, res) => {
    const me = norm(req.authEmail); const b = req.body || {}; const peer = peerOf(b);
    if (!me || !peer || peer === me) return res.status(400).json({ success: false });
    try {
      await ensure();
      await pool.query('INSERT INTO chat_prefs (user_email, peer) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, peer]);
      const sets = []; const vals = [me, peer];
      const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.pinned !== undefined) add('pinned', !!b.pinned);
      if (b.archived !== undefined) { if (b.archived) sets.push('archived_at = NOW()'); else sets.push('archived_at = NULL'); }
      if (b.muted !== undefined) {
        add('muted', !!b.muted);
        const h = parseInt(b.mute_hours, 10) || 0;          // 0 = until I turn it back on
        if (b.muted && h > 0) sets.push(`muted_until = NOW() + INTERVAL '${Math.min(h, 24 * 365)} hours'`); else sets.push('muted_until = NULL');
        // the website's chat settings keep their own list: kept the same, so both places agree
        if (b.muted) await pool.query('INSERT INTO chat_mutes (user_email, peer_email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [me, peer]).catch(() => {});
        else await pool.query('DELETE FROM chat_mutes WHERE user_email=$1 AND peer_email=$2', [me, peer]).catch(() => {});
      }
      if (b.restricted !== undefined) add('restricted', !!b.restricted);
      if (b.unread !== undefined) add('marked_unread', !!b.unread);
      if (b.accepted !== undefined) add('accepted', !!b.accepted);
      if (sets.length) await pool.query(`UPDATE chat_prefs SET ${sets.join(', ')} WHERE user_email = $1 AND peer = $2`, vals);
      const r = await pool.query('SELECT * FROM chat_prefs WHERE user_email = $1 AND peer = $2', [me, peer]);
      res.json({ success: true, pref: out(r.rows[0]) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // the "Message requests" switch (each person decides; off = anybody can write to you)
  app.post('/api/chat-prefs/requests', async (req, res) => {
    const me = norm(req.authEmail); if (!me) return res.status(401).json({ success: false });
    try {
      await ensure();
      await pool.query('UPDATE users SET msg_requests_on = $1 WHERE LOWER(email) = $2', [!!(req.body || {}).on, me]);
      res.json({ success: true, requestsOn: !!(req.body || {}).on });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  async function purgeMessages(where, params) {
    // collect the photos / videos / voice of these messages first, then delete the rows, then the files
    const rows = await pool.query(`SELECT id, message, media_url FROM messages WHERE ${where}`, params).catch(() => ({ rows: [] }));
    const urls = [];
    for (const r of rows.rows) {
      if (r.media_url) { try { urls.push(...(extractMediaUrls ? extractMediaUrls(r.media_url) : [r.media_url])); } catch (e) { /* not a file */ } }
    }
    await pool.query(`DELETE FROM messages WHERE ${where}`, params);
    if (urls.length && cleanup && cleanup.purgeMediaUrls) { try { await cleanup.purgeMediaUrls(urls); } catch (e) { console.error('[chat-prefs] storage:', e.message); } }
    return rows.rows.length;
  }

  // delete a conversation. scope 'me' = only I stop seeing the old messages; 'both' = removed for both people (1-to-1 only,
  // or the whole group history by a group admin) and the files are removed from storage.
  app.post('/api/chat-clear', async (req, res) => {
    const me = norm(req.authEmail); const b = req.body || {}; const peer = peerOf(b);
    const scope = b.scope === 'both' ? 'both' : 'me';
    if (!me || !peer || peer === me) return res.status(400).json({ success: false });
    try {
      await ensure();
      const isGroup = peer.startsWith('group:');
      if (scope === 'both') {
        if (isGroup) {
          const gid = parseInt(peer.slice(6), 10);
          const m = await pool.query('SELECT role FROM chat_group_members WHERE group_id = $1 AND user_email = $2', [gid, me]);
          if (!m.rows[0] || m.rows[0].role !== 'admin') return res.status(403).json({ success: false, error: 'Only a group manager can delete the messages for everyone.' });
          const gm = await pool.query('SELECT media_url, message FROM group_messages WHERE group_id = $1', [gid]).catch(() => ({ rows: [] }));
          const urls = [];
          gm.rows.forEach((r) => { if (r.media_url) { try { urls.push(...(extractMediaUrls ? extractMediaUrls(r.media_url) : [r.media_url])); } catch (e) {} } });
          await pool.query("DELETE FROM group_messages WHERE group_id = $1 AND message_type <> 'system'", [gid]);
          if (urls.length && cleanup && cleanup.purgeMediaUrls) { try { await cleanup.purgeMediaUrls(urls); } catch (e) {} }
          return res.json({ success: true, removed: gm.rows.length });
        }
        const n = await purgeMessages('(LOWER(sender_email) = $1 AND LOWER(receiver_email) = $2) OR (LOWER(sender_email) = $2 AND LOWER(receiver_email) = $1)', [me, peer]);
        return res.json({ success: true, removed: n });
      }
      await pool.query(`INSERT INTO chat_prefs (user_email, peer, cleared_at, marked_unread) VALUES ($1, $2, NOW(), FALSE)
                        ON CONFLICT (user_email, peer) DO UPDATE SET cleared_at = NOW(), marked_unread = FALSE`, [me, peer]);
      // nothing old stays "unread" after deleting
      if (isGroup) await pool.query('UPDATE chat_group_members SET last_read_id = GREATEST(last_read_id, COALESCE((SELECT MAX(id) FROM group_messages WHERE group_id = $1), 0)) WHERE group_id = $1 AND user_email = $2', [parseInt(peer.slice(6), 10), me]).catch(() => {});
      else await pool.query('UPDATE messages SET is_read = TRUE WHERE LOWER(receiver_email) = $1 AND LOWER(sender_email) = $2 AND COALESCE(is_read, FALSE) = FALSE', [me, peer]).catch(() => {});
      let removed = 0;
      if (!isGroup) {
        // both people deleted the conversation for themselves: the old messages are not needed by anybody -> really delete them
        const other = await pool.query('SELECT cleared_at FROM chat_prefs WHERE user_email = $1 AND peer = $2', [peer, me]);
        const t = other.rows[0] && other.rows[0].cleared_at;
        if (t) removed = await purgeMessages('((LOWER(sender_email) = $1 AND LOWER(receiver_email) = $2) OR (LOWER(sender_email) = $2 AND LOWER(receiver_email) = $1)) AND created_at <= $3', [me, peer, t]);
      }
      res.json({ success: true, removed });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // 🗑 hide one message for me only (the other side still sees it; it stays in the database, e.g. as proof for a report)
  app.post('/api/messages/hide-for-me', async (req, res) => {
    const me = norm(req.authEmail); const b = req.body || {};
    const id = parseInt(b.id, 10), kind = b.group ? 'group' : 'dm';
    if (!me || !id) return res.status(400).json({ success: false });
    try {
      await ensure();
      // only a message of a chat I am in
      const ok = kind === 'dm'
        ? await pool.query('SELECT 1 FROM messages WHERE id = $1 AND (LOWER(sender_email) = $2 OR LOWER(receiver_email) = $2)', [id, me])
        : await pool.query('SELECT 1 FROM group_messages gm JOIN chat_group_members m ON m.group_id = gm.group_id WHERE gm.id = $1 AND LOWER(m.user_email) = $2', [id, me]);
      if (!ok.rows.length) return res.status(404).json({ success: false });
      await pool.query('INSERT INTO message_hides (user_email, kind, message_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [me, kind, id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  // used by the message lists: which of these messages did this person hide for themselves
  async function hiddenFor(me, kind, ids) {
    try {
      if (!ids || !ids.length) return new Set();
      await ensure();
      const r = await pool.query('SELECT message_id FROM message_hides WHERE user_email = $1 AND kind = $2 AND message_id = ANY($3::int[])', [norm(me), kind, ids.map(Number)]);
      return new Set(r.rows.map((x) => Number(x.message_id)));
    } catch (e) { return new Set(); }
  }

  // used by the message list: when did this person delete this conversation for themselves (null = never)
  async function clearedAt(me, peer) {
    try {
      await ensure();
      const r = await pool.query('SELECT cleared_at FROM chat_prefs WHERE user_email = $1 AND peer = $2', [norm(me), String(peer).startsWith('group:') ? peer : norm(peer)]);
      return r.rows[0] ? r.rows[0].cleared_at : null;
    } catch (e) { return null; }
  }

  // used by push: should a new message from `from` ring on `to`'s phone?
  async function shouldNotify(to, from, peerKey) {
    try {
      await ensure();
      const peer = peerKey || norm(from);
      const r = await pool.query('SELECT muted, muted_until, restricted, accepted FROM chat_prefs WHERE user_email = $1 AND peer = $2', [norm(to), peer]);
      const p = r.rows[0];
      if (p && (mutedNow(p) || p.restricted)) return false;
      if (!p || !p.muted) {                                  // muted on the website (its own list)
        const w = await pool.query('SELECT 1 FROM chat_mutes WHERE user_email = $1 AND peer_email = $2', [norm(to), peer]).catch(() => ({ rows: [] }));
        if (w.rows.length && !(p && p.muted_until)) return false;
      }
      if (peer.startsWith('group:')) return true;
      if (p && p.accepted) return true;
      const u = await pool.query('SELECT COALESCE(msg_requests_on, FALSE) AS on FROM users WHERE LOWER(email) = $1', [norm(to)]);
      if (!(u.rows[0] && u.rows[0].on)) return true;
      const k = await pool.query(`SELECT 1 FROM follows WHERE LOWER(follower_email) = $1 AND LOWER(following_email) = $2
                                  UNION SELECT 1 FROM messages WHERE LOWER(sender_email) = $1 AND LOWER(receiver_email) = $2 LIMIT 1`, [norm(to), norm(from)]);
      return k.rows.length > 0;           // a stranger's message waits quietly in Message requests
    } catch (e) { return true; }
  }

  // calls: has `to` restricted `from`? (then a call from `from` does not ring; it shows later as a missed call)
  async function isRestricted(to, from) {
    try {
      await ensure();
      const r = await pool.query('SELECT restricted FROM chat_prefs WHERE user_email = $1 AND peer = $2', [norm(to), norm(from)]);
      return !!(r.rows[0] && r.rows[0].restricted);
    } catch (e) { return false; }
  }

  return { clearedAt, shouldNotify, isRestricted, hiddenFor };
};
