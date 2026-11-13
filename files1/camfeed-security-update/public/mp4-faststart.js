/* CamFeed: move the "moov" index of an MP4/MOV file to the FRONT so the video starts playing
   immediately while it is still downloading (no spinner / black screen). Works in the browser
   (File/Blob) and in Node (for tests). The video data itself is NOT re-encoded or loaded into
   memory: only the small index is read and patched, the rest is streamed from the original file.
   Returns the original file untouched whenever anything looks unusual (safe fallback). */
(function (root) {
  'use strict';
  var MAX_MOOV_BYTES = 64 * 1024 * 1024;

  function fourcc(dv, o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); }

  async function readTopLevelBoxes(file) {
    var boxes = [], pos = 0, total = file.size;
    while (pos + 8 <= total) {
      var buf = await file.slice(pos, Math.min(pos + 16, total)).arrayBuffer();
      var dv = new DataView(buf);
      var size = dv.getUint32(0), type = fourcc(dv, 4), header = 8;
      if (size === 1) {
        if (buf.byteLength < 16) return null;
        var big = dv.getBigUint64(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(big); header = 16;
      } else if (size === 0) {
        size = total - pos;
      }
      if (size < header || pos + size > total) return null;   // corrupt / truncated
      boxes.push({ type: type, start: pos, size: size, header: header });
      pos += size;
    }
    return pos === total ? boxes : null;
  }

  // Adds `delta` to every chunk offset (stco / co64) inside the moov bytes. Returns false if unsafe.
  function patchChunkOffsets(bytes, delta) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, edts: 0 };
    var ok = true;
    function walk(start, end) {
      var p = start;
      while (p + 8 <= end && ok) {
        var size = dv.getUint32(p), type = fourcc(dv, p + 4), header = 8;
        if (size === 1) { size = Number(dv.getBigUint64(p + 8)); header = 16; }
        else if (size === 0) { size = end - p; }
        if (size < header || p + size > end) { ok = false; return; }
        if (type === 'cmov') { ok = false; return; }               // compressed moov: bail out
        if (type === 'stco') {
          var n = dv.getUint32(p + header + 4);
          for (var i = 0; i < n; i++) {
            var o = p + header + 8 + i * 4;
            var v = dv.getUint32(o) + delta;
            if (v > 0xFFFFFFFF) { ok = false; return; }
            dv.setUint32(o, v);
          }
        } else if (type === 'co64') {
          var n2 = dv.getUint32(p + header + 4);
          for (var j = 0; j < n2; j++) {
            var o2 = p + header + 8 + j * 8;
            dv.setBigUint64(o2, dv.getBigUint64(o2) + BigInt(delta));
          }
        } else if (CONTAINERS[type]) {
          walk(p + header, p + size);
        }
        p += size;
      }
    }
    walk(0, bytes.byteLength);
    return ok;
  }

  async function ensureFastStart(file) {
    try {
      if (!file || typeof file.slice !== 'function' || file.size < 32) return file;
      var boxes = await readTopLevelBoxes(file);
      if (!boxes || boxes.length < 3 || boxes[0].type !== 'ftyp') return file;
      var types = boxes.map(function (b) { return b.type; });
      if (types.indexOf('moof') !== -1) return file;                    // fragmented MP4: already stream-friendly
      var moovIdx = types.indexOf('moov'), mdatIdx = types.indexOf('mdat');
      if (moovIdx === -1 || mdatIdx === -1) return file;
      if (moovIdx < mdatIdx) return file;                                // already "fast start"
      if (moovIdx !== boxes.length - 1) return file;                     // moov must be the LAST box (the usual case)
      var moov = boxes[moovIdx], ftyp = boxes[0];
      if (moov.size > MAX_MOOV_BYTES) return file;

      var moovBytes = new Uint8Array(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
      // patch only the children (skip the moov header itself)
      var inner = moovBytes.subarray(moov.header);
      if (!patchChunkOffsets(inner, moov.size)) return file;

      var ftypEnd = ftyp.start + ftyp.size;
      var out = new Blob([file.slice(0, ftypEnd), moovBytes, file.slice(ftypEnd, moov.start)],
        { type: file.type || 'video/mp4' });
      if (out.size !== file.size) return file;                          // sanity check
      if (typeof File !== 'undefined' && file.name) {
        return new File([out], file.name, { type: file.type || 'video/mp4' });
      }
      return out;
    } catch (e) {
      return file;
    }
  }

  var api = { ensureFastStart: ensureFastStart, _readTopLevelBoxes: readTopLevelBoxes, _patchChunkOffsets: patchChunkOffsets };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CamFaststart = api;
})(typeof window !== 'undefined' ? window : globalThis);
