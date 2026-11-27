// 📅 Money from VIEWS goes by month (like Facebook): during the month it is counted (the creator sees it grow), then early
// next month CamFeed checks each creator and approves the month (optionally taking away money for bad views). Only then
// can it be withdrawn (wallet-pockets.js locks it until then). Bonuses given by the Admin by hand are not locked.
//   POST /api/admin/earn-months           { month? }                        the months + one month's creators
//   POST /api/admin/earn-months/approve   { month, creators: [{ creator, cut, note }] }  or { month, all: true }
// The Admin app shows how many wait; on the 1st–10th of a month the team gets one reminder a day while any wait.
'use strict';

const { KH_MONTH, NOW_MONTH } = require('./wallet-pockets');

// creators × months with money from views in past months that CamFeed has not approved yet
const PENDING_SQL = `SELECT COUNT(*) FROM (SELECT LOWER(user_email) AS e, ${KH_MONTH} AS m FROM wallet_ledger
    WHERE kind = 'revenue_share' AND amount_cents > 0 AND ${KH_MONTH} < ${NOW_MONTH} GROUP BY 1, 2) x
    WHERE NOT EXISTS (SELECT 1 FROM earn_months em WHERE em.user_email = x.e AND em.month = x.m AND em.approved_at IS NOT NULL)`;

