// 🤖 One place for the Gemini model name. Google retires old models (e.g. "gemini-2.5-flash is no longer available to new users"),
// so: GEMINI_MODEL in Render (if set) → else the newest model we learned → else the default below.
// When Google answers 404 for the model, we read the model it recommends in its answer (or ask Google for the list of models),
// switch to it, and try again once — the AI keeps working without a new DEPLOY.
'use strict';

const DEFAULT_MODEL = 'gemini-3.8-flash';
let learned = '';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const model = () => String(process.env.GEMINI_MODEL || '').trim() || learned || DEFAULT_MODEL;

async function pickFromList(key) {
  try {
    const r = await fetch(`${BASE}/models?key=${key}&pageSize=200`);
    const d = await r.json().catch(() => null);
    const names = ((d && d.models) || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /^gemini-[\d.]+-flash$/.test(n));          // a plain "flash" model (not lite / image / tts / preview)
    names.sort((a, b) => parseFloat(b.split('-')[1]) - parseFloat(a.split('-')[1]));
    return names[0] || '';
  } catch (e) { return ''; }
}

// POST generateContent; returns { status, ok, data, model }
async function generate(key, body, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const m = model();
    const resp = await fetch(`${BASE}/models/${m}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = await resp.json().catch(() => null);
    if (resp.status === 404 && attempt === 0 && !process.env.GEMINI_MODEL) {
      const msg = String((data && data.error && data.error.message) || '');
      const said = (msg.match(/use\s+models\/([a-z0-9.\-]+)/i) || [])[1];
      const next = (said && said !== m) ? said : await pickFromList(key);
      if (next && next !== m) { learned = next; console.log('[gemini] model', m, '→', next); continue; }
    }
    return { status: resp.status, ok: resp.ok, data, model: m };
  }
  return { status: 0, ok: false, data: null, model: model() };
}

module.exports = { generate, model };
