/* CamFeed app install helper: registers the service worker and offers "Install" (Android/desktop) or the
   "Add to Home Screen" hint (iPhone) once, on the login and feed pages. Remembers a "not now" for 14 days. */
(function () {
  'use strict';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }

  var KEY = 'camfeed_install_dismissed';
  var DAYS14 = 14 * 24 * 3600 * 1000;
  var path = location.pathname;
  var onPromoPage = path === '/' || /\/(index|feed)\.html$/.test(path);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

  function dismissedRecently() {
    try { var t = parseInt(localStorage.getItem(KEY) || '0', 10); return t && Date.now() - t < DAYS14; } catch (e) { return false; }
  }
  var showBanner = onPromoPage && !standalone && !dismissedRecently();   // the banner only appears on the login and feed pages

  var km = (function () { try { return (localStorage.getItem('camfeed_lang') || 'km') !== 'en'; } catch (e) { return true; } })();
  var T = km
    ? { title: 'ដំឡើងកម្មវិធី CamFeed', install: 'ដំឡើង', later: 'មិនទាន់', ios: 'ចុចប៊ូតុង «ចែករំលែក» (Share) ក្នុង Safari រួចជ្រើស «បន្ថែមទៅអេក្រង់ដើម» (Add to Home Screen)' }
    : { title: 'Install the CamFeed app', install: 'Install', later: 'Not now', ios: 'Tap the Share button in Safari, then choose "Add to Home Screen"' };

  var bar = null;
  function build(text, withInstall, onInstall) {
    if (bar || !document.body) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'dialog');
    bar.style.cssText = 'position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:99999;background:#fff;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,.25);padding:12px 14px;display:flex;align-items:center;gap:12px;font-family:"Noto Sans Khmer",-apple-system,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto';
    var img = document.createElement('img'); img.src = '/icons/icon-192.png'; img.alt = ''; img.style.cssText = 'width:42px;height:42px;border-radius:10px;flex-shrink:0';
    var mid = document.createElement('div'); mid.style.cssText = 'flex:1;min-width:0';
    var h = document.createElement('div'); h.textContent = T.title; h.style.cssText = 'font-weight:800;font-size:14.5px;color:#1c1e21';
    var p = document.createElement('div'); p.textContent = text || ''; p.style.cssText = 'font-size:12.5px;color:#65676b;line-height:1.35;margin-top:2px';
    mid.appendChild(h); if (text) mid.appendChild(p);
    var btns = document.createElement('div'); btns.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex-shrink:0';
    if (withInstall) {
      var b = document.createElement('button'); b.textContent = T.install;
      b.style.cssText = 'background:#1877f2;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-weight:800;font-size:14px;cursor:pointer';
      b.addEventListener('click', onInstall); btns.appendChild(b);
    }
    var x = document.createElement('button'); x.textContent = T.later;
    x.style.cssText = 'background:none;color:#65676b;border:0;font-size:12.5px;cursor:pointer;padding:2px';
    x.addEventListener('click', function () { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} close(); });
    btns.appendChild(x);
    bar.appendChild(img); bar.appendChild(mid); bar.appendChild(btns);
    document.body.appendChild(bar);
  }
  function close() { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); bar = null; }

  // Android / desktop Chrome and Edge. Every page remembers the browser's install offer so the Settings page can use it too.
  var deferred = null;
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  var isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  window.CamInstall = {
    installed: standalone,
    isIOS: isIOS,
    canPrompt: function () { return !!deferred; },
    prompt: function () {
      if (!deferred) return Promise.resolve(false);
      var d = deferred; d.prompt();
      return d.userChoice.then(function (c) { deferred = null; close(); return !!c && c.outcome === 'accepted'; }).catch(function () { close(); return false; });
    }
  };
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    try { window.dispatchEvent(new Event('camfeed-install-available')); } catch (err) {}
    if (!showBanner) return;
    var show = function () {
      build('', true, function () {
        if (!deferred) return;
        deferred.prompt();
        deferred.userChoice.then(function () { deferred = null; close(); }).catch(function () { close(); });
      });
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  });
  window.addEventListener('appinstalled', function () { close(); deferred = null; window.CamInstall.installed = true; });

  // iPhone / iPad Safari has no install button: show the hint instead
  if (isIOS && isSafari && showBanner) {
    window.addEventListener('load', function () { setTimeout(function () { build(T.ios, false); }, 1500); });
  }
})();