module.exports = function earnMonths({ app, pool, adminGate, audit, notify, remind }) {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const nowMonth = async () => (await pool.query(`SELECT ${NOW_MONTH} AS m`)).rows[0].m;
  const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); };
  const KM_MONTHS = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
  const kmMonth = (m) => { const [y, mo] = m.split('-').map(Number); return 'ខែ' + KM_MONTHS[mo - 1] + ' ' + y; };

  async function pendingCount() { try { return Number(Object.values((await pool.query(PENDING_SQL)).rows[0])[0]) || 0; } catch (e) { return 0; } }

  app.post('/api/admin/earn-months', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      const cur = await nowMonth();
      const month = MONTH_RE.test(String(b.month || '')) ? String(b.month) : prevMonth(cur);
      // the last 12 months that had money from views, with how many creators wait in each
      const months = (await pool.query(`SELECT ${KH_MONTH} AS month, COUNT(DISTINCT LOWER(user_email))::int AS people, SUM(amount_cents)::bigint AS cents,
            COUNT(DISTINCT LOWER(user_email)) FILTER (WHERE NOT EXISTS (SELECT 1 FROM earn_months em WHERE em.user_email = LOWER(wallet_ledger.user_email)
              AND em.month = ${KH_MONTH.replace('created_at', 'wallet_ledger.created_at')} AND em.approved_at IS NOT NULL))::int AS waiting
          FROM wallet_ledger WHERE kind = 'revenue_share' AND amount_cents > 0 GROUP BY 1 ORDER BY 1 DESC LIMIT 12`)).rows
        .map((x) => ({ month: x.month, label: kmMonth(x.month), people: x.people, earned: Number(x.cents) / 100, waiting: x.month < cur ? x.waiting : 0, current: x.month === cur }));
      const rows = (await pool.query(`WITH m AS (SELECT LOWER(user_email) AS e, SUM(amount_cents)::bigint AS cents FROM wallet_ledger
              WHERE kind = 'revenue_share' AND amount_cents > 0 AND ${KH_MONTH} = $1 GROUP BY 1),
            v AS (SELECT LOWER(user_email) AS e, SUM(views)::bigint AS views, COUNT(DISTINCT post_id)::int AS videos FROM earn_log WHERE ${KH_MONTH} = $1 GROUP BY 1)
          SELECT m.e AS email, m.cents, COALESCE(v.views, 0) AS views, COALESCE(v.videos, 0) AS videos, em.approved_at, em.approved_by, em.cut_cents, em.note,
                 u.first_name, u.last_name, u.profile_pic, u.public_id
            FROM m LEFT JOIN v ON v.e = m.e LEFT JOIN earn_months em ON em.user_email = m.e AND em.month = $1 LEFT JOIN users u ON LOWER(u.email) = m.e
           ORDER BY (em.approved_at IS NULL) DESC, m.cents DESC LIMIT 500`, [month]).catch(async (e) => {
        if (!/earn_log/.test(e.message)) throw e;   // an old database without the view log
        return pool.query(`SELECT LOWER(w.user_email) AS email, SUM(w.amount_cents)::bigint AS cents, 0 AS views, 0 AS videos, NULL AS approved_at, NULL AS approved_by, 0 AS cut_cents, NULL AS note,
            '' AS first_name, '' AS last_name, '' AS profile_pic, '' AS public_id FROM wallet_ledger w WHERE w.kind = 'revenue_share' AND w.amount_cents > 0 AND to_char(w.created_at AT TIME ZONE 'Asia/Phnom_Penh', 'YYYY-MM') = $1 GROUP BY 1`, [month]);
      })).rows.map((x) => ({
        email: x.email, name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), pic: x.profile_pic || '', public_id: x.public_id || '',
        earned: Number(x.cents) / 100, views: Number(x.views) || 0, videos: Number(x.videos) || 0,
        approved: !!x.approved_at, approvedAt: x.approved_at, approvedBy: x.approved_by === 'system' ? 'system' : (x.approved_by ? 'admin' : ''), cut: (Number(x.cut_cents) || 0) / 100, note: x.note || '',
      }));
      res.json({ success: true, month, label: kmMonth(month), current: month === cur, canApprove: month < cur, isSuperAdmin: a.isSuperAdmin, months, creators: rows, waitingAll: await pendingCount() });
    } catch (err) { console.error('[earn-months] list error:', err.message); res.status(500).json({ success: false, error: 'Could not load.' }); }
  });

  app.post('/api/admin/earn-months/approve', async (req, res) => {
    const b = req.body || {};
    try {
      const a = await adminGate(req, res); if (!a) return;
      if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can approve money.' });
      const month = String(b.month || '');
      if (!MONTH_RE.test(month)) return res.status(400).json({ success: false, error: 'Choose a month.' });
      if (month >= await nowMonth()) return res.status(400).json({ success: false, error: 'This month is not finished yet: approve it from the 1st of next month.' });
      // who: the list sent, or everybody still waiting in that month
      let list = Array.isArray(b.creators) ? b.creators.slice(0, 500) : [];
      if (b.all === true) {
        list = (await pool.query(`SELECT DISTINCT LOWER(user_email) AS creator FROM wallet_ledger w WHERE kind = 'revenue_share' AND amount_cents > 0 AND ${KH_MONTH} = $1
            AND NOT EXISTS (SELECT 1 FROM earn_months em WHERE em.user_email = LOWER(w.user_email) AND em.month = $1 AND em.approved_at IS NOT NULL)`, [month])).rows;
      }
      let done = 0, cutTotal = 0;
      for (const it of list) {
        const who = String((it && it.creator) || '').trim().toLowerCase(); if (!who) continue;
        const earned = Number((await pool.query(`SELECT COALESCE(SUM(amount_cents), 0)::bigint AS c FROM wallet_ledger WHERE LOWER(user_email) = $1 AND kind = 'revenue_share' AND amount_cents > 0 AND ${KH_MONTH} = $2`, [who, month])).rows[0].c) || 0;
        if (earned <= 0) continue;
        const cut = Math.max(0, Math.min(earned, Math.round((Number(it.cut) || 0) * 100)));
        const note = String(it.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        // only once: a month that is already approved is never approved (or cut) again
        const ins = await pool.query(`INSERT INTO earn_months (user_email, month, earned_cents, cut_cents, note, approved_at, approved_by) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
            ON CONFLICT (user_email, month) DO UPDATE SET earned_cents = EXCLUDED.earned_cents, cut_cents = EXCLUDED.cut_cents, note = EXCLUDED.note, approved_at = NOW(), approved_by = EXCLUDED.approved_by
            WHERE earn_months.approved_at IS NULL RETURNING user_email`, [who, month, earned, cut, note || null, a.adminEmail]);
        if (!ins.rows.length) continue;
        if (cut > 0) {
          await pool.query("INSERT INTO wallet_ledger (user_email, amount_cents, kind, note, created_by, pocket) VALUES ($1, $2, 'revenue_cut', $3, $4, 'content')",
            [who, -cut, 'Views not counted for ' + month + (note ? ': ' + note : ''), a.adminEmail]);
          cutTotal += cut;
        }
        done++;
        const paid = (earned - cut) / 100;
        if (notify) notify(who, `💵 CamFeed បានពិនិត្យប្រាក់ពីការមើលវីដេអូ ${kmMonth(month)} រួចហើយ។ $${paid.toFixed(2)} អាចដកបានឥឡូវ` + (cut > 0 ? ` (ដកចេញ $${(cut / 100).toFixed(2)} សម្រាប់ដងមើលដែលមិនត្រឹមត្រូវ${note ? ': ' + note : ''})។` : '។')).catch(() => {});
      }
      if (audit) audit(a.adminEmail, 'earn-month-approve', month, done + ' creators' + (cutTotal ? ', cut $' + (cutTotal / 100).toFixed(2) : ''));
      res.json({ success: true, approved: done, cut: cutTotal / 100 });
    } catch (err) { console.error('[earn-months] approve error:', err.message); res.status(500).json({ success: false, error: 'Could not approve.' }); }
  });

  // 🔔 1st–10th of a month, once a day (after 9:00 Cambodia time): remind the team while creators wait
  async function daily() {
    try {
      if (!remind) return;
      const kh = new Date(Date.now() + 7 * 3600000);
      if (kh.getUTCDate() > 10 || kh.getUTCHours() < 9) return;
      const day = kh.toISOString().slice(0, 10);
      const last = (await pool.query("SELECT value FROM creator_settings WHERE key = 'earn_months_remind'").catch(() => ({ rows: [] }))).rows[0];
      if (last && last.value === day) return;
      const n = await pendingCount(); if (!n) return;
      await pool.query("INSERT INTO creator_settings (key, value) VALUES ('earn_months_remind', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [day]);
      await remind('📅 ប្រាក់ពីការមើលខែមុន រង់ចាំអនុម័ត', 'អ្នកបង្កើតមាតិកា ' + n + ' នាក់ កំពុងរង់ចាំ', { open: 'web' });
    } catch (e) { console.error('[earn-months] reminder:', e.message); }
  }
  const t = setInterval(daily, 15 * 60 * 1000); if (t.unref) t.unref();

  return { pendingCount };
};
module.exports.PENDING_SQL = PENDING_SQL;
