/* CamFeed: the video you are watching comes first.
   When the playing video is stuck buffering ("waiting"), everything else that could use the same connection steps aside:
   neighbour videos stop downloading, and small background requests (notification counters, story bar, presence, view counts...)
   wait until the video plays smoothly again (never longer than 8 seconds). */
(function () {
  'use strict';
  if (window.CamNet) return;
  var net = window.CamNet = { busy: false };
  var waitTimer = null, goodTimer = null, maxTimer = null;

  function setBusy(on) {
    if (net.busy === on) return; net.busy = on;
    clearTimeout(maxTimer);
    if (on) maxTimer = setTimeout(function () { setBusy(false); }, 20000);      // never stay in "busy" mode for long
    try { window.dispatchEvent(new Event(on ? 'camnet:busy' : 'camnet:free')); } catch (e) {}
  }
  function isPlayingVideo(v) { return v && v.tagName === 'VIDEO' && !v.paused && !v.ended; }

  document.addEventListener('waiting', function (e) {
    var v = e.target; if (!isPlayingVideo(v)) return;
    clearTimeout(goodTimer); goodTimer = null;
    if (waitTimer) return;
    waitTimer = setTimeout(function () { waitTimer = null; if (isPlayingVideo(v) && v.readyState < 3) setBusy(true); }, 600);
  }, true);
  document.addEventListener('stalled', function (e) {
    var v = e.target; if (!isPlayingVideo(v) || v.readyState >= 3) return;
    clearTimeout(goodTimer); goodTimer = null;
    if (!waitTimer) waitTimer = setTimeout(function () { waitTimer = null; if (isPlayingVideo(v) && v.readyState < 3) setBusy(true); }, 800);
  }, true);
  function good(e) {
    var v = e.target; if (!isPlayingVideo(v) || v.readyState < 3) return;
    clearTimeout(waitTimer); waitTimer = null;
    if (net.busy && !goodTimer) goodTimer = setTimeout(function () { goodTimer = null; setBusy(false); }, 2500);   // smooth for 2.5 s -> back to normal
  }
  document.addEventListener('playing', good, true);
  document.addEventListener('canplaythrough', good, true);
  document.addEventListener('timeupdate', good, true);

  // small background requests wait while the video is struggling
  var LOW = [[/\/api\/(chat-notifications|stories\/feed|live\/active|sponsored-ads)(\?|$|\/)/, 'GET'], [/\/api\/notifications(\?|$)/, 'GET'], [/\/api\/presence\/ping/, 'POST'], [/\/api\/feed\/seen/, 'POST']];
  function isLow(url, method) { for (var i = 0; i < LOW.length; i++) if (LOW[i][1] === method && LOW[i][0].test(url)) return true; return false; }
  function waitFree() {
    return new Promise(function (resolve) {
      if (!net.busy) return resolve();
      var t = setTimeout(done, 8000);
      function done() { clearTimeout(t); window.removeEventListener('camnet:free', done); resolve(); }
      window.addEventListener('camnet:free', done);
    });
  }
  var orig = window.fetch && window.fetch.bind(window), pending = {};
  if (orig) window.fetch = function (input, init) {
    try {
      if (net.busy) {
        var url = typeof input === 'string' ? input : (input && input.url) || '', m = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (isLow(url, m)) {
          if (m === 'GET') {                                                   // many identical polls collapse into one
            var key = url;
            if (!pending[key]) pending[key] = waitFree().then(function () { delete pending[key]; return orig(input, init); });
            return pending[key].then(function (r) { return r.clone(); });
          }
          return waitFree().then(function () { return orig(input, init); });
        }
      }
    } catch (e) {}
    return orig(input, init);
  };
})();
