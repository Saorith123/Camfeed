/* CamFeed feed freshness + sound (feed.html):
   - clicking Home loads the newest posts (not only scrolls up)
   - coming back to the page after a while (or from the browser's back button) refreshes it
   - sound: the first tap on the page turns the sound on for every video; it stays on for the next videos and pages until you mute it yourself.
     (A web page can not hear the phone's volume buttons; this one tap is the closest a browser allows.) */
(function () {
  'use strict';
  var lastRefresh = 0, hiddenAt = 0, pill = null, checking = false;
  var TXT = { km: '↑ ប្រកាសថ្មី', en: '↑ New posts' };
  function lang() { try { return localStorage.getItem('camfeed_lang') === 'en' ? 'en' : 'km'; } catch (e) { return 'km'; } }
  function me() { try { return JSON.parse(localStorage.getItem('camfeed_user')); } catch (e) { return null; } }
  function atTop() { return (window.pageYOffset || document.documentElement.scrollTop || 0) < 250; }

  function hidePill() { if (pill && pill.parentNode) pill.parentNode.removeChild(pill); pill = null; }
  function showPill() {
    if (pill || !document.body) return;
    pill = document.createElement('button'); pill.type = 'button'; pill.id = 'newPostsPill'; pill.textContent = TXT[lang()];
    pill.style.cssText = 'position:fixed;top:118px;left:50%;transform:translateX(-50%);z-index:60;background:#1877f2;color:#fff;border:0;border-radius:20px;padding:9px 18px;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer';
    pill.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); window.refreshFeedNow(); });
    document.body.appendChild(pill);
  }

  // load the newest posts at the top (same as opening the page again)
  window.refreshFeedNow = function () {
    hidePill();
    var now = Date.now(); if (now - lastRefresh < 1200) return; lastRefresh = now;
    if (typeof loadPosts === 'function') loadPosts(false);
  };

  // coming back to the page after a while (or with the browser's back button): a fresh, re-ranked feed
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 90000) { hiddenAt = 0; if (atTop()) window.refreshFeedNow(); }
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted && atTop()) window.refreshFeedNow(); });

  // first tap = sound on (unless the person muted on purpose)
  var gestureDone = false;
  function pref() { try { return localStorage.getItem('camfeed_sound'); } catch (e) { return null; } }
  function onGesture(e) {
    if (gestureDone) return;
    if (e && e.target && e.target.closest && e.target.closest('.feed-mute-btn')) return;     // the speaker button does its own job
    gestureDone = true;
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) { document.removeEventListener(ev, onGesture, true); });
    if (pref() === 'off') return;
    if (typeof syncAllVideosMuteState === 'function' && typeof globalVideoUnmuted !== 'undefined' && !globalVideoUnmuted) syncAllVideosMuteState(true);
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) { document.addEventListener(ev, onGesture, { capture: true, passive: true }); });
})();
