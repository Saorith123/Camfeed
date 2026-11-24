/* 📣 CamFeed's message for everyone (Admin › ⚙️ System › 📣), on the website too: once / once a day / every visit. */
(function () {
  'use strict';
  function today() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function show(n) {
    var en = get('camfeed_lang') === 'en';
    var pick = function (k) { var a = String(n[k + (en ? '_en' : '_km')] || '').trim(), b = String(n[k + (en ? '_km' : '_en')] || '').trim(); return a || b; };
    var text = pick('text'); if (!text) return;
    var id = String(n.id || 0), every = n.every || 'once';
    if (every === 'once' && get('cf_notice_seen_' + id)) return;
    if (every === 'day' && get('cf_notice_day_' + id) === today()) return;
    if (every === 'open') { try { if (sessionStorage.getItem('cf_notice_open_' + id)) return; sessionStorage.setItem('cf_notice_open_' + id, '1'); } catch (e) {} }
    set('cf_notice_seen_' + id, '1'); set('cf_notice_day_' + id, today());
    var bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;z-index:6000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:18px;max-width:420px;width:100%;padding:22px 20px 18px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:inherit';
    var ic = document.createElement('div'); ic.textContent = '📣'; ic.style.cssText = 'font-size:38px;line-height:1';
    var h = document.createElement('div'); h.textContent = pick('title') || 'CamFeed'; h.style.cssText = 'font-size:18px;font-weight:800;margin:10px 0 8px;color:#050505';
    var p = document.createElement('div'); p.textContent = text; p.style.cssText = 'font-size:15px;line-height:1.65;color:#333;white-space:pre-wrap;max-height:50vh;overflow:auto';
    var b = document.createElement('button'); b.type = 'button'; b.textContent = en ? 'OK' : 'យល់ហើយ';
    b.style.cssText = 'margin-top:16px;border:none;border-radius:12px;background:#1877f2;color:#fff;font-weight:800;font-size:15px;padding:11px 28px;cursor:pointer;font-family:inherit';
    var close = function () { bg.remove(); };
    b.onclick = close; bg.onclick = function (e) { if (e.target === bg) close(); };
    card.appendChild(ic); card.appendChild(h); card.appendChild(p); card.appendChild(b); bg.appendChild(card); document.body.appendChild(bg);
  }
  function go() {
    if (/CamFeedApp/.test(navigator.userAgent)) return;          // the app shows it itself
    fetch('/api/app-config', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      var n = d && d.config && d.config.notice;
      if (n && n.on && n.web !== false) setTimeout(function () { show(n); }, 1200);
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
