/* "20 minutes ago" style times, shared by every page (the full date stays in the tooltip) */
(function () {
  function toDate(v) { var x = v instanceof Date ? v : new Date(v); return isNaN(x.getTime()) ? null : x; }
  window.timeAgo = function (v) {
    var x = toDate(v); if (!x) return '';
    var s = Math.max(0, Math.floor((Date.now() - x.getTime()) / 1000));
    if (s < 45) return 'just now';
    var m = Math.max(1, Math.round(s / 60)); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.floor(s / 3600); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.floor(s / 86400); if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
    var w = Math.floor(d / 7); if (d < 35) return w + (w === 1 ? ' week ago' : ' weeks ago');
    return x.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  window.fullDateTime = function (v) { var x = toDate(v); return x ? x.toLocaleString() : ''; };
  setInterval(function () {   // keep the words fresh while the page stays open
    var list = document.querySelectorAll('[data-ts]');
    for (var i = 0; i < list.length; i++) { var t = window.timeAgo(list[i].getAttribute('data-ts')); if (t && list[i].textContent !== t) list[i].textContent = t; }
  }, 60000);
})();
