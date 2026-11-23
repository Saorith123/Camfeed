/* 🖼️ CamFeed: several pictures / videos in one post (up to 60).
   In the feed: a layout that fits the number (2, 3, 4, 5+), the last tile shows +N. A tap opens the album (all of them, one under the
   other); a picture in the album opens full screen (slide left / right). ⬇️ is hidden when the owner turned downloads off.
   Everything comes from the server as links that were already checked; text is never inserted as HTML. */
(function () {
  'use strict';
  if (window.CamGrid) return;
  var store = {}, noDl = new Set(), seq = 0;
  var EN = (function () { try { return localStorage.getItem('camfeed_lang') === 'en'; } catch (e) { return false; } })();
  var T = function (km, en) { return EN ? en : km; };
  var isVid = function (it) { return it.type === 'video' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(it.url || ''); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  (function css() {
    var st = document.createElement('style');
    st.textContent = '.cg{display:grid;gap:2px;background:#fff;margin-bottom:8px}.cg .t{position:relative;overflow:hidden;background:#e4e6eb;cursor:pointer}' +
      '.cg .t img,.cg .t video{width:100%;height:100%;object-fit:cover;display:block}.cg .t .pl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:42px;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.6);pointer-events:none}' +
      '.cg .t .more{position:absolute;inset:0;background:rgba(0,0,0,.55);color:#fff;font-size:30px;font-weight:800;display:flex;align-items:center;justify-content:center}' +
      '.cg2{grid-template-columns:1fr 1fr}.cg2 .t{aspect-ratio:4/5}.cg3{grid-template-columns:3fr 2fr;grid-template-rows:1fr 1fr;aspect-ratio:10/9}.cg3 .t:first-child{grid-row:1/3}' +
      '.cg4{grid-template-columns:1fr 1fr}.cg4 .t{aspect-ratio:1}.cg5{grid-template-columns:repeat(6,1fr)}.cg5 .t:nth-child(-n+2){grid-column:span 3;aspect-ratio:1}.cg5 .t:nth-child(n+3){grid-column:span 2;aspect-ratio:1}' +
      '.cga{position:fixed;inset:0;background:#f0f2f5;z-index:9990;display:flex;flex-direction:column}.cga .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);font-weight:800}' +
      '.cga .bar button,.cgv .bar button,.cgv .bar a{background:#f0f2f5;border:none;width:38px;height:38px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none;color:#050505}' +
      '.cga .list{flex:1;overflow-y:auto;max-width:680px;width:100%;margin:0 auto}.cga .list img,.cga .list video{width:100%;display:block;margin-bottom:6px;background:#000;cursor:pointer}' +
      '.cgv{position:fixed;inset:0;background:#000;z-index:9995;display:flex;flex-direction:column}.cgv .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;color:#fff;font-weight:700}.cgv .bar button,.cgv .bar a{background:rgba(255,255,255,.15);color:#fff}' +
      '.cgv .track{flex:1;display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}.cgv .track::-webkit-scrollbar{display:none}' +
      '.cgv .sl{flex:0 0 100%;scroll-snap-align:center;display:flex;align-items:center;justify-content:center}.cgv .sl img,.cgv .sl video{max-width:100%;max-height:calc(100vh - 70px);object-fit:contain}';
    (document.head || document.documentElement).appendChild(st);
  })();

  // the owner turned the download button off for this post
  function markPost(p) {
    if (!p) return;
    var add = function (raw, allow) { if (allow !== false) return; list(raw).forEach(function (it) { noDl.add(it.url); }); };
    add(p.media_url, p.allow_download); if (p.orig_id) add(p.orig_media_url, p.orig_allow_download);
  }
  function list(raw) {
    var s = String(raw || '').trim(); if (!s) return [];
    if (s[0] === '[') { try { var j = JSON.parse(s); return Array.isArray(j) ? j.filter(function (x) { return x && x.url; }) : []; } catch (e) { return []; } }
    return [{ url: s }];
  }

  function tile(key, i, it, more) {
    var media = isVid(it) ? '<video src="' + esc(it.url) + '#t=0.5" preload="metadata" muted playsinline></video><div class="pl">▶</div>'
      : '<img src="' + esc(it.url) + '" loading="lazy" alt="">';
    return '<div class="t" onclick="CamGrid.open(\'' + key + '\',' + i + ')">' + media + (more > 0 ? '<div class="more">+' + more + '</div>' : '') + '</div>';
  }
  // the feed: 2 / 3 / 4 / 5 or more
  function html(postId, items) {
    var key = 'g' + (++seq) + '_' + Number(postId || 0);
    store[key] = items;
    var n = items.length, cls = n === 2 ? 'cg2' : n === 3 ? 'cg3' : n === 4 ? 'cg4' : 'cg5', show = items.slice(0, n >= 5 ? 5 : n);
    return '<div class="cg ' + cls + '">' + show.map(function (it, i) { return tile(key, i, it, n > 5 && i === 4 ? n - 5 : 0); }).join('') + '</div>';
  }

  function close(id) { var e = document.getElementById(id); if (e) e.remove(); document.body.style.overflow = document.getElementById('cgAlbum') || document.getElementById('cgView') ? 'hidden' : ''; }
  // the album: all of them, one under the other
  function open(key, start) {
    var items = store[key]; if (!items) return;
    close('cgAlbum');
    var d = document.createElement('div'); d.className = 'cga'; d.id = 'cgAlbum';
    d.innerHTML = '<div class="bar"><button type="button" aria-label="close">✕</button><span>' + esc(T('រូបភាព និងវីដេអូ', 'Photos and videos')) + ' (' + items.length + ')</span></div><div class="list">' +
      items.map(function (it, i) { return isVid(it) ? '<video src="' + esc(it.url) + '" controls preload="none" playsinline id="cga' + i + '"></video>' : '<img src="' + esc(it.url) + '" loading="lazy" alt="" id="cga' + i + '" data-i="' + i + '">'; }).join('') + '</div>';
    d.querySelector('.bar button').onclick = function () { close('cgAlbum'); };
    d.querySelectorAll('img[data-i]').forEach(function (im) { im.onclick = function () { view(key, Number(im.getAttribute('data-i'))); }; });
    document.body.appendChild(d); document.body.style.overflow = 'hidden';
    if (start > 0) setTimeout(function () { var t = document.getElementById('cga' + start); if (t) t.scrollIntoView({ block: 'start' }); }, 60);
  }
  // full screen, slide left / right
  function view(key, start) {
    var items = store[key]; if (!items) return;
    close('cgView');
    var d = document.createElement('div'); d.className = 'cgv'; d.id = 'cgView';
    d.innerHTML = '<div class="bar"><button type="button" class="x">✕</button><span class="n" style="flex:1"></span><a class="dl" download>⬇</a></div><div class="track">' +
      items.map(function (it) { return '<div class="sl">' + (isVid(it) ? '<video src="' + esc(it.url) + '" controls preload="none" playsinline></video>' : '<img src="' + esc(it.url) + '" alt="">') + '</div>'; }).join('') + '</div>';
    var tr = d.querySelector('.track'), n = d.querySelector('.n'), dl = d.querySelector('.dl');
    function cur() { return Math.round(tr.scrollLeft / Math.max(1, tr.clientWidth)); }
    function upd() {
      var i = Math.min(items.length - 1, Math.max(0, cur())); n.textContent = (i + 1) + ' / ' + items.length;
      var u = items[i].url; if (noDl.has(u)) { dl.style.display = 'none'; } else { dl.style.display = ''; dl.href = u; }
      tr.querySelectorAll('video').forEach(function (v, k) { if (v.closest('.sl') !== tr.children[i]) v.pause(); });
    }
    tr.addEventListener('scroll', function () { clearTimeout(tr._t); tr._t = setTimeout(upd, 80); });
    d.querySelector('.x').onclick = function () { close('cgView'); };
    document.addEventListener('keydown', function k(e) { if (!document.getElementById('cgView')) { document.removeEventListener('keydown', k); return; } if (e.key === 'Escape') close('cgView'); if (e.key === 'ArrowRight') tr.scrollBy({ left: tr.clientWidth, behavior: 'smooth' }); if (e.key === 'ArrowLeft') tr.scrollBy({ left: -tr.clientWidth, behavior: 'smooth' }); });
    document.body.appendChild(d); document.body.style.overflow = 'hidden';
    setTimeout(function () { tr.scrollLeft = start * tr.clientWidth; upd(); }, 30);
  }

  window.CamGrid = { html: html, open: open, view: view, markPost: markPost, blocked: function (u) { return noDl.has(u); } };
})();
