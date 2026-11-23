// 🏷️ CamFeed keywords: every post gets keywords from one shared list (the AI chooses them from 3 frames of the video / the pictures + the caption),
// every person gets keyword scores from what they do (search, watch to the end, skip, like, comment, share, open a profile),
// and the feed / ads match the two. Scores fade with time: "now" (half in 3 days) and "long" (half in 14 days).
// 🔒 Chat messages are never read for this. A person can see and delete their keywords (/api/me/interests).
'use strict';

const CATS = ['Comedy', 'Music', 'Gaming', 'Food', 'Vehicles & Motorcycles', 'Technology', 'News', 'Sports', 'Education', 'Travel', 'Lifestyle', 'General'];
const HL_SHORT = 3 * 86400, HL_LONG = 14 * 86400;
const GROUP_SHARE = 0.3;          // a keyword of the same group counts 30 % (MacBook ↔ Dell laptop)

// [word, group, category, synonyms]  — Admin › 🏷️ AI Keywords can change all of this
const SEED = [
  ['ទូរស័ព្ទ', 'អេឡិចត្រូនិក', 'Technology', 'phone, smartphone, ទូរសព្ទ, iphone, samsung, oppo, vivo, xiaomi, redmi, realme'],
  ['iPhone', 'អេឡិចត្រូនិក', 'Technology', 'iphone, អាយហ្វូន, apple phone'],
  ['កុំព្យូទ័រ', 'អេឡិចត្រូនិក', 'Technology', 'computer, pc, កំព្យូទ័រ, desktop'],
  ['កុំព្យូទ័រយួរដៃ', 'អេឡិចត្រូនិក', 'Technology', 'laptop, notebook, ឡេបថប, ឡាបថប, កុំព្យូទ័រយួរដៃ'],
  ['MacBook', 'អេឡិចត្រូនិក', 'Technology', 'macbook, mac, ម៉េកប៊ុក'],
  ['ថេប្លេត', 'អេឡិចត្រូនិក', 'Technology', 'tablet, ipad, អាយផេត'],
  ['កាមេរ៉ា', 'អេឡិចត្រូនិក', 'Technology', 'camera, ម៉ាស៊ីនថត, gopro'],
  ['កាស និងឧបករណ៍ស្ដាប់', 'អេឡិចត្រូនិក', 'Technology', 'headphone, earphone, airpods, កាស, speaker, ឧបករណ៍បំពងសំឡេង'],
  ['នាឡិកា', 'អេឡិចត្រូនិក', 'Technology', 'watch, smartwatch, apple watch'],
  ['ជួសជុលទូរស័ព្ទ និងកុំព្យូទ័រ', 'អេឡិចត្រូនិក', 'Technology', 'repair, ជួសជុល, ប្ដូរអេក្រង់'],
  ['AI និងកម្មវិធី', 'អេឡិចត្រូនិក', 'Technology', 'ai, app, software, chatgpt, កម្មវិធី'],
  ['ម៉ូតូ', 'យានយន្ត', 'Vehicles & Motorcycles', 'motorbike, motorcycle, moto, honda, dream, scoopy, ម៉ូតូឌុប, yamaha'],
  ['ឡាន', 'យានយន្ត', 'Vehicles & Motorcycles', 'car, រថយន្ត, toyota, lexus, prius, ford, ranger, ឡានលក់'],
  ['ឡានអគ្គិសនី', 'យានយន្ត', 'Vehicles & Motorcycles', 'ev, electric car, tesla, byd'],
  ['កង់', 'យានយន្ត', 'Vehicles & Motorcycles', 'bicycle, bike, កង់អគ្គិសនី'],
  ['គ្រឿងបន្លាស់ និងជួសជុលយានយន្ត', 'យានយន្ត', 'Vehicles & Motorcycles', 'parts, garage, ជួសជុលឡាន, កង់ឡាន, ប្រេងម៉ាស៊ីន'],
  ['ម្ហូបខ្មែរ', 'ម្ហូប', 'Food', 'khmer food, សម្លម្ជូរ, អាម៉ុក, ប្រហុក, បាយ'],
  ['អាហារតាមផ្លូវ', 'ម្ហូប', 'Food', 'street food, ម្ហូបសម្រន់, អាំង, ចៀន'],
  ['ធ្វើម្ហូប', 'ម្ហូប', 'Food', 'cooking, recipe, របៀបធ្វើម្ហូប, chef'],
  ['បង្អែម និងនំ', 'ម្ហូប', 'Food', 'dessert, cake, នំ, បង្អែម, bakery'],
  ['កាហ្វេ និងភេសជ្ជៈ', 'ម្ហូប', 'Food', 'coffee, cafe, កាហ្វេ, តែ, តែគុជ, milk tea, drink, ភេសជ្ជៈ'],
  ['ភោជនីយដ្ឋាន', 'ម្ហូប', 'Food', 'restaurant, ហាងបាយ, buffet, ប៊ូហ្វេ'],
  ['ផ្លែឈើ', 'ម្ហូប', 'Food', 'fruit, ស្វាយ, ធូរេន, durian, mango'],
  ['សម្លៀកបំពាក់', 'ម៉ូដ និងសម្រស់', 'Lifestyle', 'clothes, fashion, អាវ, ខោ, សំពត់, dress, ម៉ូដ'],
  ['ស្បែកជើង', 'ម៉ូដ និងសម្រស់', 'Lifestyle', 'shoes, sneakers, nike, adidas'],
  ['កាបូប', 'ម៉ូដ និងសម្រស់', 'Lifestyle', 'bag, handbag, wallet'],
  ['គ្រឿងសម្អាង', 'ម៉ូដ និងសម្រស់', 'Lifestyle', 'makeup, cosmetics, ម៉េកអាប់, lipstick, ក្រែមលាបមាត់'],
  ['ថែរក្សាស្បែក', 'ម៉ូដ និងសម្រស់', 'Lifestyle', 'skincare, ក្រែម, serum, ស្បែកស'],
  ['សក់ និងហាងសម្អាង', 'ម៉ូដ និងសម្រស់', 'Lifestyle', 'hair, salon, កាត់សក់, ពណ៌សក់, barber'],
  ['គ្រឿងអលង្ការ', 'ម៉ូដ និងសម្រស់', 'Lifestyle', 'jewelry, មាស, gold, ចិញ្ចៀន, ខ្សែក'],
  ['លក់ទំនិញអនឡាញ', 'ទិញ និងលក់', 'Lifestyle', 'online shop, លក់, for sale, ទិញ, ហាង, shop, ទំនិញ'],
  ['បញ្ចុះតម្លៃ', 'ទិញ និងលក់', 'Lifestyle', 'promotion, discount, sale, ប្រូម៉ូសិន, បញ្ចុះតម្លៃ'],
  ['ដឹកជញ្ជូន', 'ទិញ និងលក់', 'Lifestyle', 'delivery, ដឹកជញ្ជូន, ផ្ញើឥវ៉ាន់'],
  ['ផ្ទះ និងដី', 'ផ្ទះ និងកសិកម្ម', 'Lifestyle', 'house, land, real estate, ដី, ផ្ទះលក់, ខុនដូ, condo, បុរី'],
  ['គ្រឿងសង្ហារឹម និងតុបតែងផ្ទះ', 'ផ្ទះ និងកសិកម្ម', 'Lifestyle', 'furniture, interior, តុ, កៅអី, គ្រែ, decor'],
  ['ឧបករណ៍ប្រើប្រាស់ក្នុងផ្ទះ', 'ផ្ទះ និងកសិកម្ម', 'Lifestyle', 'home appliance, ទូទឹកកក, ម៉ាស៊ីនបោកខោអាវ, ម៉ាស៊ីនត្រជាក់, aircon'],
  ['ដាំដុះ និងសួនច្បារ', 'ផ្ទះ និងកសិកម្ម', 'Lifestyle', 'garden, plants, ដាំបន្លែ, ផ្កា, flowers'],
  ['កសិកម្ម និងចិញ្ចឹមសត្វ', 'ផ្ទះ និងកសិកម្ម', 'Lifestyle', 'farming, agriculture, ចិញ្ចឹមមាន់, ចិញ្ចឹមត្រី, ស្រូវ, គោ'],
  ['រឿងភាគ និងភាពយន្ត', 'កម្សាន្ត', 'Lifestyle', 'movie, film, drama, រឿង, រឿងភាគ, series, ភាពយន្ត'],
  ['រឿង AI', 'កម្សាន្ត', 'Lifestyle', 'ai story, ai video, រឿងនិទាន ai'],
  ['តុក្កតា និង Anime', 'កម្សាន្ត', 'Lifestyle', 'cartoon, anime, តុក្កតា, animation'],
  ['កំប្លែង', 'កម្សាន្ត', 'Comedy', 'funny, comedy, joke, សើច, ល្បែងកំប្លែង, prank'],
  ['តារា និងសិល្បករ', 'កម្សាន្ត', 'Lifestyle', 'celebrity, star, តារា, សិល្បករ'],
  ['ចម្រៀងខ្មែរ', 'តន្ត្រី', 'Music', 'khmer song, ចម្រៀង, បទ, ចម្រៀងខ្មែរ'],
  ['ចម្រៀងបរទេស', 'តន្ត្រី', 'Music', 'kpop, k-pop, thai song, english song, ចម្រៀងថៃ'],
  ['ច្រៀង Cover', 'តន្ត្រី', 'Music', 'cover, karaoke, ខារ៉ាអូខេ, ច្រៀង'],
  ['ឧបករណ៍ភ្លេង', 'តន្ត្រី', 'Music', 'guitar, piano, ហ្គីតា, ភ្លេង, drum'],
  ['រាំ', 'តន្ត្រី', 'Music', 'dance, រាំវង់, tiktok dance, ល្បែងរាំ'],
  ['ហ្គេមទូរស័ព្ទ', 'ហ្គេម', 'Gaming', 'mobile game, free fire, ff, mobile legends, mlbb, pubg, rov, ហ្គេម'],
  ['ហ្គេមកុំព្យូទ័រ', 'ហ្គេម', 'Gaming', 'pc game, playstation, ps5, steam'],
  ['បាល់ទាត់', 'កីឡា', 'Sports', 'football, soccer, បាល់ទាត់, premier league'],
  ['បាល់ទះ', 'កីឡា', 'Sports', 'volleyball'],
  ['គុនខ្មែរ និងប្រដាល់', 'កីឡា', 'Sports', 'kun khmer, boxing, ប្រដាល់, mma, គុនខ្មែរ'],
  ['ហាត់ប្រាណ', 'កីឡា', 'Sports', 'gym, fitness, workout, ហាត់ប្រាណ, រត់'],
  ['រៀនភាសា', 'អប់រំ', 'Education', 'english, រៀនអង់គ្លេស, ភាសាចិន, chinese, ភាសាកូរ៉េ, language'],
  ['រៀនកុំព្យូទ័រ និងកូដ', 'អប់រំ', 'Education', 'coding, programming, រៀនកុំព្យូទ័រ, excel, design'],
  ['ការងារ និងជំនាញ', 'អប់រំ', 'Education', 'job, jobs, ការងារ, ជ្រើសរើសបុគ្គលិក, skill, ជំនាញ'],
  ['ធុរកិច្ច និងលុយ', 'អប់រំ', 'Education', 'business, money, ធុរកិច្ច, លុយ, investment, វិនិយោគ, marketing'],
  ['សុខភាព', 'អប់រំ', 'Education', 'health, សុខភាព, doctor, វេជ្ជបណ្ឌិត'],
  ['សាសនា និងធម៌', 'អប់រំ', 'Education', 'buddhism, dharma, ធម៌, ព្រះសង្ឃ, វត្ត'],
  ['ទេសចរណ៍ក្នុងស្រុក', 'ទេសចរណ៍', 'Travel', 'travel, ដើរលេង, សៀមរាប, អង្គរវត្ត, កែប, កំពត, ព្រះសីហនុ, មណ្ឌលគិរី'],
  ['ទេសចរណ៍ក្រៅប្រទេស', 'ទេសចរណ៍', 'Travel', 'abroad, thailand, japan, korea, ក្រៅប្រទេស'],
  ['សណ្ឋាគារ និងរីសត', 'ទេសចរណ៍', 'Travel', 'hotel, resort, សណ្ឋាគារ, guesthouse'],
  ['ព័ត៌មានក្នុងស្រុក', 'ព័ត៌មាន', 'News', 'news, ព័ត៌មាន, កម្ពុជា'],
  ['ព័ត៌មានអន្តរជាតិ', 'ព័ត៌មាន', 'News', 'world news, international'],
  ['អាកាសធាតុ', 'ព័ត៌មាន', 'News', 'weather, ភ្លៀង, ខ្យល់ព្យុះ'],
  ['ចរាចរណ៍ និងគ្រោះថ្នាក់', 'ព័ត៌មាន', 'News', 'traffic, accident, គ្រោះថ្នាក់'],
  ['គ្រួសារ និងកូនតូច', 'ជីវិតប្រចាំថ្ងៃ', 'Lifestyle', 'family, baby, kids, កូនតូច, ម្ដាយ'],
  ['សត្វចិញ្ចឹម', 'ជីវិតប្រចាំថ្ងៃ', 'Lifestyle', 'pets, dog, cat, ឆ្កែ, ឆ្មា'],
  ['ស្នេហា', 'ជីវិតប្រចាំថ្ងៃ', 'Lifestyle', 'love, ស្នេហ៍, couple, សង្សារ'],
  ['Vlog ប្រចាំថ្ងៃ', 'ជីវិតប្រចាំថ្ងៃ', 'Lifestyle', 'vlog, daily life, ជីវិតប្រចាំថ្ងៃ'],
  ['មង្គលការ និងពិធីបុណ្យ', 'ជីវិតប្រចាំថ្ងៃ', 'Lifestyle', 'wedding, ការ, មង្គលការ, បុណ្យ, ចូលឆ្នាំ, party'],
];

