// 🛒 Google Play: check a purchase made in the Android app with Google itself (never trust the phone alone).
// Render env:
//   GOOGLE_PLAY_SERVICE_ACCOUNT = the whole JSON key of a Google Cloud service account that has access in Play Console (Users & permissions)
//   PLAY_PACKAGE                = the app id (default com.camfeed.camfeed)
'use strict';
const crypto = require('crypto');

let sa = null, saErr = '', tok = null, tokUntil = 0;
function account() {
  if (sa) return sa;
  const raw = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT || '').trim();
  if (!raw) { saErr = 'GOOGLE_PLAY_SERVICE_ACCOUNT is not set'; return null; }
  try {
    const j = JSON.parse(raw);
    if (!j.client_email || !j.private_key) { saErr = 'the JSON has no client_email / private_key'; return null; }
    j.private_key = String(j.private_key).replace(/\\n/g, '\n');
    sa = j; saErr = ''; return sa;
  } catch (e) { saErr = 'the JSON could not be read'; return null; }
}
const pkg = () => String(process.env.PLAY_PACKAGE || 'com.camfeed.camfeed').trim();
const on = () => !!account();
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// a short-lived Google access token from the service account (JWT signed with its key)
async function accessToken() {
  if (tok && Date.now() < tokUntil - 60 * 1000) return tok;
  const a = account(); if (!a) throw new Error(saErr);
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(a.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(head + '.' + body + '.' + sig) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !d.access_token) throw new Error('Google token ' + r.status + ' ' + ((d && (d.error_description || d.error)) || ''));
  tok = d.access_token; tokUntil = Date.now() + (Number(d.expires_in) || 3600) * 1000;
  return tok;
}

// { ok, state, account, order, consumed } — state 0 = purchased, 1 = cancelled, 2 = pending
async function checkProduct(productId, token) {
  const t = await accessToken();
  const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + encodeURIComponent(pkg()) + '/purchases/products/' + encodeURIComponent(productId) + '/tokens/' + encodeURIComponent(token);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) return { ok: false, http: r.status, why: (d && d.error && d.error.message) || '' };
  return { ok: true, state: Number(d.purchaseState), account: d.obfuscatedExternalAccountId || '', order: d.orderId || '', consumed: Number(d.consumptionState) === 1, test: Number(d.purchaseType) === 0 };
}

// the id the app gives Google with each purchase, so a token can not be used by another CamFeed account
const accountIdOf = (email) => crypto.createHash('sha256').update('camfeed-play:' + String(email || '').toLowerCase()).digest('hex').slice(0, 64);

module.exports = { on, checkProduct, accountIdOf, pkg, lastError: () => saErr };
