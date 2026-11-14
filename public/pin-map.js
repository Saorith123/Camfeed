/* CamFeed pin map: a small map you can drag, so you choose the exact spot (Google/GPS can be a few metres off).
   - PinMap.mount(box, {lat, lng, zoom, onMove})  -> interactive map, the pin stays in the middle, drag the map under it
   - PinMap.previewHtml(lat, lng, w, h)           -> a still picture of the place for a chat message card
   Tiles: OpenStreetMap (https://tile.openstreetmap.org). No API key, no extra library. */
(function () {
  'use strict';
  var TILE = 256, MAXZ = 19, MINZ = 3;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function toWorld(lat, lng, z) {
    var n = TILE * Math.pow(2, z), s = Math.sin(clamp(lat, -85.05, 85.05) * Math.PI / 180);
    return { x: (lng + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function fromWorld(x, y, z) {
    var n = TILE * Math.pow(2, z);
    return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI, lng: x / n * 360 - 180 };
  }
  function tileUrl(z, x, y) {
    var n = Math.pow(2, z); x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    return 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png';
  }
  function tileImg(url, left, top) {
    return '<img src="' + url + '" alt="" draggable="false" referrerpolicy="origin" style="position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + TILE + 'px;height:' + TILE + 'px;max-width:none;user-select:none;-webkit-user-drag:none">';
  }
  var PIN = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-100%);font-size:34px;line-height:1;filter:drop-shadow(0 2px 2px rgba(0,0,0,.45));pointer-events:none">📍</div>';
  var ATTR = '<div style="position:absolute;right:4px;bottom:2px;font:10px sans-serif;background:rgba(255,255,255,.75);padding:0 4px;border-radius:3px;color:#333;pointer-events:none">© OpenStreetMap</div>';

  // a still picture (used inside chat messages)
  function previewHtml(lat, lng, w, h, z) {
    z = z || 16; var c = toWorld(lat, lng, z), x0 = c.x - w / 2, y0 = c.y - h / 2, out = '';
    for (var ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty++)
      for (var tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) {
        var u = tileUrl(z, tx, ty); if (u) out += tileImg(u, Math.round(tx * TILE - x0), Math.round(ty * TILE - y0));
      }
    return '<div style="position:relative;width:100%;height:' + h + 'px;overflow:hidden;background:#e5e3df">' + out + PIN + ATTR + '</div>';
  }

  // the map you can move
  function mount(box, opts) {
    opts = opts || {};
    var z = clamp(opts.zoom || 16, MINZ, MAXZ), c = toWorld(opts.lat, opts.lng, z), w = 0, h = 0;
    var tiles = {}, drag = null, pinch = null;
    box.innerHTML = '';
    box.style.position = 'relative'; box.style.overflow = 'hidden'; box.style.touchAction = 'none'; box.style.cursor = 'grab'; box.style.background = '#e5e3df';
    var layer = document.createElement('div'); layer.style.cssText = 'position:absolute;inset:0';
    box.appendChild(layer);
    box.insertAdjacentHTML('beforeend', PIN + ATTR);
    var ctr = document.createElement('div'); ctr.style.cssText = 'position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:6px;z-index:3';
    function btn(t, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.style.cssText = 'width:34px;height:34px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;font-size:20px;font-weight:800;cursor:pointer;color:#0f172a;line-height:1'; b.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); b.addEventListener('click', function (e) { e.stopPropagation(); fn(); }); ctr.appendChild(b); }
    btn('+', function () { setZoom(z + 1); }); btn('−', function () { setZoom(z - 1); });
    box.appendChild(ctr);

    function center() { return fromWorld(c.x, c.y, z); }
    function emit() { if (opts.onMove) { var p = center(); opts.onMove(p.lat, p.lng); } }
    function render() {
      w = box.clientWidth; h = box.clientHeight; if (!w || !h) return;
      var x0 = c.x - w / 2, y0 = c.y - h / 2, keep = {};
      for (var ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty++)
        for (var tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) {
          var u = tileUrl(z, tx, ty); if (!u) continue;
          var key = z + '/' + tx + '/' + ty; keep[key] = 1;
          var img = tiles[key];
          if (!img) { var t = document.createElement('div'); t.innerHTML = tileImg(u, 0, 0); img = tiles[key] = t.firstChild; layer.appendChild(img); }
          img.style.left = Math.round(tx * TILE - x0) + 'px'; img.style.top = Math.round(ty * TILE - y0) + 'px';
        }
      Object.keys(tiles).forEach(function (k) { if (!keep[k]) { layer.removeChild(tiles[k]); delete tiles[k]; } });
    }
    function setZoom(nz) {
      nz = clamp(nz, MINZ, MAXZ); if (nz === z) return;
      var p = center(); z = nz; c = toWorld(p.lat, p.lng, z);
      Object.keys(tiles).forEach(function (k) { layer.removeChild(tiles[k]); delete tiles[k]; }); render(); emit();
    }
    function setCenter(lat, lng) { c = toWorld(lat, lng, z); render(); emit(); }

    var pts = {};
    function dist() { var k = Object.keys(pts); if (k.length < 2) return 0; var a = pts[k[0]], b = pts[k[1]]; return Math.hypot(a.x - b.x, a.y - b.y); }
    box.addEventListener('pointerdown', function (e) {
      try { box.setPointerCapture(e.pointerId); } catch (x) {}
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(pts).length === 2) { pinch = { d: dist(), z: z }; drag = null; } else { drag = { x: e.clientX, y: e.clientY }; box.style.cursor = 'grabbing'; }
    });
    box.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId]) return; pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pinch && Object.keys(pts).length >= 2) { var d = dist(); if (pinch.d > 0 && Math.abs(Math.log2(d / pinch.d)) >= 0.6) { setZoom(pinch.z + Math.round(Math.log2(d / pinch.d))); } return; }
      if (!drag) return; c.x -= e.clientX - drag.x; c.y -= e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; render(); emit();
    });
    function up(e) { delete pts[e.pointerId]; pinch = null; drag = null; box.style.cursor = 'grab'; var k = Object.keys(pts); if (k.length === 1) drag = { x: pts[k[0]].x, y: pts[k[0]].y }; }
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    box.addEventListener('wheel', function (e) { e.preventDefault(); setZoom(z + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    box.addEventListener('dblclick', function () { setZoom(z + 1); });
    var ro = null; if (window.ResizeObserver) { ro = new ResizeObserver(render); ro.observe(box); }
    render(); setTimeout(render, 60); emit();
    return { getCenter: center, setCenter: setCenter, destroy: function () { if (ro) ro.disconnect(); box.innerHTML = ''; } };
  }

  window.PinMap = { mount: mount, previewHtml: previewHtml };
})();