// the same text written in different ways is one word: small letters, no invisible marks, single spaces
function norm(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/[​-‍﻿]/g, '').replace(/[“”"'`.,!?;:()\[\]{}#@]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const effSql = (t) => `(${t}.s_short * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - ${t}.updated_at)) / ${HL_SHORT}.0) + ${t}.s_long * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - ${t}.updated_at)) / ${HL_LONG}.0))`;

module.exports = function ({ app, pool, adminGate, audit, pubMedia, videoSecs }) {
  let ready = null, tablesOk = false;
  function ensure() {
    if (!ready) ready = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS kw_dict (id SERIAL PRIMARY KEY, word TEXT NOT NULL, grp TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL DEFAULT 'General',
        synonyms TEXT NOT NULL DEFAULT '', source VARCHAR(10) NOT NULL DEFAULT 'seed', reviewed BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_kw_dict_word ON kw_dict (LOWER(word))');
      await pool.query(`CREATE TABLE IF NOT EXISTS post_kw (post_id INTEGER NOT NULL, kw_id INTEGER NOT NULL, weight REAL NOT NULL DEFAULT 1, PRIMARY KEY (post_id, kw_id))`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_post_kw_kw ON post_kw (kw_id)');
      await pool.query(`CREATE TABLE IF NOT EXISTS user_kw (user_email TEXT NOT NULL, kw_id INTEGER NOT NULL, s_short DOUBLE PRECISION NOT NULL DEFAULT 0,
        s_long DOUBLE PRECISION NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_email, kw_id))`);
      await pool.query('CREATE TABLE IF NOT EXISTS kw_state (k TEXT PRIMARY KEY, v TEXT)');
      await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS kw_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS kw_tries SMALLINT NOT NULL DEFAULT 0');
      await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS kw_src VARCHAR(8) NOT NULL DEFAULT ''");
      const seeded = (await pool.query("SELECT v FROM kw_state WHERE k = 'seeded'")).rows[0];
      if (!seeded) {
        for (const [w, g, c, syn] of SEED) await pool.query('INSERT INTO kw_dict (word, grp, cat, synonyms) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [w, g, c, syn]);
        await pool.query("INSERT INTO kw_state (k, v) VALUES ('seeded', '1') ON CONFLICT (k) DO NOTHING");
      }
      await loadDict(true);
      tablesOk = true;
    })().catch((e) => { ready = null; console.error('[keywords] setup:', e.message); throw e; });
    return ready;
  }

  // ---- the keyword list, kept in memory (refreshed when the Admin changes it) ----
  let dict = { at: 0, rows: [], byText: new Map(), byId: new Map() };
  async function loadDict(force) {
    if (!force && Date.now() - dict.at < 5 * 60 * 1000) return dict;
    const rows = (await pool.query('SELECT id, word, grp, cat, synonyms, source, reviewed FROM kw_dict ORDER BY grp, word')).rows;
    const byText = new Map(), byId = new Map();
    for (const r of rows) {
      byId.set(r.id, r);
      for (const t of [r.word, ...String(r.synonyms || '').split(',')]) { const n = norm(t); if (n && !byText.has(n)) byText.set(n, r.id); }
    }
    dict = { at: Date.now(), rows, byText, byId };
    return dict;
  }
  // which keywords a piece of text (a search) means: the whole text, then each word, then known words inside it
  function kwOfText(text) {
    const q = norm(text); if (!q) return [];
    const out = new Set();
    if (dict.byText.has(q)) out.add(dict.byText.get(q));
    for (const tok of q.split(' ')) if (dict.byText.has(tok)) out.add(dict.byText.get(tok));
    if (!out.size) for (const [t, id] of dict.byText) if (t.length >= 3 && q.includes(t)) { out.add(id); if (out.size >= 3) break; }
    return [...out].slice(0, 3);
  }

  // ---- a person's scores ----
  async function bumpKw(email, list, dShortMul, dLongMul) {     // list: [{id, w}]
    email = String(email || '').toLowerCase();
    if (!email || !list.length) return;
    try {
      await ensure();
      const pos = list.filter((x) => x.w > 0), neg = list.filter((x) => x.w < 0);
      const age = 'EXTRACT(EPOCH FROM (NOW() - user_kw.updated_at))';
      if (pos.length) await pool.query(`INSERT INTO user_kw (user_email, kw_id, s_short, s_long, updated_at)
          SELECT $1, x.id, x.w * $3, x.w * $4, NOW() FROM UNNEST($2::int[], $5::float8[]) AS x(id, w)
          ON CONFLICT (user_email, kw_id) DO UPDATE SET
            s_short = LEAST(100, user_kw.s_short * POWER(0.5, ${age} / ${HL_SHORT}.0) + EXCLUDED.s_short),
            s_long = LEAST(200, user_kw.s_long * POWER(0.5, ${age} / ${HL_LONG}.0) + EXCLUDED.s_long), updated_at = NOW()`,
        [email, pos.map((x) => x.id), dShortMul, dLongMul, pos.map((x) => x.w)]);
      if (neg.length) await pool.query(`UPDATE user_kw SET
            s_short = GREATEST(0, s_short * POWER(0.5, ${age} / ${HL_SHORT}.0) + x.w * $3),
            s_long = GREATEST(0, s_long * POWER(0.5, ${age} / ${HL_LONG}.0) + x.w * $4), updated_at = NOW()
          FROM UNNEST($2::int[], $5::float8[]) AS x(id, w) WHERE user_kw.user_email = $1 AND user_kw.kw_id = x.id`,
        [email, neg.map((x) => x.id), dShortMul, dLongMul, neg.map((x) => x.w)]);
    } catch (e) { console.error('[keywords] bump:', e.message); }
  }
  async function postKw(postId) {
    const r = await pool.query('SELECT pk.kw_id AS id, pk.weight AS w FROM post_kw pk WHERE pk.post_id = (SELECT COALESCE(shared_post_id, id) FROM posts WHERE id = $1)', [postId]);
    return r.rows.map((x) => ({ id: x.id, w: Number(x.w) || 0.5 }));
  }
  // like 5, comment 4, share 8, seen 1 … (the same numbers as the category scores)
  async function bumpPost(email, postId, delta) {
    if (!email || !postId || !delta) return;
    try {
      await ensure();
      const kws = await postKw(postId); if (!kws.length) return;
      const sign = delta < 0 ? -1 : 1;
      await bumpKw(email, kws.map((k) => ({ id: k.id, w: k.w * sign })), Math.abs(delta) * 0.6, Math.abs(delta) * 0.4);
    } catch (e) {}
  }
  const once = new Map();                       // the same signal is counted once in a while (a search is asked twice: videos + posts)
  function first(key, ms) {
    const now = Date.now(), t = once.get(key);
    if (t && now - t < ms) return false;
    once.set(key, now);
    if (once.size > 8000) for (const [k, v] of once) { if (now - v > 3600 * 1000) once.delete(k); if (once.size < 5000) break; }
    return true;
  }
  async function onSearch(email, text) {
    if (!email) return [];
    try {
      await ensure(); await loadDict();
      const ids = kwOfText(text);
      const fresh = ids.filter((id) => first(`s:${email}:${id}`, 10 * 60 * 1000));
      if (fresh.length) bumpKw(email, fresh.map((id) => ({ id, w: 1 })), 5, 1.5);
      return ids;
    } catch (e) { return []; }
  }
  async function onProfile(email, ownerEmail) {
    email = String(email || '').toLowerCase(); ownerEmail = String(ownerEmail || '').toLowerCase();
    if (!email || !ownerEmail || email === ownerEmail || !first(`p:${email}:${ownerEmail}`, 12 * 3600 * 1000)) return;
    try {
      await ensure();
      const r = await pool.query(`SELECT pk.kw_id AS id, SUM(pk.weight) AS w FROM post_kw pk JOIN posts p ON p.id = pk.post_id
        WHERE p.user_email = $1 AND COALESCE(p.privacy, 'public') = 'public' AND p.created_at > NOW() - INTERVAL '120 days'
        GROUP BY pk.kw_id ORDER BY w DESC LIMIT 5`, [ownerEmail]);
      if (r.rows.length) bumpKw(email, r.rows.map((x) => ({ id: x.id, w: 1 })), 1.5, 0.5);
    } catch (e) {}
  }
  // /api/watch: watched to the end (+3), half (+1.5), watched again (+2)
  function onWatch(email, postId, secs, dur, prev) {
    if (!email || !postId || dur < 5) return;
    const r = secs / dur, pr = prev ? (Number(prev.secs) || 0) / Math.max(dur, 1) : 0;
    let d = 0;
    if (r >= 0.9 && pr < 0.9) d = 3;
    else if (r >= 0.5 && pr < 0.5) d = 1.5;
    else if (pr >= 0.9 && secs < (Number(prev.secs) || 0) * 0.5 && first(`r:${email}:${postId}`, 24 * 3600 * 1000)) d = 2;
    if (d) bumpPost(email, postId, d);
  }
  function onSkip(email, postId) {
    if (!email || !postId || !first(`k:${email}:${postId}`, 24 * 3600 * 1000)) return;
    bumpPost(email, postId, -1.5);
  }

  // ---- the AI: one post at a time, in the background (new posts first, then the old ones) ----
  const ffbin = () => { try { return require('ffmpeg-static') || 'ffmpeg'; } catch (e) { return 'ffmpeg'; } };
  function frame(src, ss) {
    const { execFile } = require('child_process');
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (ss != null) args.push('-ss', String(ss));
    args.push('-i', src, '-frames:v', '1', '-vf', "scale='min(360,iw)':-2", '-q:v', '6', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1');
    return new Promise((ok) => execFile(ffbin(), args, { timeout: 30000, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 }, (e, out) => ok(!e && out && out.length > 500 ? out : null)));
  }
  async function framesOf(row) {
    const m = pubMedia(row), out = [];
    if (m.video) {
      let secs = null; try { secs = await videoSecs(m.video); } catch (e) {}
      const at = secs && secs > 3 ? [0.15, 0.5, 0.85].map((f) => (secs * f).toFixed(1)) : ['0.5'];
      for (const ss of at) { const b = await frame(m.video, ss); if (b) out.push(b); }
    }
    for (const u of m.images.slice(0, 3 - Math.min(out.length, 2))) { const b = await frame(u, null); if (b) out.push(b); }
    return out.slice(0, 3);
  }
  let lastAi = { err: '', at: null };
  function aiErr(m) { if (m) { lastAi = { err: m, at: new Date().toISOString() }; console.error('[keywords] AI:', m); } else lastAi = { err: '', at: null }; }
  async function askGemini(row, frames, opts) {
    const key = process.env.GEMINI_API_KEY; if (!key) return null;
    const list = dict.rows.map((r) => `${r.word} | ${r.grp}`).join('\n');
    const prompt = `You label posts of CamFeed, a Cambodian social app, so people see posts and ads they care about.
Look at the ${frames.length} picture(s) (frames of the video or the photos) and the caption.
1) "category": exactly ONE of: ${CATS.join(', ')}.
2) "keywords": 1 to 8 items {"word": ..., "weight": 0.3-1.0} chosen ONLY from the KEYWORD LIST below (copy the word exactly). weight 1.0 = the post is mainly about it, 0.3 = a small part.
   For something sold (a product), choose the product keywords AND "លក់ទំនិញអនឡាញ".
3) "new": at most 2 important topics or product types that are clearly in the post but missing from the list: {"word": short Khmer word, "group": one existing group, "synonyms": "english, other spellings"}. Usually empty.
Never use names of people, phone numbers, addresses or prices as keywords. Only topics and kinds of products.
Caption: """${String(row.content || '').slice(0, 1500)}"""
KEYWORD LIST (word | group):
${list}
Answer only JSON: {"category": "...", "keywords": [{"word": "...", "weight": 1.0}], "new": []}`;
    return geminiJson(prompt, frames, opts);
  }
  // one question to Gemini with pictures; the answer as JSON (null = no answer, {retry: true} = the limit was reached)
  async function geminiJson(prompt, frames, opts) {
    const key = process.env.GEMINI_API_KEY; if (!key) { aiErr('GEMINI_API_KEY is missing'); return null; }
    const parts = [{ text: prompt }, ...frames.map((b) => ({ inline_data: { mime_type: 'image/jpeg', data: b.toString('base64') } }))];
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 60000);
    try {
      const resp = await require('./gemini').generate(key, { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }, ctl.signal, opts);   // 🤖 the model name lives in gemini.js
      if (resp.status === 429) { aiErr('429 limit reached (too many requests today / this minute)'); return { retry: true }; }
      const data = resp.data;
      if (!resp.ok) { aiErr(resp.status + ' [' + resp.model + '] ' + ((data && data.error && data.error.message) || '').slice(0, 200)); return null; }
      const parts2 = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const txt = parts2.filter((x) => x && x.text && !x.thought).map((x) => x.text).join('');
      if (!txt) { aiErr('empty answer' + (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason ? ' (' + data.candidates[0].finishReason + ')' : '') + (data && data.promptFeedback && data.promptFeedback.blockReason ? ' blocked: ' + data.promptFeedback.blockReason : '')); return null; }
      try { const j = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); aiErr(''); return j; } catch (e) { aiErr('answer was not JSON'); return null; }
    } catch (e) { aiErr(e.name === 'AbortError' ? 'no answer in 60 s' : ('network: ' + ((e.cause && e.cause.code) || '') + ' ' + e.message)); return null; } finally { clearTimeout(tm); }
  }
  async function addWord(word, grp, synonyms, source, reviewed) {
    word = String(word || '').replace(/\s+/g, ' ').trim().slice(0, 60); if (!word) return null;
    grp = String(grp || '').trim().slice(0, 40);
    const g = dict.rows.find((r) => r.grp === grp);
    const cat = g ? g.cat : 'General';
    const r = await pool.query(`INSERT INTO kw_dict (word, grp, cat, synonyms, source, reviewed) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT ((LOWER(word))) DO UPDATE SET word = kw_dict.word RETURNING id`, [word, grp || 'ផ្សេងៗ', cat, String(synonyms || '').slice(0, 400), source, reviewed]);
    return r.rows[0] && r.rows[0].id;
  }
  async function saveKeywords(postId, items, src) {      // items: [{id, w}]
    const seen = new Map(); for (const x of items) if (x.id && !seen.has(x.id)) seen.set(x.id, Math.min(1, Math.max(0.3, Number(x.w) || 0.6)));
    await pool.query('DELETE FROM post_kw WHERE post_id = $1', [postId]);
    if (seen.size) await pool.query('INSERT INTO post_kw (post_id, kw_id, weight) SELECT $1, x.id, x.w FROM UNNEST($2::int[], $3::real[]) AS x(id, w) ON CONFLICT DO NOTHING', [postId, [...seen.keys()], [...seen.values()]]);
    const words = [...seen.keys()].map((id) => dict.byId.get(id)).filter(Boolean).map((r) => r.word);
    await pool.query('UPDATE posts SET kw_at = NOW(), kw_src = $2, ai_tags = $3 WHERE id = $1', [postId, src, words.join(', ').slice(0, 500)]);
    return words;
  }
  async function classify(row) {
    await loadDict();
    const frames = await framesOf(row).catch(() => []);
    if (!frames.length && !String(row.content || '').trim()) { await pool.query("UPDATE posts SET kw_at = NOW(), kw_src = 'empty' WHERE id = $1", [row.id]); return { words: [] }; }
    const ans = await askGemini(row, frames, { background: true });   // labelling old posts: never uses the spare models (they are kept for people waiting)
    if (!ans || ans.retry) return ans;
    const items = [];
    for (const n of (Array.isArray(ans.new) ? ans.new : []).slice(0, 2)) {
      if (!n || !n.word || dict.byText.has(norm(n.word))) continue;
      const id = await addWord(n.word, n.group, n.synonyms, 'ai', false);
      if (id) items.push({ id, w: 0.7 });
    }
    if (items.length) await loadDict(true);
    for (const k of (Array.isArray(ans.keywords) ? ans.keywords : []).slice(0, 8)) {
      const id = k && dict.byText.get(norm(k.word)); if (id) items.push({ id, w: k.weight });
    }
    const words = await saveKeywords(row.id, items, 'ai');
    if (CATS.includes(ans.category)) await pool.query('UPDATE posts SET ai_category = $2 WHERE id = $1', [row.id, ans.category]);
    return { words, category: ans.category };
  }
  let busy = false, pauseUntil = 0, stats = { done: 0, failed: 0, last: null };
  async function paused() { const r = (await pool.query("SELECT v FROM kw_state WHERE k = 'paused'")).rows[0]; return !!(r && r.v === '1'); }
  async function tick() {
    if (busy || Date.now() < pauseUntil || !process.env.GEMINI_API_KEY || process.env.AI_KEYWORDS === 'off') return;
    busy = true;
    try {
      await ensure();
      const stop = await paused();
      // new posts (2 days) always; the old ones only when the Admin has not paused it
      const r = await pool.query(`SELECT id, content, media_type, media_url FROM posts
        WHERE kw_at IS NULL AND shared_post_id IS NULL AND kw_tries < 3 ${stop ? "AND created_at > NOW() - INTERVAL '2 days'" : ''}
        ORDER BY (created_at > NOW() - INTERVAL '2 days') DESC, id DESC LIMIT 1`);
      const row = r.rows[0]; if (!row) return;
      await pool.query('UPDATE posts SET kw_tries = kw_tries + 1 WHERE id = $1', [row.id]);
      const res = await classify(row);
      if (res && res.retry) { pauseUntil = Date.now() + 30 * 60 * 1000;   // the daily / minute limit: rest 30 min so people's AI buttons keep working
        await pool.query('UPDATE posts SET kw_tries = GREATEST(kw_tries - 1, 0) WHERE id = $1', [row.id]); }
      else if (res) { stats.done++; stats.last = { id: row.id, words: res.words, at: new Date().toISOString() }; }
      else stats.failed++;
    } catch (e) { stats.failed++; console.error('[keywords] tick:', e.message); } finally { busy = false; }
  }
  setTimeout(() => { tick(); setInterval(tick, 60 * 1000); }, 45 * 1000);   // one post a minute (the free Gemini limit is small; people come first)
  // old scores that faded away are removed once a day
  setInterval(() => { pool.query(`DELETE FROM user_kw u WHERE ${effSql('u')} < 0.05`).catch(() => {}); }, 24 * 3600 * 1000);

  // ---- for the feed: the part of the ORDER BY score that comes from keywords ($1 = viewer) ----
  function feedJoinSql(viewerParam) {
    if (!tablesOk) return '';
    const v = viewerParam || '$1';
    return `LEFT JOIN (
        SELECT pk.post_id, SUM(pk.weight * (COALESCE(mk.s, 0) + ${GROUP_SHARE} * COALESCE(mg.s, 0))) AS kws
        FROM post_kw pk JOIN kw_dict kd ON kd.id = pk.kw_id
        LEFT JOIN (SELECT u.kw_id, ${effSql('u')} AS s FROM user_kw u WHERE u.user_email = LOWER(${v}) ORDER BY 2 DESC LIMIT 40) mk ON mk.kw_id = pk.kw_id
        LEFT JOIN (SELECT d.grp, SUM(${effSql('u')}) AS s FROM user_kw u JOIN kw_dict d ON d.id = u.kw_id WHERE u.user_email = LOWER(${v}) GROUP BY d.grp ORDER BY 2 DESC LIMIT 8) mg ON mg.grp = kd.grp
        WHERE mk.kw_id IS NOT NULL OR mg.grp IS NOT NULL
        GROUP BY pk.post_id) ukw ON ukw.post_id = COALESCE(p.shared_post_id, p.id)`;
  }
  const feedScoreSql = () => (tablesOk ? '+ LEAST(COALESCE(ukw.kws, 0) * 1.5, 45)' : '');
  async function searchIds(text) { try { await ensure(); await loadDict(); return kwOfText(text); } catch (e) { return []; } }

  // ---- 🔒 a person's own keywords: see them, delete one, delete all ----
  app.get('/api/me/interests', async (req, res) => {
    const me = String(req.authEmail || '').toLowerCase(); if (!me) return res.status(401).json({ success: false });
    try {
      await ensure();
      const r = await pool.query(`SELECT d.id, d.word, d.grp, ROUND(${effSql('u')}::numeric, 1)::float AS score FROM user_kw u JOIN kw_dict d ON d.id = u.kw_id
        WHERE u.user_email = $1 AND ${effSql('u')} >= 0.3 ORDER BY score DESC LIMIT 40`, [me]);
      res.json({ success: true, interests: r.rows });
    } catch (e) { res.status(500).json({ success: false, interests: [] }); }
  });
  app.post('/api/me/interests/remove', async (req, res) => {
    const me = String(req.authEmail || '').toLowerCase(); if (!me) return res.status(401).json({ success: false });
    try {
      await ensure();
      const b = req.body || {};
      if (b.all === true) {
        await pool.query('DELETE FROM user_kw WHERE user_email = $1', [me]);
        await pool.query('DELETE FROM user_interest_scores WHERE LOWER(user_email) = $1', [me]).catch(() => {});
      } else {
        const id = parseInt(b.id, 10); if (!(id > 0)) return res.status(400).json({ success: false });
        await pool.query('DELETE FROM user_kw WHERE user_email = $1 AND kw_id = $2', [me, id]);
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
  });
  // the phone app: the viewer moved on within 2 seconds
  app.post('/api/interest/skip', (req, res) => {
    const me = String(req.authEmail || '').toLowerCase(); const pid = parseInt((req.body || {}).post_id, 10) || 0;
    if (me && pid > 0) onSkip(me, pid);
    res.json({ success: true });
  });

  // ---- Admin › 🏷️ AI Keywords ----
  app.post('/api/admin/keywords', async (req, res) => {
    try {
      const a = await adminGate(req, res); if (!a) return;
      await ensure(); await loadDict();
      const b = req.body || {}, act = String(b.action || 'list');
      const done = async (what, target) => { await loadDict(true); try { audit(a.adminEmail, 'keywords.' + what, String(target || ''), ''); } catch (e) {} };
      if (act === 'list') {
        const q = norm(b.q);
        const counts = (await pool.query('SELECT kw_id, COUNT(*)::int AS n FROM post_kw GROUP BY kw_id')).rows;
        const cm = new Map(counts.map((x) => [x.kw_id, x.n]));
        const words = dict.rows.filter((r) => !q || norm(r.word).includes(q) || norm(r.synonyms).includes(q) || norm(r.grp).includes(q))
          .map((r) => Object.assign({}, r, { posts: cm.get(r.id) || 0 }));
        const st = (await pool.query(`SELECT COUNT(*) FILTER (WHERE kw_at IS NULL AND shared_post_id IS NULL AND kw_tries < 3)::int AS waiting,
            COUNT(*) FILTER (WHERE kw_at IS NOT NULL)::int AS labelled, COUNT(*) FILTER (WHERE kw_tries >= 3 AND kw_at IS NULL)::int AS failed,
            COUNT(*) FILTER (WHERE shared_post_id IS NULL)::int AS total FROM posts`)).rows[0];
        const groups = [...new Set(dict.rows.map((r) => r.grp))];
        return res.json({ success: true, words, groups, cats: CATS, queue: Object.assign(st, { paused: await paused(), gemini: !!process.env.GEMINI_API_KEY, worker: stats, aiError: lastAi }) });
      }
      if (act === 'add' || act === 'edit') {
        const word = String(b.word || '').replace(/\s+/g, ' ').trim().slice(0, 60), grp = String(b.grp || '').trim().slice(0, 40) || 'ផ្សេងៗ';
        const cat = CATS.includes(b.cat) ? b.cat : 'General', syn = String(b.synonyms || '').slice(0, 400);
        if (!word) return res.status(400).json({ success: false, error: 'Write the keyword.' });
        if (act === 'add') await pool.query("INSERT INTO kw_dict (word, grp, cat, synonyms, source, reviewed) VALUES ($1, $2, $3, $4, 'admin', TRUE)", [word, grp, cat, syn]);
        else await pool.query('UPDATE kw_dict SET word = $2, grp = $3, cat = $4, synonyms = $5, reviewed = TRUE WHERE id = $1', [parseInt(b.id, 10) || 0, word, grp, cat, syn]);
        await done(act, word); return res.json({ success: true });
      }
      if (act === 'approve') { await pool.query('UPDATE kw_dict SET reviewed = TRUE WHERE id = $1', [parseInt(b.id, 10) || 0]); await done('approve', b.id); return res.json({ success: true }); }
      if (act === 'delete' || act === 'merge') {
        const id = parseInt(b.id, 10) || 0, into = parseInt(b.into, 10) || 0;
        if (act === 'merge') {
          if (!into || into === id || !dict.byId.has(into)) return res.status(400).json({ success: false, error: 'Choose the keyword to join it into.' });
          const old = dict.byId.get(id);
          if (old) await pool.query("UPDATE kw_dict SET synonyms = TRIM(BOTH ', ' FROM synonyms || ', ' || $2) WHERE id = $1", [into, [old.word, old.synonyms].filter(Boolean).join(', ').slice(0, 300)]);
          await pool.query('INSERT INTO post_kw (post_id, kw_id, weight) SELECT post_id, $2, weight FROM post_kw WHERE kw_id = $1 ON CONFLICT DO NOTHING', [id, into]);
          await pool.query(`INSERT INTO user_kw (user_email, kw_id, s_short, s_long, updated_at) SELECT user_email, $2, s_short, s_long, updated_at FROM user_kw WHERE kw_id = $1
            ON CONFLICT (user_email, kw_id) DO UPDATE SET s_short = LEAST(100, user_kw.s_short + EXCLUDED.s_short), s_long = LEAST(200, user_kw.s_long + EXCLUDED.s_long)`, [id, into]);
        }
        await pool.query('DELETE FROM post_kw WHERE kw_id = $1', [id]);
        await pool.query('DELETE FROM user_kw WHERE kw_id = $1', [id]);
        await pool.query('DELETE FROM kw_dict WHERE id = $1', [id]);
        await done(act, id); return res.json({ success: true });
      }
      if (act === 'posts') {      // examples of posts with one keyword
        const r = await pool.query(`SELECT p.id, LEFT(p.content, 140) AS content, p.thumb_url, p.media_type, p.ai_category, pk.weight FROM post_kw pk JOIN posts p ON p.id = pk.post_id
          WHERE pk.kw_id = $1 ORDER BY p.id DESC LIMIT 30`, [parseInt(b.id, 10) || 0]);
        return res.json({ success: true, posts: r.rows });
      }
      if (act === 'detail') {     // one post: its keywords
        const id = parseInt(b.id, 10) || 0;
        const p = (await pool.query('SELECT id, LEFT(content, 300) AS content, thumb_url, media_type, ai_category, kw_at, kw_src, kw_tries FROM posts WHERE id = $1', [id])).rows[0];
        if (!p) return res.status(404).json({ success: false, error: 'No post with this number.' });
        const k = (await pool.query('SELECT d.id, d.word, d.grp, pk.weight FROM post_kw pk JOIN kw_dict d ON d.id = pk.kw_id WHERE pk.post_id = $1 ORDER BY pk.weight DESC', [id])).rows;
        return res.json({ success: true, post: p, keywords: k });
      }
      if (act === 'relabel') {    // the Admin writes the keywords of a post by hand (the AI then leaves it alone)
        const id = parseInt(b.id, 10) || 0;
        const items = [];
        for (const w of String(b.words || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10)) {
          let kid = dict.byText.get(norm(w));
          if (!kid) { kid = await addWord(w, b.grp || 'ផ្សេងៗ', '', 'admin', true); await loadDict(true); }
          if (kid) items.push({ id: kid, w: 1 });
        }
        const words = await saveKeywords(id, items, 'admin');
        if (CATS.includes(b.cat)) await pool.query('UPDATE posts SET ai_category = $2 WHERE id = $1', [id, b.cat]);
        await done('relabel', id); return res.json({ success: true, words });
      }
      if (act === 'reclassify') { // one post now
        const row = (await pool.query('SELECT id, content, media_type, media_url FROM posts WHERE id = $1', [parseInt(b.id, 10) || 0])).rows[0];
        if (!row) return res.status(404).json({ success: false, error: 'No post with this number.' });
        const r = await classify(row);
        if (!r || r.retry) return res.status(503).json({ success: false, error: r && r.retry ? 'The AI is busy (limit reached). Try again in a few minutes.' : 'The AI did not answer.' });
        await done('reclassify', row.id); return res.json({ success: true, words: r.words, category: r.category });
      }
      if (act === 'redo-all') {   // all posts again, one by one in the background (hand-made labels are kept)
        await pool.query("UPDATE posts SET kw_at = NULL, kw_tries = 0 WHERE kw_src <> 'admin'");
        await done('redo-all', ''); return res.json({ success: true });
      }
      if (act === 'pause') {
        await pool.query("INSERT INTO kw_state (k, v) VALUES ('paused', $1) ON CONFLICT (k) DO UPDATE SET v = $1", [b.on ? '1' : '0']);
        await done('pause', b.on ? 'on' : 'off'); return res.json({ success: true });
      }
      res.status(400).json({ success: false, error: 'Unknown action.' });
    } catch (e) { console.error('[keywords] admin:', e.message); res.status(500).json({ success: false, error: /duplicate|unique/i.test(e.message) ? 'This keyword is already in the list.' : 'Could not do it.' }); }
  });

  ensure().catch(() => {});
  // ---- for ads ----
  async function resolveWords(words) {                // ["laptop", "MacBook"] -> [{id, word}] (only words in the list)
    await ensure(); await loadDict();
    const out = [], seen = new Set();
    for (const w of (Array.isArray(words) ? words : String(words || '').split(',')).slice(0, 20)) {
      const id = dict.byText.get(norm(w));
      if (id && !seen.has(id)) { seen.add(id); out.push({ id, word: dict.byId.get(id).word }); }
    }
    return out.slice(0, 12);
  }
  function wordsOf(ids) { return String(ids || '').split(',').map((x) => dict.byId.get(parseInt(x, 10))).filter(Boolean).map((r) => ({ id: r.id, word: r.word, grp: r.grp })); }
  async function allWords() { await ensure(); await loadDict(); return dict.rows.map((r) => ({ id: r.id, word: r.word, grp: r.grp, syn: r.synonyms })); }
  async function userTop(email, n) {                   // my keywords now: Map id -> score
    email = String(email || '').toLowerCase(); const m = new Map(); if (!email) return m;
    try {
      await ensure();
      const r = await pool.query(`SELECT u.kw_id, ${effSql('u')} AS s FROM user_kw u WHERE u.user_email = $1 ORDER BY 2 DESC LIMIT $2`, [email, n || 40]);
      for (const x of r.rows) if (Number(x.s) >= 0.3) m.set(Number(x.kw_id), Number(x.s));
    } catch (e) {}
    return m;
  }
  async function interestedCount(ids, emails) {        // how many of these people have a score for one of these keywords
    if (!ids.length) return 0;
    const r = await pool.query(`SELECT COUNT(DISTINCT u.user_email)::int AS n FROM user_kw u WHERE u.kw_id = ANY($1::int[]) AND ${effSql('u')} >= 1 ${emails ? 'AND u.user_email = ANY($2::text[])' : ''}`, emails ? [ids, emails] : [ids]);
    return r.rows[0].n;
  }
  // the AI reads the ad (caption + up to 3 pictures) and chooses keywords from the list
  async function suggest(text, urls) {
    await ensure(); await loadDict();
    const frames = [];
    for (const u of (urls || []).slice(0, 3)) { const b = await frame(u, /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) ? '1' : null); if (b) frames.push(b); }
    if (!frames.length && !String(text || '').trim()) return [];
    const ans = await askGemini({ content: text }, frames);
    if (!ans || ans.retry) return { error: ans && ans.retry ? 'busy' : 'ai', why: lastAi.err };
    const out = [], seen = new Set();
    for (const k of (Array.isArray(ans.keywords) ? ans.keywords : [])) { const id = k && dict.byText.get(norm(k.word)); if (id && !seen.has(id)) { seen.add(id); out.push(dict.byId.get(id).word); } }
    return out.slice(0, 8);
  }

  return { bumpPost, onSearch, onProfile, onWatch, onSkip, feedJoinSql, feedScoreSql, searchIds, kick: () => setTimeout(tick, 3000), ready: () => ensure().catch(() => {}),
    resolveWords, wordsOf, allWords, userTop, interestedCount, suggest, loadDict, geminiJson, lastAiError: () => lastAi.err,
    framesOfUrls: async (urls) => { const out = []; for (const u of (urls || []).slice(0, 3)) { const b = await frame(u, /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) ? '1' : null); if (b) out.push(b); } return out; } };
};
