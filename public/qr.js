/* A small QR-code generator (QR model 2, byte mode, error correction M, versions 1-10) for CamFeed profile links.
   No outside library. Based on the standard algorithm (ISO/IEC 18004).
   CamQR.matrix(text)               -> array of rows of booleans (true = dark)
   CamQR.toSvg(text, opts)          -> SVG string
   CamQR.draw(canvas, text, pixels) -> paints the code (white background, quiet zone included)  */
(function (root) {
  'use strict';
  // version: [error-correction codewords per block, [[blocks, data codewords per block], ...]]   (level M)
  var TABLE = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

  function utf8(str) { var s = unescape(encodeURIComponent(String(str))), out = []; for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); return out; }
  function dataCapacity(v) { return TABLE[v][1].reduce(function (n, b) { return n + b[0] * b[1]; }, 0); }

  // ---- Reed-Solomon over GF(256) ----
  function gfMul(a, b) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((b >>> i) & 1) * a; } return z; }
  function rsGenerator(degree) {
    var r = []; for (var i = 0; i < degree - 1; i++) r.push(0); r.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) { for (var j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = gfMul(root, 0x02); }
    return r;
  }
  function rsRemainder(data, gen) {
    var res = gen.map(function () { return 0; });
    data.forEach(function (b) { var f = b ^ res.shift(); res.push(0); gen.forEach(function (c, i) { res[i] ^= gfMul(c, f); }); });
    return res;
  }

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }

  function encode(text) {
    var bytes = utf8(text), v, countBits;
    for (v = 1; v <= 10; v++) {
      countBits = v < 10 ? 8 : 16;
      if (Math.ceil((4 + countBits + 8 * bytes.length) / 8) <= dataCapacity(v)) break;
    }
    if (v > 10) throw new Error('text is too long for this QR code');
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, countBits); bytes.forEach(function (b) { put(b, 8); });
    var cap = dataCapacity(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = []; for (var i = 0; i < bits.length; i += 8) { var x = 0; for (var k = 0; k < 8; k++) x = (x << 1) | bits[i + k]; data.push(x); }
    return { version: v, data: data };
  }

  function interleave(v, data) {
    var eccLen = TABLE[v][0], groups = TABLE[v][1], numBlocks = groups.reduce(function (n, g) { return n + g[0]; }, 0);
    var raw = Math.floor(rawModules(v) / 8), numShort = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks);
    var gen = rsGenerator(eccLen), blocks = [], k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1)); k += dat.length;
      var ecc = rsRemainder(dat, gen); if (i < numShort) dat.push(0); blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (i = 0; i < blocks[0].length; i++) blocks.forEach(function (b, j) { if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]); });
    return out;
  }

  function build(version, codewords) {
    var size = version * 4 + 17, mod = [], fn = [];
    for (var y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function setFn(x, y, dark) { mod[y][x] = !!dark; fn[y][x] = true; }
    function bit(n, i) { return ((n >>> i) & 1) !== 0; }
    for (var i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, d !== 2 && d !== 4);
      }
    });
    var al = ALIGN[version], n = al.length;
    for (i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) setFn(al[i] + dx2, al[j] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    }
    function drawFormat(mask) {
      var data = (0 << 3) | mask, rem = data;                         // 0 = error correction level M
      for (var k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      for (k = 0; k <= 5; k++) setFn(8, k, bit(bits, k));
      setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
      for (k = 9; k < 15; k++) setFn(14 - k, 8, bit(bits, k));
      for (k = 0; k < 8; k++) setFn(size - 1 - k, 8, bit(bits, k));
      for (k = 8; k < 15; k++) setFn(8, size - 15 + k, bit(bits, k));
      setFn(8, size - 8, true);
    }
    drawFormat(0);
    if (version >= 7) {
      var rem = version; for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = (version << 12) | rem;
      for (i = 0; i < 18; i++) { var a = size - 11 + (i % 3), b = Math.floor(i / 3); setFn(a, b, bit(vb, i)); setFn(b, a, bit(vb, i)); }
    }
    // place the data (zig-zag, two columns at a time, bottom right first)
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var jj = 0; jj < 2; jj++) {
        var x = right - jj, upward = ((right + 1) & 2) === 0, yy2 = upward ? size - 1 - vert : vert;
        if (!fn[yy2][x] && idx < codewords.length * 8) { mod[yy2][x] = bit(codewords[idx >>> 3], 7 - (idx & 7)); idx++; }
      }
    }
    return { size: size, mod: mod, fn: fn, drawFormat: drawFormat };
  }

  var MASKS = [function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; }, function (x, y) { return x % 3 === 0; }, function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; }, function (x, y) { return x * y % 2 + x * y % 3 === 0; },
    function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; }, function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }];

  function penalty(m, size) {
    var score = 0, x, y, run, i;
    function line(get) {
      var r = 1, s = 0;
      for (var k = 1; k < size; k++) { if (get(k) === get(k - 1)) { r++; if (r === 5) s += 3; else if (r > 5) s++; } else r = 1; }
      return s;
    }
    for (y = 0; y < size; y++) score += line(function (k) { return m[y][k]; });
    for (x = 0; x < size; x++) score += line(function (k) { return m[k][x]; });
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    var pat = [true, false, true, true, true, false, true, false, false, false, false], pat2 = pat.slice().reverse();
    function find(get) { var s = 0; for (var st = 0; st + 11 <= size; st++) { var a = true, b = true; for (var k = 0; k < 11; k++) { if (get(st + k) !== pat[k]) a = false; if (get(st + k) !== pat2[k]) b = false; } if (a) s += 40; if (b) s += 40; } return s; }
    for (y = 0; y < size; y++) score += find(function (k) { return m[y][k]; });
    for (x = 0; x < size; x++) score += find(function (k) { return m[k][x]; });
    var dark = 0; for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size; score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;   // balance of dark and light
    return score;
  }

  function matrix(text) {
    var enc = encode(text), cw = interleave(enc.version, enc.data), best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var q = build(enc.version, cw);
      for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (!q.fn[y][x] && MASKS[mask](x, y)) q.mod[y][x] = !q.mod[y][x];
      q.drawFormat(mask);
      var s = penalty(q.mod, q.size);
      if (s < bestScore) { bestScore = s; best = q.mod; }
    }
    return best;
  }

  function toSvg(text, opts) {
    opts = opts || {}; var m = matrix(text), n = m.length, q = opts.quiet === undefined ? 4 : opts.quiet, dark = opts.dark || '#000', light = opts.light || '#fff', d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    var s = n + 2 * q;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s + '" shape-rendering="crispEdges"><rect width="' + s + '" height="' + s + '" fill="' + light + '"/><path d="' + d + '" fill="' + dark + '"/></svg>';
  }

  function draw(canvas, text, pixels) {
    var m = matrix(text), n = m.length, q = 4, total = n + 2 * q, scale = Math.max(2, Math.floor((pixels || 320) / total)), size = total * scale;
    canvas.width = size; canvas.height = size;
    var c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, size, size); c.fillStyle = '#000';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (m[y][x]) c.fillRect((x + q) * scale, (y + q) * scale, scale, scale);
    return canvas;
  }

  var api = { matrix: matrix, toSvg: toSvg, draw: draw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CamQR = api;
})(typeof window !== 'undefined' ? window : this);
