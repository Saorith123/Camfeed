// App config the Admin controls (Admin > System > 🧩 App features & lists).
// The app and the website read GET /api/app-config, so most changes need no app update.
// Saved in creator_settings as 'app:config' (only the keys the Admin changed; the rest come from DEFAULTS).
const DEFAULTS = {
  features: {
    challenge: true, wallet: true, checkin: true, stars: true, ranking: true, vip: true, frames: true,
    coins: true, saveSound: true, watchHistory: true, partyRoom: true, partyFollowers: true, roomClock: true, chatFiles: true,
    beauty: false,      // ✨ off until it is safe on every phone (it closed the app on some)
    chatBubbles: true,  // 💬 a new chat message pops up as a round picture over other apps (Android)
  },
  reportReasons: {
    post: [
      { id: 'Nudity or Sexual Content (អាសអាភាស)', km: '🔞 អាសអាភាស ឬផ្លូវភេទ', en: '🔞 Nudity or sexual content' },
      { id: 'Violence or Harmful Content (អំពើហិង្សា)', km: '⚠️ អំពើហិង្សា ឬគ្រោះថ្នាក់', en: '⚠️ Violence or harmful content' },
      { id: 'Scam, Fraud or Fake News (បោកប្រាស់)', km: '🚫 ការបោកប្រាស់ ឬព័ត៌មានក្លែងក្លាយ', en: '🚫 Scam, fraud or fake news' },
      { id: 'Harassment or Hate Speech (រំលោភបំពាន)', km: '💢 ការជេរប្រមាថ ឬរំលោភបំពាន', en: '💢 Harassment or hate speech' },
    ],
    chat: [
      { id: 'sexual', km: '🔞 អាសអាភាស ឬផ្លូវភេទ', en: '🔞 Nudity or sexual content' },
      { id: 'scam', km: '💸 បោកប្រាស់', en: '💸 Scam' },
      { id: 'harass', km: '💢 ជេរប្រមាថ ឬរំលោភ', en: '💢 Insults or harassment' },
      { id: 'violence', km: '⚠️ ហិង្សា ឬគំរាមកំហែង', en: '⚠️ Violence or threats' },
      { id: 'child', km: '🧒 ពាក់ព័ន្ធកុមារ', en: '🧒 Involves a child' },
      { id: 'spam', km: '📢 សាររំខាន', en: '📢 Spam' },
      { id: 'other', km: '❓ ផ្សេងៗ', en: '❓ Other' },
    ],
    room: [
      { id: 'ពាក្យអាសអាភាស ឬជេរប្រមាថ', km: 'ពាក្យអាសអាភាស ឬជេរប្រមាថ', en: 'Rude or insulting words' },
      { id: 'ខ្លឹមសារផ្លូវភេទ', km: 'ខ្លឹមសារផ្លូវភេទ', en: 'Sexual content' },
      { id: 'អំពើហិង្សា ឬគំរាមកំហែង', km: 'អំពើហិង្សា ឬគំរាមកំហែង', en: 'Violence or threats' },
      { id: 'បោកប្រាស់', km: 'បោកប្រាស់', en: 'Scam' },
      { id: 'ផ្សេងៗ', km: 'ផ្សេងៗ', en: 'Other' },
    ],
  },
  chatTtlHours: [0, 24, 168, 720, 4380, 8760],
  giftCounts: [1, 10],
  storySoundSeconds: 15,
  party: { metMinutes: 10, metDays: 30, followNotifyMinutes: 60, challengeMinOthers: 1 },
  watchHistoryDays: 90,
  feed: { reshowDays: 7, oldMax: 3, mix: { friends: 25, follow: 20, trending: 20, interest: 15, fresh: 10, discover: 10, freshHours: 24, trendMin: 3 } },
  people: { randomPct: 15 },   // "people you may know": this share of the list is chosen by chance (to meet new people)
  files: { maxMB: 50, perDay: 50, blocked: ['apk', 'xapk', 'apks', 'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'vbs', 'ps1', 'jar', 'dll', 'sh'] },
};

let pool = null, cache = null, cacheAt = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };

// make what the Admin sent safe: only known keys, numbers inside sensible limits, short texts
function clean(raw) {
  const o = {}, r = raw && typeof raw === 'object' ? raw : {};
  if (r.features && typeof r.features === 'object') {
    o.features = {};
    for (const k of Object.keys(DEFAULTS.features)) if (typeof r.features[k] === 'boolean') o.features[k] = r.features[k];
  }
  if (r.reportReasons && typeof r.reportReasons === 'object') {
    o.reportReasons = {};
    for (const k of Object.keys(DEFAULTS.reportReasons)) {
      const list = r.reportReasons[k]; if (!Array.isArray(list)) continue;
      const out = [];
      for (const x of list.slice(0, 15)) {
        if (!x || typeof x !== 'object') continue;
        const km = String(x.km || '').trim().slice(0, 80), en = String(x.en || '').trim().slice(0, 80);
        let id = String(x.id || en || km).trim().slice(0, 80);
        if (k === 'chat') id = id.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);      // chat_reports.reason is VARCHAR(20)
        if (id && km && en && !out.some((y) => y.id === id)) out.push({ id, km, en });
      }
      if (out.length) o.reportReasons[k] = out;
    }
  }
  if (Array.isArray(r.chatTtlHours)) { const l = [...new Set(r.chatTtlHours.map((v) => num(v, 0, 87600, -1)).filter((v) => v >= 0))].sort((a, b) => a - b).slice(0, 10); if (l.length) o.chatTtlHours = l; }
  if (Array.isArray(r.giftCounts)) { const l = [...new Set(r.giftCounts.map((v) => num(v, 1, 9999, 0)).filter((v) => v > 0))].sort((a, b) => a - b).slice(0, 6); if (l.length) o.giftCounts = l; }
  if (r.storySoundSeconds !== undefined) o.storySoundSeconds = num(r.storySoundSeconds, 5, 30, 15);
  if (r.watchHistoryDays !== undefined) o.watchHistoryDays = num(r.watchHistoryDays, 1, 3650, 90);
  if (r.feed && typeof r.feed === 'object') {
    o.feed = {};
    if (r.feed.reshowDays !== undefined) o.feed.reshowDays = num(r.feed.reshowDays, 1, 365, 7);
    if (r.feed.oldMax !== undefined) o.feed.oldMax = num(r.feed.oldMax, 0, 30, 3);
    if (r.feed.mix && typeof r.feed.mix === 'object') {
      const m = r.feed.mix, d = DEFAULTS.feed.mix; o.feed.mix = {};
      for (const k of ['friends', 'follow', 'trending', 'interest', 'fresh', 'discover']) if (m[k] !== undefined) o.feed.mix[k] = num(m[k], 0, 100, d[k]);
      if (m.freshHours !== undefined) o.feed.mix.freshHours = num(m.freshHours, 1, 168, 24);
      if (m.trendMin !== undefined) o.feed.mix.trendMin = num(m.trendMin, 1, 1000, 3);
    }
  }
  if (r.people && typeof r.people === 'object') {
    o.people = {};
    if (r.people.randomPct !== undefined) o.people.randomPct = num(r.people.randomPct, 0, 100, 15);
  }
  if (r.files && typeof r.files === 'object') {
    const f = r.files; o.files = {};
    if (f.maxMB !== undefined) o.files.maxMB = num(f.maxMB, 1, 500, 50);
    if (f.perDay !== undefined) o.files.perDay = num(f.perDay, 1, 1000, 50);
    if (Array.isArray(f.blocked)) o.files.blocked = [...new Set(f.blocked.map((x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)).filter(Boolean))].slice(0, 60);
  }
  if (r.party && typeof r.party === 'object') {
    const p = r.party; o.party = {};
    if (p.metMinutes !== undefined) o.party.metMinutes = num(p.metMinutes, 1, 600, 10);
    if (p.metDays !== undefined) o.party.metDays = num(p.metDays, 1, 365, 30);
    if (p.followNotifyMinutes !== undefined) o.party.followNotifyMinutes = num(p.followNotifyMinutes, 0, 10080, 60);
    if (p.challengeMinOthers !== undefined) o.party.challengeMinOthers = num(p.challengeMinOthers, 0, 50, 1);
  }
  return o;
}

