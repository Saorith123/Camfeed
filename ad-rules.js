// 📜 CamFeed's rules for ads: kinds of things that are never advertised (⛔ block) or only to adults (🔞 18+).
// The Admin changes the list (Admin › 📢 Ads › 📜 Ad rules). The AI (Gemini) looks at each new ad (pictures + text) and says which rule
// it seems to touch; the owner sees that in Telegram before pressing ✅. The AI only warns — a person always decides.
'use strict';

const SEED = [
  ['ល្បែងភ្នាល់ / កាស៊ីណូ', 'Gambling / casino / betting', 'block'],
  ['គ្រឿងញៀន', 'Illegal drugs', 'block'],
  ['អាវុធ និងគ្រឿងផ្ទុះ', 'Weapons and explosives', 'block'],
  ['ខ្លឹមសារផ្លូវភេទ / អាសអាភាស', 'Sexual / adult content', 'block'],
  ['ការបោកប្រាស់ / រកលុយលឿនមិនពិត', 'Scams / get-rich-quick', 'block'],
  ['បារី និងបារីអេឡិចត្រូនិក', 'Tobacco and e-cigarettes / vapes', 'block'],
  ['ឱសថគ្មានអាជ្ញាប័ណ្ណ / ព្យាបាលអស្ចារ្យ', 'Unlicensed medicine / miracle cures', 'block'],
  ['គ្រឿងស្រវឹង (ស្រា បៀរ)', 'Alcohol (wine, beer, spirits)', 'adult'],
];

module.exports = function ({ app, pool, adminGate, audit, interests }) {
  let ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS ad_rules (id SERIAL PRIMARY KEY, name_km TEXT NOT NULL, name_en TEXT NOT NULL DEFAULT '', rule VARCHAR(8) NOT NULL DEFAULT 'block',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE TABLE IF NOT EXISTS ad_rules_state (k TEXT PRIMARY KEY, v TEXT)');
      for (const t of ['ad_requests', 'sponsored_ads']) {
        await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS adult BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS ai_note TEXT NOT NULL DEFAULT ''`);
      }
      const s = (await pool.query("SELECT v FROM ad_rules_state WHERE k = 'seeded'")).rows[0];
      if (!s) {
        for (const [km, en, r] of SEED) await pool.query('INSERT INTO ad_rules (name_km, name_en, rule) VALUES ($1, $2, $3)', [km, en, r]);
        await pool.query("INSERT INTO ad_rules_state (k, v) VALUES ('seeded', '1') ON CONFLICT DO NOTHING");
      }
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  ensure().catch((e) => console.error('[ad-rules] setup:', e.message));

  // the AI looks at one ad request; writes what it found (and makes it 18+ when the rule says so)
  async function check(reqId) {
    try {
      await ensure();
      const q = (await pool.query('SELECT id, caption, media_url, items, post_id FROM ad_requests WHERE id = $1', [reqId])).rows[0];
      if (!q) return;
      const rules = (await pool.query('SELECT id, name_km, name_en, rule FROM ad_rules ORDER BY id')).rows;
      if (!rules.length) return;
      let text = String(q.caption || ''), urls = [];
      let items = []; try { items = JSON.parse(q.items || '[]'); } catch (e) {}
      if (Array.isArray(items)) { urls = items.map((x) => x && (x.url || x.image)).filter(Boolean); text += ' ' + items.map((x) => x && x.name).filter(Boolean).join(', '); }
      if (q.post_id) {
        const p = (await pool.query('SELECT content, media_url FROM posts WHERE id = $1', [q.post_id])).rows[0];
        if (p) { text += ' ' + (p.content || ''); try { const j = JSON.parse(p.media_url); if (Array.isArray(j)) urls = j.map((x) => x.url); } catch (e) { if (p.media_url) urls = [p.media_url]; } }
      }
      if (!urls.length && q.media_url) urls = [q.media_url];
      const frames = await interests.framesOfUrls(urls.slice(0, 3));
      const list = rules.map((r) => `${r.id}: ${r.name_en} (${r.name_km}) -> ${r.rule === 'adult' ? 'adults only' : 'not allowed'}`).join('\n');
      const prompt = `You check ads for CamFeed, a Cambodian social app. Look at the picture(s) and the text of this ad.
Does it advertise something in this RULE LIST? Only say yes when it is clear from the pictures or the text.
RULE LIST (id: kind -> what happens):
${list}
Ad text: """${text.slice(0, 1500)}"""
Answer only JSON: {"rule_id": number or 0 when none, "sure": 0.0-1.0, "why": "one short sentence in Khmer"}`;
      const ans = await interests.geminiJson(prompt, frames);
      if (!ans || ans.retry) { await pool.query("UPDATE ad_requests SET ai_note = $2 WHERE id = $1", [reqId, '🤖 AI មិនបានពិនិត្យ (' + (interests.lastAiError() || 'no answer') + ')']); return; }
      const r = rules.find((x) => x.id === Number(ans.rule_id));
      if (!r || Number(ans.sure) < 0.5) { await pool.query("UPDATE ad_requests SET ai_note = $2 WHERE id = $1", [reqId, '🤖 AI៖ មិនឃើញបញ្ហា']); return; }
      const note = (r.rule === 'adult' ? '🔞 AI៖ ទំនងជា «' + r.name_km + '» → បង្ហាញតែអ្នកអាយុ 18+' : '⛔ AI៖ ទំនងជា «' + r.name_km + '» (មិនអនុញ្ញាត)') + (ans.why ? ' · ' + String(ans.why).slice(0, 160) : '');
      await pool.query(`UPDATE ad_requests SET ai_note = $2, adult = (adult OR $3), age_min = CASE WHEN $3 AND age_min < 18 THEN 18 ELSE age_min END WHERE id = $1`, [reqId, note, r.rule === 'adult']);
    } catch (e) { console.error('[ad-rules] check:', e.message); }
  }

  // Admin › 📢 Ads › 📜 Ad rules
  app.post('/api/admin/ad-rules', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure();
      const b = req.body || {}, act = String(b.action || 'list');
      if (act === 'add' || act === 'edit') {
        const km = String(b.name_km || '').trim().slice(0, 80), en = String(b.name_en || '').trim().slice(0, 80), rule = b.rule === 'adult' ? 'adult' : 'block';
        if (!km) return res.status(400).json({ success: false, error: 'Write the name (Khmer).' });
        if (act === 'add') await pool.query('INSERT INTO ad_rules (name_km, name_en, rule) VALUES ($1, $2, $3)', [km, en, rule]);
        else await pool.query('UPDATE ad_rules SET name_km = $2, name_en = $3, rule = $4 WHERE id = $1', [parseInt(b.id, 10) || 0, km, en, rule]);
        try { audit(a.adminEmail, 'ad-rules.' + act, km, rule); } catch (e) {}
      } else if (act === 'delete') {
        await pool.query('DELETE FROM ad_rules WHERE id = $1', [parseInt(b.id, 10) || 0]);
        try { audit(a.adminEmail, 'ad-rules.delete', String(b.id), ''); } catch (e) {}
      }
      const rules = (await pool.query('SELECT id, name_km, name_en, rule FROM ad_rules ORDER BY rule DESC, id')).rows;
      res.json({ success: true, rules });
    } catch (e) { console.error('[ad-rules] admin:', e.message); res.status(500).json({ success: false, error: 'Could not do it.' }); }
  });

  return { check, ensure };
};
