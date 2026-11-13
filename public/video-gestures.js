/* Video gestures like Facebook / TikTok (feed videos, reels and feed pictures):
     - HOLD on a video = plays at 2x speed while your finger is down, normal speed when you let go
     - TAP TWICE on a video or a picture = Like (a big thumb pops up); already liked stays liked
     - one tap = play / pause (it waits a moment to see whether a second tap follows)
     - when paused: skip back / forward 10 seconds buttons next to the play button                      */
(function () {
  'use strict';
  var HOLD_MS = 380, DOUBLE_MS = 280, MOVE_PX = 12;
  var BOX = '.reel-item, .feed-video-wrap';
  var CONTROLS = 'button, input, a, select, textarea, label, .reel-actions, .reel-overlay, .reel-controls-bar, .feed-video-controls-bar, .reaction-picker, .action-slot, .vg-skip';
  var IMG = 'img.post-media, .carousel-slide img';
  var suppressUntil = 0, hold = null, lastTap = { t: 0, key: '' }, pending = null;

  // ---------- small helpers ----------
  function uidOf(box) { return String(box.id || '').replace(/^(reel|vwrap)-/, ''); }
  function videoOf(box) { return box.querySelector('video'); }
  function isControl(el) { return !!(el.closest && el.closest(CONTROLS)); }

  var style = document.createElement('style');
  style.textContent = '.vg-no-select{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}' +
    '.vg-pop{position:absolute;z-index:30;pointer-events:none;font-size:84px;line-height:1;transform:translate(-50%,-50%) scale(.3);opacity:0;animation:vgpop .75s ease-out forwards;filter:drop-shadow(0 4px 10px rgba(0,0,0,.45))}' +
    '@keyframes vgpop{0%{transform:translate(-50%,-50%) scale(.3);opacity:0}25%{transform:translate(-50%,-50%) scale(1.15);opacity:1}60%{transform:translate(-50%,-60%) scale(1);opacity:1}100%{transform:translate(-50%,-110%) scale(1);opacity:0}}' +
    '.vg-badge{position:absolute;top:14%;left:50%;transform:translateX(-50%);z-index:30;pointer-events:none;background:rgba(0,0,0,.6);color:#fff;font-weight:800;font-size:15px;padding:7px 14px;border-radius:18px}' +
    '.vg-skip{display:none;position:absolute;top:50%;z-index:12;width:54px;height:54px;margin-top:-27px;border-radius:50%;border:0;background:rgba(0,0,0,.5);color:#fff;font-weight:800;font-size:13px;align-items:center;justify-content:center;cursor:pointer;line-height:1.1;text-align:center}' +
    '.vg-skip.back{left:calc(50% - 112px)}.vg-skip.fwd{left:calc(50% + 58px)}.is-paused>.vg-skip{display:flex}';
  (document.head || document.documentElement).appendChild(style);

  // ---------- like through the page's own code ----------
  function pop(box, x, y) {
    var r = box.getBoundingClientRect(); if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    var d = document.createElement('div'); d.className = 'vg-pop'; d.textContent = '👍'; d.style.left = (x - r.left) + 'px'; d.style.top = (y - r.top) + 'px';
    box.appendChild(d); setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 800);
  }
  function likeTarget(el) {
    var box = el.closest('.reel-item'); if (box) return { kind: 'reel', box: box, postId: box.dataset.postId, uid: uidOf(box) };
    box = el.closest('.feed-video-wrap'); if (box) { var v = videoOf(box); return { kind: 'post', box: box, postId: v && v.dataset.postId }; }
    var item = el.closest('.post-item'); if (item) { var p = item.querySelector('[id^="picker-"]'); return { kind: 'post', box: el.closest('.carousel-slide') || el.parentNode, postId: p && p.id.replace('picker-', '') }; }
    return null;
  }
  function doLike(el, x, y) {
    var t = likeTarget(el); if (!t) return;
    pop(t.box, x, y);
    try {
      if (t.kind === 'reel') {
        var st = (typeof videoReactionState !== 'undefined') ? videoReactionState[t.postId] : null;
        if ((!st || !st.userReaction) && typeof applyReaction === 'function') applyReaction(t.postId, t.uid, '👍');
      } else if (t.postId && typeof applyReactionOptimistically === 'function') {
        var ps = (typeof postReactionsState !== 'undefined') ? postReactionsState[t.postId] : null;
        if (!ps || !ps.userReaction) applyReactionOptimistically(t.postId, '👍');
      }
    } catch (e) { /* the pop is shown anyway */ }
  }

  // ---------- one tap ----------
  function singleTap(el, ev) {
    var box = el.closest(BOX);
    if (box) {
      var uid = uidOf(box);
      if (box.classList.contains('reel-item') && typeof toggleReelPlayPause === 'function') toggleReelPlayPause(uid, null);
      else if (typeof toggleFeedVideoPlayPause === 'function') toggleFeedVideoPlayPause(uid, null);
      return;
    }
    if (typeof el.onclick === 'function') el.onclick.call(el, ev);       // pictures: open the viewer, as before
  }

  document.addEventListener('click', function (e) {
    var el = e.target; if (!el || !el.closest) return;
    var inBox = el.closest(BOX), img = !inBox && el.closest(IMG);
    if (!inBox && !img) return;
    if (inBox && isControl(el)) return;
    if (img && el.closest('button, a')) return;
    e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
    if (Date.now() < suppressUntil) return;                              // the finger that was holding for 2x speed: not a tap
    var key = inBox ? inBox.id : (img.currentSrc || img.src);
    var now = Date.now();
    if (lastTap.key === key && now - lastTap.t < DOUBLE_MS) {
      clearTimeout(pending); lastTap = { t: 0, key: '' };
      doLike(inBox || img, e.clientX, e.clientY); return;
    }
    lastTap = { t: now, key: key };
    var target = inBox ? el : img, ev = e;
    pending = setTimeout(function () { lastTap = { t: 0, key: '' }; singleTap(target, ev); }, DOUBLE_MS);
  }, true);

  // ---------- hold = 2x ----------
  function endHold() {
    if (!hold) return; clearTimeout(hold.timer);
    if (hold.active) { try { hold.video.playbackRate = hold.prev; } catch (e) {} if (hold.badge && hold.badge.parentNode) hold.badge.parentNode.removeChild(hold.badge); suppressUntil = Date.now() + 400; }
    hold = null;
  }
  document.addEventListener('pointerdown', function (e) {
    var el = e.target; if (!el || !el.closest || e.button > 0) return;
    var box = el.closest(BOX); if (!box || isControl(el)) return;
    var video = videoOf(box); if (!video) return;
    endHold();
    hold = { x: e.clientX, y: e.clientY, video: video, box: box, active: false, prev: 1, badge: null };
    hold.timer = setTimeout(function () {
      if (!hold || video.paused) return;
      hold.active = true; hold.prev = video.playbackRate || 1; video.playbackRate = 2;
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
      hold.badge = document.createElement('div'); hold.badge.className = 'vg-badge'; hold.badge.textContent = '2× ▶▶'; box.appendChild(hold.badge);
    }, HOLD_MS);
  }, true);
  document.addEventListener('pointermove', function (e) { if (hold && !hold.active && (Math.abs(e.clientX - hold.x) > MOVE_PX || Math.abs(e.clientY - hold.y) > MOVE_PX)) endHold(); }, true);
  ['pointerup', 'pointercancel'].forEach(function (ev) { document.addEventListener(ev, endHold, true); });
  document.addEventListener('contextmenu', function (e) { if (e.target && e.target.closest && (e.target.closest(BOX) || e.target.closest(IMG))) e.preventDefault(); }, true);

  // ---------- -10 s / +10 s buttons (shown while paused) ----------
  function enhance(box) {
    if (box.__vg) return; box.__vg = true; box.classList.add('vg-no-select');
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    [['back', '⏪<br>10'], ['fwd', '10<br>⏩']].forEach(function (d) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'vg-skip ' + d[0]; b.innerHTML = d[1]; b.setAttribute('aria-label', d[0] === 'back' ? 'Back 10 seconds' : 'Forward 10 seconds');
      b.addEventListener('click', function (ev) {
        ev.stopPropagation(); var v = videoOf(box); if (!v) return;
        var dur = isFinite(v.duration) ? v.duration : 1e9; v.currentTime = Math.max(0, Math.min(dur, (v.currentTime || 0) + (d[0] === 'back' ? -10 : 10)));
      });
      box.appendChild(b);
    });
  }
  function scan(root) { (root.querySelectorAll ? root.querySelectorAll(BOX) : []).forEach(enhance); if (root.matches && root.matches(BOX)) enhance(root); }
  var start = function () { scan(document); new MutationObserver(function (list) { list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); }); }); }).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