function merge(saved) {
  const c = clone(DEFAULTS), s = clean(saved);
  if (s.features) Object.assign(c.features, s.features);
  if (s.reportReasons) Object.assign(c.reportReasons, s.reportReasons);
  if (s.party) Object.assign(c.party, s.party);
  if (s.files) Object.assign(c.files, s.files);
  if (s.feed) { const m = Object.assign({}, c.feed.mix, s.feed.mix || {}); Object.assign(c.feed, s.feed); c.feed.mix = m; }
  if (s.people) Object.assign(c.people, s.people);
  for (const k of ['chatTtlHours', 'giftCounts', 'storySoundSeconds', 'watchHistoryDays']) if (s[k] !== undefined) c[k] = s[k];
  return c;
}

async function savedRaw() {
  const r = await pool.query("SELECT value FROM creator_settings WHERE key = 'app:config'").catch(() => ({ rows: [] }));
  try { return r.rows[0] ? JSON.parse(r.rows[0].value) : {}; } catch (e) { return {}; }
}
async function load() { cache = merge(await savedRaw()); cacheAt = Date.now(); return cache; }
// sync: the last known config (refreshed in the background every 30 s); before the first load → defaults
function cfg() { if (pool && Date.now() - cacheAt > 30000) { cacheAt = Date.now(); load().catch(() => {}); } return cache || clone(DEFAULTS); }

function install({ app, pool: p, adminGate, audit }) {
  pool = p; load().catch(() => {});
  app.get('/api/app-config', async (req, res) => {
    try { res.json({ success: true, config: Date.now() - cacheAt > 30000 ? await load() : cache || await load() }); }
    catch (e) { res.json({ success: true, config: clone(DEFAULTS) }); }
  });
  app.post('/api/admin/app-config', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      const b = req.body || {};
      if (b.action === 'save' || b.action === 'reset') {
        if (!a.isSuperAdmin) return res.status(403).json({ success: false, error: 'Only a Super Admin can change the app settings.' });
        if (b.action === 'reset') await pool.query("DELETE FROM creator_settings WHERE key = 'app:config'");
        else {
          const saved = { ...(await savedRaw()), ...clean(b.config) };
          await pool.query("INSERT INTO creator_settings (key, value) VALUES ('app:config', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(saved)]);
        }
        await load();
        try { audit(a.adminEmail, 'app_config_' + b.action, null, b.action === 'save' ? Object.keys(clean(b.config)).join(',') : 'all'); } catch (e) {}
      }
      res.json({ success: true, config: await load(), defaults: DEFAULTS, saved: await savedRaw(), isSuperAdmin: a.isSuperAdmin });
    } catch (e) { console.error('app-config', e.message); res.status(500).json({ success: false, error: 'Could not save.' }); }
  });
}

module.exports = { install, cfg, DEFAULTS };
