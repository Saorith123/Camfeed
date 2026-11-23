// 🤖 One place for the Gemini model name. Google retires old models (e.g. "gemini-2.5-flash is no longer available to new users"),
// so: GEMINI_MODEL in Render (if set) → else the newest model we learned → else the default below.
// When Google answers 404 for the model, we read the model it recommends in its answer (or ask Google for the list of models),
// switch to it, and try again once — the AI keeps working without a new DEPLOY.
'use strict';

const DEFAULT_MODEL = 'gemini-3.8-flash';
let learned = '';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const model = () => String(process.env.GEMINI_MODEL || '').trim() || learned || DEFAULT_MODEL;

// the plain "flash" models Google offers now, newest first (and the lighter "flash-lite" ones after them, as a spare)
async function listFlash(key) {
  try {
    const r = await fetch(`${BASE}/models?key=${key}&pageSize=200`);
    const d = await r.json().catch(() => null);
    const names = ((d && d.models) || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
    const v = (n) => parseFloat(n.split('-')[1]) - (/-lite$/.test(n) ? 100 : 0);
    return names.sort((a, b) => v(b) - v(a));
  } catch (e) { return []; }
}
let spareList = null, spareAt = 0;
const dead = new Set();                         // models Google answered 404 for ("no longer available"): never tried again
async function spareFor(key, tried) {          // another model to use while the usual one is too busy (503): one not tried yet in this call
  if (!spareList || Date.now() - spareAt > 6 * 3600 * 1000) { spareList = await listFlash(key); spareAt = Date.now(); }
  return spareList.find((n) => !tried.includes(n) && !dead.has(n)) || '';
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
// 404 (model retired) → switch model; 503 / 500 (Google busy, "high demand") → wait a little and try again, then try a spare model once
// 429 (the limit of this model is used up) → a spare model too (each model has its own limit). opts.background: no spares (kept for people).
async function generate(key, body, signal, opts) {
  const bg = !!(opts && opts.background);
  let busyTries = 0, useSpare = '', switched = false;
  const tried = [];
  let lastBusy = null;                          // the real reason to show (busy / limit), not a retired spare's 404
  for (let attempt = 0; attempt < 8; attempt++) {
    const m = useSpare || model();
    if (!tried.includes(m)) tried.push(m);
    const resp = await fetch(`${BASE}/models/${m}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = await resp.json().catch(() => null);
    if (resp.status === 429 || resp.status === 503 || resp.status === 500) lastBusy = { status: resp.status, ok: false, data, model: m };
    if (resp.status === 429 && !bg && busyTries < 6) {
      busyTries++;
      const sp = await spareFor(key, tried);
      if (sp) { useSpare = sp; console.log('[gemini] limit:', m, '→ spare', sp); continue; }
    }
    if ((resp.status === 503 || resp.status === 500) && busyTries < 6) {
      busyTries++;
      if (busyTries === 1 || bg) { if (bg && busyTries > 1) return { status: resp.status, ok: false, data, model: m }; await wait(1500); continue; }                    // the same model once more after 1.5 s
      const sp = await spareFor(key, tried);                                   // then up to 4 other models (newest flash first, then flash-lite)
      if (sp) { useSpare = sp; console.log('[gemini] busy:', m, '→ spare', sp); await wait(500); continue; }
      if (busyTries === 2) { await wait(3000); continue; }
    }
    if (resp.status === 404 && useSpare && busyTries < 7) {            // a spare that is retired: forget it, take the next one
      dead.add(m); busyTries++;
      const sp = await spareFor(key, tried);
      if (sp) { useSpare = sp; continue; }
      return lastBusy || { status: resp.status, ok: false, data, model: m };
    }
    if (resp.status === 404 && !useSpare && !switched && !process.env.GEMINI_MODEL) {
      switched = true;
      const msg = String((data && data.error && data.error.message) || '');
      const said = (msg.match(/use\s+models\/([a-z0-9.\-]+)/i) || [])[1];
      const next = (said && said !== m) ? said : await pickFromList(key);
      if (next && next !== m) { learned = next; console.log('[gemini] model', m, '→', next); continue; }
    }
    if (resp.status === 404 && lastBusy) return lastBusy;
    return { status: resp.status, ok: resp.ok, data, model: m };
  }
  return lastBusy || { status: 0, ok: false, data: null, model: model() };
}

module.exports = { generate, model };
