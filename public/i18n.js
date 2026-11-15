/* CamFeed language engine: one place that decides the language (km / en / ...) and translates screens with OUR OWN word list
   (i18n-dict.js), never with Google. Works on text that is already on the page, text added later, placeholders, titles, alert() ...
   Pages that already have their own km/en texts keep working: this only fills the gaps. */
(function () {
  'use strict';
  if (window.CamI18n) return;
  var KEY = 'camfeed_lang';
  var LANGS = [{ code: 'km', label: 'ភាសាខ្មែរ', flag: '🇰🇭' }, { code: 'en', label: 'English', flag: '🇺🇸' }];   // add { code:'zh', label:'中文', flag:'🇨🇳' } + i18n-dict zh section to add Chinese
  var inFrame = false; try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }

  function stored() { try { var l = localStorage.getItem(KEY); return LANGS.some(function (x) { return x.code === l; }) ? l : ''; } catch (e) { return ''; } }
  function lang() { return stored() || 'km'; }
  var L = lang();
  try { document.documentElement.lang = L; } catch (e) {}

  // ---------- word list ----------
  // window.CAM_DICT = { en: { 'ខ្មែរ': 'English', 'pattern {0}': ... }, km: { 'English': 'ខ្មែរ' } }
  var dict = (window.CAM_DICT && window.CAM_DICT[L]) || {};
  var exact = Object.create(null), patterns = [];
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  Object.keys(dict).forEach(function (k) {
    var nk = norm(k);
    if (/\{\d+\}/.test(nk)) {
      var parts = nk.split(/\{(\d+)\}/), re = '^', order = [];
      for (var i = 0; i < parts.length; i++) { if (i % 2 === 0) re += parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); else { re += '([\\s\\S]+?)'; order.push(+parts[i]); } }
      patterns.push({ re: new RegExp(re + '$'), order: order, to: dict[k] });
    } else exact[nk] = dict[k];
  });
  patterns.sort(function (a, b) { return b.re.source.length - a.re.source.length; });

  var HAS = L === 'en' ? /[ក-៿]/ : /[A-Za-z]/;           // only touch text that is in the "other" language
  var cache = Object.create(null);
  function tr(s) {
    if (s == null) return s;
    var raw = String(s);
    if (!HAS.test(raw)) return raw;
    var key = norm(raw);
    if (key in cache) return cache[key] === null ? raw : wrap(raw, cache[key]);
    var out = lookup(key);
    cache[key] = out;
    return out === null ? raw : wrap(raw, out);
  }
  function wrap(raw, out) {                                           // keep the original leading / trailing spaces
    var m = /^(\s*)[\s\S]*?(\s*)$/.exec(raw); return (m ? m[1] : '') + out + (m ? m[2] : '');
  }
  var EDGE = /^((?:[^\p{L}\p{M}\p{N}]|[\uFE0F\u200D])*)([\s\S]*?)((?:[^\p{L}\p{M}\p{N}]|[\uFE0F\u200D])*)$/u;
  function lookup(key) {
    if (key in exact) return exact[key];
    var m = EDGE.exec(key);                                           // "⚙️ Settings" -> prefix "⚙️ " + "Settings"
    if (m && (m[1] || m[3]) && m[2] && m[2] in exact) return m[1] + exact[m[2]] + m[3];
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i], r = p.re.exec(key);
      if (r) { var out = p.to; for (var j = 0; j < p.order.length; j++) out = out.split('{' + p.order[j] + '}').join(tr(r[j + 1])); return out; }
    }
    if (L === 'km' && /[\u1780-\u17FF]/.test(key) && /\s*\([A-Za-z][A-Za-z0-9 ,\/&'.:+-]*\)/.test(key)) {   // "ការបង្ហោះ (Post)" -> "ការបង្ហោះ"
      var o = key.replace(/\s*\([A-Za-z][A-Za-z0-9 ,\/&'.:+-]*\)/g, '').replace(/\s*\/\s*[A-Za-z][A-Za-z ]*$/, '').trim();
      if (o && o !== key) return o;
    }
    return null;
  }
  function trMulti(s) {
    var raw = String(s); if (!HAS.test(raw)) return raw;
    var whole = tr(raw); if (whole !== raw) return whole;
    if (raw.indexOf('\n') >= 0) return raw.split('\n').map(function (x) { return tr(x); }).join('\n');
    return raw;
  }

  // ---------- translate the page ----------
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, CODE: 1, PRE: 1 };
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-placeholder'];
  function skipEl(el) { return !el || SKIP[el.nodeName] || (el.closest && el.closest('[translate="no"],.notranslate,[data-i18n-skip]')); }
  function doText(n) { var v = n.nodeValue; if (!v || !HAS.test(v)) return; var o = tr(v); if (o !== v) n.nodeValue = o; }
  function doEl(el) {
    if (el.nodeType !== 1 || skipEl(el)) return;
    for (var i = 0; i < ATTRS.length; i++) { var a = el.getAttribute(ATTRS[i]); if (a && HAS.test(a)) { var o = tr(a); if (o !== a) el.setAttribute(ATTRS[i], o); } }
    if (el.nodeName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) { var v = el.value; if (v && HAS.test(v)) { var o2 = tr(v); if (o2 !== v) el.value = o2; } }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skipEl(root.parentNode)) doText(root); return; }
    if (root.nodeType !== 1 || skipEl(root)) return;
    doEl(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.nodeType === 1 ? (skipEl(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) : NodeFilter.FILTER_ACCEPT; } });
    var n; while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doEl(n); }
  }
  function titleFix() { if (document.title && HAS.test(document.title)) { var o = tr(document.title); if (o !== document.title) document.title = o; } }

  var queue = [], timer = 0;
  function flush() { timer = 0; var q = queue; queue = []; for (var i = 0; i < q.length; i++) { try { walk(q[i]); } catch (e) {} } titleFix(); }
  function enqueue(n) { queue.push(n); if (!timer) timer = setTimeout(flush, 30); }
  var obs = null;
  function start() {
    if (!Object.keys(exact).length && !patterns.length) return;
    walk(document.body || document.documentElement); titleFix();
    obs = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) enqueue(m.addedNodes[j]); }
        else if (m.type === 'characterData') enqueue(m.target);
        else if (m.type === 'attributes') enqueue(m.target);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // ---------- alert / confirm / prompt ----------
  ['alert', 'confirm', 'prompt'].forEach(function (fn) {
    var orig = window[fn]; if (typeof orig !== 'function') return;
    window[fn] = function (msg) { var a = arguments; if (typeof msg === 'string') { a = Array.prototype.slice.call(arguments); a[0] = trMulti(msg); } return orig.apply(window, a); };
  });

  // ---------- choosing the language ----------
  function setLang(code) {
    if (!LANGS.some(function (x) { return x.code === code; })) return;
    try { localStorage.setItem(KEY, code); } catch (e) {}
    location.reload();
  }
  function chooser() {
    if (inFrame || stored() || document.getElementById('ciLang')) return;
    if (/\/(admin|live)\.html/.test(location.pathname)) return;
    var d = document.createElement('div'); d.id = 'ciLang'; d.setAttribute('translate', 'no');
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;padding:20px;font-family:inherit';
    var box = '<div style="background:#fff;border-radius:18px;max-width:340px;width:100%;padding:22px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.35)">' +
      '<div style="font-size:34px">🌐</div><div style="font-size:18px;font-weight:800;margin:6px 0 2px;color:#0f172a">ជ្រើសរើសភាសា</div><div style="font-size:15px;color:#475569;margin-bottom:14px">Choose your language</div>';
    LANGS.forEach(function (x) { box += '<button type="button" data-l="' + x.code + '" style="display:block;width:100%;margin:8px 0;padding:13px;border:1.5px solid #cbd5e1;background:#f8fafc;border-radius:12px;font-size:17px;font-weight:700;cursor:pointer;color:#0f172a">' + x.flag + ' ' + x.label + '</button>'; });
    d.innerHTML = box + '</div>';
    d.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('button[data-l]'); if (b) { var c = b.getAttribute('data-l'); try { localStorage.setItem(KEY, c); } catch (x) {} if (c === L) { d.remove(); } else location.reload(); } });
    document.body.appendChild(d);
  }
  function maybeChooser() { if (!stored()) chooser(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeChooser); else maybeChooser();

  window.CamI18n = { lang: lang, setLang: setLang, tr: tr, t: trMulti, langs: LANGS, translate: function (el) { walk(el || document.body); } };
  window.camT = trMulti;      // for scripts: alert(camT('...'))
})();
