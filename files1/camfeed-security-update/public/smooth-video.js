/* CamFeed smooth video for profile (and any page): <video class="sv" data-sv-src="URL#t=0.001" preload="none" muted loop playsinline controls>
   - loads a video only when it is within ~2 screens (first frame ready before you arrive, no black box)
   - plays when >= 60% visible, pauses when scrolled away, only ONE video plays at a time
   - releases videos far away so memory and data are not wasted
   - light-grey placeholder + fade-in instead of a black box, remembers your sound choice (same as the feed) */
(function () {
  'use strict';
  var PLAY_RATIO = 0.6;
  var hasIO = 'IntersectionObserver' in window;
  var active = null;

  function base(u) { return String(u || '').split('#')[0]; }
  function srcFor(u) { return base(u) + '#t=0.001'; }

  function hydrate(v) {
    var s = v.getAttribute('data-sv-src');
    if (s && v.getAttribute('src') !== s) {
      v.setAttribute('src', s);
      v.preload = 'metadata';
      try { v.load(); } catch (e) {}
    }
  }
  function release(v) {
    if (!v.hasAttribute('src')) return;
    try {
      if (!v.paused) { v.dataset.svAuto = '1'; v.pause(); }
      v.classList.remove('vid-ready');
      v.removeAttribute('src');
      v.load();
    } catch (e) {}
    if (active === v) active = null;
  }
  function autoPause(v) { if (!v.paused) { v.dataset.svAuto = '1'; v.pause(); } }
  function wantsSound() { try { return sessionStorage.getItem('camfeed_unmuted') === 'true'; } catch (e) { return false; } }

  function play(v) {
    if (v.dataset.svUserPaused === '1') return;
    v.muted = !wantsSound();
    var p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () { v.muted = true; var q = v.play(); if (q && q.catch) q.catch(function () {}); });
    }
  }

  var nearObs = hasIO ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) hydrate(e.target); else release(e.target); });
  }, { rootMargin: '200% 0px 200% 0px' }) : null;

  var playObs = hasIO ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting && e.intersectionRatio >= PLAY_RATIO) {
        if (active && active !== v) autoPause(active);
        active = v;
        hydrate(v);
        play(v);
      } else {
        autoPause(v);
        v.dataset.svUserPaused = '';
        if (active === v) active = null;
      }
    });
  }, { threshold: [0, PLAY_RATIO] }) : null;

  function register(v) {
    if (v.getAttribute('data-sv-ready')) return;
    v.setAttribute('data-sv-ready', '1');
    if (hasIO) { nearObs.observe(v); playObs.observe(v); } else { hydrate(v); }
  }
  function scan() {
    var list = document.querySelectorAll('video.sv:not([data-sv-ready])');
    for (var i = 0; i < list.length; i++) register(list[i]);
  }

  // media events do not bubble: listen in the capture phase on the document
  function isSv(t) { return t && t.classList && t.classList.contains('sv'); }
  ['loadeddata', 'canplay', 'playing'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { if (isSv(e.target)) e.target.classList.add('vid-ready'); }, true);
  });
  document.addEventListener('loadedmetadata', function (e) {
    var v = e.target;
    if (isSv(v) && v.videoWidth > 0 && v.videoHeight > 0) v.style.aspectRatio = v.videoWidth + ' / ' + v.videoHeight;
  }, true);
  document.addEventListener('pause', function (e) {
    var v = e.target;
    if (!isSv(v)) return;
    if (v.dataset.svAuto === '1') v.dataset.svAuto = '';       // paused by us (scrolled away)
    else if (!v.ended) v.dataset.svUserPaused = '1';           // paused by the viewer: respect it until it scrolls away
  }, true);
  document.addEventListener('volumechange', function (e) {
    var v = e.target;
    if (!isSv(v)) return;
    try { sessionStorage.setItem('camfeed_unmuted', (!v.muted && v.volume > 0) ? 'true' : 'false'); } catch (err) {}
  }, true);

  var scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(function () { scheduled = false; scan(); });
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();

  window.SmoothVideo = { src: srcFor };
})();
