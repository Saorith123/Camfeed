/* CamFeed Admin Center: Overview, Users (search + manage), Content moderation, Activity log, System check.
   Everything shown comes from the server as TEXT (never inserted as HTML). Uses the page's currentUser / savedAdminKey. */
(function () {
  'use strict';
  var TABS = [['inbox', '🔔 Inbox'], ['overview', '📊 Overview'], ['umanage', '👥 Users'], ['chats', '💬 Chats'], ['content', '📝 Content'], ['audit', '🧾 Activity Log'], ['live', '🔴 Live'], ['sounds', '🎵 Sounds'], ['ads', '📢 Ads'], ['party', '🎉 Party Room'], ['coins', '💎 Diamonds & Gifts'], ['stars', '⭐ Stars'], ['challenges', '🎯 Challenges'], ['system', '⚙️ System'], ['appcfg', '🧩 App features & lists'], ['perms', '👮 Admins & rights'], ['copyright', '©️ Copyright'], ['views', '🔍 Views check'], ['keywords', '🏷️ AI Keywords'], ['verify', '✔ Official accounts']];
  // the menu, in groups (left side on a computer, on top on a phone)
  var GROUPS = [
    ['🏠 Start', ['inbox', 'overview', 'audit']],
    ['👥 People', ['umanage', 'users', 'accounts', 'verify', 'chats']],
    ['🛡️ Content & safety', ['reports', 'copyright', 'content', 'keywords', 'posts', 'live']],
    ['💰 Money', ['monetization', 'views', 'coins', 'ads']],
    ['🎉 Fun', ['party', 'challenges', 'stars', 'sounds']],
    ['⚙️ Settings', ['system', 'appcfg', 'perms']],
  ];

  // ---------- 🌐 the Admin's language: Khmer or English, one at a time (the button at the top right) ----------
  var ALANG = (function () { try { return localStorage.getItem('admin_lang') === 'en' ? 'en' : 'km'; } catch (e) { return 'km'; } })();
  function AT(km, en) { return ALANG === 'en' ? en : km; }
  (function langButton() {
    function add() {
      if (document.getElementById('atLangBtn')) return;
      var b = document.createElement('button'); b.id = 'atLangBtn'; b.type = 'button';
      b.textContent = ALANG === 'en' ? '🌐 ភាសាខ្មែរ' : '🌐 English';
      b.title = ALANG === 'en' ? 'ប្ដូរទៅភាសាខ្មែរ' : 'Switch to English';
      b.style.cssText = 'position:fixed;top:10px;right:12px;z-index:9000;background:#fff;border:1px solid #ccd0d5;border-radius:18px;padding:7px 14px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.12)';
      b.onclick = function () { try { localStorage.setItem('admin_lang', ALANG === 'en' ? 'km' : 'en'); } catch (e) {} location.reload(); };
      document.body.appendChild(b);
    }
    if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  })();

  // ---------- 🌐 Khmer: every English text of the Admin pages that is in admin-km.js is shown in Khmer (also texts added later) ----------
  (function kmAdmin() {
    var D = window.ADMIN_KM; if (ALANG !== 'km' || !D) return;
    var pre = Object.keys(D).filter(function (k) { return k.length >= 4 && /[\s:(\$#@]$/.test(k); }).sort(function (a, b) { return b.length - a.length; });
    function tr(s) {
      if (!s || !/[A-Za-z]/.test(s)) return null;
      var t = s.trim(); if (!t) return null;
      if (Object.prototype.hasOwnProperty.call(D, t)) return s.replace(t, D[t]);
      if (Object.prototype.hasOwnProperty.call(D, s)) return D[s];
      for (var i = 0; i < pre.length; i++) { var k = pre[i]; if (s.indexOf(k) === 0) return D[k] + s.slice(k.length); var k2 = k.trim(); if (k2.length >= 4 && t.indexOf(k2) === 0 && t.length > k2.length && /[\s:(\$#@]/.test(k.slice(-1))) return s.replace(k2, D[k].trim()); }
      return null;
    }
    var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
    function walk(n) {
      if (!n) return;
      if (n.nodeType === 3) { var p = n.parentNode; if (p && SKIP[p.nodeName]) return; if (p && p.closest && p.closest('[data-raw], .notranslate')) return; var x = tr(n.nodeValue); if (x !== null && x !== n.nodeValue) n.nodeValue = x; return; }
      if (n.nodeType !== 1 || SKIP[n.nodeName]) return;
      ['placeholder', 'title'].forEach(function (a) { var v = n.getAttribute && n.getAttribute(a); if (v) { var x = tr(v); if (x !== null) n.setAttribute(a, x); } });
      if (n.nodeName === 'OPTION' && !n.hasAttribute('value')) n.setAttribute('value', n.textContent);   // keep the English value: only the shown text becomes Khmer
      if (n.nodeName === 'INPUT' && (n.type === 'button' || n.type === 'submit') && n.value) { var y = tr(n.value); if (y !== null) n.value = y; }
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
    }
    function start() {
      walk(document.body);
      try { if (document.title) { var tt = tr(document.title); if (tt) document.title = tt; } } catch (e) {}
      new MutationObserver(function (ms) {
        ms.forEach(function (m) {
          if (m.type === 'characterData') { var x = tr(m.target.nodeValue); if (x !== null && x !== m.target.nodeValue) m.target.nodeValue = x; }
          else m.addedNodes.forEach(walk);
        });
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  })();

  // ---------- helpers ----------
  function el(tag, props, kids) {
    var e = document.createElement(tag); props = props || {};
    Object.keys(props).forEach(function (k) {
      if (k === 'text') e.textContent = props[k]; else if (k === 'style') e.style.cssText = props[k]; else if (k === 'class') e.className = props[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), props[k]); else e.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  // ---------- every click answers at once ----------
  // • the button you pressed shows ⏳ and can not be pressed again until the server answers (no 4–5 double sends)
  // • a card pops up in the middle of the screen: ⏳ working… → ✅ Done / ❌ the problem (instead of the grey browser box)
  (function css() {
    if (document.getElementById('atFbCss')) return;
    var st = document.createElement('style'); st.id = 'atFbCss';
    st.textContent = '.at-fb{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%) scale(.6);opacity:0;z-index:100000;min-width:220px;max-width:min(92vw,460px);padding:18px 22px;border-radius:18px;background:#fff;color:#1c1e21;box-shadow:0 18px 50px rgba(0,0,0,.28);font-size:15.5px;font-weight:700;text-align:center;line-height:1.45;transition:transform .22s cubic-bezier(.34,1.56,.64,1),opacity .18s;pointer-events:auto;cursor:pointer;white-space:pre-line}' +
      '.at-fb.on{transform:translate(-50%,-50%) scale(1);opacity:1}.at-fb .ic{display:block;font-size:40px;margin-bottom:6px;animation:atPop .45s ease}.at-fb.ok{border-top:6px solid #22c55e}.at-fb.err{border-top:6px solid #e41e3f}.at-fb.busy{border-top:6px solid #7c3aed}.at-fb.info{border-top:6px solid #f59e0b}' +
      '@keyframes atPop{0%{transform:scale(.3)}60%{transform:scale(1.25)}100%{transform:scale(1)}}@keyframes atSpin{to{transform:rotate(360deg)}}' +
      '.at-fb .sp{display:block;width:34px;height:34px;margin:0 auto 8px;border:4px solid #e9d5ff;border-top-color:#7c3aed;border-radius:50%;animation:atSpin .8s linear infinite}' +
      'button.at-busy{opacity:.65;cursor:wait!important;position:relative}button.at-busy::after{content:"";display:inline-block;width:12px;height:12px;margin-left:6px;vertical-align:-2px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:atSpin .7s linear infinite}';
    document.head.appendChild(st);
  })();
  var fbEl = null, fbT = null;
  function feedback(kind, text, ms) {
    if (!fbEl) { fbEl = document.createElement('div'); fbEl.className = 'at-fb'; fbEl.addEventListener('click', function () { fbEl.classList.remove('on'); }); document.body.appendChild(fbEl); }
    clearTimeout(fbT);
    fbEl.className = 'at-fb ' + kind; fbEl.textContent = '';
    if (kind === 'busy') fbEl.appendChild(el('span', { class: 'sp' }));
    else fbEl.appendChild(el('span', { class: 'ic', text: kind === 'ok' ? '✅' : kind === 'err' ? '❌' : 'ℹ️' }));
    fbEl.appendChild(document.createTextNode(String(text || '').replace(/^[✅❌]\s*/, '')));
    void fbEl.offsetWidth; fbEl.classList.add('on');
    var len = String(text || '').length;
    if (ms !== 0) fbT = setTimeout(function () { fbEl.classList.remove('on'); }, ms || Math.min(10000, Math.max(kind === 'err' ? 4000 : 1400, len * 45)));
  }
  // the browser's grey alert box → CamFeed's card
  function alert(m) {
    m = String(m == null ? '' : m);
    var bad = /^❌|fail|error|could not|can not|cannot|not found|only a super|must |please /i.test(m) && !/^✅/.test(m);
    feedback(/^✅/.test(m) ? 'ok' : (bad ? 'err' : 'info'), m);
  }
  // remember which button was just pressed (and stop a second press while it is still working)
  var pressed = null;
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    if (b.classList.contains('at-busy')) { ev.preventDefault(); ev.stopImmediatePropagation(); feedback('busy', 'Working… please wait', 900); return; }
    pressed = b; setTimeout(function () { if (pressed === b) pressed = null; }, 0);   // only for the request this click starts
  }, true);
  function adm(path, body, method) {
    var payload = Object.assign({ adminEmail: currentUser.email, adminKey: savedAdminKey }, body || {});
    var btn = pressed, isAction = !!btn && Object.keys(body || {}).length > 0;
    var slow = null;
    if (btn) { btn.classList.add('at-busy'); }
    if (isAction) slow = setTimeout(function () { feedback('busy', 'Working…', 0); }, 350);
    return fetch(path, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) { return r.json().catch(function () { return { success: false, error: 'Bad answer from the server.' }; }); })
      .catch(function () { return { success: false, error: 'Server connection error.' }; })
      .then(function (x) {
        clearTimeout(slow);
        if (btn) btn.classList.remove('at-busy');
        if (isAction) {
          if (x && x.success) feedback('ok', 'Done');
          else if (x && /already decided|already/i.test(String(x.error || ''))) { x.error = '✅ This was already done.'; feedback('ok', 'This was already done'); }
          else feedback('err', (x && x.error) || 'Failed');
        }
        return x;
      });
  }
  function fmt(d) { if (!d) return '—'; var x = new Date(d); return isNaN(x) ? '—' : x.toLocaleString(); }
  function ago(d) {
    if (!d) return 'never'; var s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (isNaN(s)) return '—'; if (s < 120) return 'now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago';
  }
  function nm(u) { return ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || '(no name)'; }
  function roleBadge(role, banned) {
    if (banned) return el('span', { class: 'badge badge-banned', text: 'BANNED' });
    return el('span', { class: 'badge ' + (role === 'super_admin' ? 'badge-super' : role === 'admin' ? 'badge-admin' : 'badge-user'), text: role === 'super_admin' ? 'SUPER ADMIN' : role === 'admin' ? 'ADMIN' : 'USER' });
  }
  function msg(box, ok, text) { box.textContent = text; box.style.cssText = 'margin:10px 0;padding:10px 12px;border-radius:8px;font-size:13.5px;display:' + (text ? 'block' : 'none') + ';background:' + (ok ? '#e6f4ea' : '#fdecee') + ';color:' + (ok ? '#176f35' : '#9b1229'); }
  function empty(text) { return el('div', { style: 'text-align:center;color:#65676b;padding:24px;font-size:14px', text: text }); }
  function table(headers, rows) {
    var thead = el('thead', {}, [el('tr', {}, headers.map(function (h) { return el('th', { text: h }); }))]);
    return el('table', {}, [thead, el('tbody', {}, rows)]);
  }


  // ---------- delete / warn a post: choose a reason and tell the owner (shows in their notification bell) ----------
  var REASONS = [
    'ខុសលក្ខខណ្ឌប្រើប្រាស់ (Violates our Terms)',
    'មាតិកាអាសអាភាស (Nudity / sexual content)',
    'អំពើហិង្សា ឬគ្រោះថ្នាក់ (Violence / harmful content)',
    'បោកប្រាស់ ឬព័ត៌មានក្លែងក្លាយ (Scam / fake news)',
    'ជេរប្រមាថ ឬរំលោភបំពាន (Harassment / hate speech)',
    'ស្ប៉ាម ឬផ្សាយពាណិជ្ជកម្មមិនត្រឹមត្រូវ (Spam / unwanted ads)',
    'រំលោភសិទ្ធិអ្នកដទៃ (Copyright / stolen content)',
    'ផ្សេងៗ (Other) — សរសេរក្នុងប្រអប់ខាងក្រោម'
  ];
  window.adminPostDialog = function (postId, onDone) {
    var old = document.getElementById('atPostDlg'); if (old) old.remove();
    var action = el('select', { style: 'width:100%;padding:9px;margin:6px 0 12px;border:1px solid #ccd0d5;border-radius:8px;font-size:14px' }, [
      el('option', { value: 'delete', text: '🗑 Delete the post/video (and tell the owner)' }),
      el('option', { value: 'warning', text: '⚠️ Only send a warning (keep the post)' })
    ]);
    var reason = el('select', { style: 'width:100%;padding:9px;margin:6px 0 12px;border:1px solid #ccd0d5;border-radius:8px;font-size:14px' }, REASONS.map(function (r) { return el('option', { value: r, text: r }); }));
    var note = el('textarea', { rows: '3', maxlength: '400', placeholder: 'Extra message to the owner (optional)…', style: 'width:100%;padding:9px;border:1px solid #ccd0d5;border-radius:8px;font-size:14px;box-sizing:border-box' });
    var notify = el('input', { type: 'checkbox', checked: 'checked' });
    var status = el('div', { style: 'margin:10px 0;font-size:13px;color:#b3261e' });
    var go = el('button', { class: 'btn-sm btn-red', style: 'padding:10px 18px;font-size:14px', text: 'Confirm' });
    var cancel = el('button', { class: 'btn-sm btn-gray', style: 'padding:10px 18px;font-size:14px;margin-left:8px', text: 'Cancel' });
    var ov = el('div', { id: 'atPostDlg', class: 'at-modal' }, [el('div', { class: 'at-card', style: 'max-width:480px' }, [
      el('h3', { style: 'margin:0 0 10px', text: 'Post/Video #' + postId }),
      el('label', { style: 'font-weight:700;font-size:13px', text: 'What do you want to do?' }), action,
      el('label', { style: 'font-weight:700;font-size:13px', text: 'Reason' }), reason,
      el('label', { style: 'font-weight:700;font-size:13px', text: 'Message to the owner' }), note,
      el('label', { style: 'display:flex;gap:8px;align-items:center;margin:12px 0;font-size:13.5px' }, [notify, document.createTextNode('Send a notification to the owner (they see it in the 🔔 bell)')]),
      status, el('div', {}, [go, cancel])
    ])]);
    function close() { ov.remove(); }
    cancel.addEventListener('click', close);
    action.addEventListener('change', function () { go.textContent = action.value === 'delete' ? 'Delete' : 'Send warning'; notify.disabled = action.value !== 'delete'; if (action.value !== 'delete') notify.checked = true; });
    action.dispatchEvent(new Event('change'));
    go.addEventListener('click', function () {
      var isDel = action.value === 'delete';
      if (isDel && !confirm('Delete Post/Video #' + postId + ' for ever?')) return;
      go.disabled = true; status.textContent = '';
      var rs = reason.value.indexOf('ផ្សេងៗ') === 0 ? '' : reason.value;
      var p = isDel ? adm('/api/admin/posts/' + encodeURIComponent(postId), { reason: rs, note: note.value.trim(), notify: notify.checked }, 'DELETE')
                    : adm('/api/admin/notice', { postId: postId, kind: 'warning', reason: rs, note: note.value.trim() });
      p.then(function (r) { go.disabled = false; if (!r.success) { status.textContent = r.error || 'Could not do it.'; return; } close(); if (onDone) onDone(r, isDel); });
    });
    document.body.appendChild(ov);
  };

  var css = el('style', { text: '.at-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}' +
    '.at-card{background:#fff;border-radius:14px;max-width:760px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.35)}' +
    '.at-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.at-in{width:100%;padding:9px 11px;border:1px solid #ccd0d5;border-radius:8px;font-size:14px;background:#fff}' +
    '.at-lbl{font-size:12px;font-weight:700;color:#65676b;margin:8px 0 3px}.at-h{font-size:15px;font-weight:800;margin:18px 0 8px}' +
    '.at-bars{display:flex;align-items:flex-end;gap:5px;height:110px;margin-top:8px}.at-bar{flex:1;background:#1877f2;border-radius:4px 4px 0 0;min-height:3px;position:relative}' +
    '.at-bar span{position:absolute;top:-16px;left:0;right:0;text-align:center;font-size:10.5px;color:#65676b}.at-days{display:flex;gap:5px;margin-top:4px}.at-days div{flex:1;text-align:center;font-size:10px;color:#65676b}' +
    '.at-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.at-ok{color:#176f35;font-weight:800}.at-warn{color:#b45309;font-weight:800}' +
    '.at-chk{display:flex;gap:12px;align-items:flex-start;padding:11px 4px;border-bottom:1px solid #f0f2f5}.at-chk b{display:block}.at-chk small{color:#65676b}' });
  document.head.appendChild(css);
  // grouped menu: a left column on a computer, scrolling groups on a phone
  document.head.appendChild(el('style', { text:
    '.admin-layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:18px;align-items:start}' +
    '.admin-layout>*{grid-column:2}.admin-layout>.tabs-bar{grid-column:1;grid-row:1/span 60;position:sticky;top:12px;flex-direction:column;flex-wrap:nowrap;gap:12px;margin:0;' +
    'background:#fff;border:1px solid #e4e6eb;border-radius:14px;padding:12px;max-height:calc(100vh - 24px);overflow-y:auto}' +
    '.nav-group{display:flex;flex-direction:column;gap:4px}.nav-title{font-size:11.5px;font-weight:800;color:#8a8d91;text-transform:uppercase;letter-spacing:.4px;padding:2px 8px 4px}' +
    '.nav-group .tab-btn{text-align:left;border:none;background:transparent;padding:9px 10px;border-radius:9px;font-size:14px;color:#1c1e21;width:100%}' +
    '.nav-group .tab-btn:hover{background:#f0f2f5}.nav-group .tab-btn.active{background:#e7f3ff;color:#1877f2}' +
    // a narrow screen (phone, small window): the menu groups in 3 columns, everything seen at once (no sideways scrolling)
    '@media (max-width:900px){.admin-layout{display:block}.admin-layout>.tabs-bar{position:static;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 8px;overflow:visible;max-height:none;margin-bottom:14px}' +
    '.nav-group{min-width:0}.nav-group .tab-btn{padding:8px 6px;font-size:13px;white-space:normal;line-height:1.3}.nav-title{padding:2px 6px 4px;font-size:10.5px}}' +
    '.at-chips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0 14px}.at-chips .btn-sm{width:100%;text-align:left;white-space:normal;line-height:1.3}' }));

  // ---------- tabs ----------
  function build() {
    var bar = document.querySelector('.tabs-bar'), dash = document.getElementById('adminDashboard'); if (!bar || !dash) return;
    TABS.forEach(function (t) {
      bar.insertBefore(el('button', { class: 'tab-btn', id: 'tabBtn-' + t[0], text: t[1], onclick: function () { switchAdminTab(t[0]); } }), bar.firstChild && t[0] === 'overview' ? bar.firstChild : null);
      dash.appendChild(el('div', { class: 'panel', id: 'panel-' + t[0], style: 'display:none' }));
    });
    // the menu in groups; any button not in a group goes to the last one
    var placed = {};
    var loose = Array.prototype.slice.call(bar.querySelectorAll('.tab-btn'));
    GROUPS.forEach(function (g) {
      var box = el('div', { class: 'nav-group' }, [el('div', { class: 'nav-title', text: g[0] })]);
      g[1].forEach(function (id) { var b = document.getElementById('tabBtn-' + id); if (b) { box.appendChild(b); placed[id] = 1; } });
      bar.appendChild(box);
    });
    var last = bar.lastChild;
    loose.forEach(function (b) { if (!placed[b.id.replace('tabBtn-', '')]) last.appendChild(b); });
    dash.classList.add('admin-layout');
  }

  // ---------- Overview ----------
  var LABELS = [['users', '👥 Users'], ['usersToday', '🆕 New today'], ['users7', '🆕 New 7 days'], ['users30', '🆕 New 30 days'], ['activeNow', '🟢 Online now'], ['active24', '🕒 Active 24 h'], ['banned', '⛔ Banned'], ['admins', '🛡️ Admins'],
    ['posts', '📝 Posts'], ['videos', '🎬 Videos'], ['images', '🖼️ Photos'], ['posts24', '📈 Posts 24 h'], ['comments', '💬 Comments'], ['reactions', '👍 Reactions'], ['follows', '🤝 Follows'], ['messages', '✉️ Messages'], ['reportsPending', '🚩 Pending reports'], ['blocks', '🚫 Blocks']];
  function chart(title, series) {
    var max = Math.max.apply(null, series.map(function (s) { return s.n; }).concat([1]));
    var bars = el('div', { class: 'at-bars' }, series.map(function (s) { var b = el('div', { class: 'at-bar', title: s.day + ': ' + s.n, style: 'height:' + Math.max(3, Math.round(s.n / max * 100)) + '%' }); b.appendChild(el('span', { text: String(s.n) })); return b; }));
    var days = el('div', { class: 'at-days' }, series.map(function (s) { return el('div', { text: s.day.slice(8) }); }));
    return el('div', { style: 'margin-top:18px' }, [el('div', { class: 'at-h', text: title }), series.length ? bars : empty('No data yet'), series.length ? days : null]);
  }
  function loadOverview() {
    var p = document.getElementById('panel-overview'); p.textContent = ''; p.appendChild(empty('Loading…'));
    adm('/api/admin/overview').then(function (d) {
      p.textContent = '';
      if (!d.success) { p.appendChild(empty(d.error || 'Could not load.')); return; }
      p.appendChild(el('div', { class: 'at-row' }, [el('button', { class: 'btn-sm btn-gray', text: '↻ Refresh', onclick: loadOverview })]));
      var grid = el('div', { class: 'stats-grid', style: 'margin-bottom:0' });
      LABELS.forEach(function (l) { var v = d.totals[l[0]]; if (v === null || v === undefined) return; grid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 'stat-label', text: l[1] }), el('div', { class: 'stat-val', text: Number(v).toLocaleString() })])); });
      p.appendChild(grid); p.appendChild(chart('New accounts, last 14 days', d.series.signups)); p.appendChild(chart('New posts, last 14 days', d.series.posts));
    });
  }

  // ---------- Users ----------
  var uState = { offset: 0, last: null };
  function buildUsers() {
    var p = document.getElementById('panel-umanage'); p.textContent = '';
    var q = el('input', { class: 'at-in', id: 'uQuery', placeholder: 'Name, phone number, Gmail or 15-digit ID', style: 'max-width:340px', onkeydown: function (e) { if (e.key === 'Enter') searchUsers(true); } });
    var role = el('select', { class: 'at-in', id: 'uRole', style: 'width:auto' }, [el('option', { value: '', text: 'Any role' }), el('option', { value: 'user', text: 'Users' }), el('option', { value: 'admin', text: 'Admins' }), el('option', { value: 'super_admin', text: 'Super Admins' })]);
    var st = el('select', { class: 'at-in', id: 'uStatus', style: 'width:auto' }, [el('option', { value: '', text: 'Any status' }), el('option', { value: 'active', text: 'Active' }), el('option', { value: 'banned', text: 'Banned' })]);
    p.appendChild(el('div', { class: 'at-row' }, [q, role, st, el('button', { class: 'btn-sm btn-blue', text: 'Search', onclick: function () { searchUsers(true); } })]));
    p.appendChild(el('div', { id: 'uResults' })); p.appendChild(el('div', { id: 'uMore', style: 'text-align:center;margin-top:10px' }));
    searchUsers(true);
  }
  function searchUsers(reset) {
    if (reset) uState.offset = 0;
    var box = document.getElementById('uResults'), more = document.getElementById('uMore'); if (reset) { box.textContent = ''; box.appendChild(empty('Loading…')); }
    adm('/api/admin/users/search', { query: document.getElementById('uQuery').value, role: document.getElementById('uRole').value, status: document.getElementById('uStatus').value, offset: uState.offset, limit: 25 }).then(function (d) {
      if (reset) box.textContent = '';
      if (!d.success) { box.textContent = ''; box.appendChild(empty(d.error || 'Could not search.')); return; }
      if (reset && !d.users.length) { box.appendChild(empty('No account found.')); more.textContent = ''; return; }
      var tb = box.querySelector('tbody');
      if (!tb) { box.textContent = ''; box.appendChild(table(['Person', 'Login', 'Role', 'Posts', 'Followers', 'Joined', 'Last active', ''], [])); tb = box.querySelector('tbody'); }
      d.users.forEach(function (u) {
        var who = el('div', { style: 'display:flex;gap:9px;align-items:center' }, [el('div', { style: 'width:34px;height:34px;border-radius:50%;background:#e4e6eb;display:flex;align-items:center;justify-content:center;font-weight:800;overflow:hidden' }, [u.profile_pic ? el('img', { src: u.profile_pic, alt: '', style: 'width:100%;height:100%;object-fit:cover' }) : document.createTextNode((nm(u)[0] || '?').toUpperCase())]), el('div', {}, [el('div', { style: 'font-weight:700', text: nm(u) }), el('div', { style: 'font-size:11.5px;color:#65676b', text: u.public_id || '' })])]);
        tb.appendChild(el('tr', {}, [el('td', {}, [who]), el('td', { text: (u.login_kind === 'phone' ? '📱 ' : '✉️ ') + u.contact }), el('td', {}, [roleBadge(u.role, u.is_banned)]), el('td', { text: String(u.posts_count) }), el('td', { text: String(u.followers_count) }),
          el('td', { text: fmt(u.created_at).split(',')[0] }), el('td', { text: ago(u.last_active) }), el('td', {}, [el('button', { class: 'btn-sm btn-blue', text: 'Manage', onclick: function () { openUser(u.email); } })])]));
      });
      uState.offset += d.users.length; more.textContent = '';
      if (d.hasMore) more.appendChild(el('button', { class: 'btn-sm btn-gray', text: 'Show more', onclick: function () { searchUsers(false); } }));
    });
  }
  function field(label, id, value, type) { return el('div', {}, [el('div', { class: 'at-lbl', text: label }), el('input', { class: 'at-in', id: id, type: type || 'text', value: value || '' })]); }
  function closeModal() { var m = document.getElementById('atModal'); if (m) m.remove(); }
  function openUser(email) {
    closeModal();
    var modal = el('div', { class: 'at-modal', id: 'atModal', onclick: function (e) { if (e.target === modal) closeModal(); } }, [el('div', { class: 'at-card' }, [empty('Loading…')])]); document.body.appendChild(modal);
    adm('/api/admin/users/detail', { target: email }).then(function (d) {
      var card = modal.firstChild; card.textContent = '';
      if (!d.success) { card.appendChild(empty(d.error || 'Could not load.')); card.appendChild(el('button', { class: 'btn-sm btn-gray', text: 'Close', onclick: closeModal })); return; }
      var u = d.user, pf = u.profile || {}, can = d.canManage, sup = d.isSuperAdmin, self = u.email.toLowerCase() === String(currentUser.email).toLowerCase();
      card.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:10px' }, [el('div', {}, [el('div', { style: 'font-size:20px;font-weight:800', text: nm(u) }), el('div', { style: 'color:#65676b;font-size:13px;margin-top:2px', text: (u.login_kind === 'phone' ? '📱 ' : '✉️ ') + u.contact + '  ·  ID ' + (u.public_id || '—') }), el('div', { style: 'margin-top:6px' }, [roleBadge(u.role, u.is_banned)])]), el('button', { class: 'btn-sm btn-gray', text: '✕ Close', onclick: closeModal })]));
      var info = el('div', { class: 'at-grid', style: 'margin-top:12px' });
      [['Joined', fmt(u.created_at)], ['Last active', ago(u.last_active)], ['Login with', u.login_kind === 'phone' ? 'Phone number + password' : 'E-mail + password'], ['Telegram login', u.has_telegram ? 'Yes' : 'No'], ['Posts', d.counts.posts], ['Comments', d.counts.comments], ['Reactions given', d.counts.reactionsGiven], ['Followers / following', d.counts.followers + ' / ' + d.counts.following], ['Reports against / made', d.counts.reportsAgainst + ' / ' + d.counts.reportsMade], ['Blocked by', d.counts.blockedBy]].forEach(function (x) {
        info.appendChild(el('div', { style: 'background:#f8f9fa;border-radius:8px;padding:8px 10px' }, [el('div', { class: 'at-lbl', style: 'margin:0', text: x[0] }), el('div', { style: 'font-weight:700', text: x[1] === null ? '—' : String(x[1]) })]));
      });
      card.appendChild(info);
      var out = el('div', { id: 'atMsg', style: 'display:none' }); card.appendChild(out);
      if (!can) card.appendChild(el('div', { style: 'margin-top:12px;padding:10px;border-radius:8px;background:#fff4e5;color:#b45309;font-size:13.5px', text: 'This is an admin account. Only a Super Admin can change it.' }));
      card.appendChild(el('div', { class: 'at-h', text: 'Profile' }));
      var f = el('div', { class: 'at-grid' }, [field(AT('នាមត្រកូល', 'Surname'), 'ufFirst', u.first_name), field(AT('នាមខ្លួន', 'Given name'), 'ufLast', u.last_name), field('Country', 'ufCountry', u.country), field('Location', 'ufLocation', pf.location), field('Work', 'ufWork', pf.work), field('Relationship', 'ufRel', pf.relationship_status), field('Profile phone', 'ufPhone', pf.phone),
        field('Date of birth', 'ufBirth', /^\d{4}-\d{2}-\d{2}/.test(String(pf.birthdate || '')) ? String(pf.birthdate).slice(0, 10) : '', 'date')]);
      var gsel = el('select', { class: 'at-in', id: 'ufGender' }, ['Male', 'Female', 'Other'].map(function (g) { return el('option', { value: g, text: g }); })); gsel.value = pf.gender === 'Female' || pf.gender === 'Other' ? pf.gender : 'Male';
      f.appendChild(el('div', {}, [el('div', { class: 'at-lbl', text: 'Gender' }), gsel])); card.appendChild(f);
      card.appendChild(el('div', { class: 'at-lbl', text: 'Bio' })); card.appendChild(el('textarea', { class: 'at-in', id: 'ufBio', rows: '3', text: pf.bio || '' }));
      var save = el('button', { class: 'btn-sm btn-blue', style: 'margin-top:10px;padding:9px 16px', text: 'Save profile', onclick: function () {
        var b = document.getElementById('ufBirth').value;
        adm('/api/admin/users/update', { target: u.email, fields: { first_name: val('ufFirst'), last_name: val('ufLast'), country: val('ufCountry'), location: val('ufLocation'), work: val('ufWork'), relationship_status: val('ufRel'), phone: val('ufPhone'), gender: val('ufGender'), bio: val('ufBio'), birthdate: b ? b.slice(8, 10) + '-' + b.slice(5, 7) + '-' + b.slice(0, 4) : '' } }).then(function (r) { msg(out, r.success, r.success ? '✅ Saved' : '❌ ' + (r.error || 'Could not save.')); });
      } }); if (!can) save.disabled = true; card.appendChild(save);
      function val(id) { return document.getElementById(id).value; }
      card.appendChild(el('div', { class: 'at-h', text: 'Account actions' }));
      var acts = el('div', { class: 'at-row' });
      function act(label, cls, fn, show) { if (show === false) return; var b = el('button', { class: 'btn-sm ' + cls, text: label, onclick: fn }); if (!can) b.disabled = true; acts.appendChild(b); }
      act(u.is_banned ? '✅ Unban' : '⛔ Ban', u.is_banned ? 'btn-green' : 'btn-red', function () {
        if (!confirm((u.is_banned ? 'Unban ' : 'Ban ') + nm(u) + '?')) return;
        adm('/api/admin/ban-user', { targetEmail: u.email, ban: !u.is_banned }).then(function (r) { if (r.success) { searchUsers(true); openUser(u.email); } else msg(out, false, '❌ ' + (r.error || 'Failed')); });
      }, !self);
      act('💬 Chats / limits', 'btn-blue', function () { closeModal(); switchAdminTab('chats'); openChatConsole(u); }, !!sup);
      act('🚪 Log out all devices', 'btn-gray', function () {
        if (!confirm('Log ' + nm(u) + ' out of every device?')) return;
        adm('/api/admin/users/logout-all', { target: u.email }).then(function (r) { msg(out, r.success, r.success ? '✅ Logged out (' + r.devices + ' device(s))' : '❌ ' + (r.error || 'Failed')); });
      });
      act('🔑 Reset password', 'btn-blue', function () {
        if (!confirm('Reset the password of ' + nm(u) + '? All their devices will be logged out.')) return;
        adm('/api/admin/reset-password', { identifier: u.email }).then(function (r) { msg(out, r.success, r.success ? '✅ Temporary password: ' + r.tempPassword + '   — send it to the person, they should change it in Settings.' : '❌ ' + (r.error || 'Failed')); });
      });
      act(u.role === 'admin' ? '⬇ Make a normal user' : '⬆ Make admin', 'btn-gray', function () {
        var to = u.role === 'admin' ? 'user' : 'admin'; if (!confirm('Change the role of ' + nm(u) + ' to ' + to + '?')) return;
        adm('/api/admin/set-role', { targetEmail: u.email, newRole: to }).then(function (r) { if (r.success) { searchUsers(true); openUser(u.email); } else msg(out, false, '❌ ' + (r.error || 'Failed')); });
      }, sup && u.role !== 'super_admin' && !self);
      act('✉️ Invite to earn', 'btn-green', function () {
        if (!confirm('Invite ' + nm(u) + ' to earn money (no need to meet the requirements)?')) return;
        adm('/api/admin/monetization-action', { targetEmail: u.email, status: 'invite', note: 'Invited by CamFeed' }).then(function (r) { msg(out, r.success, r.success ? (r.status === 'invited' ? '✅ Invitation sent to ' + nm(u) + ' (waiting for them to accept)' : '✅ ' + nm(u) + ' can earn now') : '❌ ' + (r.error || 'Failed')); });
      }, !self);
      act(AT('✔ អញ្ជើញឲ្យមានសញ្ញាខៀវ', '✔ Invite to Blue Verify'), 'btn-sm', function () {   // they press "Accept" and get the ✔ (no conditions)
        if (!confirm(AT('អញ្ជើញ ', 'Invite ') + nm(u) + AT(' ឲ្យមានសញ្ញា ✔? (គាត់ចុច «ទទួល» ហើយបាន ✔ ភ្លាម មិនចាំបាច់លក្ខខណ្ឌ)', ' to get the ✔? (they press "Accept" and get it at once, no conditions)'))) return;
        adm('/api/admin/verify', { action: 'invite', targetEmail: u.email }).then(function (r) { msg(out, r.success, r.success ? (r.already ? AT('ℹ️ បានអញ្ជើញរួចហើយ កំពុងរង់ចាំគាត់ចុចទទួល', 'ℹ️ Already invited, waiting for them to accept') : AT('✅ បានផ្ញើការអញ្ជើញទៅ ', '✅ Invitation sent to ') + nm(u)) : '❌ ' + (r.error || 'Failed')); });
      }, sup && !self && !(u.verified && !u.verified_paused));
      act(AT('🏆 អញ្ជើញចូល Challenge', '🏆 Invite to a challenge'), 'btn-sm', function () {   // the invite-only challenges still running
        adm('/api/admin/challenges', { action: 'invitable', targetEmail: u.email }).then(function (r) {
          if (!r.success) return msg(out, false, '❌ ' + (r.error || 'Failed'));
          if (!r.challenges.length) return msg(out, false, AT('មិនមាន Challenge «អញ្ជើញប៉ុណ្ណោះ» ទេ។ សូមបង្កើតមួយក្នុង 🎯 Challenges (ធីក ✉️)។', 'No invite-only challenge. Make one in 🎯 Challenges (tick ✉️).'));
          var pick = el('div', { style: 'margin-top:8px;border:1px solid #e4e6eb;border-radius:10px;padding:8px' });
          r.challenges.forEach(function (c) {
            pick.appendChild(el('div', { class: 'at-row', style: 'gap:8px;align-items:center;margin:4px 0' }, [el('span', { style: 'flex:1', text: c.icon + ' ' + c.title_km + (c.invited ? AT(' · ✅ បានអញ្ជើញ', ' · ✅ invited') : '') }),
              c.invited ? el('span') : el('button', { class: 'btn-sm btn-blue', text: AT('✉️ អញ្ជើញ', '✉️ Invite'), onclick: function () { adm('/api/admin/challenges', { action: 'invite', id: c.id, targetEmail: u.email }).then(function (x) { msg(out, x.success, x.success ? AT('✅ បានអញ្ជើញ ', '✅ Invited ') + nm(u) + ' → ' + c.title_km : '❌ ' + (x.error || 'Failed')); pick.remove(); }); } })]));
          });
          out.parentNode.insertBefore(pick, out);
        });
      }, sup && !self);
      act('💵 Wallet bonus', 'btn-gray', function () {
        var a = prompt('Amount in $ to add to the wallet of ' + nm(u) + ' (negative = take back):', '5'); if (a === null || a === '') return; var why = prompt('Reason (the creator sees it):', 'Bonus'); if (!why) return;
        adm('/api/admin/wallet/credit', { targetEmail: u.email, amount: a, note: why, kind: 'bonus' }).then(function (r) { msg(out, r.success, r.success ? '✅ New balance: ' + money(r.balance) : '❌ ' + (r.error || 'Failed')); });
      }, sup);
      act('🗑 Delete account', 'btn-red', function () {
        var t = prompt('This deletes the account and ALL its posts, comments, photos and videos for ever.\nType DELETE to confirm:'); if (t !== 'DELETE') return;
        adm('/api/admin/users/' + encodeURIComponent(u.email), {}, 'DELETE').then(function (r) { if (r.success) { closeModal(); searchUsers(true); } else msg(out, false, '❌ ' + (r.error || 'Failed')); });
      }, sup && u.role !== 'super_admin' && !self);
      card.appendChild(acts);
      card.appendChild(el('div', { class: 'at-h', text: 'Devices logged in' }));
      card.appendChild(d.sessions.length ? table(['Device', 'Place', 'Last seen'], d.sessions.map(function (s) { return el('tr', {}, [el('td', { text: (s.browser || 'Browser') + ' · ' + (s.os || '') }), el('td', { text: [s.city, s.country].filter(Boolean).join(', ') + ' ' + (s.ip_masked || '') }), el('td', { text: ago(s.last_seen) })]); })) : empty('No tracked devices (older logins are not listed).'));
      card.appendChild(el('div', { class: 'at-h', text: 'Latest posts' }));
      card.appendChild(d.recentPosts.length ? table(['Type', 'Post', 'Privacy', 'Date'], d.recentPosts.map(function (x) { return el('tr', {}, [el('td', { text: x.media_type || 'text' }), el('td', { text: String(x.content || '').slice(0, 90) || '(media)' }), el('td', { text: x.privacy || '' }), el('td', { text: fmt(x.created_at) })]); })) : empty('No posts.'));
    });
  }

  // ---------- Content ----------
  var cState = { kind: 'posts', offset: 0 };
  function buildContent() {
    var p = document.getElementById('panel-content'); p.textContent = '';
    var kind = el('select', { class: 'at-in', id: 'cKind', style: 'width:auto', onchange: function () { cState.kind = this.value; buildContent(); } }, [el('option', { value: 'posts', text: 'Posts & videos' }), el('option', { value: 'comments', text: 'Comments' })]); kind.value = cState.kind;
    var q = el('input', { class: 'at-in', id: 'cQuery', placeholder: 'Search text or author name', style: 'max-width:300px', onkeydown: function (e) { if (e.key === 'Enter') searchContent(true); } });
    var row = el('div', { class: 'at-row' }, [kind, q]);
    if (cState.kind === 'posts') {
      row.appendChild(el('select', { class: 'at-in', id: 'cType', style: 'width:auto' }, [el('option', { value: '', text: 'Any type' }), el('option', { value: 'video', text: 'Videos' }), el('option', { value: 'image', text: 'Photos' }), el('option', { value: 'text', text: 'Text' })]));
      row.appendChild(el('select', { class: 'at-in', id: 'cPrivacy', style: 'width:auto' }, [el('option', { value: '', text: 'Any privacy' }), el('option', { value: 'public', text: 'Public' }), el('option', { value: 'private', text: 'Private' })]));
    }
    row.appendChild(el('button', { class: 'btn-sm btn-blue', text: 'Search', onclick: function () { searchContent(true); } })); p.appendChild(row);
    p.appendChild(el('div', { id: 'cResults' })); p.appendChild(el('div', { id: 'cMore', style: 'text-align:center;margin-top:10px' })); searchContent(true);
  }
  function searchContent(reset) {
    if (reset) cState.offset = 0;
    var box = document.getElementById('cResults'), more = document.getElementById('cMore'); if (reset) { box.textContent = ''; box.appendChild(empty('Loading…')); }
    var posts = cState.kind === 'posts', body = { query: document.getElementById('cQuery').value, offset: cState.offset, limit: 25 };
    if (posts) { body.type = document.getElementById('cType').value; body.privacy = document.getElementById('cPrivacy').value; }
    adm(posts ? '/api/admin/posts/search' : '/api/admin/comments/search', body).then(function (d) {
      if (reset) box.textContent = '';
      if (!d.success) { box.textContent = ''; box.appendChild(empty(d.error || 'Could not search.')); return; }
      var items = posts ? d.posts : d.comments;
      if (reset && !items.length) { box.appendChild(empty('Nothing found.')); more.textContent = ''; return; }
      var tb = box.querySelector('tbody'); if (!tb) { box.textContent = ''; box.appendChild(table(posts ? ['Author', 'Content', 'Type', 'Privacy', '👍', '💬', 'Date', ''] : ['Author', 'Comment', 'Post', 'Date', ''], [])); tb = box.querySelector('tbody'); }
      items.forEach(function (x) {
        var who = (x.first_name || '') + ' ' + (x.last_name || ''); var tr;
        function del() {
          if (posts) { window.adminPostDialog(x.id, function (r, isDel) { if (isDel) tr.remove(); else alert('Warning sent.'); }); return; }
          if (!confirm('Delete this ' + (posts ? 'post' : 'comment (and its replies)') + ' for ever?')) return;
          (posts ? adm('/api/admin/posts/' + encodeURIComponent(x.id), {}, 'DELETE') : adm('/api/admin/comments/delete', { commentId: x.id })).then(function (r) { if (r.success) tr.remove(); else alert(r.error || 'Could not delete.'); });
        }
        var delBtn = el('button', { class: 'btn-sm btn-red', text: 'Delete', onclick: del });
        tr = posts ? el('tr', {}, [el('td', { text: who.trim() }), el('td', { text: String(x.content || '').slice(0, 120) || '(media only)' }), el('td', { text: x.media_type || 'text' }), el('td', { text: x.privacy || '' }), el('td', { text: String(x.likes_count || 0) }), el('td', { text: String(x.comments_count || 0) }), el('td', { text: fmt(x.created_at) }), el('td', {}, [delBtn])])
          : el('tr', {}, [el('td', { text: who.trim() }), el('td', { text: String(x.content || '').slice(0, 160) + (x.reply_to_id ? '  (reply)' : '') }), el('td', { text: '#' + x.post_id }), el('td', { text: fmt(x.created_at) }), el('td', {}, [delBtn])]);
        tb.appendChild(tr);
      });
      cState.offset += items.length; more.textContent = ''; if (d.hasMore) more.appendChild(el('button', { class: 'btn-sm btn-gray', text: 'Show more', onclick: function () { searchContent(false); } }));
    });
  }

  // ---------- Activity log ----------
  var aState = { offset: 0 };
  function loadAudit(reset) {
    var p = document.getElementById('panel-audit');
    if (reset) { aState.offset = 0; p.textContent = ''; p.appendChild(el('div', { class: 'at-row' }, [el('button', { class: 'btn-sm btn-gray', text: '↻ Refresh', onclick: function () { loadAudit(true); } }), el('span', { style: 'color:#65676b;font-size:13px', text: 'Every admin action is recorded here for 180 days.' })])); p.appendChild(el('div', { id: 'aResults' })); p.appendChild(el('div', { id: 'aMore', style: 'text-align:center;margin-top:10px' })); }
    var box = document.getElementById('aResults'), more = document.getElementById('aMore');
    adm('/api/admin/audit', { offset: aState.offset, limit: 50 }).then(function (d) {
      if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      if (reset && !d.entries.length) { box.appendChild(empty('No admin action recorded yet.')); return; }
      var tb = box.querySelector('tbody'); if (!tb) { box.appendChild(table(['When', 'Admin', 'Action', 'Target', 'Details'], [])); tb = box.querySelector('tbody'); }
      d.entries.forEach(function (e) { tb.appendChild(el('tr', {}, [el('td', { text: fmt(e.at) }), el('td', { text: e.admin_email || '' }), el('td', {}, [el('span', { class: 'badge badge-admin', text: e.action })]), el('td', { text: e.target || '' }), el('td', { text: e.details || '' })])); });
      aState.offset += d.entries.length; more.textContent = ''; if (d.hasMore) more.appendChild(el('button', { class: 'btn-sm btn-gray', text: 'Show more', onclick: function () { loadAudit(false); } }));
    });
  }

  // ---------- System ----------
  var HINTS = {
    database: ['Database (Supabase)', 'The website can not work without it.'], jwtSecret: ['JWT_SECRET', 'Set a long random value in Render, otherwise login tokens are not safe.'], adminPin: ['Admin PIN (ADMIN_SECRET_KEY)', 'Without it nobody can open the admin center.'],
    emailCodes: ['E-mail codes (Resend)', 'Needed for Gmail sign-up and forgot password. Check RESEND_API_KEY and the verified domain.'], phoneCodes: ['Phone codes (Telegram Gateway)', 'Paused when TELEGRAM_GATEWAY_TOKEN is not set: people use Gmail or message you on Telegram.'],
    telegramLogin: ['Telegram login', 'Off by decision (ENABLE_TELEGRAM_LOGIN).'], turnstile: ['Human check (Cloudflare Turnstile)', 'Set TURNSTILE_SECRET_KEY to stop bots on sign-up and login.'], mediaStorage: ['Photo / video storage (R2)', 'Needs R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.'],
    aiCategories: ['AI post categories (Gemini)', 'Without it every post is "General", so the feed can not learn what people like.'], supportTelegram: ['Support Telegram link', 'Set SUPPORT_TELEGRAM so people can message you from the sign-up page.'],
    googlePlay: ['Diamonds by Google Play (app)', 'Set GOOGLE_PLAY_SERVICE_ACCOUNT (the JSON key of a service account added in Play Console › Users and permissions). Products: cf_coins_1, cf_coins_5, cf_coins_10, cf_coins_20.'], payway: ['Ad wallet by ABA PayWay', 'Set PAYWAY_MERCHANT_ID, PAYWAY_API_KEY and PAYWAY_API_URL.'] };
  // 📲 the Android app file for testers and family (camfeedkh.com/apk.html) — only the Super Admin uploads
  function apkCard(p) {
    var box = el('div', { class: 'at-card', style: 'margin:10px 0 14px' }); p.appendChild(box);
    function draw() {
      adm('/api/admin/apk', { action: 'list' }).then(function (d) {
        box.textContent = '';
        box.appendChild(el('div', { class: 'at-h', text: AT('📲 កម្មវិធី Android (APK) សម្រាប់ទាញយក', '📲 Android app (APK) to download') }));
        if (!d || !d.success) { box.appendChild(el('div', { text: (d && d.error) || AT('មិនបាន', 'Failed') })); return; }
        var link = location.origin + '/apk.html';
        box.appendChild(el('div', { style: 'font-size:13.5px;color:#444;line-height:1.7' }, [
          AT('ទំព័រទាញយក៖ ', 'Download page: '), el('a', { href: link, target: '_blank', rel: 'noopener', text: link }),
          el('button', { class: 'btn-sm btn-gray', style: 'margin-left:8px', text: AT('📋 ចម្លង link', '📋 Copy link'), onclick: function () { try { navigator.clipboard.writeText(link); this.textContent = '✅'; } catch (e) {} } }),
          el('span', { style: 'margin-left:8px', text: d.on ? AT('· ✅ បើក', '· ✅ open') : AT('· ⛔ បិទ', '· ⛔ closed') }),
          d.isSuperAdmin ? el('button', { class: 'btn-sm btn-gray', style: 'margin-left:8px', text: d.on ? AT('⛔ បិទទំព័រ', '⛔ Close the page') : AT('✅ បើកទំព័រ', '✅ Open the page'), onclick: function () { adm('/api/admin/apk', { action: 'settings', on: !d.on }).then(draw); } }) : null
        ]));
        if (d.isSuperAdmin) {
          var file = el('input', { type: 'file', accept: '.apk,application/vnd.android.package-archive', style: 'font-size:13px' });
          var ver = el('input', { class: 'at-in', placeholder: AT('កំណែ ឧ. 1.0.5', 'Version e.g. 1.0.5'), maxlength: '30', style: 'max-width:150px' });
          var bld = el('input', { class: 'at-in', type: 'number', min: '1', placeholder: 'BUILD', style: 'max-width:110px' });
          var note = el('textarea', { class: 'at-in', rows: '3', maxlength: '1000', placeholder: AT('អ្វីថ្មី / អ្វីដែលត្រូវសាក (អ្នកទាញយកនឹងឃើញ)', 'What is new / what to test (people will see it)'), style: 'width:100%' });
          var msg = el('div', { style: 'font-size:13px;color:#65676b;margin-top:6px' });
          file.addEventListener('change', function () {
            var f = file.files && file.files[0]; if (!f) return;
            var m = /(\d{2,6})/.exec(f.name || ''); if (m && !bld.value) bld.value = m[1];
          });
          var go = el('button', { class: 'btn-sm btn-blue', text: AT('⬆️ អាប់ឡូត ហើយដាក់ឲ្យទាញយក', '⬆️ Upload and publish'), onclick: function () {
            var f = file.files && file.files[0];
            if (!f || !/\.apk$/i.test(f.name || '')) { msg.textContent = AT('❌ សូមជ្រើសឯកសារ .apk', '❌ Please choose an .apk file'); return; }
            go.disabled = true; msg.textContent = AT('កំពុងអាប់ឡូត… (កុំបិទទំព័រ)', 'Uploading… (do not close the page)');
            adm('/api/admin/apk', { action: 'upload-url', build: bld.value }).then(function (u) {
              if (!u || !u.success) throw new Error((u && u.error) || 'Upload not allowed');
              return new Promise(function (ok, no) {
                var x = new XMLHttpRequest(); x.open('PUT', u.uploadUrl); x.setRequestHeader('Content-Type', 'application/vnd.android.package-archive');
                x.upload.onprogress = function (e) { if (e.lengthComputable) msg.textContent = AT('កំពុងអាប់ឡូត… ', 'Uploading… ') + Math.round(e.loaded * 100 / e.total) + '%'; };
                x.onload = function () { x.status >= 200 && x.status < 300 ? ok(u.publicUrl) : no(new Error('Upload failed (' + x.status + ')')); };
                x.onerror = function () { no(new Error('Upload failed (network)')); };
                x.send(f);
              });
            }).then(function (url) {
              return adm('/api/admin/apk', { action: 'save', url: url, version: ver.value, build: bld.value, note: note.value, size: f.size });
            }).then(function (r) {
              go.disabled = false;
              if (!r || !r.success) { msg.textContent = '❌ ' + ((r && r.error) || 'Failed'); return; }
              draw();
            }).catch(function (e) { go.disabled = false; msg.textContent = '❌ ' + e.message; });
          } });
          box.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center' }, [file, ver, bld]));
          box.appendChild(note);
          box.appendChild(el('div', { style: 'margin-top:6px' }, [go])); box.appendChild(msg);
        }
        box.appendChild(el('div', { style: 'font-weight:800;margin-top:12px', text: AT('កំណែដែលបានអាប់ឡូត (ថ្មីបំផុតនៅលើគេ = អ្វីដែលគេទាញយក)', 'Uploaded versions (newest on top = what people download)') }));
        if (!d.list.length) box.appendChild(el('div', { style: 'font-size:13px;color:#65676b', text: AT('មិនទាន់មានទេ', 'None yet') }));
        d.list.forEach(function (x, i) {
          var row = el('div', { class: 'at-row', style: 'gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center;font-size:13.5px;border-bottom:1px solid #f0f2f5;padding-bottom:6px' }, [
            el('span', { style: 'flex:1;min-width:200px', text: (i === 0 ? '⭐ ' : '') + (x.version ? 'v' + x.version + ' · ' : '') + (x.build ? 'BUILD ' + x.build : '') + (x.sizeMb ? ' · ' + x.sizeMb + ' MB' : '') + ' · ' + new Date(x.at).toLocaleString() }),
            el('a', { href: x.url, target: '_blank', rel: 'noopener', text: '⬇️' })
          ]);
          if (d.isSuperAdmin) row.appendChild(el('button', { class: 'btn-sm btn-gray', text: AT('🗑️ ដកចេញ', '🗑️ Remove'), onclick: function () { if (confirm(AT('ដកកំណែនេះចេញពីទំព័រទាញយក?', 'Remove this version from the download page?'))) adm('/api/admin/apk', { action: 'remove', id: x.id }).then(draw); } }));
          box.appendChild(row);
        });
      });
    }
    draw();
  }

  // 📣 a message for everyone when the app opens + ⬆️ "a new version: please update" (opens Play Store / App Store)
  function noticeCard(p) {
    var box = el('div', { class: 'at-card', style: 'margin:0 0 14px' }); p.appendChild(box);
    function inp(v, ph, ml) { return el('input', { class: 'at-in', value: v == null ? '' : String(v), placeholder: ph || '', maxlength: String(ml || 300), style: 'width:100%' }); }
    function area(v, ph) { var t = el('textarea', { class: 'at-in', rows: '3', maxlength: '800', placeholder: ph || '', style: 'width:100%' }); t.value = v || ''; return t; }
    function lbl(t) { return el('div', { style: 'font-weight:700;font-size:13.5px;margin:10px 0 4px', text: t }); }
    function draw() {
      adm('/api/admin/app-config', {}).then(function (d) {
        box.textContent = '';
        if (!d || !d.success) { box.appendChild(el('div', { text: (d && d.error) || AT('មិនបាន', 'Failed') })); return; }
        var n = d.config.notice || {}, u = d.config.update || {}, sup = !!d.isSuperAdmin;
        // 📣 notice
        box.appendChild(el('div', { class: 'at-h', text: AT('📣 សារជូនដំណឹងពេលបើកកម្មវិធី', '📣 Message when the app opens') }));
        box.appendChild(el('div', { style: 'font-size:13px;color:#555;line-height:1.6', text: AT('ឧ. «យើងកំពុងសាកល្បងពាណិជ្ជកម្មថ្ងៃនេះ»។ រាល់ពេលចុចរក្សាទុក អ្នកប្រើនឹងឃើញសារនេះម្ដងទៀត។', 'e.g. "We are testing ads today". Each time you save, people see it again.') }));
        var on = el('input', { type: 'checkbox' }); on.checked = !!n.on;
        var web = el('input', { type: 'checkbox' }); web.checked = n.web !== false;
        var every = el('select', { class: 'at-in', style: 'max-width:260px' }, [
          el('option', { value: 'once', text: AT('បង្ហាញម្ដងគត់', 'Show once') }), el('option', { value: 'day', text: AT('ម្ដងក្នុងមួយថ្ងៃ', 'Once a day') }), el('option', { value: 'open', text: AT('រាល់ពេលបើកកម្មវិធី', 'Every time the app opens') })]);
        every.value = n.every || 'once';
        var tk = inp(n.title_km, 'ឧ. 🛠️ កំពុងសាកល្បង', 80), xk = area(n.text_km, 'ឧ. ថ្ងៃនេះ CamFeed កំពុងសាកល្បងពាណិជ្ជកម្ម។ អ្នកអាចឃើញពាណិជ្ជកម្មច្រើនជាងធម្មតា។ អរគុណ!');
        var te = inp(n.title_en, 'e.g. 🛠️ Testing', 80), xe = area(n.text_en, 'e.g. Today CamFeed is testing ads. You may see more ads than usual. Thank you!');
        box.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:8px;font-weight:700' }, [on, AT(' បើកសារនេះ', ' Turn this message on')]));
        box.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px' }, [web, AT(' បង្ហាញលើវេបសាយដែរ', ' Show on the website too')]));
        box.appendChild(lbl(AT('ញឹកញាប់', 'How often'))); box.appendChild(every);
        box.appendChild(lbl(AT('ចំណងជើង (ខ្មែរ)', 'Title (Khmer)'))); box.appendChild(tk);
        box.appendChild(lbl(AT('សារ (ខ្មែរ)', 'Message (Khmer)'))); box.appendChild(xk);
        box.appendChild(lbl(AT('ចំណងជើង (អង់គ្លេស)', 'Title (English)'))); box.appendChild(te);
        box.appendChild(lbl(AT('សារ (អង់គ្លេស)', 'Message (English)'))); box.appendChild(xe);
        var m1 = el('div', { style: 'font-size:13px;margin-top:6px' });
        if (sup) box.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'margin-top:10px', text: AT('💾 រក្សាទុក ហើយបង្ហាញ', '💾 Save and show'), onclick: function () {
          if (on.checked && !xk.value.trim() && !xe.value.trim()) { m1.textContent = AT('❌ សូមសរសេរសារ', '❌ Please write the message'); return; }
          adm('/api/admin/app-config', { action: 'save', config: { notice: { on: on.checked, web: web.checked, every: every.value, title_km: tk.value, text_km: xk.value, title_en: te.value, text_en: xe.value } } }).then(function (x) { m1.textContent = x && x.success ? '✅ ' + AT('បានរក្សាទុក', 'Saved') : '❌ ' + ((x && x.error) || 'Failed'); });
        } }));
        box.appendChild(m1);
        // ⬆️ update
        box.appendChild(el('div', { class: 'at-h', style: 'margin-top:18px', text: AT('⬆️ ប្រាប់ឲ្យ Update កម្មវិធី', '⬆️ Ask people to update the app') }));
        box.appendChild(el('div', { style: 'font-size:13px;color:#555;line-height:1.6', text: AT('កម្មវិធីដែល BUILD តូចជាង «BUILD ថ្មីបំផុត» ឃើញសារ «មាន Update ថ្មី» (អាចចុច ពេលក្រោយ)។ តូចជាង «BUILD តិចបំផុត» ត្រូវតែ Update ទើបប្រើបាន។ 0 = បិទ។ ចុច Update → Play Store / App Store (មុនមាន Play Store ដាក់ https://camfeedkh.com/apk.html)។', 'Apps with a BUILD lower than "Latest BUILD" see "A new update" (they can choose Later). Lower than "Lowest BUILD" must update to go on. 0 = off. Update opens Play Store / App Store (before Play Store, put https://camfeedkh.com/apk.html).') }));
        var lb = el('input', { class: 'at-in', type: 'number', min: '0', value: String(u.latestBuild || 0), style: 'max-width:140px' });
        var mb = el('input', { class: 'at-in', type: 'number', min: '0', value: String(u.minBuild || 0), style: 'max-width:140px' });
        var au = inp(u.androidUrl, 'https://play.google.com/store/apps/details?id=com.camfeed.camfeed'), iu = inp(u.iosUrl, 'https://apps.apple.com/app/…');
        var nk = area(u.note_km, 'ឧ. កែពាណិជ្ជកម្ម និងវីដេអូឲ្យលឿនជាងមុន'), ne = area(u.note_en, 'e.g. Faster videos and better ads');
        box.appendChild(el('div', { class: 'at-row', style: 'gap:10px;flex-wrap:wrap;align-items:flex-end' }, [
          el('div', {}, [lbl(AT('BUILD ថ្មីបំផុត', 'Latest BUILD')), lb]), el('div', {}, [lbl(AT('BUILD តិចបំផុត (ត្រូវតែ Update)', 'Lowest BUILD (must update)')), mb])]));
        box.appendChild(lbl('Android (Play Store / apk.html)')); box.appendChild(au);
        box.appendChild(lbl('iPhone (App Store)')); box.appendChild(iu);
        box.appendChild(lbl(AT('អ្វីថ្មី (ខ្មែរ)', 'What is new (Khmer)'))); box.appendChild(nk);
        box.appendChild(lbl(AT('អ្វីថ្មី (អង់គ្លេស)', 'What is new (English)'))); box.appendChild(ne);
        var m2 = el('div', { style: 'font-size:13px;margin-top:6px' });
        if (sup) box.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'margin-top:10px', text: AT('💾 រក្សាទុក', '💾 Save'), onclick: function () {
          if (Number(mb.value) > Number(lb.value)) { m2.textContent = AT('❌ BUILD តិចបំផុត មិនអាចធំជាង BUILD ថ្មីបំផុតទេ', '❌ Lowest BUILD can not be bigger than Latest BUILD'); return; }
          adm('/api/admin/app-config', { action: 'save', config: { update: { latestBuild: Number(lb.value) || 0, minBuild: Number(mb.value) || 0, androidUrl: au.value.trim(), iosUrl: iu.value.trim(), note_km: nk.value, note_en: ne.value } } }).then(function (x) { m2.textContent = x && x.success ? '✅ ' + AT('បានរក្សាទុក', 'Saved') : '❌ ' + ((x && x.error) || 'Failed'); });
        } }));
        box.appendChild(m2);
      });
    }
    draw();
  }

  // 🐞 why the phone app closed (sent by the app when it opens again)
  function crashCard(p) {
    var box = el('div', { style: 'margin:8px 0 14px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:12px 14px' });
    p.appendChild(box);
    box.appendChild(el('div', { style: 'font-weight:800;font-size:16px;margin-bottom:6px', text: '🐞 App crashes (phones)' }));
    var out = el('div', {}, [empty('Loading…')]); box.appendChild(out);
    adm('/api/admin/app/crashes', {}).then(function (d) {
      out.textContent = '';
      if (!d || !d.success) { out.appendChild(empty((d && d.error) || 'Could not load.')); return; }
      if (!d.crashes.length) { out.appendChild(empty('No crash reported.')); return; }
      d.crashes.forEach(function (c) {
        var t = el('pre', { style: 'display:none;white-space:pre-wrap;font-size:11.5px;background:#f8fafc;border-radius:8px;padding:8px;max-height:320px;overflow:auto', text: c.text || '' });
        out.appendChild(el('div', { style: 'border-top:1px solid #eef0f3;padding:8px 0' }, [
          el('div', { style: 'font-weight:700', text: new Date(c.created_at).toLocaleString() + ' · ' + nm(c) + ' · Build ' + c.build + (c.place ? ' · ' + c.place : '') }),
          el('div', { style: 'font-size:12.5px;color:#65676b', text: c.device || '' }),
          el('button', { class: 'btn-sm btn-gray', style: 'margin-top:4px', text: 'Details', onclick: function () { t.style.display = t.style.display === 'none' ? 'block' : 'none'; } }), t]));
      });
    });
  }

  function loadSystem() {
    var p = document.getElementById('panel-system'); p.textContent = ''; p.appendChild(empty('Checking…'));
    adm('/api/admin/system').then(function (d) {
      p.textContent = ''; if (!d.success) { p.appendChild(empty(d.error || 'Could not load.')); return; }
      p.appendChild(el('div', { class: 'at-row' }, [el('button', { class: 'btn-sm btn-gray', text: '↻ Check again', onclick: loadSystem }), el('span', { style: 'color:#65676b;font-size:13px', text: 'Only yes / no is shown here. Secret values are never displayed.' })]));
      apkCard(p);
      noticeCard(p);
      var c = d.checks;
      // 📊 count every table: used when the database moves (compare the old site and the new site)
      var dbBox = el('div', { style: 'margin:8px 0 14px' }); p.appendChild(dbBox);
      dbBox.appendChild(el('button', { class: 'btn-sm btn-gray', text: '📊 Count everything in the database', onclick: function () {
        dbBox.lastChild !== this && dbBox.removeChild(dbBox.lastChild);
        var out = el('div', { style: 'margin-top:8px' }, [empty('Counting… (may take a minute)')]); dbBox.appendChild(out);
        adm('/api/admin/system/db-count', {}).then(function (x) {
          out.textContent = '';
          if (!x || !x.success) { out.appendChild(empty((x && x.error) || 'Could not count.')); return; }
          var text = x.tables.map(function (r) { return r.name + ' ' + r.n; }).join('\n');
          out.appendChild(el('div', { style: 'font-weight:700;margin-bottom:6px', text: x.tables.length + ' tables · ' + x.total.toLocaleString() + ' rows · ' + x.sizeMb + ' MB · PostgreSQL ' + x.version }));
          var ta = el('textarea', { class: 'at-in', rows: '10', style: 'width:100%;font-family:monospace;font-size:12.5px' }); ta.value = text; ta.readOnly = true; out.appendChild(ta);
          out.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin-top:4px', text: 'Open this on the old site and on the new site: every line must be the same.' }));
        });
      } }));
      crashCard(p);
      var appBox = el('div'); p.appendChild(appBox); monRules(appBox, 'app');      // settings the Super Admin changes here (name change days, group call size ...)
      Object.keys(HINTS).forEach(function (k) {
        var ok = k === 'supportTelegram' ? !!c[k] : !!c[k]; var extra = k === 'database' && c.databaseMs !== null ? ' (' + c.databaseMs + ' ms)' : (k === 'supportTelegram' && c[k] ? ' ' + c[k] : '');
        p.appendChild(el('div', { class: 'at-chk' }, [el('span', { class: ok ? 'at-ok' : 'at-warn', text: ok ? '✅' : '⚠️' }), el('div', {}, [el('b', { text: HINTS[k][0] + extra }), el('small', { text: ok ? 'Working' : HINTS[k][1] })])]));
      });
      var more = [['Feed order', c.feedMode === 'ranked' ? 'Ranked by popularity and interests' : 'Newest first'], ['Video feed order', c.videoFeedMode === 'ranked' ? 'Ranked' : 'Newest first'], ['Hide e-mails behind IDs', c.maskUserIds ? 'On' : 'OFF'], ['Show server error texts', c.debugErrors ? 'ON (turn off after debugging)' : 'Off'], ['Strict security policy (CSP)', c.cspEnforced ? 'Enforced' : 'Report only'], ['Server running for', c.uptimeMinutes + ' min'], ['Memory', c.memoryMb + ' MB'], ['Node', c.node]];
      p.appendChild(el('div', { class: 'at-h', text: 'Settings in use' })); more.forEach(function (m) { p.appendChild(el('div', { class: 'at-chk' }, [el('span', { text: '•' }), el('div', {}, [el('b', { text: m[0] }), el('small', { text: m[1] })])])); });
    });
  }


  // ---------- Monetization (Creator Program, wallets, withdrawals) ----------
  var mon = { view: 'inv' };
  function money(n) { return '$' + Number(n || 0).toFixed(2); }
  function statusBadge(s) { return el('span', { class: 'badge ' + (s === 'approved' || s === 'paid' ? 'badge-resolved' : s === 'pending' ? 'badge-pending' : 'badge-banned'), text: s }); }
  function loadMonetizationAdmin() {
    var p = document.getElementById('panel-monetization'); if (!p) return;
    p.textContent = '';
    var bar = el('div', { class: 'at-row' }, [['inv', '✉️ Invited by CamFeed'], ['apps', '📋 Applications (requirements)'], ['rules', '⚙️ Conditions'], ['ref', '🎁 Friend invitations'], ['wd', '💵 Withdrawals'], ['logos', '📱 Top-up & 🏦 bank pictures'], ['rate', '💲 Pay per view'], ['wallet', '👛 Wallet bonus'], ['rate', '🎬 Rate videos'], ['report', '📊 Spending report'], ['months', '📅 Monthly approval']].map(function (v) {
      return el('button', { class: 'btn-sm ' + (mon.view === v[0] ? 'btn-blue' : 'btn-gray'), text: v[1], onclick: function () { mon.view = v[0]; loadMonetizationAdmin(); } });
    }));
    p.appendChild(bar); var body = el('div', { id: 'monBody' }); p.appendChild(body);
    if (mon.view === 'inv') monApps(body, 'invited'); else if (mon.view === 'apps') monApps(body, 'applied'); else if (mon.view === 'rules') monRules(body, 'creator'); else if (mon.view === 'ref') monReferrals(body); else if (mon.view === 'wd') monWithdrawals(body); else if (mon.view === 'logos') monCarrierLogos(body); else if (mon.view === 'rate') monRate(body); else if (mon.view === 'report') monReport(body); else if (mon.view === 'months') monMonths(body); else if (mon.view === 'rate') monRate(body); else monWallet(body);
  }
  // the settings of one way to earn (its switch and text; the price is the common one)
  function monPath(box, src) {
    box.appendChild(empty('Loading…'));
    function draw(d) {
      box.textContent = '';
      var wrap = el('div', { style: 'max-width:560px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px 16px;margin-bottom:16px' });
      box.appendChild(wrap);
      wrap.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: src === 'invited' ? '✉️ Invited by CamFeed — settings' : '📋 Earning by requirements — settings' }));
      wrap.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:8px', text: src === 'invited' ? 'People YOU choose (Users → Manage → "Invite to earn"). No requirements.' : 'People who meet the requirements (⚙️ Conditions) and apply; you approve or refuse.' }));
      if (!d.success) { wrap.appendChild(empty(d.error || 'Could not load.')); return; }
      var dis = !d.isSuperAdmin, out = el('div', { style: 'display:none' });
      // 💲 ONE price and ONE daily limit for everybody: they are set only in 💲 Pay per view
      wrap.appendChild(el('div', { style: 'background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:10px 12px;margin:6px 0 4px;font-size:14px;font-weight:700' }, [
        el('div', { text: AT('✅ តម្លៃក្នុង ១,០០០ ដងមើល៖ $', '✅ Price per 1,000 views: $') + d.commonRpm + AT(' · កំណត់ប្រចាំថ្ងៃ៖ $', ' · Daily limit: $') + d.commonCap }),
        el('div', { style: 'font-weight:500;font-size:13px', text: AT('ដូចគ្នាសម្រាប់អ្នកទាំងអស់។ ប្ដូរនៅ 💲 បង់តាមចំនួនមើល។', 'The same for everybody. Change it in 💲 Pay per view.') })]));
      var sw = el('input', { type: 'checkbox' }); sw.checked = src === 'invited' ? d.mustAccept : d.open;
      var tx = el('textarea', { class: 'at-in', rows: '3', placeholder: 'Text people see (empty = the standard text)' }); tx.value = d.text || '';
      [sw, tx].forEach(function (x) { x.disabled = dis; });
      wrap.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14px' }, [sw, el('span', { text: src === 'invited' ? 'The person must ACCEPT the invitation first' : 'Applying is OPEN (off = the requirements card is hidden)' })]));
      wrap.appendChild(el('div', { class: 'at-lbl', text: 'Text shown to people' })); wrap.appendChild(tx);
      if (!dis) {
        var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:10px', text: 'Save', onclick: function () {
          var body2 = { source: src, set: true, text: tx.value };
          if (src === 'invited') body2.mustAccept = sw.checked; else body2.open = sw.checked;
          btn.disabled = true; adm('/api/admin/creator-path', body2).then(function (x) { btn.disabled = false; if (x.success) { draw(x); } else msg(out, false, '❌ ' + (x.error || 'Failed')); });
        } });
        wrap.appendChild(btn);
      } else wrap.appendChild(el('div', { style: 'margin-top:10px;font-size:13px;color:#b45309', text: 'Only a Super Admin can change these.' }));
      wrap.appendChild(out);
    }
    adm('/api/admin/creator-path', { source: src }).then(draw);
  }
  // 🎬 new videos of earning people wait here: choose how much of the price they earn (the money for their views is added then)
  var mr = { status: 'ai' };
  function monRate(body) {
    body.textContent = ''; body.appendChild(empty('Loading…'));
    adm('/api/admin/video-rating/list', { status: mr.status, limit: 60 }).then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      body.appendChild(el('div', { style: 'background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13.5px', text: AT('🤖 AI វាយតម្លៃវីដេអូថ្មីនីមួយៗភ្លាម (ឡូហ្គោ/ឈ្មោះ · ភាពច្បាស់ · រយៈពេល) ហើយវីដេអូរកប្រាក់តាម % នោះតែម្ដង។ ពិនិត្យឡើងវិញនៅទីនេះពេលណាក៏បាន៖ % ថ្មីប្រើចំពោះការមើលចាប់ពីពេលនោះទៅ ប្រាក់ចាស់មិនដក មិនបន្ថែម។ អ្នកបង្កើតមាតិកាមិនដឹងអ្វីទាំងអស់។', '🤖 The AI rates each new video at once (logo/name · clarity · length) and it earns at that %. Check here any time: a new % counts for the views from then on; money already earned is not taken back or added. The creator is never told.') }));
      body.appendChild(el('div', { class: 'at-row', style: 'margin-bottom:10px' }, [['ai', AT('🤖 AI បានវាយ (', '🤖 Rated by AI (') + d.waiting + ')'], ['rated', AT('✅ យើងបានពិនិត្យ', '✅ Checked by us')]].map(function (v) {
        return el('button', { class: 'btn-sm ' + (mr.status === v[0] ? 'btn-blue' : 'btn-gray'), text: v[1], onclick: function () { mr.status = v[0]; monRate(body); } });
      })));
      if (!d.items.length) { body.appendChild(empty(mr.status === 'ai' ? AT('គ្មានវីដេអូរង់ចាំពិនិត្យទេ', 'Nothing to check.') : AT('មិនទាន់មានទេ', 'Nothing yet.'))); return; }
      d.items.forEach(function (x) {
        var card = el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin-bottom:12px;display:flex;gap:12px;flex-wrap:wrap;background:#fff' });
        var vid = x.video ? el('video', { src: x.video, controls: 'controls', preload: 'metadata', style: 'width:180px;max-height:320px;border-radius:10px;background:#000' }) : el('div', { text: '🎬' });
        if (x.video && x.thumb) vid.setAttribute('poster', x.thumb);
        var info = el('div', { style: 'flex:1;min-width:220px' });
        info.appendChild(el('div', { style: 'font-weight:800', text: (x.name || '(no name)') + ' · ' + x.public_id }));
        info.appendChild(el('div', { style: 'font-size:12.5px;color:#65676b', text: new Date(x.posted_at).toLocaleString() + ' · 👁 ' + x.views + (x.height ? ' · ' + Math.min(x.width || x.height, x.height) + 'p' : '') }));
        if (x.text) info.appendChild(el('div', { style: 'margin:6px 0;font-size:13.5px', text: x.text }));
        var ai = x.ai_flag === 'reupload' ? ['#fef2f2', '#991b1b', '🤖 ' + x.ai_note] : x.ai_flag === 'lowq' ? ['#fffbeb', '#92400e', '🤖 ' + x.ai_note] : x.ai_flag === 'ok' ? ['#f0fdf4', '#166534', '🤖 ' + x.ai_note] : ['#f8fafc', '#475569', x.ai_done ? '🤖 —' : '🤖 The AI has not looked yet'];
        info.appendChild(el('div', { style: 'background:' + ai[0] + ';color:' + ai[1] + ';border-radius:8px;padding:6px 8px;font-size:13px;font-weight:700;margin:6px 0', text: ai[2] }));
        // 🏷 the kind the AI chose: check it, change it if wrong
        var catRow = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 6px;font-size:13px' });
        catRow.appendChild(el('b', { text: AT('🏷 ប្រភេទ (AI)៖', '🏷 Kind (AI):') }));
        var catSel = el('select', { class: 'at-in', style: 'max-width:220px;padding:6px 8px' });
        if (!x.cat) catSel.appendChild(el('option', { value: '', text: x.cat_done ? '—' : AT('AI មិនទាន់កំណត់', 'AI not done yet') }));
        (d.cats || []).forEach(function (c) { var o = el('option', { value: c.v, text: c.km + ' · ' + c.v }); if (c.v === x.cat) o.selected = true; catSel.appendChild(o); });
        var catMsg = el('span', { style: 'color:#15803d;font-weight:700' });
        catSel.onchange = function () { if (!catSel.value) return; catMsg.textContent = '…'; adm('/api/admin/video-rating/category', { post_id: x.post_id, cat: catSel.value }).then(function (r) { catMsg.style.color = r.success ? '#15803d' : '#b91c1c'; catMsg.textContent = r.success ? AT('✅ បានកែ', '✅ Changed') : '❌ ' + (r.error || ''); }); };
        catRow.appendChild(catSel); catRow.appendChild(catMsg);
        info.appendChild(catRow);
        if (x.tags) info.appendChild(el('div', { style: 'font-size:12.5px;color:#65676b;margin-bottom:6px', text: AT('ពាក្យគន្លឹះ៖ ', 'Keywords: ') + x.tags }));
        if (x.pct !== null) info.appendChild(el('div', { style: 'font-weight:800;color:' + (x.by_ai ? '#7c3aed' : '#15803d') + ';margin-bottom:6px', text: (x.by_ai ? AT('🤖 ឥឡូវ ', '🤖 Now ') : '✅ ') + x.pct + '% · $' + (x.rpm * x.pct / 100).toFixed(2) + ' / 1,000 views' + (x.reason ? ' · ' + x.reason : '') }));
        var why = el('input', { class: 'at-in', placeholder: 'Reason (e.g. from TikTok, blurry)', value: x.reason || (x.ai_flag === 'reupload' ? 'យកពីគេ' : x.ai_flag === 'lowq' ? 'មិនសូវច្បាស់' : ''), style: 'max-width:260px;margin-bottom:6px' });
        info.appendChild(why);
        var row = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
        // ✅ the AI was right: keep its % (the video moves to "Checked by us")
        if (x.by_ai && x.pct !== null) row.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'background:#16a34a', text: AT('✅ យល់ព្រមតាម AI (', '✅ Agree with AI (') + x.pct + '%)', onclick: function () {
          this.disabled = true; adm('/api/admin/video-rating/rate', { post_id: x.post_id, pct: x.pct, reason: AT('យល់ព្រមតាម AI', 'agreed with AI') }).then(function (r) { if (r.success) monRate(body); else alert(r.error || 'Failed'); });
        } }));
        [100, 75, 50, 25, 10, 0].forEach(function (pc) {
          row.appendChild(el('button', { class: 'btn-sm ' + (pc === 100 ? 'btn-blue' : pc === 0 ? 'btn-red' : 'btn-gray'), title: '$' + (x.rpm * pc / 100).toFixed(2) + ' / 1,000 views', text: pc + '% · $' + (x.rpm * pc / 100).toFixed(2), onclick: function () {
            this.disabled = true; adm('/api/admin/video-rating/rate', { post_id: x.post_id, pct: pc, reason: pc >= 100 ? '' : why.value }).then(function (r) { if (r.success) monRate(body); else alert(r.error || 'Failed'); });
          } }));
        });
        info.appendChild(row);
        card.appendChild(vid); card.appendChild(info); body.appendChild(card);
      });
    });
  }
  // 📅 money from views is approved month by month (early next month): until then the creator sees it but cannot withdraw it
  var mm = { month: '' };
  function monMonths(body) {
    body.textContent = ''; body.appendChild(empty('Loading…'));
    adm('/api/admin/earn-months', { month: mm.month }).then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      mm.month = d.month;
      body.appendChild(el('div', { style: 'background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13.5px', text: 'Money from views comes into the creator\'s wallet at once, but it can be withdrawn only after you approve its month here (from the 1st of next month). You can take away money for bad views. Bonuses you give by hand can be withdrawn at once.' }));
      // the months
      body.appendChild(el('div', { class: 'at-row', style: 'margin-bottom:12px;flex-wrap:wrap' }, (d.months || []).map(function (m) {
        return el('button', { class: 'btn-sm ' + (m.month === d.month ? 'btn-blue' : 'btn-gray'), text: m.label + ' · $' + Number(m.earned).toFixed(2) + (m.current ? ' · counting' : (Number(m.waiting) > 0 ? ' · ⏳ ' + m.waiting : ' · ✅')), onclick: function () { mm.month = m.month; monMonths(body); } });
      })));
      var waiting = d.creators.filter(function (c) { return !c.approved; });
      var tot = d.creators.reduce(function (a, c) { return a + c.earned; }, 0);
      body.appendChild(el('div', { style: 'font-weight:800;font-size:16px;margin-bottom:6px', text: d.label + ' · ' + d.creators.length + ' creators · $' + tot.toFixed(2) + (waiting.length ? ' · ⏳ ' + waiting.length + ' waiting' : '') }));
      if (d.current) body.appendChild(el('div', { style: 'color:#b45309;font-size:13px;margin-bottom:8px', text: 'This month is still counting. You can approve it from the 1st of next month.' }));
      var out = el('div', { style: 'font-size:13px;margin:6px 0' });
      if (d.canApprove && d.isSuperAdmin && waiting.length) {
        body.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-bottom:10px', text: '✅ Approve all ' + waiting.length + ' (no money taken away)', onclick: function () {
          if (!confirm('Approve ' + d.label + ' for ' + waiting.length + ' creators? Their money can then be withdrawn.')) return;
          this.disabled = true; adm('/api/admin/earn-months/approve', { month: d.month, all: true }).then(function (x) { if (x.success) monMonths(body); else { out.style.color = '#b91c1c'; out.textContent = '❌ ' + (x.error || 'Failed'); } });
        } }));
      }
      body.appendChild(out);
      if (!d.creators.length) { body.appendChild(empty('No money from views in this month.')); return; }
      body.appendChild(table(['Creator', 'Views', 'Videos', 'Earned', 'Take away ($)', 'Reason', ''], d.creators.map(function (c) {
        var cut = el('input', { class: 'at-in', type: 'number', step: '0.01', min: '0', max: String(c.earned), value: c.approved ? String(c.cut || '') : '', placeholder: '0', style: 'max-width:90px' });
        var why = el('input', { class: 'at-in', value: c.note || '', placeholder: 'e.g. fake views', style: 'max-width:160px' });
        cut.disabled = why.disabled = c.approved || !d.canApprove || !d.isSuperAdmin;
        var act = c.approved ? el('span', { style: 'color:#15803d;font-weight:700', text: '✅ Approved' + (c.approvedBy === 'system' ? ' (before)' : '') })
          : (d.canApprove && d.isSuperAdmin ? el('button', { class: 'btn-sm btn-blue', text: 'Approve', onclick: function () {
              var n = Number(cut.value || 0); if (n < 0 || n > c.earned) { alert('Take away between $0 and $' + c.earned.toFixed(2)); return; }
              if (!confirm('Approve ' + (c.name || c.public_id) + ': $' + (c.earned - n).toFixed(2) + ' can be withdrawn' + (n > 0 ? ' ($' + n.toFixed(2) + ' taken away)' : '') + '?')) return;
              this.disabled = true; adm('/api/admin/earn-months/approve', { month: d.month, creators: [{ creator: c.email, cut: n, note: why.value }] }).then(function (x) { if (x.success) monMonths(body); else alert(x.error || 'Failed'); });
            } }) : el('span', { style: 'color:#b45309', text: '⏳ Waiting' }));
        return el('tr', {}, [el('td', {}, [el('div', { style: 'font-weight:700', text: c.name || '(no name)' }), el('div', { style: 'font-size:11.5px;color:#65676b', text: c.public_id })]),
          el('td', { text: String(c.views) }), el('td', { text: String(c.videos) }), el('td', { style: 'font-weight:800', text: money(c.earned) }), el('td', {}, [cut]), el('td', {}, [why]), el('td', {}, [act])]);
      })));
    });
  }
  // 📊 money paid for views: by day, by creator, by video (Cambodia time). Money shows within 5 minutes of the views.
  var rep = { from: '', to: '', email: '', name: '' };
  function monReport(body) {
    var pp = function (d) { return d.toISOString().slice(0, 10); };
    var kh = function () { return new Date(Date.now() + 7 * 3600000); };
    function range(k) {
      var t = kh(), y = t.getUTCFullYear(), m = t.getUTCMonth();
      if (k === 'today') return [pp(t), pp(t)];
      if (k === 'yesterday') { var d = new Date(t.getTime() - 86400000); return [pp(d), pp(d)]; }
      if (k === '7') return [pp(new Date(t.getTime() - 6 * 86400000)), pp(t)];
      if (k === 'month') return [pp(new Date(Date.UTC(y, m, 1))), pp(t)];
      return [pp(new Date(Date.UTC(y, m - 1, 1))), pp(new Date(Date.UTC(y, m, 0)))];
    }
    if (!rep.from) { var r0 = range('7'); rep.from = r0[0]; rep.to = r0[1]; }
    var fromIn = el('input', { class: 'at-in', type: 'date', value: rep.from, style: 'max-width:170px' }), toIn = el('input', { class: 'at-in', type: 'date', value: rep.to, style: 'max-width:170px' });
    var chips = el('div', { class: 'at-row', style: 'margin-bottom:8px' }, [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['month', 'This month'], ['last', 'Last month']].map(function (v) {
      return el('button', { class: 'btn-sm btn-gray', text: v[1], onclick: function () { var r = range(v[0]); rep.from = r[0]; rep.to = r[1]; rep.email = ''; load(); } });
    }));
    var pick = el('div', { class: 'at-row', style: 'align-items:center;margin-bottom:12px' }, [fromIn, el('span', { text: '→' }), toIn,
      el('button', { class: 'btn-sm btn-blue', text: 'Show', onclick: function () { rep.from = fromIn.value; rep.to = toIn.value; rep.email = ''; load(); } })]);
    var out = el('div'); body.appendChild(chips); body.appendChild(pick); body.appendChild(out);
    function tile(icon, label, val) { return el('div', { style: 'flex:1;min-width:150px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:12px 14px' }, [el('div', { style: 'font-size:13px;color:#65676b', text: icon + ' ' + label }), el('div', { style: 'font-size:22px;font-weight:800;margin-top:4px', text: val })]); }
    function csv(name, head, rows) {
      var q = function (v) { v = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var txt = '﻿' + [head].concat(rows).map(function (r) { return r.map(q).join(','); }).join('\n');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    }
    function load() {
      fromIn.value = rep.from; toIn.value = rep.to; out.textContent = ''; out.appendChild(empty('Loading…'));
      adm('/api/admin/earn-report', { from: rep.from, to: rep.to, creator: rep.email }).then(function (d) {
        out.textContent = ''; if (!d.success) { out.appendChild(empty(d.error || 'Could not load.')); return; }
        rep.from = d.from; rep.to = d.to; fromIn.value = d.from; toIn.value = d.to;
        out.appendChild(el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px' }, [
          tile('💵', 'Money paid', money(d.paid)), tile('👁', 'Paid views', String(d.views)), tile('👤', 'Creators paid', String(d.people)), tile('🎬', 'Videos', String(d.videos))]));
        if (d.earned > d.paid + 0.005) out.appendChild(el('div', { style: 'color:#b45309;font-size:13px;margin:-6px 0 12px', text: 'Not paid because of the daily limit: ' + money(d.earned - d.paid) }));
        // daily bars
        var max = 0; d.days.forEach(function (x) { if (x.paid > max) max = x.paid; });
        var bars = el('div', { style: 'display:flex;align-items:flex-end;gap:3px;height:120px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:10px 10px 4px;overflow-x:auto;margin-bottom:4px' }, d.days.map(function (x) {
          var h = max > 0 ? Math.max(2, Math.round(x.paid / max * 100)) : 2;
          return el('div', { title: x.day + ' · ' + money(x.paid) + ' · ' + x.views, style: 'flex:1;min-width:8px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center' }, [el('div', { style: 'width:100%;height:' + h + 'px;background:' + (x.paid > 0 ? '#1877f2' : '#e4e6eb') + ';border-radius:4px 4px 0 0' })]);
        }));
        out.appendChild(bars);
        out.appendChild(el('div', { style: 'display:flex;justify-content:space-between;font-size:11.5px;color:#65676b;margin-bottom:16px' }, [el('span', { text: d.from }), el('span', { text: d.to })]));
        // creators
        out.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' }, [el('div', { style: 'font-weight:800;font-size:16px', text: '👤 Creators' }),
          el('button', { class: 'btn-sm btn-gray', text: '⬇️ Download CSV', onclick: function () { csv('camfeed-creators-' + d.from + '_' + d.to + '.csv', ['Name', 'ID', 'Paid views', 'Videos', 'Earned ($)', 'Paid ($)'], d.creators.map(function (c) { return [nm(c), c.public_id, c.views, c.videos, c.earned.toFixed(2), c.paid.toFixed(2)]; })); } })]));
        if (!d.creators.length) out.appendChild(empty('No money paid for views in these days.'));
        else out.appendChild(table(['Creator', 'Paid views', 'Videos', 'Earned', 'Paid', ''], d.creators.map(function (c) {
          return el('tr', {}, [el('td', {}, [el('div', { style: 'font-weight:700', text: nm(c) }), el('div', { style: 'font-size:11.5px;color:#65676b', text: c.public_id })]),
            el('td', { text: String(c.views) }), el('td', { text: String(c.videos) }), el('td', { text: money(c.earned) }), el('td', { style: 'font-weight:800', text: money(c.paid) }),
            el('td', {}, [el('button', { class: 'btn-sm btn-blue', text: 'Videos ›', onclick: function () { rep.email = c.email; rep.name = nm(c); load(); } })])]);
        })));
        // one creator's videos
        if (rep.email && d.videoList) {
          var vb = el('div', { style: 'margin-top:18px;background:#f7f8fa;border-radius:12px;padding:12px' }); out.appendChild(vb);
          vb.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' }, [el('div', { style: 'font-weight:800;font-size:16px', text: '🎬 ' + rep.name }),
            el('div', { class: 'at-row' }, [el('button', { class: 'btn-sm btn-gray', text: '⬇️ Download CSV', onclick: function () { csv('camfeed-videos-' + d.from + '_' + d.to + '.csv', ['Post', 'Text', 'Paid views', 'Earned ($)'], d.videoList.map(function (v) { return [v.post_id, v.text, v.views, v.earned.toFixed(2)]; })); } }),
              el('button', { class: 'btn-sm btn-gray', text: '✕ Close', onclick: function () { rep.email = ''; load(); } })])]));
          if (!d.videoList.length) vb.appendChild(empty('No video details in these days.'));
          else vb.appendChild(table(['Video', 'Paid views', 'Earned', ''], d.videoList.map(function (v) {
            return el('tr', {}, [el('td', {}, [el('div', { style: 'display:flex;gap:8px;align-items:center' }, [v.thumb ? el('img', { src: v.thumb, alt: '', style: 'width:44px;height:44px;object-fit:cover;border-radius:6px' }) : el('span', { text: v.gone ? '🗑' : '🎬' }), el('div', { style: 'max-width:260px;white-space:normal;font-size:13px', text: v.gone ? 'Deleted post' : (v.text || '#' + v.post_id) })])]),
              el('td', { text: String(v.views) }), el('td', { style: 'font-weight:800', text: money(v.earned) }),
              el('td', {}, [v.gone ? el('span') : el('a', { href: '/p/' + v.post_id, target: '_blank', rel: 'noopener', class: 'btn-sm btn-gray', text: 'Open post' })])]);
          })));
        }
        out.appendChild(el('div', { style: 'margin-top:14px;font-size:12px;color:#65676b', text: 'Earned = views × price. Paid = what went into the wallet (after the daily limit). Video details start from the day this report was added.' }));
      });
    }
    load();
  }
  function monApps(body, src) {
    var setBox = el('div'); body.appendChild(setBox); monPath(setBox, src);
    var listBox = el('div'); body.appendChild(listBox); body = listBox;
    body.appendChild(empty('Loading…'));
    adm('/api/admin/monetization-requests').then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      d.requests = (d.requests || []).filter(function (r) { return (r.source || 'applied') === src; }); var pending = d.requests.filter(function (r) { return r.status === 'pending'; }).length; var sm = document.getElementById('statMonetize'); if (sm) sm.textContent = String(pending);
      var c = d.criteria || { followers: 0, views: 0, posts: 0, ageDays: 0 };
      body.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Requirements: ' + c.followers + ' followers · ' + c.views + ' views · ' + c.posts + ' posts · ' + c.ageDays + ' days old (change them in ⚙️ Conditions). To let someone earn WITHOUT the requirements, use ✉️ Invited by CamFeed.' }));
      if (!d.requests.length) { body.appendChild(empty(src === 'invited' ? 'Nobody invited yet. Open Users → Manage → "✉️ Invite to earn".' : 'No application yet.')); return; }
      body.appendChild(table(['Creator', 'Followers', 'Views', 'Posts', 'Age', 'Wallet', 'Status', 'Decision', ''], d.requests.map(function (r) {
        function decide(status, askNote) {
          var note = ''; if (askNote) { note = prompt('Reason (shown to the creator):', '') || ''; } else if (!confirm((status === 'approved' ? 'Approve ' : 'Reset ') + nm(r) + '?')) return;
          adm('/api/admin/monetization-action', { targetEmail: r.user_email, status: status, note: note }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
        }
        var acts = el('td', {}, r.status === 'pending' ? [el('button', { class: 'btn-sm btn-green', text: 'Approve', onclick: function () { decide('approved', false); } }), el('button', { class: 'btn-sm btn-red', text: 'Reject', onclick: function () { decide('rejected', true); } })]
          : [el('button', { class: 'btn-sm btn-gray', text: 'Reset to pending', onclick: function () { decide('pending', false); } })].concat(r.status === 'approved' ? [r.earn_suspended
            ? el('button', { class: 'btn-sm btn-green', text: '▶ Resume earning', onclick: function () { if (!confirm('Let ' + nm(r) + ' earn again? Views made while stopped will not be paid.')) return; adm('/api/admin/creator-earning', { targetEmail: r.user_email, suspend: false }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); }); } })
            : el('button', { class: 'btn-sm btn-red', text: '⏸ Stop earning', onclick: function () { var why = prompt('Why? (the creator sees this, e.g. "Views do not look real")', ''); if (!why) return; adm('/api/admin/creator-earning', { targetEmail: r.user_email, suspend: true, reason: why }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); }); } })] : []));
        if (r.earn_suspended) acts.appendChild(el('div', { style: 'font-size:12px;color:#9b1229;margin-top:4px', text: '⏸ Earning stopped: ' + (r.suspend_reason || '') }));
        if (r.status === 'invited') acts.appendChild(el('div', { style: 'font-size:12px;color:#b06000;margin-top:4px', text: '✉️ Waiting for the person to accept' }));
        acts.appendChild(el('button', { class: 'btn-sm btn-gray', text: src === 'invited' ? '→ Move to "requirements"' : '→ Move to "invited"', onclick: function () {
          if (!confirm('Move ' + nm(r) + ' to the other way to earn? Its price / daily limit is used from now on.')) return;
          adm('/api/admin/monetization-action', { targetEmail: r.user_email, status: 'move', source: src === 'invited' ? 'applied' : 'invited' }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
        } }));
        function stat(have, need) { return el('td', { text: Number(have).toLocaleString() + ' / ' + Number(need).toLocaleString(), style: have >= need ? 'color:#176f35;font-weight:700' : '' }); }
        return el('tr', {}, [el('td', {}, [el('div', { style: 'font-weight:700', text: nm(r) }), el('div', { style: 'font-size:11.5px;color:#65676b', text: r.public_id || '' }), r.message ? el('div', { style: 'font-size:12px;margin-top:4px;max-width:240px;white-space:normal', text: '“' + r.message + '”' }) : el('span')]), stat(r.followers_count, c.followers), stat(r.total_views, c.views), stat(r.posts_count, c.posts), stat(r.age_days, c.ageDays), el('td', { text: money(r.balance) }),
          el('td', {}, [statusBadge(r.status)]), el('td', { style: 'font-size:12px;color:#65676b', text: (r.decided_by ? 'by ' + r.decided_by + ' · ' : '') + (r.note || '') }), acts]);
      })));
    });
  }
  function monReferrals(body) {
    var rulesBox = el('div'); body.appendChild(rulesBox); monRules(rulesBox, 'referral');
    var listBox = el('div'); body.appendChild(listBox); body = listBox;
    body.appendChild(empty('Loading…'));
    adm('/api/admin/referrals').then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      d.referrals = d.referrals || []; var rl = d.rules || { rewardCents: 20, days: 3, posts: 3, windowDays: 3 };
      var waiting = d.referrals.filter(function (r) { return r.status === 'review'; }).length;
      body.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Reward ' + money(rl.rewardCents / 100) + ' per friend after ' + rl.days + ' days of use and ' + rl.posts + ' public photos/videos within ' + rl.windowDays + ' days. Paid automatically, except when several invited accounts share one network or the monthly limit is reached: those wait here for a Super Admin (' + waiting + ' waiting).' }));
      if (!d.referrals.length) { body.appendChild(empty('No invitation yet.')); return; }
      body.appendChild(table(['Inviter', 'Invited friend', 'Days', 'Posts', 'Status', 'Note', ''], d.referrals.map(function (r) {
        function decide(status) {
          var note = prompt(status === 'rewarded' ? 'Note (optional):' : 'Reason (optional):', ''); if (note === null) return;
          if (!confirm((status === 'rewarded' ? 'Pay ' + money(rl.rewardCents / 100) + ' to ' : 'Do NOT pay ') + (r.inviter_first || '') + ' ' + (r.inviter_last || '') + '?')) return;
          adm('/api/admin/referrals/decide', { referredEmail: r.referred_email, status: status, note: note }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
        }
        var acts = el('td', {}, r.status === 'review' && d.isSuperAdmin ? [el('button', { class: 'btn-sm btn-green', text: 'Pay', onclick: function () { decide('rewarded'); } }), el('button', { class: 'btn-sm btn-red', text: 'Do not pay', onclick: function () { decide('rejected'); } })] : []);
        return el('tr', {}, [el('td', {}, [el('div', { style: 'font-weight:700', text: ((r.inviter_first || '') + ' ' + (r.inviter_last || '')).trim() }), el('div', { style: 'font-size:11.5px;color:#65676b', text: r.inviter_id || '' })]), el('td', { text: ((r.friend_first || '') + ' ' + (r.friend_last || '')).trim() }),
          el('td', { text: r.days_done + ' / ' + rl.days }), el('td', { text: r.posts_done + ' / ' + rl.posts }), el('td', {}, [statusBadge(r.status === 'rewarded' ? 'paid' : r.status)]), el('td', { style: 'font-size:12px;color:#65676b', text: r.note || '' }), acts]);
      })));
    });
  }
  // ---------- 💎 Coins & 🎁 gifts: top-ups waiting, packs, receiver share, waiting days, payment details, the gift list ----------
  // ---------- 🚩 chat reports (on top of the Reports tab): see the reported message + the messages around it, delete at once,
  // message the person, limit their chat, suspend, dismiss; every report about the same person is counted (watch them) ----------
  function chatReportsAdmin() {
    var panel = document.getElementById('panel-reports'); if (!panel) return;
    var box = document.getElementById('chatReportsBox');
    if (!box) { box = el('div', { id: 'chatReportsBox', class: 'at-card', style: 'margin-bottom:14px' }); panel.insertBefore(box, panel.firstChild); }
    var mode = box.getAttribute('data-mode') || 'pending', target = box.getAttribute('data-target') || '';
    function call(extra) {
      return adm('/api/admin/chat-reports', Object.assign({ status: mode === 'done' ? 'done' : 'pending' }, target ? { target_email: target } : {}, extra || {}))
        .then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); return x; });
    }
    function media(url, type) {
      if (!url) return null;
      var u = String(url); if (u.charAt(0) === '[') { try { u = JSON.parse(u)[0].url || ''; } catch (e) { u = ''; } }
      if (!u) return null;
      if (type === 'video' || /\.(mp4|mov|webm)(\?|$)/i.test(u)) return el('video', { src: u, controls: 'controls', style: 'max-width:260px;max-height:260px;border-radius:8px;background:#000' });
      if (type === 'audio' || /\.(m4a|aac|mp3|ogg|webm)(\?|$)/i.test(u)) return el('audio', { src: u, controls: 'controls' });
      return el('img', { src: u, style: 'max-width:260px;max-height:260px;border-radius:8px;border:1px solid #ccc' });
    }
    function draw(d) {
      box.textContent = '';
      var reasons = d.reasons || {};
      var head = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, [
        el('span', { style: 'font-size:16px;font-weight:800', text: '💬 Chat reports' + (d.pending ? ' (' + d.pending + ' waiting)' : '') }),
        el('button', { class: 'btn-sm' + (mode === 'pending' ? ' btn-blue' : ''), text: 'Waiting', onclick: function () { box.setAttribute('data-mode', 'pending'); chatReportsAdmin(); } }),
        el('button', { class: 'btn-sm' + (mode === 'done' ? ' btn-blue' : ''), text: 'Done', onclick: function () { box.setAttribute('data-mode', 'done'); chatReportsAdmin(); } }),
        target ? el('button', { class: 'btn-sm', text: '✕ Show everybody', onclick: function () { box.setAttribute('data-target', ''); chatReportsAdmin(); } }) : '']);
      box.appendChild(head);
      box.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin-bottom:8px', text: 'Only what was reported is shown (with 10 messages before and after). Pictures / videos of deleted messages are kept 60 days as proof, then removed. Every action is saved in the Activity Log.' }));
      if (!d.reports.length) { box.appendChild(el('div', { style: 'color:#65676b;padding:10px', text: mode === 'pending' ? 'No chat reports waiting 🎉' : 'Nothing yet.' })); return; }
      d.reports.forEach(function (r) {
        var tname = ((r.t_first || '') + ' ' + (r.t_last || '')).trim() || r.target_email, rname = ((r.r_first || '') + ' ' + (r.r_last || '')).trim() || r.reporter_email;
        var card = el('div', { style: 'border:1px solid ' + (r.reason === 'child' || r.reason === 'sexual' ? '#fca5a5' : '#e4e6eb') + ';border-radius:12px;padding:12px;margin:8px 0;background:#fff' });
        card.appendChild(el('div', { style: 'font-weight:800', text: '🚩 ' + (reasons[r.reason] || r.reason) + ' · ' + (r.kind === 'person' ? 'person' : 'message') + (r.group_name ? ' · group "' + r.group_name + '"' : '') + ' · ' + ago(r.created_at) }));
        card.appendChild(el('div', { style: 'font-size:13px;margin:2px 0' }, [el('span', { text: 'Reported: ' }), el('b', { text: tname }),
          el('span', { text: ' · reports about this person: ' + (r.t_reports || 0) + ' (acted on ' + (r.t_resolved || 0) + ')' + (r.t_banned ? ' · ⛔ suspended' : '') + (r.t_limit ? ' · chat: ' + r.t_limit : '') }), ' ',
          el('a', { href: '#', text: '👁 watch this person', onclick: function (ev) { ev.preventDefault(); box.setAttribute('data-target', r.target_email); box.setAttribute('data-mode', 'done'); chatReportsAdmin(); } })]));
        card.appendChild(el('div', { style: 'font-size:13px;color:#65676b', text: 'By: ' + rname + (r.note ? ' · note: "' + r.note + '"' : '') }));
        if (r.kind === 'message') {
          var main = el('div', { style: 'background:#fff7ed;border-radius:10px;padding:8px;margin:6px 0' }, [el('div', { style: 'font-size:12px;color:#9a3412;font-weight:700', text: 'Reported message' })]);
          var m = media(r.media_url, r.message_type); if (m) main.appendChild(m);
          if (r.message && r.message !== '[Photo]' && r.message !== '[Video]') main.appendChild(el('div', { text: String(r.message).replace(/^__CAMFEED_EDITED__:/, '') }));
          card.appendChild(main);
        }
        var ctx = Array.isArray(r.context) ? r.context : [];
        if (ctx.length) {
          var det = el('details', { style: 'margin:4px 0' }, [el('summary', { style: 'cursor:pointer;font-size:13px', text: 'Messages around it (' + ctx.length + ')' })]);
          ctx.forEach(function (c) {
            var who = c.sender_email === r.target_email ? tname : (c.sender_email === r.reporter_email ? rname : 'other');
            var line = el('div', { style: 'font-size:13px;padding:3px 0;border-bottom:1px solid #f0f2f5' + (Number(c.id) === Number(r.message_id) ? ';background:#fff7ed' : '') }, [el('b', { text: who + ': ' }), el('span', { text: String(c.message || '').replace(/^__CAMFEED_EDITED__:/, '').slice(0, 300) })]);
            var mm = media(c.media_url, c.message_type); if (mm) { mm.style.maxWidth = '140px'; mm.style.maxHeight = '140px'; line.appendChild(el('div', {}, [mm])); }
            det.appendChild(line);
          });
          card.appendChild(det);
        }
        if (r.status === 'pending') {
          card.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' }, [
            r.message_id ? el('button', { class: 'btn-sm btn-red', text: '🗑 Delete now (both sides)', onclick: function () { var w = prompt('Reason (the sender sees it):', reasons[r.reason] || ''); if (w !== null) call({ action: 'delete', id: r.id, reason: w }); } }) : '',
            el('button', { class: 'btn-sm', text: '✉️ Send a message', onclick: function () { var t = prompt('Message to ' + tname + ' (from CamFeed):'); if (t) call({ action: 'notice', id: r.id, text: t, close: confirm('Close this report too?') }); } }),
            el('button', { class: 'btn-sm', text: '🔒 Limit chat', onclick: function () { var w = prompt('Reason (the person sees it):'); if (w) call({ action: 'limit', id: r.id, limit: confirm('OK = no chats or calls at all · Cancel = may only answer') ? 'banned' : 'reply_only', reason: w }); } }),
            d.isSuperAdmin ? el('button', { class: 'btn-sm btn-red', text: '⛔ Suspend account', onclick: function () { var w = prompt('Reason:'); if (w && confirm('Suspend ' + tname + '?')) call({ action: 'suspend', id: r.id, reason: w }); } }) : '',
            el('button', { class: 'btn-sm', text: '✔ Nothing wrong', onclick: function () { call({ action: 'dismiss', id: r.id }); } })]));
        } else {
          card.appendChild(el('div', { style: 'font-size:12.5px;color:#65676b;margin-top:4px', text: '✅ ' + r.status + (r.action ? ' · ' + r.action : '') + ' · by ' + (r.handled_by || '') + ' · ' + ago(r.handled_at) }));
        }
        box.appendChild(card);
      });
    }
    call();
  }

  // ---------- 🔍 Views check: the rules for real / paid views, and the views that look fake ----------
  function viewsAdmin(body) {
    var box = el('div', { style: 'max-width:900px' }, [empty('Loading…')]); body.appendChild(box);
    function call(extra) { return adm('/api/admin/view-guard', extra || {}).then(function (x) { if (x && x.success) draw(x); else { box.textContent = ''; box.appendChild(empty((x && x.error) || 'Could not load.')); } return x; }); }
    var WHY = { new_accounts: 'mostly new accounts', one_ip: 'many from one IP / phone', no_engagement: 'almost no likes or comments', too_many: 'counted too many views in one hour' };
    function draw(d) {
      box.textContent = '';
      var s = d.settings || {}, sp = s.spike || {}, su = !!d.isSuperAdmin, st = d.stats || {};
      box.appendChild(el('div', { style: 'font-size:17px;font-weight:800;margin-bottom:4px', text: '🔍 Views check' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Shown view = the number under a video. Paid view = what Creators earn from (its rules are never shown to users; Creators only see their money and a rate = money ÷ all views × 1,000). Paid views last day: ' + (st.day || 0) + ' · waiting for you: ' + (st.held || 0) + ' · removed as fake: ' + (st.removed || 0) }));
      var list = d.open || [];
      box.appendChild(el('div', { style: 'font-weight:800;font-size:15px;margin:8px 0 6px', text: 'To check (' + list.length + ')' }));
      if (!list.length) box.appendChild(empty('Nothing to check. 👍'));
      list.forEach(function (r) {
        var f = r.facts || {}, why = String(r.reason || '').split(',').map(function (k) { return WHY[k] || k; }).join(' · ');
        var line = r.kind === 'post'
          ? 'Post #' + r.post_id + ' by ' + nm(r) + ' · ' + (f.hour || 0) + ' paid views in 1 hour · new accounts ' + (f.newPct || 0) + '% · top IP ' + (f.ipPct || 0) + '% · likes+comments ' + (f.engagePct || 0) + '% of views · ' + (r.held || 0) + ' paid views waiting'
          : nm(r) + ' (' + r.user_email + ') counted more than ' + (f.perHour || '') + ' views in one hour';
        var card = el('div', { style: 'background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:12px 14px;margin-bottom:10px' }, [
          el('div', { style: 'font-weight:700', text: (r.kind === 'post' ? '📈 ' : '🤖 ') + why }),
          el('div', { style: 'font-size:13px;color:#444;margin:4px 0 8px', text: line }),
          r.kind === 'post' && r.content ? el('div', { style: 'font-size:12.5px;color:#65676b;margin-bottom:8px', text: String(r.content).slice(0, 160) }) : el('span'),
        ]);
        var btns = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
        if (r.kind === 'post') btns.appendChild(el('a', { href: '/p/' + r.post_id, target: '_blank', class: 'btn-sm btn-gray', text: 'Open post' }));
        btns.appendChild(el('button', { class: 'btn-sm btn-blue', text: '✅ Views are real', onclick: function () { call({ decide: { id: r.id, ok: true } }); } }));
        btns.appendChild(el('button', { class: 'btn-sm btn-gray', text: r.kind === 'post' ? '🗑️ Remove fake views' : '🗑️ Remove their paid views', onclick: function () { if (confirm('Remove these views? They will not be paid.')) call({ decide: { id: r.id, ok: false } }); } }));
        if (r.kind === 'post') btns.appendChild(el('button', { class: 'btn-sm', style: 'background:#e41e3f;color:#fff', text: '⛔ Remove + stop earning', onclick: function () { if (confirm('Remove the fake views AND stop this Creator\'s earning?')) call({ decide: { id: r.id, ok: false, stopEarning: true } }); } }));
        card.appendChild(btns); box.appendChild(card);
      });
      box.appendChild(el('div', { style: 'font-weight:800;font-size:15px;margin:16px 0 6px', text: 'Rules' + (su ? '' : ' (only a Super Admin can change)') }));
      var form = el('div', { style: 'background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:12px 14px' }); box.appendChild(form);
      // English label + the same in Khmer under it (Admin reads both)
      var KM = {
        'Shown view: watched at least (seconds)': 'ការមើលដែលបង្ហាញ៖ ត្រូវមើលយ៉ាងហោចណាស់ (វិនាទី)',
        'Shown view: one person counts once every (hours)': 'ការមើលដែលបង្ហាញ៖ មនុស្សម្នាក់រាប់ ១ ដង ក្នុងរយៈពេល (ម៉ោង)',
        'Paid view: watched at least (seconds)': 'ការមើលដែលបង់ប្រាក់៖ ត្រូវមើលយ៉ាងហោចណាស់ (វិនាទី) 🔒 សម្ងាត់ ម្នាក់បង់ ១ ដងគត់ក្នុងមួយការបង្ហោះ',
        'Paid view, short video: at least this % of it': 'វីដេអូខ្លី៖ ត្រូវមើលយ៉ាងហោចណាស់ ភាគរយនៃវីដេអូ (%)',
        'Paid view, short video: never less than (seconds)': 'វីដេអូខ្លី៖ មិនតិចជាង (វិនាទី)',
        'Paid view: viewer account at least (days old)': 'គណនីអ្នកមើលត្រូវមានអាយុយ៉ាងហោចណាស់ (ថ្ងៃ)',
        'Paid views from one phone / IP per post per day': 'ការមើលដែលបង់ប្រាក់ ពីទូរសព្ទ ឬ IP មួយ ក្នុងមួយការបង្ហោះ ក្នុងមួយថ្ងៃ',
        'One person: views counted per hour at most': 'មនុស្សម្នាក់៖ រាប់ការមើលច្រើនបំផុតក្នុងមួយម៉ោង (លើសនេះ បញ្ឈប់ ហើយបង្ហាញនៅទីនេះ)',
        'Paid views are paid after (days)': 'បង់ប្រាក់ក្រោយ (ថ្ងៃ) ដើម្បីមានពេលរកអ្នកបន្លំ',
        'Strange jump: paid views in 1 hour at least': 'ការកើនឡើងចម្លែក៖ ការមើលដែលបង់ប្រាក់ក្នុង ១ ម៉ោង យ៉ាងហោចណាស់',
        '… from new accounts (< 30 days) at least (%)': '… ពីគណនីថ្មី (តិចជាង ៣០ ថ្ងៃ) យ៉ាងហោចណាស់ (%)',
        '… from one IP at least (%)': '… ពី IP តែមួយ យ៉ាងហោចណាស់ (%)',
        '… likes + comments less than (% of views)': '… ចូលចិត្ត និងមតិ តិចជាង (% នៃការមើល)'
      };
      function field(label, val, hint) { var i = el('input', { class: 'at-in', value: String(val), style: 'width:110px;display:inline-block' }); i.disabled = !su; form.appendChild(el('label', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0' }, [el('span', { style: 'min-width:min(340px,100%);max-width:100%;flex:1 1 340px;overflow-wrap:anywhere' }, [el('div', { text: label }), KM[label] ? el('div', { style: 'color:#1E4BFF;font-size:13px;margin-top:2px', text: KM[label] }) : el('span')]), i, el('span', { style: 'color:#65676b;font-size:12px', text: hint || '' })])); return i; }
      var f1 = field('Shown view: watched at least (seconds)', s.shownSec, '');
      var f2 = field('Shown view: one person counts once every (hours)', s.shownHours, '');
      var f3 = field('Paid view: watched at least (seconds)', s.paidSec, '🔒 secret — only CamFeed knows it (3–120). One paid view per person per post, for ever');
      var f4 = field('Paid view, short video: at least this % of it', s.shortPct, '');
      var f5 = field('Paid view, short video: never less than (seconds)', s.shortMinSec, '');
      var f6 = field('Paid view: viewer account at least (days old)', s.minAgeDays, '');
      var f7 = field('Paid views from one phone / IP per post per day', s.perDevice, '');
      var f8 = field('One person: views counted per hour at most', s.perHour, 'more = stopped and shown here');
      var f9 = field('Paid views are paid after (days)', s.holdDays, 'time to find cheats');
      var g1 = field('Strange jump: paid views in 1 hour at least', sp.minHour, 'then the checks below');
      var g2 = field('… from new accounts (< 30 days) at least (%)', sp.newPct, '');
      var g3 = field('… from one IP at least (%)', sp.ipPct, '');
      var g4 = field('… likes + comments less than (% of views)', sp.engagePct, '');
      if (su) form.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'margin-top:8px', text: '💾 Save', onclick: function () {
        call({ set: { shownSec: +f1.value, shownHours: +f2.value, paidSec: +f3.value, shortPct: +f4.value, shortMinSec: +f5.value, minAgeDays: +f6.value, perDevice: +f7.value, perHour: +f8.value, holdDays: +f9.value,
          spike: { minHour: +g1.value, newPct: +g2.value, ipPct: +g3.value, engagePct: +g4.value } } }).then(function (x) { if (x && x.success) alert('✅ Saved'); });
      } }));
    }
    call();
  }

  // ---------- ©️ Copyright: claims ("this uses my work") and copies found by the fingerprints ----------
  // ---------- ✔ Official accounts: requests, paused ticks (name changed / yearly check), all ticks, the rules. Only the Super Admin decides. ----------
  function verifyAdmin(body) {
    var PATH = { business: AT('🏪 ហាង ឬក្រុមហ៊ុន — ពិនិត្យលេខចុះបញ្ជីលើគេហទំព័រក្រសួងពាណិជ្ជកម្ម', '🏪 Shop or company — check the registration number on the Ministry of Commerce website'),
      official: AT('🏛️ បុគ្គល ឬស្ថាប័នល្បី — បើកតំណ ហើយមើលថាមានលេខកូដ', '🏛️ Well-known person or organisation — open the link and look for the code'),
      creator: AT('🎬 អ្នកបង្កើតមាតិកាធំ — មើលអ្នកតាមដាន ឬបើកតំណឆានែល ហើយមើលលេខកូដ', '🎬 Big content creator — look at the followers, or open the channel link and look for the code') };
    var CK = { days: AT('ថ្ងៃប្រើ', 'Days on CamFeed'), clean: AT('មិនដែលបំពាន', 'Never broke rules'), phone: AT('លេខទូរស័ព្ទ', 'Phone'), pic: AT('រូប និងឈ្មោះ', 'Picture and name'), posts: AT('បង្ហោះ 30 ថ្ងៃ', 'Posts in 30 days'), followers: AT('អ្នកតាមដាន', 'Followers'), rename: AT('មិនបានប្ដូរឈ្មោះ', 'No name change'), tick: AT('មាន ✔', 'Has ✔'), idproof: AT('🪪 ID ឬថ្លៃខែ', '🪪 ID or monthly fee'), bank: AT('🏦 ឈ្មោះធនាគារ', '🏦 Bank name') };
    var state = { status: 'pending' };
    function call(x) { return adm('/api/admin/verify', x); }
    var top = el('div', { class: 'at-card' }); body.appendChild(top);
    var list = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.appendChild(list);
    var paused = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.appendChild(paused);
    var have = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.appendChild(have);
    var proofsBox = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.insertBefore(proofsBox, paused);
    var namesBox = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.insertBefore(namesBox, paused);
    var rules = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.appendChild(rules);
    function who(x) { return ((x.first_name || '') + ' ' + (x.last_name || '')).trim(); }
    function linkEl(u) { return /^https?:\/\//i.test(u || '') ? el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: u, style: 'word-break:break-all' }) : el('span', { text: '—' }); }
    function load() {
      call({ action: 'list', status: state.status }).then(function (d) {
        if (!d.success) { top.textContent = d.error || 'Failed'; return; }
        var sup = d.isSuperAdmin;
        top.textContent = '';
        top.appendChild(el('div', { class: 'at-h', text: AT('✔ គណនីផ្លូវការ', '✔ Official accounts') }));
        top.appendChild(el('div', { style: 'color:#65676b;font-size:13.5px;line-height:1.6', text: AT('សញ្ញា ✔ = គណនីនេះជាគណនីផ្លូវការ មិនមែនក្លែងបន្លំ។ ផ្ដល់តែគណនីដែលមានលក្ខខណ្ឌគ្រប់ និងបញ្ជាក់បានច្បាស់។ មិនលក់។ មានតែ Super Admin អាចផ្ដល់ ឬដក។ រូបអត្តសញ្ញាណប័ណ្ណ (បើបើក) មានតែ Super Admin មើលបាន ហើយលុបចោលក្រោយពិនិត្យ។',
          'The ✔ means this is the official account, not a fake. Give it only when every condition is met and the proof is clear. Never sold. Only the Super Admin can give or take it. ID photos (when turned on) are seen only by the Super Admin and deleted after the check.') }));
        var tabs = el('div', { class: 'at-row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap' });
        [['pending', AT('⏳ កំពុងរង់ចាំ', '⏳ Waiting')], ['approved', AT('✅ បានអនុម័ត', '✅ Approved')], ['rejected', AT('✖ មិនអនុម័ត', '✖ Not approved')]].forEach(function (t) {
          tabs.appendChild(el('button', { class: 'btn-sm' + (state.status === t[0] ? '' : ' btn-gray'), text: t[1], onclick: function () { state.status = t[0]; load(); } }));
        });
        top.appendChild(tabs);

        list.textContent = '';
        list.appendChild(el('div', { class: 'at-h', text: AT('ពាក្យសុំ', 'Requests') + ' (' + d.requests.length + ')' }));
        if (!d.requests.length) list.appendChild(el('div', { style: 'color:#65676b', text: AT('មិនមាន', 'None') }));
        d.requests.forEach(function (q) {
          var box = el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin-top:10px' });
          box.appendChild(el('div', { style: 'font-weight:800;font-size:15px', text: 'V' + q.id + ' · ' + who(q) + (q.account_type === 'business' ? ' · 🏪' : '') + ' · 👥 ' + Number(q.followers || 0).toLocaleString() }));
          box.appendChild(el('div', { style: 'margin-top:4px', text: PATH[q.path] || q.path }));
          box.appendChild(el('div', { style: 'margin-top:6px' }, [el('b', { text: AT('លេខកូដ៖ ', 'Code: ') }), el('span', { text: q.code, style: 'font-weight:800;color:#1877f2;font-size:16px' })]));
          if (q.reg_no) box.appendChild(el('div', { style: 'margin-top:4px' }, [el('b', { text: AT('លេខចុះបញ្ជី៖ ', 'Registration no.: ') }), el('span', { text: q.reg_no })]));
          box.appendChild(el('div', { style: 'margin-top:4px' }, [el('b', { text: AT('តំណ៖ ', 'Link: ') }), linkEl(q.link)]));
          if (q.link2) box.appendChild(el('div', { style: 'margin-top:4px' }, [el('b', { text: AT('អត្ថបទព័ត៌មាន៖ ', 'News article: ') }), linkEl(q.link2)]));
          if (q.note) box.appendChild(el('div', { style: 'margin-top:4px;white-space:pre-wrap', text: '📝 ' + q.note }));
          var ck = []; try { ck = JSON.parse(q.checks || '[]'); } catch (e) {}
          box.appendChild(el('div', { style: 'margin-top:6px;font-size:13px;color:#374151', text: ck.map(function (c) { return (c.ok ? '✅ ' : '❌ ') + (CK[c.k] || c.k) + (c.have !== undefined ? ' (' + c.have + ')' : ''); }).join(' · ') }));
          if (q.admin_note) box.appendChild(el('div', { style: 'margin-top:4px;color:#65676b', text: AT('កំណត់ចំណាំ៖ ', 'Note: ') + q.admin_note }));
          if (q.status === 'pending') {
            if (!sup) box.appendChild(el('div', { style: 'margin-top:8px;color:#b45309', text: AT('មានតែ Super Admin ទេដែលអាចសម្រេច។', 'Only the Super Admin can decide.') }));
            else {
              var note = el('input', { class: 'at-in', placeholder: AT('មូលហេតុ (ផ្ញើទៅអ្នកដាក់ពាក្យ ពេលមិនអនុម័ត)', 'Reason (sent to the person when not approved)'), style: 'margin-top:8px' });
              box.appendChild(note);
              box.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px' }, [
                el('button', { class: 'btn-sm', text: AT('✅ ផ្ដល់ ✔', '✅ Give the ✔'), onclick: function () { if (confirm(AT('ផ្ដល់ ✔ ឲ្យ ', 'Give the ✔ to ') + who(q) + '?')) call({ action: 'decide', id: q.id, ok: true, note: note.value }).then(load); } }),
                el('button', { class: 'btn-sm btn-gray', text: AT('✖ មិនអនុម័ត', '✖ Not approve'), onclick: function () { call({ action: 'decide', id: q.id, ok: false, note: note.value }).then(load); } })
              ]));
            }
          }
          list.appendChild(box);
        });

        paused.textContent = '';
        paused.appendChild(el('div', { class: 'at-h', text: AT('⏸️ ✔ កំពុងផ្អាក (ប្ដូរឈ្មោះ ឬដល់ពេលពិនិត្យប្រចាំឆ្នាំ)', '⏸️ Paused ✔ (name changed or yearly check)') + ' (' + d.paused.length + ')' }));
        d.paused.forEach(function (u) {
          paused.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center' }, [
            el('span', { style: 'flex:1;min-width:200px', text: who(u) + '  ←  ' + AT('ឈ្មោះចាស់៖ ', 'old name: ') + (u.verified_name || '—') }),
            sup ? el('button', { class: 'btn-sm', text: AT('✅ បើកវិញ', '✅ Give back'), onclick: function () { call({ action: 'restore', targetEmail: u.email }).then(load); } }) : el('span'),
            sup ? el('button', { class: 'btn-sm btn-gray', text: AT('ដក ✔', 'Take the ✔ away'), onclick: function () { var r = prompt(AT('មូលហេតុ', 'Reason')); if (r !== null) call({ action: 'remove', targetEmail: u.email, note: r }).then(load); } }) : el('span')
          ]));
        });

        have.textContent = '';
        have.appendChild(el('div', { class: 'at-h', text: AT('គណនីដែលមាន ✔', 'Accounts with the ✔') + ' (' + d.verified.length + ')' }));
        d.verified.forEach(function (u) {
          have.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center' }, [
            el('span', { style: 'flex:1;min-width:200px', text: '✔ ' + who(u) + ' · ' + (u.verified_path || '') + (u.verified_at ? ' · ' + String(u.verified_at).slice(0, 10) : '') }),
            sup ? el('button', { class: 'btn-sm btn-gray', text: AT('ដក ✔', 'Take the ✔ away'), onclick: function () { var r = prompt(AT('មូលហេតុ (បំពានច្បាប់ លក់គណនី …)', 'Reason (broke the rules, sold the account …)')); if (r !== null) call({ action: 'remove', targetEmail: u.email, note: r }).then(load); } }) : el('span')
          ]));
        });

        // 🪪 🏦 💳 proofs waiting (ID + selfie: only the Super Admin sees the photos; they are deleted after the answer)
        proofsBox.textContent = '';
        var pf = d.proofs || [], KIND = { id: AT('🪪 ID + Selfie', '🪪 ID + selfie'), pay: AT('💳 ថ្លៃប្រចាំខែ', '💳 Monthly fee'), bank: AT('🏦 បញ្ជាក់ឈ្មោះធនាគារ', '🏦 Bank name check') };
        proofsBox.appendChild(el('div', { class: 'at-h', text: AT('🪪 ភស្តុតាងកំពុងរង់ចាំ', '🪪 Proofs waiting') + ' (' + pf.length + ')' }));
        if (!pf.length) proofsBox.appendChild(el('div', { style: 'color:#65676b', text: AT('មិនមាន', 'None') }));
        pf.forEach(function (p) {
          var box = el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin-top:10px' });
          box.appendChild(el('div', { style: 'font-weight:800;font-size:15px', text: 'P' + p.id + ' · ' + (KIND[p.kind] || p.kind) + (p.amount_cents ? ' · $' + (p.amount_cents / 100).toFixed(2) : '') }));
          box.appendChild(el('div', { style: 'margin-top:4px' }, [el('b', { text: AT('ឈ្មោះក្នុង CamFeed៖ ', 'Name on CamFeed: ') }), el('span', { text: who(p), style: 'font-weight:800;color:#1877f2' })]));
          var pics = el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' });
          [[p.id_url, AT('អត្តសញ្ញាណប័ណ្ណ', 'ID card')], [p.selfie_url, 'Selfie'], [p.receipt_url, AT('វិក្កយបត្រ', 'Receipt')]].forEach(function (x) {
            if (!/^https:\/\//.test(x[0] || '')) return;
            var a = el('a', { href: x[0], target: '_blank', rel: 'noopener noreferrer', style: 'display:block;text-align:center;font-size:12px;color:#65676b' });
            a.appendChild(el('img', { src: x[0], alt: x[1], style: 'width:150px;height:150px;object-fit:cover;border-radius:10px;border:1px solid #e4e6eb;display:block' }));
            a.appendChild(el('span', { text: x[1] }));
            pics.appendChild(a);
          });
          box.appendChild(pics);
          if (p.kind === 'id' && !sup) box.appendChild(el('div', { style: 'margin-top:6px;color:#b45309', text: AT('🔒 មានតែ Super Admin ទេដែលមើលរូប ID បាន។', '🔒 Only the Super Admin can see the ID photos.') }));
          if (p.ref) box.appendChild(el('div', { style: 'margin-top:4px', text: '🧾 ' + p.ref }));
          box.appendChild(el('div', { style: 'margin-top:6px;font-size:13px;color:#374151', text: p.kind === 'id' ? AT('ឈ្មោះលើអត្តសញ្ញាណប័ណ្ណ ត្រូវដូចឈ្មោះខាងលើ ហើយមុខត្រូវដូច Selfie។', 'The name on the ID must be the same as above, and the face the same as the selfie.') : AT('ឈ្មោះគណនីលើវិក្កយបត្រ ត្រូវដូចឈ្មោះខាងលើ ហើយប្រាក់ចូលពិតមែន។', 'The account name on the receipt must be the same as above, and the money really came in.') }));
          if (p.kind !== 'id' || sup) {
            var nt = el('input', { class: 'at-in', placeholder: AT('មូលហេតុ (ពេលបដិសេធ)', 'Reason (when refused)'), style: 'margin-top:8px' });
            box.appendChild(nt);
            box.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px' }, [
              el('button', { class: 'btn-sm', text: AT('✅ អនុម័ត', '✅ Approve'), onclick: function () { call({ action: 'proof', id: p.id, ok: true, note: nt.value }).then(load); } }),
              el('button', { class: 'btn-sm btn-gray', text: AT('❌ បដិសេធ', '❌ Refuse'), onclick: function () { call({ action: 'proof', id: p.id, ok: false, note: nt.value }).then(load); } })
            ]));
          }
          proofsBox.appendChild(box);
        });

        // 🏷️ one-word names waiting
        namesBox.textContent = '';
        var nm = d.names || [];
        namesBox.appendChild(el('div', { class: 'at-h', text: AT('🏷️ សំណើឈ្មោះមួយពាក្យ', '🏷️ One-word name requests') + ' (' + nm.length + ')' }));
        if (!nm.length) namesBox.appendChild(el('div', { style: 'color:#65676b', text: AT('មិនមាន', 'None') }));
        nm.forEach(function (n) {
          var nt = el('input', { class: 'at-in', placeholder: AT('មូលហេតុ (ពេលបដិសេធ)', 'Reason (when refused)'), style: 'margin-top:8px' });
          namesBox.appendChild(el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin-top:10px' }, [
            el('div', { style: 'font-weight:800', text: 'N' + n.id + ' · ' + who(n) + '  →  ' + n.name }), nt,
            el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px' }, [
              el('button', { class: 'btn-sm', text: AT('✅ អនុម័ត', '✅ Approve'), onclick: function () { call({ action: 'name', id: n.id, ok: true, note: nt.value }).then(load); } }),
              el('button', { class: 'btn-sm btn-gray', text: AT('❌ បដិសេធ', '❌ Refuse'), onclick: function () { call({ action: 'name', id: n.id, ok: false, note: nt.value }).then(load); } })
            ])
          ]));
        });

        // ☑️ the conditions: tick / untick and the number, one column for ✔ and one for a one-word name
        rules.textContent = '';
        rules.appendChild(el('div', { class: 'at-h', text: AT('⚙️ លក្ខខណ្ឌ', '⚙️ Conditions') }));
        rules.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:8px', text: AT('ធីក ☑ = លក្ខខណ្ឌនេះត្រូវការ។ ដាក់លេខ 0 = មិនកំណត់ចំនួន។', 'Tick ☑ = this condition is needed. A number 0 = no minimum.') }));
        var CN = [['days', AT('ប្រើ CamFeed យ៉ាងតិច (ថ្ងៃ)', 'Used CamFeed at least (days)')], ['followers', AT('អ្នកតាមដានយ៉ាងតិច', 'Followers at least')], ['posts', AT('ការបង្ហោះក្នុង 30 ថ្ងៃ យ៉ាងតិច', 'Posts in 30 days at least')],
          ['phone', AT('បញ្ជាក់លេខទូរស័ព្ទ', 'Phone confirmed')], ['pic', AT('មានរូបប្រូហ្វាល', 'Has a profile picture')], ['clean', AT('មិនដែលបំពានច្បាប់', 'Never broke the rules')],
          ['rename', AT('មិនបានប្ដូរឈ្មោះក្នុង (ថ្ងៃ)', 'No name change in (days)')], ['tick', AT('មាន ✔ រួចហើយ', 'Already has the ✔')], ['idproof', AT('🪪 ID + Selfie (កាមេរ៉ា) ឬ 💳 ថ្លៃប្រចាំខែ', '🪪 ID + selfie (camera) or 💳 monthly fee')], ['bank', AT('🏦 បញ្ជាក់ឈ្មោះតាមគណនីធនាគារ (ផ្ទេរប្រាក់តិចតួច)', '🏦 Bank account name (a small transfer)')]];
        var cd = d.conds || {}, cb = {};
        var grid = el('div', { style: 'display:grid;grid-template-columns:minmax(150px,1.6fr) 1fr 1fr;gap:6px 10px;align-items:center;font-size:13.5px' });
        grid.appendChild(el('b', { text: '' })); grid.appendChild(el('b', { text: AT('✔ គណនីផ្លូវការ', '✔ Official') })); grid.appendChild(el('b', { text: AT('🏷️ ឈ្មោះមួយពាក្យ', '🏷️ One-word name') }));
        CN.forEach(function (r) {
          grid.appendChild(el('span', { text: r[1] }));
          ['tick', 'name'].forEach(function (pp) {
            var v = (cd[pp] || {})[r[0]] || {}; cb[pp] = cb[pp] || {};
            var cell = el('div', { class: 'at-row', style: 'gap:6px;align-items:center' });
            if (pp === 'tick' && r[0] === 'tick') { grid.appendChild(el('span', { text: '—', style: 'color:#9ca3af' })); return; }
            var c1 = el('input', { type: 'checkbox' }); c1.checked = !!v.on; cell.appendChild(c1);
            var n1 = null;
            if (v.n !== undefined) { n1 = el('input', { class: 'at-in', type: 'number', min: '0', value: v.n, style: 'width:90px;margin:0' }); cell.appendChild(n1); }
            cb[pp][r[0]] = { c: c1, n: n1 };
            grid.appendChild(cell);
          });
        });
        rules.appendChild(grid);
        // 💳 🏦 the amounts and the notes people read
        var pc = d.proofCfg || {}, pin = {};
        [['monthCents', AT('💳 ថ្លៃប្រចាំខែ (សេន · 100 = $1)', '💳 Monthly fee (cents · 100 = $1)'), 'number'], ['bankCents', AT('🏦 ចំនួនផ្ទេរ ដើម្បីបញ្ជាក់ឈ្មោះ (សេន · ឧ. 2 ឬ 3)', '🏦 Transfer to check the name (cents · e.g. 2 or 3)'), 'number'],
         ['note_km', AT('🏦 ពន្យល់ការផ្ទេរ (ខ្មែរ)', '🏦 About the transfer (Khmer)'), 'area'], ['note_en', AT('🏦 ពន្យល់ការផ្ទេរ (អង់គ្លេស)', '🏦 About the transfer (English)'), 'area'],
         ['id_note_km', AT('🪪 អ្វីដែល CamFeed ត្រូវការមើលលើអត្តសញ្ញាណប័ណ្ណ (ខ្មែរ) — ឧ. មើលតែរូប និងឈ្មោះ អាចបិទលេខបាន', '🪪 What CamFeed needs to see on the ID (Khmer) — e.g. only photo and name, the number may be covered'), 'area'],
         ['id_note_en', AT('🪪 អ្វីដែល CamFeed ត្រូវការមើលលើអត្តសញ្ញាណប័ណ្ណ (អង់គ្លេស)', '🪪 What CamFeed needs to see on the ID (English)'), 'area']].forEach(function (f) {
          rules.appendChild(el('label', { style: 'display:block;margin-top:10px;font-size:13px;font-weight:700', text: f[1] }));
          pin[f[0]] = f[2] === 'area' ? el('textarea', { class: 'at-in', rows: '2', style: 'width:100%' }) : el('input', { class: 'at-in', type: 'number', min: '0' });
          pin[f[0]].value = pc[f[0]] !== undefined ? pc[f[0]] : '';
          rules.appendChild(pin[f[0]]);
        });
        var yr = el('input', { class: 'at-in', type: 'number', min: '0', value: (d.cfg || {}).years });
        rules.appendChild(el('label', { style: 'display:block;margin-top:10px;font-size:13px;font-weight:700', text: AT('ពិនិត្យ ✔ ឡើងវិញរៀងរាល់ (ឆ្នាំ)', 'Check the ✔ again every (years)') }));
        rules.appendChild(yr);
        if (sup) rules.appendChild(el('button', { class: 'btn-sm', style: 'margin-top:10px', text: AT('💾 រក្សាទុក', '💾 Save'), onclick: function () {
          var out = { tick: {}, name: {} };
          ['tick', 'name'].forEach(function (pp) { Object.keys(cb[pp] || {}).forEach(function (k) { var x = cb[pp][k]; out[pp][k] = { on: x.c.checked }; if (x.n) out[pp][k].n = Number(x.n.value) || 0; }); });
          var proof = {}; Object.keys(pin).forEach(function (k) { proof[k] = /Cents$/.test(k) ? Number(pin[k].value) || 0 : pin[k].value; });
          call({ action: 'conds', conds: out, proof: proof }).then(function () {
            var x = { action: 'settings', years: Number(yr.value) }; Object.assign(x, { minDays: out.tick.days.n, minFollowers: out.tick.followers.n, minPosts30: out.tick.posts.n });
            return call(x);
          }).then(function () { load(); });
        } }));
        else rules.appendChild(el('div', { style: 'margin-top:8px;color:#b45309', text: AT('មានតែ Super Admin ទេដែលអាចប្ដូរ។', 'Only the Super Admin can change this.') }));
        // 🇰🇭 old names: surname first (preview, then swap; ↩️ undo)
        if (sup) {
          var no = el('div', { style: 'border-top:1px solid #e4e6eb;margin-top:16px;padding-top:12px' }); rules.appendChild(no);
          var drawNo = function () {
            call({ action: 'nameorder', step: 'preview' }).then(function (x) {
              no.textContent = '';
              no.appendChild(el('div', { class: 'at-h', text: AT('🔁 លំដាប់ឈ្មោះចាស់ (នាមត្រកូលមុន)', '🔁 Old names: surname first') }));
              no.appendChild(el('div', { style: 'color:#65676b;font-size:13px;line-height:1.6', text: AT('គណនីដែលបង្កើតមុនការកែនេះ បង្ហាញនាមខ្លួនមុននាមត្រកូល។ ចុចប្ដូរ ដើម្បីដាក់នាមត្រកូលមុន។ ឈ្មោះមួយពាក្យមិនប៉ះពាល់ទេ។', 'Accounts made before this fix show the given name first. Swap puts the surname first. One-word names are not touched.') }));
              if (!x.success) { no.appendChild(el('div', { text: x.error || 'Failed' })); return; }
              no.appendChild(el('div', { style: 'margin-top:6px;font-weight:700', text: AT('រង់ចាំប្ដូរ៖ ', 'To swap: ') + x.waiting + ' · ' + AT('បានប្ដូររួច៖ ', 'Swapped: ') + x.swapped }));
              if (x.waiting) no.appendChild(el('div', { style: 'margin-top:6px;color:#b45309;font-size:13px', text: AT('⚠️ ដកធីក ☐ ឈ្មោះដែលត្រឹមត្រូវរួចហើយ (ឧ. ឈ្មោះដែលអ្នកបានកែដោយដៃ) — តែឈ្មោះដែលធីក ☑ ប៉ុណ្ណោះត្រូវប្ដូរ។', '⚠️ Untick ☐ names that are already right (e.g. fixed by hand) — only ticked ☑ names are swapped.') }));
              var boxes = [];
              var listBox = el('div', { style: 'max-height:360px;overflow:auto;margin-top:6px;border:1px solid #e4e6eb;border-radius:10px;padding:6px 10px' });
              (x.sample || []).forEach(function (r) {
                var cb = el('input', { type: 'checkbox' }); cb.checked = true; cb.dataset.email = r.email; boxes.push(cb);
                var lb = el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13.5px;padding:3px 0;cursor:pointer' }, [cb, el('span', { text: (r.first_name + ' ' + r.last_name) + '  →  ' + (r.last_name + ' ' + r.first_name) })]);
                listBox.appendChild(lb);
              });
              if (x.sample && x.sample.length) no.appendChild(listBox);
              var row = el('div', { class: 'at-row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap' });
              if (x.waiting) row.appendChild(el('button', { class: 'btn-sm', text: AT('🔁 ប្ដូរឈ្មោះដែលធីក', '🔁 Swap the ticked names'), onclick: function () {
                var em = boxes.filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.email; });
                if (!em.length) return;
                if (confirm(AT('ប្ដូរលំដាប់ឈ្មោះ ', 'Swap the order of ') + em.length + AT(' គណនី?', ' names?'))) call({ action: 'nameorder', step: 'swap', emails: em }).then(drawNo);
              } }));
              if (x.swapped) row.appendChild(el('button', { class: 'btn-sm btn-gray', text: AT('↩️ ត្រឡប់វិញ (', '↩️ Undo (') + x.swapped + ')', onclick: function () { if (confirm(AT('ត្រឡប់លំដាប់ឈ្មោះវិញ?', 'Put the names back?'))) call({ action: 'nameorder', step: 'undo' }).then(drawNo); } }));
              no.appendChild(row);
            });
          };
          drawNo();
        }
      });
    }
    load();
  }

  // ---------- 🏷️ AI Keywords: the shared keyword list, what the AI gave each post, and fixing it by hand ----------
  function keywordsAdmin(body) {
    var state = { q: '' };
    function call(extra) { return adm('/api/admin/keywords', extra); }
    var head = el('div', { class: 'at-card' }); body.appendChild(head);
    var postBox = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.appendChild(postBox);
    var listBox = el('div', { class: 'at-card', style: 'margin-top:14px' }); body.appendChild(listBox);
    var groups = [], cats = [], words = [];
    function catSelect(v) { var s = el('select', { class: 'at-in' }); cats.forEach(function (c) { var o = el('option', { value: c, text: c }); if (c === v) o.selected = true; s.appendChild(o); }); return s; }
    function form(w, done) {       // add / edit one keyword
      var f = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin:8px 0;padding:10px;background:#f7f8fa;border-radius:10px' });
      var word = el('input', { class: 'at-in', placeholder: 'Keyword (Khmer)', value: w ? w.word : '' });
      var grp = el('input', { class: 'at-in', placeholder: 'Group', list: 'kwGroups', value: w ? w.grp : '' });
      var cat = catSelect(w ? w.cat : 'General');
      var syn = el('input', { class: 'at-in', placeholder: 'Same meaning: laptop, notebook, …', value: w ? w.synonyms : '' });
      var save = el('button', { class: 'btn-sm', text: w ? '💾 Save' : '➕ Add', onclick: function () {
        call({ action: w ? 'edit' : 'add', id: w ? w.id : 0, word: word.value, grp: grp.value, cat: cat.value, synonyms: syn.value }).then(function (x) { if (x.success) { done(); load(); } });
      } });
      [word, grp, cat, syn, save].forEach(function (n) { f.appendChild(n); });
      return f;
    }
    function load() {
      call({ action: 'list', q: state.q }).then(function (d) {
        if (!d.success) { head.textContent = d.error || 'Failed'; return; }
        groups = d.groups; cats = d.cats; words = d.words;
        var q = d.queue || {};
        head.textContent = '';
        head.appendChild(el('div', { class: 'at-h', text: '🏷️ AI Keywords' }));
        head.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:8px', text: 'The AI looks at 3 frames of each video (or the photos) and the caption, and chooses keywords from this list. People get scores for keywords from what they search, watch to the end, skip, like, comment, share and whose profile they open. The feed (and later the ads) match the two. Chat messages are never used.' }));
        head.appendChild(el('div', { class: 'at-row', style: 'flex-wrap:wrap;gap:8px' }, [
          el('span', { class: 'btn-sm btn-gray', text: '✅ Labelled: ' + (q.labelled || 0) + ' / ' + (q.total || 0) }),
          el('span', { class: 'btn-sm btn-gray', text: '⏳ Waiting: ' + (q.waiting || 0) }),
          el('span', { class: 'btn-sm btn-gray', text: '⚠️ Failed: ' + (q.failed || 0) }),
          el('span', { class: 'btn-sm ' + (q.gemini ? 'btn-gray' : ''), style: q.gemini ? '' : 'background:#e41e3f;color:#fff', text: q.gemini ? '🤖 AI: on' : '🤖 AI: GEMINI_API_KEY missing' }),
          el('button', { class: 'btn-sm' + (q.paused ? '' : ' btn-gray'), text: q.paused ? '▶️ Label old posts too' : '⏸ Pause old posts (new ones still labelled)', onclick: function () { call({ action: 'pause', on: !q.paused }).then(load); } }),
          el('button', { class: 'btn-sm btn-gray', text: '🔁 Label ALL posts again', onclick: function () { if (confirm('Label all posts again, one by one in the background? Keywords written by hand are kept.')) call({ action: 'redo-all' }).then(load); } })
        ]));
        if (q.aiError && q.aiError.err) head.appendChild(el('div', { style: 'font-size:12.5px;color:#b42318;margin-top:6px', text: '⚠️ AI last problem: ' + q.aiError.err + (q.aiError.at ? ' · ' + ago(q.aiError.at) : '') }));
        if (d.catCounts && d.catCounts.length) {   // 🗂 how many posts of each kind
          var totC = 0; d.catCounts.forEach(function (c) { totC += c.n; });
          head.appendChild(el('div', { style: 'font-weight:800;margin-top:12px;font-size:14px', text: '🗂 Posts by kind' }));
          head.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' }, d.catCounts.map(function (c) {
            var pc = totC ? Math.round(c.n * 100 / totC) : 0;
            return el('span', { style: 'padding:5px 10px;border-radius:999px;font-size:12.5px;font-weight:700;background:' + (c.c === 'General' ? '#fff4e5' : '#eef3ff') + ';color:' + (c.c === 'General' ? '#b45309' : '#1d4ed8'), text: c.c + ' · ' + c.n + ' (' + pc + '%)' });
          })));
        }
        if (q.worker && q.worker.last) head.appendChild(el('div', { style: 'font-size:12px;color:#65676b;margin-top:6px', text: 'Last: post #' + q.worker.last.id + ' → ' + (q.worker.last.words || []).join(', ') }));
        drawList();
      });
    }
    // one post: what the AI chose; change by hand
    function drawPostBox() {
      postBox.textContent = '';
      postBox.appendChild(el('div', { class: 'at-h', text: '🔎 Check one post' }));
      var id = el('input', { class: 'at-in', placeholder: 'Post number, e.g. 1234', style: 'max-width:200px' });
      var out = el('div');
      function show() {
        call({ action: 'detail', id: id.value }).then(function (d) {
          out.textContent = ''; if (!d.success) { out.appendChild(empty(d.error || 'Not found')); return; }
          var p = d.post;
          out.appendChild(el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-top:10px' }, [
            p.thumb_url ? el('img', { src: p.thumb_url, style: 'width:120px;border-radius:8px' }) : '',
            el('div', { style: 'flex:1;min-width:220px' }, [
              el('a', { href: '/videos.html?post=' + p.id, target: '_blank', text: 'open post #' + p.id }),
              el('div', { style: 'font-size:13px;white-space:pre-wrap;margin:4px 0', text: p.content || '(no caption)' }),
              el('div', { style: 'font-size:12px;color:#65676b', text: 'Category: ' + p.ai_category + ' · labelled by: ' + (p.kw_src || '—') + (p.kw_at ? ' · ' + ago(p.kw_at) : ' · not yet') })])]));
          var words = el('input', { class: 'at-in', style: 'width:100%;margin-top:8px', value: d.keywords.map(function (k) { return k.word; }).join(', ') });
          var cat = catSelect(p.ai_category);
          out.appendChild(words);
          out.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, [cat,
            el('button', { class: 'btn-sm', text: '💾 Save these keywords', onclick: function () { call({ action: 'relabel', id: p.id, words: words.value, cat: cat.value }).then(function (x) { if (x.success) show(); }); } }),
            el('button', { class: 'btn-sm btn-gray', text: '🤖 Ask the AI again', onclick: function () { call({ action: 'reclassify', id: p.id }).then(function (x) { if (x.success) show(); }); } })]));
          out.appendChild(el('div', { style: 'font-size:12px;color:#65676b;margin-top:4px', text: 'Separate with commas. A word not in the list is added to it. Saved by hand = the AI will not change it.' }));
        });
      }
      postBox.appendChild(el('div', { class: 'at-row', style: 'gap:8px' }, [id, el('button', { class: 'btn-sm', text: 'Show', onclick: show })]));
      postBox.appendChild(out);
    }
    function drawList() {
      listBox.textContent = '';
      var dl = el('datalist', { id: 'kwGroups' }); groups.forEach(function (g) { dl.appendChild(el('option', { value: g })); }); listBox.appendChild(dl);
      listBox.appendChild(el('div', { class: 'at-h', text: '📚 Keyword list (' + words.length + ')' }));
      var q = el('input', { class: 'at-in', placeholder: 'Search keyword / group…', value: state.q, style: 'max-width:260px' });
      var addBox = el('div');
      listBox.appendChild(el('div', { class: 'at-row', style: 'gap:8px;flex-wrap:wrap' }, [q,
        el('button', { class: 'btn-sm btn-gray', text: 'Search', onclick: function () { state.q = q.value; load(); } }),
        el('button', { class: 'btn-sm', text: '➕ New keyword', onclick: function () { addBox.textContent = ''; addBox.appendChild(form(null, function () {})); } })]));
      q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.q = q.value; load(); } });
      listBox.appendChild(addBox);
      var fresh = words.filter(function (w) { return !w.reviewed; });
      if (fresh.length) listBox.appendChild(el('div', { style: 'margin:8px 0;padding:8px 10px;background:#fff7e6;border-radius:8px;font-size:13px', text: '🆕 ' + fresh.length + ' new keyword(s) added by the AI — check them (✔ keep, ✏️ change, 🔗 join into another, 🗑 delete).' }));
      var lastG = null;
      words.slice().sort(function (a, b) { return (a.reviewed - b.reviewed) || (a.grp > b.grp ? 1 : a.grp < b.grp ? -1 : 0); }).forEach(function (w) {
        if (w.grp !== lastG) { lastG = w.grp; listBox.appendChild(el('div', { style: 'font-weight:800;margin:12px 0 4px', text: w.grp })); }
        var row = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 8px;border-bottom:1px solid #eef0f2' + (w.reviewed ? '' : ';background:#fff7e6') });
        var extra = el('div', { style: 'width:100%' });
        row.appendChild(el('b', { text: w.word }));
        row.appendChild(el('span', { style: 'font-size:12px;color:#65676b;flex:1;min-width:160px', text: w.cat + (w.synonyms ? ' · ' + w.synonyms : '') }));
        row.appendChild(el('span', { class: 'btn-sm btn-gray', text: w.posts + ' posts' }));
        if (!w.reviewed) row.appendChild(el('button', { class: 'btn-sm', text: '✔', title: 'Keep', onclick: function () { call({ action: 'approve', id: w.id }).then(load); } }));
        row.appendChild(el('button', { class: 'btn-sm btn-gray', text: '👁', title: 'Posts with it', onclick: function () {
          call({ action: 'posts', id: w.id }).then(function (d) {
            extra.textContent = ''; if (!d.success || !d.posts.length) { extra.appendChild(empty('No posts yet.')); return; }
            var g = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0' });
            d.posts.forEach(function (p) { g.appendChild(el('a', { href: '/videos.html?post=' + p.id, target: '_blank', style: 'width:120px;font-size:11px;color:#1c1e21;text-decoration:none' }, [
              p.thumb_url ? el('img', { src: p.thumb_url, style: 'width:120px;height:160px;object-fit:cover;border-radius:6px;background:#eee' }) : el('div', { style: 'width:120px;height:60px;background:#f0f2f5;border-radius:6px' }),
              el('div', { text: '#' + p.id + ' ' + (p.content || '').slice(0, 50) })])); });
            extra.appendChild(g);
          });
        } }));
        row.appendChild(el('button', { class: 'btn-sm btn-gray', text: '✏️', title: 'Change', onclick: function () { extra.textContent = ''; extra.appendChild(form(w, function () {})); } }));
        row.appendChild(el('button', { class: 'btn-sm btn-gray', text: '🔗', title: 'Join into another keyword', onclick: function () {
          var into = prompt('Join "' + w.word + '" into which keyword? (write it exactly)'); if (!into) return;
          var t = words.filter(function (x) { return x.word.toLowerCase() === into.trim().toLowerCase(); })[0];
          if (!t) { alert('Not found in the list. Search it first or check the spelling.'); return; }
          call({ action: 'merge', id: w.id, into: t.id }).then(load);
        } }));
        row.appendChild(el('button', { class: 'btn-sm btn-gray', text: '🗑', title: 'Delete', onclick: function () { if (confirm('Delete "' + w.word + '"? It is removed from all posts and people.')) call({ action: 'delete', id: w.id }).then(load); } }));
        row.appendChild(extra);
        listBox.appendChild(row);
      });
    }
    drawPostBox(); load();
  }

  function copyrightAdmin(body) {
    var mode = body.getAttribute('data-mode') || 'pending';
    var box = el('div', { class: 'at-card' }); body.appendChild(box);
    function call(extra) {
      return adm('/api/admin/copyright', Object.assign({ status: mode === 'done' ? 'done' : 'pending' }, extra || {})).then(function (x) {
        if (!x.success && x.error !== 'already') { alert(x.error || 'Failed'); return x; }
        if (extra && extra.action) { body.textContent = ''; copyrightAdmin(body); } else draw(x);
        return x;
      });
    }
    function firstUrl(raw) { var u = String(raw || ''); if (u.charAt(0) === '[' || u.charAt(0) === '{') { try { var j = JSON.parse(u); j = Array.isArray(j) ? j[0] : j; u = (j && (j.url || j)) || ''; } catch (e) { u = ''; } } return String(u); }
    function media(raw, type, thumb) {
      var u = firstUrl(raw); if (!u) return el('div', { style: 'color:#65676b;font-size:12px', text: '(deleted or no media)' });
      if (type === 'video' || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u)) return el('video', { src: u, poster: thumb || '', controls: 'controls', preload: 'none', style: 'width:220px;max-height:260px;border-radius:8px;background:#000' });
      return el('img', { src: u, style: 'max-width:220px;max-height:260px;border-radius:8px;border:1px solid #ccc' });
    }
    function side(title, name, raw, type, thumb, text, at, postId) {
      return el('div', { style: 'flex:1;min-width:220px;background:#f7f8fa;border-radius:10px;padding:8px' }, [
        el('div', { style: 'font-size:12px;font-weight:800;color:#65676b', text: title }),
        el('div', { style: 'font-weight:700', text: name + (at ? ' · ' + ago(at) : '') }),
        postId ? el('a', { href: '/videos.html?post=' + postId, target: '_blank', style: 'font-size:12px', text: 'open post #' + postId }) : '',
        el('div', { style: 'margin:6px 0' }, [media(raw, type, thumb)]),
        text ? el('div', { style: 'font-size:13px;white-space:pre-wrap', text: String(text).slice(0, 300) }) : '']);
    }
    function ask(t) { var w = prompt(t + '\n\nOptional message to the person (or leave empty):', ''); return w === null ? null : w; }
    function draw(d) {
      box.textContent = '';
      box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px' }, [
        el('span', { style: 'font-size:16px;font-weight:800', text: '©️ Copyright' }),
        el('button', { class: 'btn-sm' + (mode === 'pending' ? ' btn-blue' : ''), text: 'Waiting', onclick: function () { body.setAttribute('data-mode', 'pending'); body.textContent = ''; copyrightAdmin(body); } }),
        el('button', { class: 'btn-sm' + (mode === 'done' ? ' btn-blue' : ''), text: 'Done', onclick: function () { body.setAttribute('data-mode', 'done'); body.textContent = ''; copyrightAdmin(body); } })]));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin-bottom:8px', text: 'Fingerprints made: ' + d.checked + ' posts (' + d.waiting + ' still waiting; one every 15 s, newest first). A copy, or a post with a claim waiting, earns no money until you decide. Removing = 1 strike; ' + d.maxStrikes + ' strikes in a year stop the person\'s earnings (System › App settings).' }));
      box.appendChild(el('div', { class: 'at-h', text: '©️ Claims: "this post uses my work" (' + d.claims.length + ')' }));
      if (!d.claims.length) box.appendChild(el('div', { style: 'color:#65676b;padding:6px 0', text: mode === 'pending' ? 'No claims waiting 🎉' : 'Nothing yet.' }));
      d.claims.forEach(function (c) {
        var cn = ((c.c_first || '') + ' ' + (c.c_last || '')).trim() || 'User', on = ((c.o_first || '') + ' ' + (c.o_last || '')).trim() || 'User';
        var card = el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin:8px 0;background:#fff' }, [
          el('div', { style: 'font-weight:800', text: '©️ ' + cn + ' says the post of ' + on + ' uses their work · ' + ago(c.created_at) }),
          el('div', { style: 'font-size:13px;margin:4px 0' }, [el('b', { text: 'Their original: ' }), /^https?:\/\//.test(c.original || '') ? el('a', { href: c.original, target: '_blank', rel: 'noopener', text: c.original }) : el('span', { text: c.original || '—' })]),
          c.note ? el('div', { style: 'font-size:13px;white-space:pre-wrap;margin:2px 0' }, [el('b', { text: 'Why: ' }), el('span', { text: c.note })]) : '',
          el('div', { style: 'font-size:13px;white-space:pre-wrap;margin:2px 0;color:' + (c.counter_note ? '#166534' : '#65676b') }, [el('b', { text: 'Answer of ' + on + ': ' }), el('span', { text: c.counter_note || '(no answer yet)' })]),
          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px' }, [side('The reported post', on + ' · strikes this year: ' + (c.strikes || 0), c.media_url, c.media_type, c.thumb_url, c.content, c.post_at, c.post_id)])]);
        if (c.status === 'pending') {
          card.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' }, [
            el('button', { class: 'btn-sm btn-red', text: '🗑 Remove the post + 1 strike', onclick: function () { var w = ask('Remove the post of ' + on + '?'); if (w !== null) call({ action: 'claim_uphold', id: c.id, note: w }); } }),
            el('button', { class: 'btn-sm', text: '✔ No copyright problem', onclick: function () { var w = ask('Close this claim?'); if (w !== null) call({ action: 'claim_reject', id: c.id, note: w }); } })]));
        } else card.appendChild(el('div', { style: 'font-size:12.5px;color:#65676b;margin-top:4px', text: '✅ ' + c.status + ' · by ' + (c.decided_by || '') + ' · ' + ago(c.decided_at) + (c.admin_note ? ' · ' + c.admin_note : '') }));
        box.appendChild(card);
      });
      box.appendChild(el('div', { class: 'at-h', style: 'margin-top:16px', text: '🔁 Possible copies found by the fingerprints (' + d.dups.length + ')' }));
      if (!d.dups.length) box.appendChild(el('div', { style: 'color:#65676b;padding:6px 0', text: mode === 'pending' ? 'No copies waiting 🎉' : 'Nothing yet.' }));
      d.dups.forEach(function (x) {
        var cn = ((x.c_first || '') + ' ' + (x.c_last || '')).trim() || 'User', on = ((x.o_first || '') + ' ' + (x.o_last || '')).trim() || 'User';
        var card = el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin:8px 0;background:#fff' }, [
          el('div', { style: 'font-weight:800', text: '🔁 ' + x.score + '% the same · ' + ago(x.created_at) }),
          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px' }, [
            side('NEWER post (the copy?)', cn + ' · strikes this year: ' + (x.strikes || 0), x.media_url, x.media_type, x.thumb_url, x.content, x.post_at, x.post_id),
            side('OLDER post (the original?)', on, x.o_media_url, x.o_media_type, x.o_thumb_url, x.o_content, x.o_post_at, x.orig_post_id)])]);
        if (x.status === 'pending') {
          card.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' }, [
            el('button', { class: 'btn-sm btn-red', text: '🗑 Remove the copy + 1 strike', onclick: function () { var w = ask('Remove the post of ' + cn + '?'); if (w !== null) call({ action: 'dup_remove', id: x.id, note: w }); } }),
            el('button', { class: 'btn-sm', text: '💤 Keep it, but no earnings', onclick: function () { var w = ask('Keep the post, no money for it?'); if (w !== null) call({ action: 'dup_noearn', id: x.id, note: w }); } }),
            el('button', { class: 'btn-sm', text: '✔ Not a copy / allowed', onclick: function () { call({ action: 'dup_ok', id: x.id }); } })]));
        } else card.appendChild(el('div', { style: 'font-size:12.5px;color:#65676b;margin-top:4px', text: '✅ ' + x.status + ' · by ' + (x.decided_by || '') + ' · ' + ago(x.decided_at) }));
        box.appendChild(card);
      });
    }
    box.appendChild(empty('Loading…'));
    call();
  }

  // ---------- ⭐ CamFeed Stars: applications (ID + selfie), stars (hours this month, pause / remove / warn), monthly bonuses, all rules ----------
  function starsAdmin(body) {
    var box = el('div', { class: 'at-card' }); body.appendChild(box);
    function call(extra) { return adm('/api/admin/stars', extra || {}).then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); return x; }); }
    function draw(d) {
      box.textContent = '';
      var su = d.isSuperAdmin, s = d.settings || {};
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '⭐ CamFeed Stars (Party Room hosts)' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'People apply in the app (18+, real name, ID card photo + selfie). You approve → trial → star. ID photos are deleted after you decide. Hours count only while a star sits on a seat in an open room with enough listeners.' }));
      // rules
      function num(v, w) { return el('input', { class: 'at-in', type: 'number', value: String(v), style: 'width:' + (w || 80) + 'px' }); }
      var on = el('input', { type: 'checkbox' }); on.checked = s.on !== false;
      var sh = num(s.share), md = num(s.minDays), ms = num(s.minSession), mx = num(s.maxDay), ml = num(s.minListeners), hf = num(s.half), tr_ = num(s.trialDays);
      var ins = [on, sh, md, ms, mx, ml, hf, tr_];
      function row(label, i) { return el('div', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0' }, [el('span', { style: 'min-width:300px', text: label }), i]); }
      box.appendChild(el('div', { style: 'font-weight:800;margin:6px 0' , text: 'Rules' }));
      box.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-weight:700;margin:4px 0' }, [on, el('span', { text: 'Stars program open (applications + bigger share + bonus)' })]));
      box.appendChild(row('Star share of gift value (%) — normal people get the Diamonds share', sh));
      box.appendChild(row('Days needed in a month (days with the minimum session)', md));
      box.appendChild(row('Minimum minutes for a day to count', ms));
      box.appendChild(row('Most minutes counted in one day', mx));
      box.appendChild(row('Listeners needed in the room for minutes to count', ml));
      box.appendChild(row('Bonus % when diamonds are reached but hours / days are not', hf));
      box.appendChild(row('Trial days after approval (0 = star at once)', tr_));
      box.appendChild(el('div', { style: 'font-weight:800;margin:10px 0 4px', text: 'Monthly bonus tiers (hours + gift diamonds received → $)' }));
      var tiers = (s.tiers || []).map(function (t) { return { h: num(t.hours), c: num(t.coins, 110), u: el('input', { class: 'at-in', value: (Number(t.cents || 0) / 100).toFixed(2), style: 'width:80px' }) }; });
      if (su) tiers.push({ h: num(''), c: num('', 110), u: el('input', { class: 'at-in', value: '', style: 'width:80px', placeholder: '$' }) });
      tiers.forEach(function (t) { ins.push(t.h, t.c, t.u); });
      box.appendChild(table(['⭐', 'Hours', 'Gift diamonds received', 'Bonus $'], tiers.map(function (t, i) { return el('tr', {}, [el('td', { text: '⭐' + (i + 1) }), el('td', {}, [t.h]), el('td', {}, [t.c]), el('td', {}, [t.u])]); })));
      if (!su) ins.forEach(function (i) { i.disabled = true; });
      if (su) box.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'margin:8px 0', text: 'Save rules', onclick: function () {
        call({ action: 'settings', on: on.checked, share: sh.value, minDays: md.value, minSession: ms.value, maxDay: mx.value, minListeners: ml.value, half: hf.value, trialDays: tr_.value,
          tiers: tiers.filter(function (t) { return t.h.value !== '' && t.c.value !== '' && t.u.value !== ''; }).map(function (t) { return { hours: t.h.value, coins: t.c.value, usd: t.u.value }; }) });
      } }));
      // applications + stars
      var pend = d.list.filter(function (x) { return x.status === 'pending'; }), others = d.list.filter(function (x) { return x.status !== 'pending'; });
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: '📝 Applications waiting (' + pend.length + ')' }));
      pend.forEach(function (x) {
        var pics = el('div', { style: 'display:flex;gap:8px;margin:6px 0' });
        var card = el('div', { style: 'border:1px solid #ddd;border-radius:12px;padding:10px;margin:6px 0' }, [
          el('div', { style: 'font-weight:700', text: nm(x) + ' · real name: ' + (x.real_name || '—') + ' · ' + x.user_email + ' · ' + ago(x.applied_at) }), pics,
          el('button', { class: 'btn-sm', text: '👁 Show ID + selfie', onclick: function () { adm('/api/admin/stars', { action: 'doc', user: x.user_email }).then(function (r) {
            pics.textContent = ''; [r.id_photo, r.selfie].forEach(function (u) { if (u) pics.appendChild(el('img', { src: u, style: 'max-width:260px;max-height:260px;border-radius:8px;border:1px solid #ccc' })); });
            if (!r.id_photo && !r.selfie) pics.appendChild(el('span', { text: 'No pictures.' })); }); } }), ' ',
          su ? el('button', { class: 'btn-sm btn-blue', text: '✅ Approve', onclick: function () { if (confirm('Approve ' + nm(x) + ' as a Star? (ID photos will be deleted)')) call({ action: 'decide', user: x.user_email, ok: true }); } }) : '', ' ',
          su ? el('button', { class: 'btn-sm', text: '✖ Reject', onclick: function () { var r = prompt('Reason (the person sees it):'); if (r) call({ action: 'decide', user: x.user_email, ok: false, note: r }); } }) : '']);
        box.appendChild(card);
      });
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: '⭐ Stars and past applications (' + others.length + ')' }));
      var daysBox = el('div');
      function showDays(x) {
        daysBox.textContent = 'Loading…';
        adm('/api/admin/stars', { action: 'days', user: x.user_email }).then(function (r) {
          daysBox.textContent = '';
          if (!r.success) { daysBox.appendChild(empty(r.error || 'Could not load.')); return; }
          var ru = r.rules || {}, m = r.month || {}, pm = r.prevMonth || {}, lv = r.live || {};
          daysBox.appendChild(el('div', { style: 'border:1px solid #ddd;border-radius:12px;padding:10px;margin:8px 0' }, [
            el('div', { style: 'font-weight:800', text: '📊 ' + nm(x) + ' — minutes counted day by day (a day counts with ≥ ' + ru.minSession + ' min, at most ' + ru.maxDay + ' a day)' }),
            el('div', { text: 'This month: ' + m.hours + ' h · ' + m.days + ' / ' + ru.minDays + ' days · ' + m.coins + ' diamonds · tier ' + ((m.tier || {}).tier || '—') }),
            el('div', { text: 'Last month: ' + pm.hours + ' h · ' + pm.days + ' days · ' + pm.coins + ' diamonds · tier ' + ((pm.tier || {}).tier || '—') }),
            el('div', { text: 'Now: ' + (lv.counting ? '🟢 counting' : (lv.inRoom ? (lv.seated ? '⏸ ' + lv.others + ' listeners (needs ' + ru.minListeners + ')' : '⏸ in a room, not on a seat') : '⏸ not in a room')) }),
            table(['Day', 'Minutes', 'Counts'], (r.days || []).slice().reverse().map(function (dd) {
              return el('tr', {}, [el('td', { text: dd.day }), el('td', { text: String(dd.minutes) }), el('td', { text: dd.minutes >= ru.minSession ? '✅' : '—' })]);
            })),
            el('button', { class: 'btn-sm btn-gray', text: 'Close', onclick: function () { daysBox.textContent = ''; } })]));
          daysBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      box.appendChild(daysBox);
      box.appendChild(table(['Name', 'Status', 'This month: hours / days / diamonds', 'Warnings', 'Note', ''], others.map(function (x) {
        var m = x.month || {};
        var acts = !su ? [el('button', { class: 'btn-sm', text: '📊 Days', onclick: function () { showDays(x); } })] : [
          el('button', { class: 'btn-sm', text: '📊 Days', onclick: function () { showDays(x); } }),
          x.status !== 'star' && x.status !== 'rejected' ? el('button', { class: 'btn-sm btn-blue', text: '⭐ Star', onclick: function () { call({ action: 'status', user: x.user_email, status: 'star' }); } }) : '',
          x.status === 'star' || x.status === 'trial' ? el('button', { class: 'btn-sm', text: '⚠️ Warn', onclick: function () { var r = prompt('Warning (the person sees it):'); if (r) call({ action: 'status', user: x.user_email, status: 'warn', note: r }); } }) : '',
          x.status === 'star' || x.status === 'trial' ? el('button', { class: 'btn-sm', text: '⏸ Pause', onclick: function () { var r = prompt('Why paused (the person sees it):'); if (r !== null) call({ action: 'status', user: x.user_email, status: 'paused', note: r }); } }) : '',
          x.status !== 'removed' && x.status !== 'rejected' ? el('button', { class: 'btn-sm', text: '🗑 Remove', onclick: function () { var r = prompt('Why removed (the person sees it):'); if (r !== null && confirm('Remove ' + nm(x) + ' from Stars?')) call({ action: 'status', user: x.user_email, status: 'removed', note: r }); } }) : ''];
        return el('tr', {}, [el('td', { text: nm(x) }), el('td', { text: x.status + (x.trial_until && x.status === 'trial' ? ' (until ' + String(x.trial_until).slice(0, 10) + ')' : '') }),
          el('td', { text: x.month ? (m.hours + ' h / ' + m.days + ' d / ' + m.coins + ' diamonds') : '—' }), el('td', { text: String(x.warnings || 0) }), el('td', { text: x.note || '' }), el('td', {}, acts)]);
      })));
      // bonuses
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: '💵 Monthly bonuses (worked out at the start of each month — check, then pay into the wallet)' }));
      box.appendChild(table(['Name', 'Month', 'Hours / days / diamonds', 'Tier', 'Amount', 'Status', ''], (d.bonuses || []).map(function (b) {
        return el('tr', {}, [el('td', { text: nm(b) }), el('td', { text: b.month }), el('td', { text: b.hours + ' h / ' + b.days + ' d / ' + b.coins }), el('td', { text: b.tier ? '⭐' + b.tier + (b.half ? ' (half)' : '') : '—' }),
          el('td', { text: '$' + (Number(b.amount_cents || 0) / 100).toFixed(2) }), el('td', { text: b.status }),
          el('td', {}, su && b.status === 'pending' ? [el('button', { class: 'btn-sm btn-blue', text: 'Pay', onclick: function () { if (confirm('Pay $' + (b.amount_cents / 100).toFixed(2) + ' to ' + nm(b) + '?')) call({ action: 'bonus', id: b.id, pay: true }); } }), ' ',
            el('button', { class: 'btn-sm', text: 'Cancel', onclick: function () { if (confirm('Cancel this bonus?')) call({ action: 'bonus', id: b.id, pay: false }); } })] : [])]);
      })));
    }
    call();
  }

  // ---------- 🎯 Challenges: goals for a time with steps (tier 1, 2, 3…) and/or Top N places; rewards = coins / frame / VIP / XP / a note / money ----------
  var CH_METRIC = { gift_recv: '🎁 Gift diamonds received', gift_sent: '🎁 Gift diamonds sent', room_minutes: '⏱️ Minutes in rooms (seat or listening)', seat_minutes: '🎤 Minutes on a seat', xp: '⚡ XP gained', checkins: '📅 Check-in days', room_followers: '❤️ New room followers', video_views: '▶️ Video views (Monetize)', watch_minutes: '⏱️ Minutes people watched my videos (Monetize)', posts: '📝 Posts made', followers: '👥 New followers' };
  var CH_METRIC_KM = { gift_recv: 'ពេជ្រកាដូដែលបានទទួល', gift_sent: 'ពេជ្រកាដូដែលបានផ្ញើ', room_minutes: 'នាទីក្នុងបន្ទប់', seat_minutes: 'នាទីលើកៅអី', xp: 'XP ដែលបានទទួល', checkins: 'ថ្ងៃ Check-in', room_followers: 'អ្នកតាមដានបន្ទប់ថ្មី', video_views: 'ការមើលវីដេអូ', watch_minutes: 'នាទីដែលគេមើលវីដេអូរបស់ខ្ញុំ', posts: 'ការបង្ហោះ', followers: 'អ្នកតាមដានថ្មី' };
  var CH_UNIT = { gift_recv: 'diamonds · ពេជ្រ', gift_sent: 'diamonds · ពេជ្រ', room_minutes: 'min · នាទី', seat_minutes: 'min · នាទី', xp: 'XP', checkins: 'days · ថ្ងៃ', room_followers: 'people · នាក់', video_views: 'views · ដង', watch_minutes: 'min · នាទី', posts: 'posts · ដង', followers: 'people · នាក់' };
  // which counts fit which place (the lists only show these; 'both' shows all)
  var CH_AREA = { party: ['gift_recv', 'gift_sent', 'room_minutes', 'seat_minutes', 'xp', 'checkins', 'room_followers'], monetize: ['video_views', 'watch_minutes', 'posts', 'followers'] };
  function chFit(sel, area) { var ok = CH_AREA[area]; Array.prototype.forEach.call(sel.options, function (o) { var show = !ok || ok.indexOf(o.value) >= 0 || o.selected; o.hidden = !show; o.disabled = !show; }); }
  var CH_REWARD = { coins: '💎 Diamonds', money: '💵 Money ($, Admin approves)', frame: '🖼️ Frame', vip: '👑 VIP days', xp: '⚡ XP', note: '📝 Note only (e.g. a chance to become a Star)' };
  function challengesAdmin(body) {
    var box = el('div', { class: 'at-card' }); body.appendChild(box);
    var frames = [], COIN_MONEY = null, DAILY_OK = [];
    function call(extra) { return adm('/api/admin/challenges', extra || {}).then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); return x; }); }
    function local(d) { if (!d) return ''; var x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); }
    function rewardTxt(r) { r = r || {}; var n = Number(r.amount) || 0; return r.type === 'money' ? '$' + (n / 100).toFixed(2) : r.type === 'coins' ? n + ' diamonds' : r.type === 'vip' ? 'VIP ' + n + ' days' : r.type === 'xp' ? n + ' XP' : r.type === 'frame' ? 'Frame #' + r.frame_id + ' ' + (r.days || 7) + ' days' : (r.label || '—'); }
    function rewardEditor(r) {
      r = r || { type: 'coins', amount: 0 };
      var t = el('select', { class: 'at-in', style: 'width:150px;display:inline-block' }); Object.keys(CH_REWARD).forEach(function (k) { var o = el('option', { value: k, text: CH_REWARD[k] }); if (k === r.type) o.selected = true; t.appendChild(o); });
      var amt = el('input', { class: 'at-in', type: 'number', step: 'any', style: 'width:100px;display:inline-block', value: r.type === 'money' ? String((Number(r.amount) || 0) / 100) : String(r.amount || '') });
      var fr = el('select', { class: 'at-in', style: 'width:130px;display:inline-block' }); frames.forEach(function (f) { var o = el('option', { value: String(f.id), text: (f.emoji || '') + ' ' + f.name_en }); if (Number(r.frame_id) === f.id) o.selected = true; fr.appendChild(o); });
      var days = el('input', { class: 'at-in', type: 'number', style: 'width:70px;display:inline-block', placeholder: 'days', value: String(r.days || 7) });
      var lab = el('input', { class: 'at-in', style: 'width:220px;display:inline-block', placeholder: 'Note in Khmer (e.g. ឱកាសក្លាយជាតារា)', value: r.label || '' });
      var hint = el('span', { style: 'color:#65676b;font-size:12px' });
      function show() { var k = t.value; amt.style.display = (k === 'frame' || k === 'note') ? 'none' : 'inline-block'; fr.style.display = days.style.display = k === 'frame' ? 'inline-block' : 'none'; hint.textContent = k === 'money' ? '$' : k === 'vip' ? 'days' : k === 'coins' ? 'coins' : k === 'xp' ? 'XP' : ''; }
      t.addEventListener('change', show); show();
      var w = el('span', { style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' }, [t, amt, hint, fr, days, lab]);
      w.read = function () { var k = t.value, o = { type: k, amount: k === 'money' ? Math.round(Number(amt.value || 0) * 100) : Number(amt.value || 0) }; if (k === 'frame') { o.frame_id = Number(fr.value); o.days = Number(days.value || 7); } if (lab.value.trim()) o.label = lab.value.trim(); return o; };
      return w;
    }
    function form(c) {
      c = c || { icon: '🎯', area: 'party', metric: 'gift_recv', join_mode: 'join', max_people: 50, tiers: [{ conds: [{ metric: 'checkins', need: 14, mode: 'total' }, { metric: 'seat_minutes', need: 50, mode: 'total' }], rewards: [{ type: 'coins', amount: 100 }] }], ranks: [], status: 'live',
        starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 7 * 86400000).toISOString() };
      var f = el('div', { style: 'border:2px solid #7c3aed;border-radius:14px;padding:12px;margin:10px 0;background:#faf7ff' });
      function inp(v, w, ph, type) { return el('input', { class: 'at-in', value: v == null ? '' : String(v), placeholder: ph || '', type: type || 'text', style: 'width:' + (w || 220) + 'px;display:inline-block' }); }
      function sel(map, v) { var x = el('select', { class: 'at-in', style: 'width:auto;max-width:100%;display:inline-block' }); Object.keys(map).forEach(function (k) { var o = el('option', { value: k, text: map[k] }); if (k === v) o.selected = true; x.appendChild(o); }); return x; }
      // English + Khmer (blue, under it) for every label in this form
      function two(en, km, bold) { return el('span', { style: 'display:inline-block;' + (bold ? 'font-weight:700;' : '') }, [el('div', { text: en }), km ? el('div', { style: 'color:#1E4BFF;font-size:12.5px;font-weight:400', text: km }) : el('span')]); }
      function pair(en, km, input) { return el('span', { style: 'display:inline-flex;gap:6px;align-items:center;white-space:nowrap' }, [two(en, km), input]); }
      function row(label, kids, km) { return el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0' }, [el('span', { style: 'min-width:170px' }, [two(label, km, true)])].concat(kids)); }
      function head(en, km) { return el('div', { style: 'font-weight:800;margin:12px 0 2px' }, [el('div', { text: en }), el('div', { style: 'color:#1E4BFF;font-size:13px;font-weight:600', text: km })]); }
      var icon = inp(c.icon, 60), tk = inp(c.title_km, 320, 'ចំណងជើង (ខ្មែរ)'), te = inp(c.title_en, 320, 'Title (English)');
      var bk = el('textarea', { class: 'at-in', rows: '3', style: 'width:100%', placeholder: 'អ្វីដែលអ្នកចូលរួមទទួលបាន (ខ្មែរ) — ឧ. ឱកាសក្លាយជាតារា ឱកាសរកលុយពីវីដេអូ…' }); bk.value = c.body_km || '';
      var be = el('textarea', { class: 'at-in', rows: '2', style: 'width:100%', placeholder: 'What people get (English)' }); be.value = c.body_en || '';
      var area = sel({ party: '🎉 Party Room', monetize: '💰 Monetize', both: 'Both' }, c.area), metric = sel(CH_METRIC, c.metric);
      metric.classList.add('ch-metric'); chFit(metric, area.value);
      area.addEventListener('change', function () { f.querySelectorAll('select.ch-metric').forEach(function (s) { chFit(s, area.value); }); });   // only the counts that fit the place
      var st = inp(local(c.starts_at), 200, '', 'datetime-local'), en = inp(local(c.ends_at), 200, '', 'datetime-local');
      var jm = sel({ join: 'People press "Join" (places can be limited)', auto: 'Everybody is in automatically' }, c.join_mode), mp = inp(c.max_people, 90, '0 = no limit', 'number');
      var ml = inp(c.min_level, 70, '0', 'number'), md = inp(c.min_days, 70, '0', 'number'), so = inp(c.sort, 70, '0', 'number');
      var stt = sel({ live: '🟢 Live', draft: '📝 Draft (hidden)', paused: '⏸ Paused (hidden)' }, c.status === 'ended' ? 'live' : c.status);
      var notify = el('input', { type: 'checkbox' });
      var tiersBox = el('div'), ranksBox = el('div'), tiers = [], ranks = [];
      // 🪜 a step: conditions (each: what + how much, in all or every day) → rewards. Old steps (one number of the counted thing) open as one condition.
      function addTier(t) {
        t = t || {};
        var conds = Array.isArray(t.conds) ? t.conds : (t.need ? [{ metric: c.metric, need: t.need, mode: 'total' }] : [{ metric: 'checkins', need: 0, mode: 'total' }]);
        var rewards = Array.isArray(t.rewards) ? t.rewards : (t.reward ? [t.reward] : [{ type: 'coins', amount: 0 }]);
        var o = { conds: [], rewards: [] };
        var card = el('div', { style: 'background:#fff;border:1px solid #d8cdf5;border-radius:12px;padding:10px 12px;margin:8px 0' });
        var title = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' });
        var num = el('span'); title.appendChild(num);
        title.appendChild(el('button', { class: 'btn-sm btn-gray', text: '✕', title: 'Remove this step · លុបជំហាននេះ', onclick: function () { tiers.splice(tiers.indexOf(o), 1); card.remove(); renumber(); check(); } }));
        card.appendChild(title);
        var anySel = el('select', { class: 'at-in', style: 'width:auto;max-width:100%;display:inline-block' });
        [['all', 'Do ALL of these · ត្រូវធ្វើគ្រប់ចំណុច'], ['any', 'ONE of these is enough · ធ្វើបានមួយក៏បាន']].forEach(function (x) { var op = el('option', { value: x[0], text: x[1] }); if ((t.any === true) === (x[0] === 'any')) op.selected = true; anySel.appendChild(op); });
        anySel.addEventListener('change', check);
        card.appendChild(el('div', { style: 'margin:6px 0' }, [two('Conditions', 'លក្ខខណ្ឌ', true), anySel]));
        var condBox = el('div'); card.appendChild(condBox);
        function addCond(cd) {
          cd = cd || { metric: 'checkins', need: 0, mode: 'total' };
          var m = sel(CH_METRIC, cd.metric); Object.keys(CH_METRIC).forEach(function (k, i) { m.options[i].text = CH_METRIC[k] + ' · ' + CH_METRIC_KM[k]; });
          m.classList.add('ch-metric'); chFit(m, area.value);
          var daily = cd.mode === 'daily';
          var amt = inp(daily ? cd.per_day : (cd.need || ''), 90, '0', 'number'), unit = el('span', { style: 'color:#65676b;font-size:12.5px' });
          var mode = el('select', { class: 'at-in', style: 'width:auto;display:inline-block' });
          [['total', 'in all · សរុប'], ['daily', 'every day · រៀងរាល់ថ្ងៃ']].forEach(function (x) { var op = el('option', { value: x[0], text: x[1] }); if (x[0] === (daily ? 'daily' : 'total')) op.selected = true; mode.appendChild(op); });
          var days = inp(daily ? cd.need : '', 70, 'days', 'number'), dayTxt = el('span', { style: 'font-size:12.5px', text: '× days · ថ្ងៃ' });
          var line = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:5px 0;padding:6px 0;border-top:1px dashed #e4e6eb' });
          var co = { m: m, amt: amt, mode: mode, days: days };
          function show() {
            var canDaily = (DAILY_OK || []).indexOf(m.value) >= 0;
            if (!canDaily) mode.value = 'total';
            mode.style.display = canDaily ? 'inline-block' : 'none';
            var d = mode.value === 'daily';
            days.style.display = dayTxt.style.display = d ? 'inline-block' : 'none';
            unit.textContent = CH_UNIT[m.value] + (d ? ' per day · ក្នុងមួយថ្ងៃ' : '');
            check();
          }
          m.addEventListener('change', show); mode.addEventListener('change', show); amt.addEventListener('input', check); days.addEventListener('input', check);
          var no = el('b', { text: (o.conds.length + 1) + '.' });
          [no, m, amt, unit, mode, days, dayTxt, el('button', { class: 'btn-sm btn-gray', text: '✕', onclick: function () { o.conds.splice(o.conds.indexOf(co), 1); line.remove(); o.conds.forEach(function (x, i) { x.no.textContent = (i + 1) + '.'; }); check(); } })].forEach(function (k) { line.appendChild(k); });
          co.no = no; co.read = function () { var d = mode.value === 'daily'; return d ? { metric: m.value, mode: 'daily', per_day: Number(amt.value || 0), need: Number(days.value || 0) } : { metric: m.value, mode: 'total', need: Number(amt.value || 0) }; };
          o.conds.push(co); condBox.appendChild(line); show();
        }
        conds.forEach(addCond);
        card.appendChild(el('button', { class: 'btn-sm', text: '+ Condition · បន្ថែមលក្ខខណ្ឌ', onclick: function () { addCond(); } }));
        card.appendChild(el('div', { style: 'margin:10px 0 4px' }, [two('Rewards (all of them are given)', 'រង្វាន់ (ផ្ដល់ទាំងអស់)', true)]));
        var rwBox = el('div'); card.appendChild(rwBox);
        function addRw(r) {
          var rw = rewardEditor(r), line = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0' });
          line.appendChild(el('span', { text: '🎁' })); line.appendChild(rw);
          line.appendChild(el('button', { class: 'btn-sm btn-gray', text: '✕', onclick: function () { o.rewards.splice(o.rewards.indexOf(rw), 1); line.remove(); check(); } }));
          line.addEventListener('input', check); line.addEventListener('change', check);
          o.rewards.push(rw); rwBox.appendChild(line);
        }
        rewards.forEach(addRw);
        card.appendChild(el('button', { class: 'btn-sm', text: '+ Reward · បន្ថែមរង្វាន់', onclick: function () { addRw({ type: 'frame' }); check(); } }));
        var warn = el('div', { style: 'margin-top:8px;font-size:13px;font-weight:700' }); card.appendChild(warn);
        o.card = card; o.num = num; o.warn = warn; o.anySel = anySel;
        o.read = function () { return { conds: o.conds.map(function (x) { return x.read(); }).filter(function (x) { return x.need > 0 && (x.mode !== 'daily' || x.per_day > 0); }), rewards: o.rewards.map(function (r) { return r.read(); }), any: anySel.value === 'any' }; };
        tiers.push(o); tiersBox.appendChild(card); renumber(); check();
      }
      function renumber() { tiers.forEach(function (x, i) { x.num.textContent = ''; x.num.appendChild(two('🪜 Step ' + (i + 1), 'ជំហាន ' + (i + 1), true)); }); }
      // 🛡️ live check: a step with gift coins must give back less than what CamFeed keeps from those coins (the server checks it again)
      function check() {
        var cm = COIN_MONEY; var bad = false;
        tiers.forEach(function (x, i) {
          if (!x.warn) return;
          var st = x.read(), gift = st.conds.filter(function (q) { return q.metric === 'gift_sent' || q.metric === 'gift_recv'; }).map(function (q) { return q.mode === 'daily' ? q.need * q.per_day : q.need; });
          var value = st.rewards.reduce(function (a, r) { return a + (r.type === 'money' ? r.amount : r.type === 'coins' ? r.amount * ((cm && cm.centsPerCoin) || 1) : 0); }, 0);
          x.warn.textContent = ''; x.warn.style.color = '';
          if (!gift.length || !cm || !value) return;
          var keep = cm.centsPerCoin - (cm.coinCents || 1) * cm.share / 100, coinsN = st.any ? Math.min.apply(null, gift) : Math.max.apply(null, gift);
          if (keep <= 0 || value >= coinsN * keep) {
            bad = true; x.warn.style.color = '#e41e3f';
            x.warn.textContent = '⛔ CamFeed would lose money · CamFeed នឹងខាត — reward $' + (value / 100).toFixed(2) + (keep > 0 ? ', ask for more than ' + Math.ceil(value / keep) + ' diamonds · សូមដាក់លើស ' + Math.ceil(value / keep) + ' ពេជ្រ' : '') + ', or give a frame / VIP / XP · ឬផ្ដល់ស៊ុម VIP XP';
          } else { x.warn.style.color = '#16a34a'; x.warn.textContent = '✅ Safe · មានសុវត្ថិភាព (CamFeed keeps $' + (coinsN * keep / 100 - value / 100).toFixed(2) + ' or more)'; }
        });
        if (saveBtn) { saveBtn.disabled = bad; saveBtn.style.opacity = bad ? '0.5' : ''; }
        if (costBox) {
          var mx = Number(mp.value) || 0, money = 0, coinsOut = 0;
          tiers.forEach(function (x) { x.read().rewards.forEach(function (r) { if (r.type === 'money') money += r.amount; if (r.type === 'coins') coinsOut += r.amount; }); });
          costBox.textContent = (money || coinsOut) ? ('💰 Most CamFeed can give for the steps · ចំណាយច្រើនបំផុតសម្រាប់ជំហាន៖ ' + (money ? '$' + (money / 100).toFixed(2) : '') + (money && coinsOut ? ' + ' : '') + (coinsOut ? coinsOut.toLocaleString() + ' diamonds' : '') + (mx ? ' × ' + mx + ' people · នាក់ = ' + (money ? '$' + (money * mx / 100).toFixed(2) : '') + (money && coinsOut ? ' + ' : '') + (coinsOut ? (coinsOut * mx).toLocaleString() + ' diamonds' : '') : ' per person · ក្នុងម្នាក់ (no limit of people · គ្មានកំណត់ចំនួនមនុស្ស)')) : '';
        }
      }
      var saveBtn = null, costBox = el('div', { style: 'margin:8px 0;padding:8px 10px;background:#fff7ed;border-radius:8px;font-size:13px;font-weight:700' });
      function addRank(r) { r = r || {}; var fr = inp(r.from || (ranks.length + 1), 60, 'from', 'number'), to = inp(r.to || r.from || (ranks.length + 1), 60, 'to', 'number'), rw = rewardEditor(r.reward), line = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0' }); var o = { fr: fr, to: to, rw: rw };
        line.appendChild(two('Place', 'លេខរៀង', true)); line.appendChild(fr); line.appendChild(two('to', 'ដល់')); line.appendChild(to); line.appendChild(el('span', { text: '→' })); line.appendChild(rw);
        line.appendChild(el('button', { class: 'btn-sm btn-gray', text: '✕', onclick: function () { ranks.splice(ranks.indexOf(o), 1); line.remove(); } })); ranks.push(o); ranksBox.appendChild(line); }
      (c.tiers && c.tiers.length ? c.tiers : [{}]).forEach(addTier); (c.ranks || []).forEach(addRank); mp.addEventListener('input', function () { check(); });
      f.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:6px', text: c.id ? '✏️ Edit challenge #' + c.id : '➕ New challenge' }));
      f.appendChild(row('Icon + title', [icon, tk, te], 'រូប និងចំណងជើង'));
      f.appendChild(head('What people get (shown to them)', 'អ្វីដែលអ្នកចូលរួមទទួលបាន (បង្ហាញឲ្យគេឃើញ)')); f.appendChild(bk); f.appendChild(be);
      f.appendChild(row('Shown in', [area], 'បង្ហាញនៅ'));
      f.appendChild(row('Start → end', [st, el('span', { text: '→' }), en], 'ចាប់ផ្ដើម ដល់ បញ្ចប់'));
      f.appendChild(row('Who takes part', [jm, pair('places', 'ចំនួនកន្លែង', mp)], 'អ្នកណាចូលរួម'));
      // ✉️ only the people CamFeed invites (they press "Join"); who can see it
      var io = el('input', { type: 'checkbox' }); io.checked = !!c.invite_only;
      var iv = sel({ invited: '🔒 Only the invited people see it · មើលឃើញតែអ្នកត្រូវបានអញ្ជើញ', all: '👀 Everybody sees it, only the invited join · គ្រប់គ្នាមើលឃើញ តែចូលរួមបានតែអ្នកត្រូវបានអញ្ជើញ' }, c.invite_view || 'invited');
      var ivRow = row('Who can see it', [iv], 'អ្នកណាមើលឃើញ');
      var fitIo = function () { ivRow.style.display = io.checked ? '' : 'none'; if (io.checked) { jm.value = 'join'; jm.disabled = true; } else jm.disabled = false; };
      io.addEventListener('change', fitIo);
      f.appendChild(row('Invite only', [el('label', { style: 'display:flex;gap:6px;align-items:center' }, [io, el('span', { text: '✉️ Only for the people CamFeed invites · សម្រាប់តែអ្នកដែល CamFeed អញ្ជើញ' })])], 'អញ្ជើញប៉ុណ្ណោះ'));
      f.appendChild(ivRow); fitIo();
      if (c.id) f.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin:0 0 6px', text: 'Invite people with "✉️ Invited" in the list below, or in Users › Manage › 🏆. · អញ្ជើញមនុស្សតាមប៊ូតុង «✉️ Invited» ក្នុងបញ្ជីខាងក្រោម ឬ អ្នកប្រើ › Manage › 🏆។' }));
      f.appendChild(row('Needs (0 = none)', [pair('level Lv ≥', 'កម្រិតយ៉ាងហោចណាស់', ml), pair('account age (days) ≥', 'អាយុគណនី (ថ្ងៃ) យ៉ាងហោចណាស់', md)], 'លក្ខខណ្ឌ (0 = គ្មាន)'));
      f.appendChild(head('🪜 Steps — do the conditions → get the rewards (everybody who does them)', 'ជំហាន៖ ធ្វើតាមលក្ខខណ្ឌ ទទួលបានរង្វាន់ (គ្រប់គ្នាដែលធ្វើបាន)')); f.appendChild(tiersBox);
      f.appendChild(el('button', { class: 'btn-sm', text: '+ Step · បន្ថែមជំហាន', onclick: function () { addTier(); } }));
      f.appendChild(costBox);
      f.appendChild(head('🏆 Top places — given when the challenge ends', 'លេខរៀងកំពូល៖ ផ្ដល់ឲ្យពេលបញ្ចប់')); 
      f.appendChild(row('Places counted by', [metric], 'លេខរៀងរាប់តាម'));
      f.appendChild(ranksBox);
      f.appendChild(el('button', { class: 'btn-sm', text: '+ Place', onclick: function () { addRank(); } }));
      f.appendChild(row('Status / order', [stt, pair('order', 'លំដាប់', so)], 'ស្ថានភាព'));
      if (!c.id) f.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;margin:6px 0' }, [notify, el('span', { text: '🔔 Tell everybody active in the last 30 days (a notification)' })]));
      f.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin:6px 0', text: 'Joining is always free. Diamonds, frames, VIP and XP are given at once; money waits here for a Super Admin to pay. Gifts between the same person\'s accounts should be checked before paying money.' }));
      f.appendChild(el('div', { style: 'color:#1E4BFF;font-size:12.5px;margin:0 0 6px', text: 'ការចូលរួមឥតគិតថ្លៃជានិច្ច។ ពេជ្រ ស៊ុម VIP និង XP ផ្ដល់ឲ្យភ្លាមៗ។ ប្រាក់ត្រូវរង់ចាំ Super Admin បង់។ មុនបង់ប្រាក់ សូមពិនិត្យកាដូរវាងគណនីរបស់មនុស្សតែម្នាក់។' }));
      f.appendChild(el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
        saveBtn = el('button', { class: 'btn-sm btn-blue', text: c.id ? '💾 Save' : '✅ Create', onclick: function () {
          var data = { id: c.id, icon: icon.value, title_km: tk.value, title_en: te.value, body_km: bk.value, body_en: be.value, area: area.value, metric: metric.value,
            starts_at: new Date(st.value).toISOString(), ends_at: new Date(en.value).toISOString(), join_mode: io.checked ? 'join' : jm.value, max_people: mp.value, min_level: ml.value, min_days: md.value, status: stt.value, sort: so.value,
            invite_only: io.checked, invite_view: iv.value,
            tiers: tiers.map(function (t) { return t.read(); }).filter(function (t) { return t.conds.length; }), ranks: ranks.map(function (r) { return { from: Number(r.fr.value), to: Number(r.to.value), reward: r.rw.read() }; }) };
          if (!st.value || !en.value) return alert('Choose the start and end time.');
          call({ action: 'save', challenge: data, notify: notify.checked });
        } }),
        el('button', { class: 'btn-sm btn-gray', text: 'Cancel', onclick: function () { f.remove(); } })]));
      return f;
    }
    // ✉️ who is invited to one challenge: search a person and add, or remove
    function chInvites(c, pb, su) {
      pb.textContent = '';
      var wrap = el('div', { style: 'border:2px solid #1877f2;border-radius:14px;padding:12px;margin:12px 0' }); pb.appendChild(wrap);
      wrap.appendChild(el('div', { style: 'font-weight:800', text: '✉️ ' + c.icon + ' ' + c.title_km + AT(' — អ្នកត្រូវបានអញ្ជើញ', ' — invited people') }));
      var out = el('div', { style: 'margin:6px 0;font-size:13px' }); wrap.appendChild(out);
      if (su) {
        var q = el('input', { class: 'at-in', placeholder: AT('ស្វែងរកឈ្មោះ អ៊ីមែល ឬលេខទូរស័ព្ទ…', 'Search name, email or phone…'), style: 'max-width:300px;display:inline-block' });
        var found = el('div');
        var go = function () {
          adm('/api/admin/users/search', { query: q.value, role: '', status: '', offset: 0, limit: 10 }).then(function (d) {
            found.textContent = ''; if (!d.success) return;
            (d.users || []).forEach(function (u) {
              found.appendChild(el('div', { class: 'at-row', style: 'gap:8px;align-items:center;margin-top:6px' }, [el('span', { style: 'flex:1', text: nm(u) + ' · ' + (u.email || '') }),
                el('button', { class: 'btn-sm btn-blue', text: AT('✉️ អញ្ជើញ', '✉️ Invite'), onclick: function () { adm('/api/admin/challenges', { action: 'invite', id: c.id, targetEmail: u.email }).then(function (r) { msg(out, r.success, r.success ? (r.already ? AT('ℹ️ បានអញ្ជើញរួចហើយ', 'ℹ️ Already invited') : AT('✅ បានអញ្ជើញ ', '✅ Invited ') + nm(u)) : '❌ ' + (r.error || 'Failed')); list(); }); } })]));
            });
          });
        };
        q.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        wrap.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:6px' }, [q, el('button', { class: 'btn-sm', text: AT('🔍 ស្វែងរក', '🔍 Search'), onclick: go })]));
        wrap.appendChild(found);
      }
      var lb = el('div', { style: 'margin-top:10px' }); wrap.appendChild(lb);
      function list() {
        adm('/api/admin/challenges', { action: 'invites', id: c.id }).then(function (r) {
          lb.textContent = ''; if (!r.success) return;
          lb.appendChild(el('div', { style: 'font-weight:700;margin-bottom:4px', text: AT('បានអញ្ជើញ៖ ', 'Invited: ') + r.invites.length + ' · ' + AT('បានចូលរួម៖ ', 'Joined: ') + r.invites.filter(function (x) { return x.joined; }).length }));
          r.invites.forEach(function (x) {
            lb.appendChild(el('div', { class: 'at-row', style: 'gap:8px;align-items:center;margin-top:4px' }, [el('span', { style: 'flex:1', text: (x.joined ? '✅ ' : '⏳ ') + nm(x) + ' · ' + x.user_email }),
              su ? el('button', { class: 'btn-sm btn-gray', text: AT('ដកចេញ', 'Remove'), onclick: function () { if (confirm(AT('ដក ', 'Remove ') + nm(x) + '?')) adm('/api/admin/challenges', { action: 'uninvite', id: c.id, targetEmail: x.user_email }).then(list); } }) : el('span')]));
          });
        });
      }
      list();
      pb.scrollIntoView({ behavior: 'smooth' });
    }
    function draw(d) {
      box.textContent = ''; frames = d.frames || []; COIN_MONEY = d.coinMoney || null; DAILY_OK = d.daily || [];
      var su = d.isSuperAdmin;
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '🎯 Challenges' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'The 🎯 Challenge button in the app (Party Room top right) and the Monetize page show the live ones. Everything here can change at any time without an app update.' }));
      var formBox = el('div'); box.appendChild(formBox);
      if (su) box.appendChild(el('button', { class: 'btn-sm btn-blue', text: '➕ New challenge', onclick: function () { formBox.textContent = ''; formBox.appendChild(form()); } }));
      var peopleBox = el('div');
      box.appendChild(table(['', 'Challenge', 'Counts', 'When', 'Who', 'Joined', 'Rewards', 'Status', ''], (d.challenges || []).map(function (c) {
        return el('tr', {}, [el('td', { text: c.icon }), el('td', { text: c.title_km + (c.title_en ? ' · ' + c.title_en : '') + ' (' + c.area + ')' }), el('td', { text: (Array.isArray(c.tiers) && c.tiers.some(function (t) { return Array.isArray(t.conds); })) ? c.tiers.map(function (t, i) { return (i + 1) + ') ' + (t.conds || []).map(function (q) { return (CH_METRIC[q.metric] || q.metric) + ' ' + (q.mode === 'daily' ? q.per_day + '/day × ' + q.need : q.need); }).join(t.any ? ' OR ' : ' + '); }).join(' · ') : (CH_METRIC[c.metric] || c.metric) }),
          el('td', { text: new Date(c.starts_at).toLocaleString() + ' → ' + new Date(c.ends_at).toLocaleString() }), el('td', { text: (c.invite_only ? (c.invite_view === 'all' ? '✉️ Invited (all see) · ' : '✉️ Invited (hidden) · ') : '') + (c.join_mode === 'join' ? 'Join' + (c.max_people ? ' (max ' + c.max_people + ')' : '') : 'Everybody') }),
          el('td', { text: c.join_mode === 'join' ? String(c.joined) : '—' }), el('td', { text: String(c.rewards) }), el('td', { text: c.status }),
          el('td', {}, [
            el('button', { class: 'btn-sm', text: '👥 People', onclick: function () { adm('/api/admin/challenges', { action: 'people', id: c.id }).then(function (r) {
              peopleBox.textContent = ''; if (!r.success) return;
              peopleBox.appendChild(el('div', { style: 'font-weight:800;margin:12px 0 4px', text: '👥 ' + c.title_km + ' — numbers now' }));
              peopleBox.appendChild(table(['#', 'Person', 'Number'], r.people.map(function (p) { return el('tr', {}, [el('td', { text: String(p.place) }), el('td', { text: nm(p) + ' · ' + p.user_email }), el('td', { text: String(p.value) })]); })));
              peopleBox.scrollIntoView({ behavior: 'smooth' }); }); } }),
            c.invite_only ? el('button', { class: 'btn-sm', text: '✉️ Invited', onclick: function () { chInvites(c, peopleBox, su); } }) : '',
            su ? el('button', { class: 'btn-sm', text: '✏️ Edit', onclick: function () { formBox.textContent = ''; formBox.appendChild(form(c)); formBox.scrollIntoView({ behavior: 'smooth' }); } }) : '',
            su && c.status === 'live' ? el('button', { class: 'btn-sm', text: '⏸ Pause', onclick: function () { call({ action: 'status', id: c.id, status: 'paused' }); } }) : '',
            su && (c.status === 'paused' || c.status === 'draft') ? el('button', { class: 'btn-sm btn-blue', text: '▶ Live', onclick: function () { call({ action: 'status', id: c.id, status: 'live' }); } }) : '',
            su && c.status === 'live' ? el('button', { class: 'btn-sm btn-red', text: '⏹ End now', onclick: function () { if (confirm('End "' + c.title_km + '" now and give the Top places?')) call({ action: 'status', id: c.id, status: 'end' }); } }) : '',
            su && !Number(c.rewards) ? el('button', { class: 'btn-sm btn-gray', text: '🗑', onclick: function () { if (confirm('Delete this challenge?')) call({ action: 'status', id: c.id, status: 'delete' }); } }) : ''])]);
      })));
      box.appendChild(peopleBox);
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: '💵 Rewards (money waits here; others were given at once)' }));
      box.appendChild(table(['Person', 'Challenge', 'For', 'Number', 'Reward', 'Status', ''], (d.rewards || []).map(function (r) {
        return el('tr', {}, [el('td', { text: nm(r) + ' · ' + r.user_email }), el('td', { text: r.title_km }), el('td', { text: r.kind === 'rank' ? 'Place ' + r.level : 'Step ' + (((r.level - 1) % 100) + 1) }), el('td', { text: String(r.value) }),
          el('td', { text: rewardTxt(r.reward) }), el('td', { text: r.status }),
          el('td', {}, su && r.status === 'pending' ? [el('button', { class: 'btn-sm btn-blue', text: 'Pay', onclick: function () { if (confirm('Pay ' + rewardTxt(r.reward) + ' to ' + nm(r) + '?')) call({ action: 'pay', id: r.id, pay: true }); } }), ' ',
            el('button', { class: 'btn-sm', text: 'Cancel', onclick: function () { if (confirm('Cancel this reward?')) call({ action: 'pay', id: r.id, pay: false }); } })] : [])]);
      })));
    }
    call();
  }

  function coinsAdmin(body) {
    var box = el('div', { style: 'max-width:900px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px 16px;margin-bottom:16px' }, [empty('Loading…')]);
    body.appendChild(box);
    function call(extra) { return adm('/api/admin/coins', extra || {}).then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); return x; }); }
    function draw(d) {
      box.textContent = '';
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '💎 Diamonds & 🎁 gifts (Party Room)' }));
      if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      var tt = d.totals || {};
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: '1 diamond = $0.01. Sold on the website so far: $' + Number(tt.sold_usd || 0).toFixed(2) + ' · diamonds spent on gifts: ' + Number(tt.gift_coins || 0).toLocaleString() + ' · paid to receivers: $' + (Number(tt.receiver_cents || 0) / 100).toFixed(2) + '. People buy on camfeedkh.com/coins.html.' }));
      var su = !!d.isSuperAdmin;
      // top-ups waiting
      box.appendChild(el('div', { style: 'font-weight:800;margin:10px 0 6px', text: 'Top-ups waiting (' + d.pending.length + ')' }));
      if (!d.pending.length) box.appendChild(empty('Nothing waiting.'));
      else box.appendChild(table(['Person', 'Pack', 'Paid with', 'Transaction', 'Receipt', 'Sent', ''], d.pending.map(function (x) {
        return el('tr', {}, [el('td', { text: nm(x) + ' · ' + x.user_email }), el('td', { text: '$' + Number(x.usd).toFixed(2) + ' → ' + x.coins + ' diamonds' }), el('td', { text: x.method }), el('td', { text: x.payer_ref || '—' }),
          el('td', {}, [x.receipt_url ? el('a', { href: x.receipt_url, target: '_blank', text: '🖼️ Open' }) : el('span', { text: '—' })]), el('td', { text: ago(x.created_at) }),
          el('td', {}, su ? [
            el('button', { class: 'btn-sm btn-blue', text: 'Approve', onclick: function () { if (confirm('Add ' + x.coins + ' diamonds to ' + nm(x) + '? Check that the money arrived first.')) call({ action: 'decide', id: x.id, status: 'approved' }); } }), ' ',
            el('button', { class: 'btn-sm btn-red', text: 'Reject', onclick: function () { var why = prompt('Reason (the person sees it):', ''); if (why) call({ action: 'decide', id: x.id, status: 'rejected', note: why }); } })
          ] : [el('span', { text: 'Super Admin' })])]);
      })));
      // settings
      var s = d.settings;
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: 'Packs, share and payment details' }));
      var rows = el('div');
      function packRow(p) {
        var u = el('input', { class: 'at-in', type: 'number', step: '0.01', value: String(p.usd), style: 'width:90px;display:inline-block' });
        var w = el('input', { class: 'at-in', type: 'number', value: String(p.web), style: 'width:110px;display:inline-block' });
        var a = el('input', { class: 'at-in', type: 'number', value: String(p.app || 0), style: 'width:110px;display:inline-block' });
        var r = el('div', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0' }, [el('span', { text: '$' }), u, el('span', { text: 'website diamonds' }), w, el('span', { text: 'in-app diamonds (later)' }), a,
          el('button', { class: 'btn-sm btn-gray', text: '✕', onclick: function () { r.remove(); } })]);
        r._get = function () { return { usd: u.value, web: w.value, app: a.value }; };
        rows.appendChild(r);
      }
      s.packs.forEach(packRow);
      box.appendChild(rows);
      if (su) box.appendChild(el('button', { class: 'btn-sm btn-gray', text: '+ Add pack', onclick: function () { packRow({ usd: 1, web: 100, app: 100 }); } }));
      var share = el('input', { class: 'at-in', type: 'number', value: String(s.share) }), hold = el('input', { class: 'at-in', type: 'number', value: String(s.holdDays) });
      var pay = el('textarea', { class: 'at-in', rows: '5', style: 'width:100%' }); pay.value = s.payinfo || '';
      var wOn = el('input', { type: 'checkbox' }); wOn.checked = s.walletOn !== false; if (!su) wOn.disabled = true;
      box.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;margin:10px 0;font-weight:700' }, [wOn, el('span', { text: '💰 People can change wallet money into diamonds (same diamonds as the website packs, at once)' })]));
      box.appendChild(el('div', { class: 'at-lbl', text: 'Receiver gets … % of a gift\'s value (start 50)' })); box.appendChild(share);
      box.appendChild(el('div', { class: 'at-lbl', text: 'Gift money can be withdrawn after … days' })); box.appendChild(hold);
      box.appendChild(el('div', { class: 'at-lbl', text: 'Payment details shown on the website (ABA / ACLEDA / Wing account name and number, KHQR …)' })); box.appendChild(pay);
      if (!su) [share, hold, pay].forEach(function (i) { i.disabled = true; });
      if (su) box.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:10px', text: 'Save', onclick: function () {
        var packs = Array.prototype.map.call(rows.children, function (r) { return r._get(); });
        call({ action: 'settings', packs: packs, share: share.value, hold: hold.value, payinfo: pay.value, walletOn: wOn.checked }).then(function (x) { if (x.success) alert('✅ Saved'); });
      } }));
      // gifts
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: 'Gifts (' + d.gifts.length + ')' }));
      function giftRow(g) {
        var e = el('input', { class: 'at-in', value: g.emoji || '', style: 'width:60px' }), km = el('input', { class: 'at-in', value: g.name_km || '' }), en = el('input', { class: 'at-in', value: g.name_en || '' });
        var c = el('input', { class: 'at-in', type: 'number', value: String(g.coins || ''), style: 'width:100px' }), ti = el('select', { class: 'at-in', style: 'width:90px' });
        [1, 2, 3, 4].forEach(function (n) { var o = el('option', { value: String(n), text: ['', 'Small', 'Medium', 'Big', 'Top'][n] }); if (n === (g.tier || 1)) o.selected = true; ti.appendChild(o); });
        var on = el('input', { type: 'checkbox' }); on.checked = g.active !== false;
        if (!su) [e, km, en, c, ti, on].forEach(function (i) { i.disabled = true; });
        return el('tr', {}, [el('td', {}, [e]), el('td', {}, [km]), el('td', {}, [en]), el('td', {}, [c]), el('td', {}, [ti]), el('td', {}, [on]),
          el('td', {}, su ? [el('button', { class: 'btn-sm btn-blue', text: g.id ? 'Save' : 'Add', onclick: function () {
            call({ action: 'gift', gift: { id: g.id, emoji: e.value, name_km: km.value, name_en: en.value, coins: c.value, tier: ti.value, active: on.checked } });
          } })] : [])]);
      }
      var list = d.gifts.map(giftRow); if (su) list.push(giftRow({}));
      box.appendChild(table(['Picture', 'Khmer name', 'English name', 'Coins', 'Size', 'On', ''], list));
      // 🖼️ Party Room picture frames (our own designs: 2–4 colours + one emoji, the app draws them)
      var frames = d.frames || [];
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 2px', text: '🖼️ Party Room frames (' + frames.length + ')' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:6px', text: 'People buy a frame with diamonds for some days; it shows around their picture on the seats, in the room chat and the room list. Colours: #RRGGBB, comma between (2–4). Move: none / pulse / spin.' }));
      function frameRow(g) {
        var km = el('input', { class: 'at-in', value: g.name_km || '' }), en = el('input', { class: 'at-in', value: g.name_en || '' });
        var co = el('input', { class: 'at-in', value: g.colors || '', style: 'width:150px', placeholder: '#FDE047,#B45309' }), em = el('input', { class: 'at-in', value: g.emoji || '', style: 'width:55px' });
        var an = el('select', { class: 'at-in', style: 'width:80px' });
        ['none', 'pulse', 'spin'].forEach(function (n) { var o = el('option', { value: n, text: n }); if (n === (g.anim || 'none')) o.selected = true; an.appendChild(o); });
        var c = el('input', { class: 'at-in', type: 'number', value: String(g.coins || ''), style: 'width:90px' }), dy = el('input', { class: 'at-in', type: 'number', value: String(g.days || 7), style: 'width:60px' });
        var on = el('input', { type: 'checkbox' }); on.checked = g.active !== false;
        var cols = String(g.colors || '').split(',');
        var look = el('div', { style: 'width:34px;height:34px;border-radius:50%;padding:3px;background:linear-gradient(135deg,' + (cols.length > 1 ? cols.join(',') : '#ccc,#999') + ')' }, [el('div', { style: 'width:100%;height:100%;border-radius:50%;background:#fff' })]);
        if (!su) [km, en, co, em, an, c, dy, on].forEach(function (i) { i.disabled = true; });
        return el('tr', {}, [el('td', {}, [look]), el('td', {}, [km]), el('td', {}, [en]), el('td', {}, [co]), el('td', {}, [em]), el('td', {}, [an]), el('td', {}, [c]), el('td', {}, [dy]), el('td', {}, [on]),
          el('td', { text: g.id ? String(g.owners || 0) : '' }),
          el('td', {}, su ? [el('button', { class: 'btn-sm btn-blue', text: g.id ? 'Save' : 'Add', onclick: function () {
            call({ action: 'frame', frame: { id: g.id, name_km: km.value, name_en: en.value, colors: co.value, emoji: em.value, anim: an.value, coins: c.value, days: dy.value, active: on.checked } });
          } })] : [])]);
      }
      var flist = frames.map(frameRow); if (su) flist.push(frameRow({}));
      box.appendChild(table(['Look', 'Khmer name', 'English name', 'Colours', 'Emoji', 'Move', 'Coins', 'Days', 'On', 'Wearing now', ''], flist));
      // 👑 VIP + levels
      var st = d.settings || {};
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 2px', text: '👑 VIP & levels (VIP now: ' + (d.vipNow || 0) + ')' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:6px', text: 'Level = XP (like Bigo). XP comes from: diamonds spent (gifts, frames, VIP), gift diamonds received, minutes in rooms (a seat gives more, up to a daily limit) and the daily check-in; VIP gets extra XP for time and check-in. Write the XP where each level starts, comma between, first is 0 (Level 1). VIP: N days bought with coins: 👑 badge, golden name, a big "VIP came in" banner, first in the ✋ list, a helper can not send them out.' }));
      var lv = el('input', { class: 'at-in', value: (st.levels || []).join(','), style: 'width:100%' });
      var xr = st.xp || {}, pk = st.perks || {};
      function xin(v) { var i = el('input', { class: 'at-in', type: 'number', value: String(v == null ? '' : v), style: 'width:80px' }); if (!su) i.disabled = true; return i; }
      var xSpend = xin(xr.spend), xRecv = xin(xr.receive), xListen = xin(xr.listen), xSeat = xin(xr.seat), xMax = xin(xr.roomMax), xCk = xin(xr.checkin), xVip = xin(xr.vipBonus), pName = xin(pk.nameColor), pEntry = xin(pk.entry);
      function xrow(label, i) { return el('div', { style: 'display:flex;gap:8px;align-items:center;margin:3px 0' }, [el('span', { style: 'min-width:330px', text: label }), i]); }
      box.appendChild(el('div', { style: 'font-weight:700;margin:8px 0 4px', text: 'How much XP' }));
      box.appendChild(xrow('XP for 1 diamond spent', xSpend));
      box.appendChild(xrow('XP for 1 gift diamond received', xRecv));
      box.appendChild(xrow('XP per minute listening in a room', xListen));
      box.appendChild(xrow('XP per minute on a seat', xSeat));
      box.appendChild(xrow('Most XP from rooms in one day', xMax));
      box.appendChild(xrow('XP for the daily check-in', xCk));
      box.appendChild(xrow('VIP extra XP for time + check-in (%)', xVip));
      box.appendChild(el('div', { style: 'font-weight:700;margin:8px 0 4px', text: 'Level perks (from which level; 0 = off)' }));
      box.appendChild(xrow('Coloured name in rooms (level colour)', pName));
      box.appendChild(xrow('"Lv.N came in" banner when joining a room', pEntry));
      var vp = el('input', { class: 'at-in', type: 'number', value: String(st.vipPrice || 3000), style: 'width:110px' }), vd = el('input', { class: 'at-in', type: 'number', value: String(st.vipDays || 30), style: 'width:80px' });
      var vo = el('input', { type: 'checkbox' }); vo.checked = st.vipOn !== false;
      if (!su) [lv, vp, vd, vo].forEach(function (i) { i.disabled = true; });
      box.appendChild(el('div', { class: 'at-lbl', text: 'Levels (XP where each level starts — ' + (st.levels || []).length + ' levels)' })); box.appendChild(lv);
      box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap' }, [el('label', { style: 'display:flex;gap:6px;align-items:center;font-weight:700' }, [vo, el('span', { text: 'VIP open' })]),
        el('span', { text: 'VIP price (diamonds)' }), vp, el('span', { text: 'days' }), vd,
        su ? el('button', { class: 'btn-sm btn-blue', text: 'Save VIP & levels', onclick: function () { call({ action: 'vip', levels: lv.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean), vipPrice: vp.value, vipDays: vd.value, vipOn: vo.checked,
          xp: { spend: xSpend.value, receive: xRecv.value, listen: xListen.value, seat: xSeat.value, roomMax: xMax.value, checkin: xCk.value, vipBonus: xVip.value }, perks: { nameColor: pName.value, entry: pEntry.value } }); } }) : '']));
      // 📅 daily check-in
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 2px', text: '📅 Daily check-in (today: ' + (d.checkinToday || 0) + ' people · diamonds given in 30 days: ' + Number(d.checkinCoins30 || 0).toLocaleString() + ')' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:6px', text: 'Once a day people open a 🎁 gift box (+ the check-in XP set in VIP & levels). Diamonds go round between people: only N winners a day get diamonds (picked by chance through the whole day), a winner waits some days before winning again, everybody else finds the box empty. Prize of a winner: coins:weight, e.g. 1:3,2:2 = 1 diamond (3 of 5) or 2 diamonds (2 of 5). Careful: diamonds can be gifted, and gifts turn into real money for the receiver — keep them small.' }));
      var deckNow = st.checkinDeck || [{ coins: 0, times: 2 }, { coins: 1, times: 3 }, { coins: 2, times: 2 }];
      var ckv = el('input', { class: 'at-in', value: deckNow.map(function (x) { return x.coins + ':' + x.times; }).join(','), style: 'width:260px' });
      var ckW = el('input', { class: 'at-in', type: 'number', value: String(st.checkinWinners == null ? 20 : st.checkinWinners), style: 'width:90px' });
      var ckC = el('input', { class: 'at-in', type: 'number', value: String(st.checkinCooldown == null ? 7 : st.checkinCooldown), style: 'width:80px' });
      if (!su) [ckW, ckC].forEach(function (i) { i.disabled = true; });
      box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0' }, [el('span', { text: 'Winners a day' }), ckW, el('span', { text: 'Days before the same person can win again' }), ckC,
        el('span', { style: 'color:#65676b', text: 'Today: ' + (d.checkinWinnersToday || 0) + ' winners' })]));
      var cko = el('input', { type: 'checkbox' }); cko.checked = st.checkinOn !== false;
      if (!su) [ckv, cko].forEach(function (i) { i.disabled = true; });
      box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap' }, [el('label', { style: 'display:flex;gap:6px;align-items:center;font-weight:700' }, [cko, el('span', { text: 'Check-in open' })]), ckv,
        su ? el('button', { class: 'btn-sm btn-blue', text: 'Save check-in', onclick: function () { call({ action: 'checkin', checkinWinners: ckW.value, checkinCooldown: ckC.value, checkinDeck: ckv.value.split(',').map(function (x) { var p = x.split(':'); return { coins: (p[0] || '').trim(), times: (p[1] || '').trim() }; }).filter(function (x) { return x.coins !== '' && x.times !== ''; }), checkinOn: cko.checked }); } }) : '']));
      // add / take coins by hand
      if (su) {
        box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: 'Give or take diamonds by hand' }));
        var who = el('input', { class: 'at-in', placeholder: 'e-mail, phone account or 15-digit id' }), n = el('input', { class: 'at-in', type: 'number', placeholder: '+100 or -100' }), why = el('input', { class: 'at-in', placeholder: 'Note (kept in the audit log)' });
        box.appendChild(who); box.appendChild(n); box.appendChild(why);
        box.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:10px', text: 'Apply', onclick: function () {
          var amt = parseInt(n.value, 10); if (!amt) { alert('Enter the number of diamonds (+ to add, - to take).'); return; }
          // 🔎 show WHO it is (name + id + diamonds now) before anything changes
          adm('/api/admin/coins', { action: 'whois', user: who.value.trim() }).then(function (w) {
            if (!w || !w.success) { alert(AT('រកមិនឃើញអ្នកប្រើនេះទេ។ សូមប្រើអ៊ីមែល គណនីទូរសព្ទ ឬលេខ ID ១៥ ខ្ទង់។', (w && w.error) || 'No such person.')); return; }
            var p = w.person, after = p.coins + amt;
            var q = AT((amt > 0 ? 'បញ្ចូល ' : 'ដក ') + Math.abs(amt) + ' 💎 ' + (amt > 0 ? 'ទៅ' : 'ពី') + '\n\n👤 ' + (p.name || '(គ្មានឈ្មោះ)') + '\n🆔 ' + p.id + '\n💎 ឥឡូវ៖ ' + p.coins + ' → ក្រោយ៖ ' + after + '\n\nបន្តឬ?',
                       (amt > 0 ? 'Give ' : 'Take ') + Math.abs(amt) + ' 💎 ' + (amt > 0 ? 'to' : 'from') + '\n\n👤 ' + (p.name || '(no name)') + '\n🆔 ' + p.id + '\n💎 Now: ' + p.coins + ' → after: ' + after + '\n\nGo on?');
            if (!confirm(q)) return;
            call({ action: 'adjust', user: who.value.trim(), coins: n.value, note: why.value }).then(function (x) { if (x.success) alert(AT('✅ រួចរាល់៖ ', '✅ Done: ') + (p.name || p.id) + ' · 💎 ' + after); });
          });
        } }));
      }
      // recent decisions
      if (d.recent.length) {
        box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: 'Recent decisions' }));
        box.appendChild(table(['Person', 'Pack', 'Status', 'Note', 'By', 'When'], d.recent.map(function (x) {
          return el('tr', {}, [el('td', { text: nm(x) }), el('td', { text: '$' + Number(x.usd).toFixed(2) + ' / ' + x.coins }), el('td', { text: x.status }), el('td', { text: x.note || '' }), el('td', { text: x.decided_by || '' }), el('td', { text: ago(x.decided_at) })]);
        })));
      }
    }
    call({});
  }
  // ---------- 🎉 Party Room: the LiveKit keys (sound server), the rooms open now, reports ----------
  function partyAdmin(body) {
    var box = el('div', { style: 'max-width:760px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px 16px;margin-bottom:16px' }, [empty('Loading…')]);
    body.appendChild(box);
    function draw(d) {
      box.textContent = '';
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '🎉 Party Room ' + (d.ready ? '— ✅ ready' : '— ⚠️ not ready (enter the LiveKit keys)') }));
      if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'The voice goes through LiveKit Cloud (cloud.livekit.io › your project › Settings › Keys). The secret is never shown again; leave its box empty to keep the saved one.' }));
      var url = el('input', { class: 'at-in', placeholder: 'wss://xxxx.livekit.cloud', value: d.settings.url || '' });
      var key = el('input', { class: 'at-in', placeholder: 'API Key', value: d.settings.key || '' });
      var sec = el('input', { class: 'at-in', type: 'password', placeholder: d.settings.secretSet ? '•••••• (saved)' : 'API Secret', value: '' });
      var out = el('div', { style: 'display:none' });
      [url, key, sec].forEach(function (i) { if (!d.isSuperAdmin) i.disabled = true; });
      box.appendChild(el('div', { class: 'at-lbl', text: 'LiveKit URL' })); box.appendChild(url);
      box.appendChild(el('div', { class: 'at-lbl', text: 'API Key' })); box.appendChild(key);
      box.appendChild(el('div', { class: 'at-lbl', text: 'API Secret' })); box.appendChild(sec);
      if (d.isSuperAdmin) {
        var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:12px', text: 'Save', onclick: function () {
          btn.disabled = true; adm('/api/admin/party', { set: { url: url.value, key: key.value, secret: sec.value } }).then(function (x) { btn.disabled = false; if (x.success) { draw(x); msg(box.querySelector('.party-out'), true, '✅ Saved'); } else msg(out, false, '❌ ' + (x.error || 'Failed')); });
        } });
        box.appendChild(btn);
      }
      out.className = 'party-out'; box.appendChild(out);
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: 'Rooms open now (' + d.rooms.length + ')' }));
      if (!d.rooms.length) box.appendChild(empty('No room is open.'));
      else box.appendChild(table(['Room', 'Owner', 'Who', 'Seats', 'People', 'Reports', 'Opened', ''], d.rooms.map(function (r) {
        return el('tr', {}, [el('td', { text: r.title || '(no name)' }), el('td', { text: nm(r) + ' · ' + r.owner_email }), el('td', { text: r.privacy === 'friends' ? 'Friends' : 'Public' }),
          el('td', { text: String(r.seats) }), el('td', { text: String(r.people) }), el('td', { text: String(r.reports), style: Number(r.reports) ? 'color:#c0392b;font-weight:700' : '' }), el('td', { text: ago(r.created_at) }),
          el('td', {}, [el('button', { class: 'btn-sm btn-red', text: 'Close room', onclick: function () {
            var why = prompt('Why is this room closed? (kept in the audit log)', ''); if (why === null) return;
            adm('/api/admin/party', { close: r.id, reason: why }).then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); });
          } })])]);
      })));
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: 'Reports waiting (' + d.reports.length + ')' }));
      if (!d.reports.length) box.appendChild(empty('No report.'));
      else box.appendChild(table(['Room', 'Status', 'Owner', 'Reason', 'By', 'When', ''], d.reports.map(function (r) {
        return el('tr', {}, [el('td', { text: '#' + r.room_id + ' ' + (r.title || '') }), el('td', { text: r.status || '—' }), el('td', { text: r.owner_email || '' }), el('td', {}, [el('div', { text: r.reason || '' }), r.board_pic ? el('img', { src: r.board_pic, title: 'Picture put by ' + (r.board_by || ''), style: 'max-width:160px;max-height:160px;border-radius:8px;margin-top:4px;border:1px solid #ccc' }) : '', r.board_by ? el('div', { style: 'font-size:12px;color:#65676b', text: '🖼️ by ' + r.board_by }) : '']),
          el('td', { text: r.reporter_email }), el('td', { text: ago(r.created_at) }),
          el('td', {}, [el('button', { class: 'btn-sm btn-gray', text: 'Done', onclick: function () { adm('/api/admin/party', { handled: r.room_id }).then(function (x) { if (x.success) draw(x); }); } })])]);
      })));
      // 🚫 CamFeed's ban from every Party Room + the room owners' bans + the ban times owners can choose
      var su = !!d.isSuperAdmin, gaps = d.gaps || {}, anims = d.anims || { action: [], emote: [] };
      function banLen(m) { m = Number(m); if (!m) return 'for ever'; if (m % 1440 === 0 && m > 1440) return (m / 1440) + ' days'; if (m % 60 === 0) return (m / 60) + ' hours'; return m + ' min'; }
      function untilTxt(u) { return u ? 'until ' + new Date(u).toLocaleString() : 'for ever'; }
      box.appendChild(el('div', { style: 'font-weight:800;margin:18px 0 6px', text: '🚫 Ban from ALL Party Rooms (CamFeed)' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:6px', text: 'The person can not enter or open any room until the time ends. If they are in a room now they are put out (their own room is closed). Kept in the audit log.' }));
      var bWho = el('input', { class: 'at-in', placeholder: 'E-mail, ID or phone', style: 'width:220px;display:inline-block' });
      var bLen = el('select', { class: 'at-in', style: 'width:130px;display:inline-block' });
      [[60, '1 hour'], [1440, '24 hours'], [10080, '7 days'], [43200, '30 days'], [0, 'for ever']].forEach(function (o) { bLen.appendChild(el('option', { value: String(o[0]), text: o[1] })); });
      bLen.value = '1440';
      var bWhy = el('input', { class: 'at-in', placeholder: 'Reason', style: 'width:220px;display:inline-block' });
      box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [bWho, bLen, bWhy, el('button', { class: 'btn-sm btn-red', text: '🚫 Ban', onclick: function () {
        if (!bWho.value.trim()) return alert('Write the e-mail, ID or phone.');
        if (!confirm('Ban ' + bWho.value.trim() + ' from all Party Rooms (' + banLen(bLen.value) + ')?')) return;
        adm('/api/admin/party', { ban: { target_email: bWho.value.trim(), minutes: Number(bLen.value), reason: bWhy.value } }).then(function (x) { if (x.success) { draw(x); alert('✅ Banned'); } else alert(x.error || 'Failed'); });
      } })]));
      var gb = d.bans || [];
      if (!gb.length) box.appendChild(empty('Nobody is banned from all rooms.'));
      else box.appendChild(table(['Person', 'How long', 'Reason', 'By', 'When', ''], gb.map(function (b) {
        return el('tr', {}, [el('td', { text: nm(b) + ' · ' + b.target }), el('td', { text: untilTxt(b.until) }), el('td', { text: b.reason || '' }), el('td', { text: b.by_admin || '' }), el('td', { text: ago(b.created_at) }),
          el('td', {}, [el('button', { class: 'btn-sm btn-gray', text: 'Unban', onclick: function () { if (confirm('Unban ' + nm(b) + '?')) adm('/api/admin/party', { unban: b.target }).then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); }); } })])]);
      })));
      box.appendChild(el('div', { style: 'font-weight:800;margin:14px 0 6px', text: '⏳ Ban times a room owner can choose (minutes, 0 = for ever)' }));
      var bc = el('input', { class: 'at-in', value: (d.banChoices || []).join(', '), style: 'width:260px;display:inline-block' });
      if (!su) bc.disabled = true;
      box.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [bc, el('span', { style: 'color:#65676b;font-size:13px', text: 'Now: ' + (d.banChoices || []).map(banLen).join(' · ') }),
        su ? el('button', { class: 'btn-sm btn-blue', text: 'Save', onclick: function () {
          var l = bc.value.split(/[\s,]+/).filter(Boolean).map(Number);
          adm('/api/admin/party', { banChoices: l }).then(function (x) { if (x.success) { draw(x); alert('✅ Saved'); } else alert(x.error || 'Failed'); });
        } }) : null]));
      var ob = d.ownerBans || [];
      box.appendChild(el('div', { style: 'font-weight:800;margin:14px 0 6px', text: '👑 Bans by room owners (newest ' + ob.length + ')' }));
      if (!ob.length) box.appendChild(empty('No owner has banned anybody.'));
      else box.appendChild(table(['Room owner', 'Banned person', 'How long', 'Reason', 'When'], ob.map(function (b) {
        return el('tr', {}, [el('td', { text: b.owner }), el('td', { text: b.target }), el('td', { text: untilTxt(b.until) }), el('td', { text: b.reason || '' }), el('td', { text: ago(b.created_at) })]);
      })));
      var fc = d.followCounts || [];
      box.appendChild(el('div', { style: 'font-weight:800;margin:14px 0 6px', text: '❤️ Rooms with the most followers' }));
      if (!fc.length) box.appendChild(empty('Nobody follows a room yet.'));
      else box.appendChild(table(['Room owner', 'Followers'], fc.slice(0, 30).map(function (f) { return el('tr', {}, [el('td', { text: f.owner }), el('td', { text: String(f.n) })]); })));
      // 😘 actions and 😊 emotes + how often one person may send them
      box.appendChild(el('div', { style: 'font-weight:800;margin:18px 0 6px', text: '⏱️ Spam guard (seconds between two, per person)' }));
      var ag = el('input', { class: 'at-in', type: 'number', value: String(gaps.actionGap), style: 'width:110px;display:inline-block' }), eg = el('input', { class: 'at-in', type: 'number', value: String(gaps.emoteGap), style: 'width:110px;display:inline-block' });
      var ss = el('input', { type: 'checkbox' }); ss.checked = gaps.seatSound !== false;
      var stm = el('input', { type: 'checkbox' }); stm.checked = gaps.showTimer !== false;
      if (!su) { ag.disabled = true; eg.disabled = true; ss.disabled = true; stm.disabled = true; }
      box.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [el('span', { text: '😘 Actions:' }), ag, el('span', { text: '😊 Emotes:' }), eg,
        el('label', { style: 'display:flex;gap:6px;align-items:center' }, [ss, el('span', { text: '🔔 Sound when somebody sits down / leaves a seat' })]),
        el('label', { style: 'display:flex;gap:6px;align-items:center' }, [stm, el('span', { text: '⏱️ Show the room clock (how long it is open)' })]),
        su ? el('button', { class: 'btn-sm btn-blue', text: 'Save', onclick: function () { adm('/api/admin/party', { gaps: { actionGap: ag.value, emoteGap: eg.value, seatSound: ss.checked, showTimer: stm.checked } }).then(function (x) { if (x.success) { draw(x); alert('✅ Saved'); } else alert(x.error || 'Failed'); }); } }) : null]));
      ['action', 'emote'].forEach(function (kind) {
        var list = (d.fx || []).filter(function (f) { return f.kind === kind; });
        box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: kind === 'action' ? '😘 Actions — sent to somebody on a seat (flies from the sender to them)' : '😊 Emotes — shown on the sender\'s own seat' }));
        function row(f) {
          var e = el('input', { class: 'at-in', value: f.emoji || '', style: 'width:60px' }), km = el('input', { class: 'at-in', value: f.name_km || '' }), en = el('input', { class: 'at-in', value: f.name_en || '' });
          var an = el('select', { class: 'at-in', style: 'width:110px' }); (anims[kind] || []).forEach(function (a) { var o = el('option', { value: a, text: a }); if (a === f.anim) o.selected = true; an.appendChild(o); });
          var c = el('input', { class: 'at-in', type: 'number', value: String(f.coins || 0), style: 'width:80px' }), so = el('input', { class: 'at-in', type: 'number', value: String(f.sort || 0), style: 'width:70px' });
          var on = el('input', { type: 'checkbox' }); on.checked = f.active !== false;
          if (!su) [e, km, en, an, c, so, on].forEach(function (i) { i.disabled = true; });
          return el('tr', {}, [el('td', {}, [e]), el('td', {}, [km]), el('td', {}, [en]), el('td', {}, [an]), el('td', {}, [c]), el('td', {}, [so]), el('td', {}, [on]),
            el('td', {}, su ? [el('button', { class: 'btn-sm btn-blue', text: f.id ? 'Save' : 'Add', onclick: function () {
              adm('/api/admin/party', { fx: { id: f.id, kind: kind, emoji: e.value, name_km: km.value, name_en: en.value, anim: an.value, coins: c.value, sort: so.value, active: on.checked } }).then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); });
            } })] : [])]);
        }
        var rows = list.map(row); if (su) rows.push(row({ kind: kind, anim: (anims[kind] || [])[0], coins: 0 }));
        box.appendChild(table(['Emoji', 'Khmer', 'English', 'Move', 'Diamonds (0 = free)', 'Order', 'On', ''], rows));
      });
    }
    adm('/api/admin/party', {}).then(draw);
    partyAccessAdmin(body);
  }
  // 🔐 who may open a room, and who may make it private (levels, VIP, coin packs, CamFeed's own permission)
  function partyAccessAdmin(body) {
    var box = el('div', { style: 'max-width:760px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px 16px;margin-bottom:16px' }, [empty('Loading…')]);
    body.appendChild(box);
    function call(extra) { return adm('/api/admin/party-access', extra || {}).then(function (x) { if (x && x.success) draw(x); else { box.textContent = ''; box.appendChild(empty((x && x.error) || 'Could not load.')); } return x; }); }
    function when(t) { return t ? new Date(t).toLocaleString() : 'for ever'; }
    function draw(d) {
      box.textContent = '';
      var s = d.settings || {}, op = s.open || {}, pv = s.private || {}, su = !!d.isSuperAdmin;
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '🔐 Opening rooms & Private rooms' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Private = a room that is not in the list; only people invited, with the room\'s link, or who got the room card from the owner in a chat can enter. When the right runs out, a room open as private stays private until it closes.' + (su ? '' : ' Only a Super Admin can change the settings.') }));
      function h(t) { box.appendChild(el('div', { style: 'font-weight:800;font-size:15px;margin:12px 0 6px', text: t })); }
      function field(label, val, hint) { var i = el('input', { class: 'at-in', value: String(val), style: 'width:120px;display:inline-block' }); i.disabled = !su; box.appendChild(el('label', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:5px 0' }, [el('span', { style: 'min-width:300px', text: label }), i, el('span', { style: 'color:#65676b;font-size:12px', text: hint || '' })])); return i; }
      function check(label, on) { var x = el('input', { type: 'checkbox' }); x.checked = !!on; x.disabled = !su; box.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;margin:5px 0' }, [x, el('span', { text: label })])); return x; }
      h('1. Who may open a room');
      var mode = el('select', { class: 'at-in', style: 'width:340px;display:inline-block' }); mode.disabled = !su;
      [['all', 'Anybody'], ['rules', 'People who meet the rules below'], ['list', 'Only the people CamFeed allows (list below)']].forEach(function (o) { var op2 = el('option', { value: o[0], text: o[1] }); if (op.mode === o[0]) op2.selected = true; mode.appendChild(op2); });
      box.appendChild(mode);
      var oLv = field('Level at least', op.minLevel || 0, '0 = not needed');
      var oDays = field('Account at least (days old)', op.minDays || 0, '0 = not needed');
      var oPhone = check('Needs a phone number on the account', op.needPhone);
      h('2. 🔐 Private rooms');
      var pOn = check('Private rooms are on', pv.on !== false);
      var pLv = field('Free from Level', pv.minLevel || 0, '0 = no free level');
      var pVip = check('VIP can make rooms private', pv.vip !== false);
      var pRoom = field('Switch an open room to private — people WITHOUT the right (diamonds)', pv.roomPrice != null ? pv.roomPrice : 50, '0 = they can not · the room is not closed');
      var pSwitch = field('Switch an open room to private — people WITH the right (diamonds)', pv.switchPrice != null ? pv.switchPrice : 10, '0 = free');
      var packs = el('textarea', { class: 'at-in', rows: '4', style: 'width:100%;font-family:inherit' }); packs.disabled = !su;
      packs.value = (pv.packs || []).map(function (p) { return p.coins + ' = ' + p.days; }).join('\n');
      box.appendChild(el('div', { style: 'margin:6px 0 2px;font-weight:700', text: '💎 Diamond packs (one per line: diamonds = days, e.g. 100 = 3)' })); box.appendChild(packs);
      if (su) box.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'margin-top:8px', text: '💾 Save', onclick: function () {
        var pk = packs.value.split('\n').map(function (l) { var m = l.split('='); return { coins: Number((m[0] || '').trim()), days: Number((m[1] || '').trim()) }; }).filter(function (p) { return p.coins > 0 && p.days > 0; });
        call({ set: { open: { mode: mode.value, minLevel: Number(oLv.value), minDays: Number(oDays.value), needPhone: oPhone.checked }, private: { on: pOn.checked, minLevel: Number(pLv.value), vip: pVip.checked, roomPrice: Number(pRoom.value), switchPrice: Number(pSwitch.value), packs: pk } } }).then(function (x) { if (x && x.success) alert('✅ Saved'); });
      } }));
      var sl = d.sales || {};
      box.appendChild(el('div', { style: 'margin-top:10px;padding:8px 10px;background:#f7f8fa;border-radius:8px', text: '💎 Private sold: ' + (sl.n || 0) + ' times to ' + (sl.people || 0) + ' people · ' + (sl.coins || 0) + ' diamonds in all · ' + (sl.coins30 || 0) + ' diamonds in the last 30 days · open private rooms now: ' + (d.privateRooms || 0) }));
      h('3. CamFeed\'s own permission (no rules needed)');
      var who = el('input', { class: 'at-in', placeholder: 'email or phone', style: 'width:220px;display:inline-block' });
      var kind = el('select', { class: 'at-in', style: 'width:200px;display:inline-block' }); [['private', '🔐 Make rooms private'], ['open', '🎉 Open rooms']].forEach(function (o) { kind.appendChild(el('option', { value: o[0], text: o[1] })); });
      var days = el('input', { class: 'at-in', value: '0', style: 'width:80px;display:inline-block', title: 'days (0 = for ever)' });
      box.appendChild(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, [who, kind, days, el('span', { style: 'color:#65676b;font-size:12px', text: 'days (0 = for ever, e.g. 3 for a trial)' }),
        el('button', { class: 'btn-sm btn-blue', text: '➕ Allow', onclick: function () { if (!who.value.trim()) return; call({ grant: { target: who.value.trim(), kind: kind.value, days: Number(days.value) } }).then(function (x) { if (x && x.success) { who.value = ''; alert('✅ Allowed'); } }); } })]));
      var rows = (d.grants || []).map(function (g) {
        return el('tr', {}, [el('td', { text: nm(g) + ' · ' + g.target }), el('td', { text: g.kind === 'open' ? '🎉 Open rooms' : '🔐 Private' }), el('td', { text: when(g.until) }), el('td', { text: g.by_email || '' }),
          el('td', {}, [el('button', { class: 'btn-sm btn-gray', text: 'Take back', onclick: function () { if (confirm('Take back from ' + nm(g) + '?')) call({ revoke: { target: g.target, kind: g.kind } }); } })])]);
      });
      if (rows.length) box.appendChild(table(['Person', 'Right', 'Until', 'Given by', ''], rows)); else box.appendChild(empty('Nobody yet.'));
      h('4. Bought with diamonds (still running)');
      var prow = (d.passes || []).map(function (p) {
        return el('tr', {}, [el('td', { text: nm(p) + ' · ' + p.target }), el('td', { text: when(p.until) }), el('td', { text: String(p.coins_total || 0) }),
          el('td', {}, [el('button', { class: 'btn-sm btn-gray', text: 'End now', onclick: function () { if (confirm('End the private days of ' + nm(p) + '? (no diamonds are given back)')) call({ revoke: { target: p.target, kind: 'pass' } }); } })])]);
      });
      if (prow.length) box.appendChild(table(['Person', 'Until', 'Diamonds spent', ''], prow)); else box.appendChild(empty('Nobody yet.'));
    }
    call();
  }
  // the rules: Creator Program (who may ask to earn) and, separately, the invitation reward. Super Admin can change them at any time.
  var RULE_LABEL = {
    CREATOR_MIN_FOLLOWERS: 'Followers at least', CREATOR_MIN_VIEWS: 'Total views at least', CREATOR_MIN_POSTS: 'Posts at least', CREATOR_MIN_ACCOUNT_DAYS: 'Account age at least (days)', MIN_WITHDRAW_USD: '🎬 Content money: smallest withdrawal ($)', GIFT_MIN_WITHDRAW_USD: '🎁 Gift money: smallest withdrawal ($)', CONTENT_HOLD_DAYS: '🎬 Content money waits … days before it can be withdrawn (0 = no wait)', WITHDRAW_DAY_MAX_USD: 'Most a person can withdraw in one day ($, 0 = no limit)', WITHDRAW_MONTH_MAX_USD: 'Most a person can withdraw in 30 days ($, 0 = no limit)', WITHDRAW_HOLD_HOURS: 'A first withdrawal / new account number waits … hours before it can be paid (0 = no wait)',
    WEEK_POST_GOAL: AT('📊 ផ្ទាំងអ្នកបង្កើតមាតិកា៖ គោលដៅបង្ហោះក្នុង ៧ ថ្ងៃ (1–100)', '📊 Creator dashboard: posts to make in 7 days (1–100)'),
    COPYRIGHT_MAX_STRIKES: '©️ Copyright: upheld claims / removed copies in one year before the person\'s earnings stop (1–10)',
    NAME_CHANGE_DAYS: 'A person can change their name once every … days (0 = any time)', GROUP_CALL_MAX: 'People in one group call at most (2–16)', CHAT_MAX_MONTHS: 'Chat messages are deleted after … months at most, for everyone (1–24)',
    REFERRAL_REWARD_USD: 'Reward per invited friend ($)', REFERRAL_ACTIVE_DAYS: 'Friend must use CamFeed on … different days', REFERRAL_POSTS: 'Friend must post … public photos / videos', REFERRAL_WINDOW_DAYS: 'Within … days after signing up', REFERRAL_MAX_PER_MONTH: 'Paid automatically per inviter per month (more = waits for you)'
  };
  function monRules(body, group) {
    var box = el('div', { style: 'max-width:560px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px 16px;margin-bottom:16px' }, [empty('Loading…')]);
    body.appendChild(box);
    function draw(d) {
      box.textContent = '';
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: group === 'app' ? '⚙️ App settings' : group === 'referral' ? '🎁 Invitation reward — rules' : '⚙️ Monetization — conditions to ask for earning' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: group === 'app'
        ? 'Used by the app and the website right after Save (no code or Render change needed).'
        : group === 'referral'
        ? 'Only for inviting friends. It is separate from the monetization conditions: anybody can invite and earn this reward.'
        : 'What a person needs before the "Apply" button works. Inviting friends is NOT part of this (it has its own rules in 🎁 Invitations). You can still approve anyone by hand.' }));
      if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      var inputs = {}, out = el('div', { style: 'display:none' });
      d.rules.forEach(function (r) {
        var i = el('input', { class: 'at-in', type: 'number', step: 'any', min: String(r.min), max: String(r.max), value: String(r.value) }); inputs[r.key] = i; if (!d.isSuperAdmin) i.disabled = true;
        box.appendChild(el('div', { class: 'at-lbl', text: (RULE_LABEL[r.key] || r.key) + (r.saved ? '' : '  (default / Render)') })); box.appendChild(i);
      });
      if (d.isSuperAdmin) {
        var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:12px', text: 'Save', onclick: function () {
          var set = {}; Object.keys(inputs).forEach(function (k) { set[k] = inputs[k].value; });
          btn.disabled = true; adm('/api/admin/monetization-rules', { group: group, set: set }).then(function (x) { btn.disabled = false; if (x.success) { draw(x); msg(box.querySelector('.rules-out') || out, true, '✅ Saved — used from now on'); } else msg(out, false, '❌ ' + (x.error || 'Failed')); });
        } });
        box.appendChild(btn);
      } else box.appendChild(el('div', { style: 'margin-top:10px;font-size:13px;color:#b45309', text: 'Only a Super Admin can change these.' }));
      out.className = 'rules-out'; box.appendChild(out);
    }
    adm('/api/admin/monetization-rules', { group: group }).then(draw);
  }
  function monRate(body) {
    body.appendChild(empty('Loading…'));
    adm('/api/admin/creator-rate', {}).then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      var rpm = el('input', { class: 'at-in', type: 'number', step: '0.01', min: '0', value: d.rpm }), cap = el('input', { class: 'at-in', type: 'number', step: '0.1', min: '0', value: d.dailyCap }), out = el('div', { style: 'display:none' });
      var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px', text: 'Save', onclick: function () {
        btn.disabled = true; adm('/api/admin/creator-rate', { set: true, rpm: rpm.value, dailyCap: cap.value }).then(function (x) { btn.disabled = false; msg(out, x.success, x.success ? '✅ Saved' : '❌ ' + (x.error || 'Failed')); });
      } });
      body.appendChild(el('div', { style: 'max-width:520px' }, [
        el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Approved Creators (the ones you invited) earn this amount for every 1,000 NEW views on their posts. 0 = off. Views before the rate is switched on / before they became a Creator are not paid. Total paid so far: ' + money(d.paidTotal) + '.' }),
        el('div', { class: 'at-lbl', text: 'Price per 1,000 views ($) — example 0.10' }), rpm, el('div', { class: 'at-lbl', text: 'Daily limit per Creator ($)' }), cap, el('div', { style: 'margin-top:12px' }, [btn]), out]));
    });
  }
  function monWithdrawals(body) {
    body.appendChild(empty('Loading…'));
    adm('/api/admin/withdrawals').then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      body.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: d.isSuperAdmin ? 'Pay the person yourself. Phone top-up / Wing cash-out: buy or create the code, then press "Mark paid" and enter it. Bank (ABA / ACLEDA / Wing account): transfer, then "Mark paid". "Reject" needs a reason and refunds the wallet. Codes are never shown here again.' : 'Only a Super Admin can pay or refuse a withdrawal.' }));
      d.withdrawals = d.withdrawals || []; if (!d.withdrawals.length) { body.appendChild(empty('No withdrawal request yet.')); return; }
      var ML = { TopUp: '📱 Phone top-up', WingCash: '🟢 Wing cash-out (agent)', ABA: '🏦 ABA', ACLEDA: '🏦 ACLEDA', Wing: '🟢 Wing account' }, CODE = { TopUp: 1, WingCash: 1 };
      body.appendChild(table(['Creator', 'Amount', 'Pay with', 'Name / carrier', 'Number', 'Asked', 'Status', ''], d.withdrawals.map(function (w) {
        function decide(status) {
          var note = '', code = '';
          if (status === 'paid') {
            if (CODE[w.method]) { code = prompt((w.method === 'TopUp' ? 'Enter the TOP-UP CODE for ' + w.account_name + ' ' : 'Enter the WING CASH-OUT CODE for phone ') + w.account_number + ':', ''); if (!code) return; }
            note = prompt('Internal note / bank reference (optional):', ''); if (note === null) return;
          } else { note = prompt('Reason for refusing (the creator sees it):', ''); if (!note) return; }
          if (!confirm((status === 'paid' ? 'Mark ' + money(w.amount) + ' as PAID to ' : 'Refuse and refund ' + money(w.amount) + ' to ') + nm(w) + '?')) return;
          var force = status === 'paid' && w.hold_until && new Date(w.hold_until) > new Date() && confirm('⏳ New account details: the waiting time is not over. Pay now anyway?');
          if (status === 'paid' && w.hold_until && new Date(w.hold_until) > new Date() && !force) return;
          adm('/api/admin/withdrawals/decide', { id: w.id, status: status, note: note, code: code, force: !!force }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
        }
        function reissue() {
          var code = prompt('Enter the NEW code for ' + nm(w) + ' (' + (ML[w.method] || w.method) + ', ' + w.account_number + '):', ''); if (!code) return;
          adm('/api/admin/withdrawals/reissue', { id: w.id, code: code }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
        }
        var kids = [];
        if (d.isSuperAdmin && w.status === 'pending') kids = [el('button', { class: 'btn-sm btn-green', text: 'Mark paid', onclick: function () { decide('paid'); } }), el('button', { class: 'btn-sm btn-red', text: 'Reject', onclick: function () { decide('rejected'); } })];
        else if (w.status === 'paid' && CODE[w.method]) {
          if (w.reissue_requested_at && d.isSuperAdmin) kids.push(el('button', { class: 'btn-sm btn-green', text: '🔑 Send new code', onclick: reissue }));
          kids.push(el('span', { style: 'font-size:12px;color:#65676b;display:block', text: (w.reissue_requested_at ? '⚠️ Asked for a new code. ' : '') + (w.code_viewed_at ? 'Code seen by owner.' : 'Code not seen yet.') }));
        } else kids.push(el('span', { style: 'font-size:12px;color:#65676b', text: w.note || '' }));
        // 🛡️ what to look at before paying
        if (w.status === 'pending') {
          var warn = [];
          if (w.name_check === 'differ') warn.push('⚠️ Name not the same as on CamFeed — check');
          else if (w.name_check === 'same') warn.push('✅ Same name as on CamFeed');
          if (w.new_details) warn.push('🆕 New account number');
          if (w.hold_until && new Date(w.hold_until) > new Date()) warn.push('⏳ Wait until ' + new Date(w.hold_until).toLocaleString());
          warn.forEach(function (t) { kids.push(el('div', { style: 'font-size:12px;margin-top:4px;color:' + (/^⚠️/.test(t) ? '#b45309' : '#65676b') }, [el('span', { text: t.indexOf('⏳ Wait until ') === 0 ? '⏳ Wait until ' : t }), el('span', { text: t.indexOf('⏳ Wait until ') === 0 ? t.slice(13) : '' })])); });
        }
        var hot = w.reissue_requested_at ? 'background:#fff4e5' : (w.status === 'pending' && w.name_check === 'differ' ? 'background:#fffbeb' : '');
        return el('tr', { style: hot }, [el('td', {}, [el('div', { style: 'font-weight:700', text: nm(w) }), el('div', { style: 'font-size:11.5px;color:#65676b', text: w.public_id || '' })]), el('td', {}, [el('div', { style: 'font-weight:800', text: money(w.amount) }), el('div', { style: 'font-size:11.5px;font-weight:700;color:' + (w.pocket === 'content' ? '#7c3aed' : '#e8590c'), text: w.pocket === 'content' ? '🎬 Content money' : '🎁 Gift money' })]), el('td', { text: ML[w.method] || w.method }), el('td', { text: w.account_name || '' }), el('td', { text: w.account_number || '' }), el('td', { text: fmt(w.created_at) }), el('td', {}, [statusBadge(w.status)]), el('td', {}, kids)]);
      })));
    });
  }
  // 📱 the pictures of Smart / Metfone / Cellcard (people choose one for a phone top-up withdrawal). Empty = the picture CamFeed comes with.
  function monCarrierLogos(body) {
    body.textContent = 'Loading…';
    adm('/api/admin/carrier-logo', { list: true }).then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      // 💵 the card amounts people can choose (cards come only in some amounts)
      var am = el('input', { class: 'at-in', value: (d.amounts || []).join(', '), placeholder: '1, 1.5, 2, 5, 10, 20', style: 'max-width:320px' });
      var amOut = el('div', { style: 'font-size:12.5px;margin-top:4px' });
      body.appendChild(el('div', { style: 'margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #e4e6eb' }, [
        el('div', { style: 'font-weight:800;margin-bottom:4px', text: '💵 Top-up card amounts ($)' }),
        el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:8px', text: 'People can only choose one of these amounts for a phone top-up. Write them with commas.' }),
        am, d.isSuperAdmin ? el('button', { class: 'btn-sm btn-blue', style: 'margin-left:8px', text: 'Save', onclick: function () {
          adm('/api/admin/carrier-logo', { amounts: am.value }).then(function (x) { amOut.style.color = x.success ? '#15803d' : '#b91c1c'; amOut.textContent = x.success ? '✅ ' + x.amounts.map(function (n) { return '$' + n; }).join(' · ') : '❌ ' + (x.error || 'Failed'); if (x.success) am.value = x.amounts.join(', '); });
        } }) : null, amOut]));
      // 🏦 the bank / wallet pictures (ABA, ACLEDA …) people see when they choose how to be paid
      body.appendChild(el('div', { style: 'font-weight:800;margin-bottom:4px', text: '🏦 Bank and wallet pictures' }));
      body.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:12px', text: 'People see these pictures when they choose how to be paid. Best: PNG with a clear or white background, about 300 × 120 pixels, smaller than 400 KB. No picture = the name is shown.' }));
      (d.methods || []).forEach(function (c) { body.appendChild(logoBox(c, true)); });
      body.appendChild(el('div', { style: 'border-top:1px solid #e4e6eb;margin:6px 0 14px' }));
      body.appendChild(el('div', { style: 'font-weight:800;margin-bottom:4px', text: '📱 Phone company pictures' }));
      body.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:12px', text: 'People see these pictures when they choose a phone top-up. Best: PNG with a clear or white background, about 300 × 120 pixels, smaller than 400 KB.' }));
      (d.carriers || []).forEach(function (c) { body.appendChild(logoBox(c, false)); });
      function logoBox(c, bank) {
        var url = (d.logos || {})[c] || (bank ? '' : ('/icons/carriers/' + c.toLowerCase() + '.png'));
        var img = el('img', { src: url || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', alt: c, style: 'max-width:100%;max-height:100%;object-fit:contain' + (url ? '' : ';display:none') });
        var nameTx = el('span', { style: 'font-weight:800;color:#65676b' + (url ? ';display:none' : ''), text: c });
        var box = el('div', { style: 'width:130px;height:70px;border:1px solid #dadde1;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box' }, [img, nameTx]);
        var file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
        var out = el('div', { style: 'font-size:12.5px;margin-top:4px' });
        file.addEventListener('change', function () {
          var f = file.files && file.files[0]; if (!f) return;
          if (f.size > 400 * 1024) { out.style.color = '#b91c1c'; out.textContent = '❌ The picture must be smaller than 400 KB.'; return; }
          var r = new FileReader(); r.onload = function () {
            out.style.color = '#65676b'; out.textContent = 'Uploading…';
            adm('/api/admin/carrier-logo', { carrier: c, pic: r.result }).then(function (x) { if (x.success) { img.src = x.logos[c]; img.style.display = ''; nameTx.style.display = 'none'; out.style.color = '#15803d'; out.textContent = '✅ Saved'; } else { out.style.color = '#b91c1c'; out.textContent = '❌ ' + (x.error || 'Failed'); } });
          }; r.readAsDataURL(f); file.value = '';
        });
        var kids = [el('div', { style: 'font-weight:800;margin-bottom:6px', text: c }), box, file];
        if (d.isSuperAdmin) kids.push(el('div', { style: 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap' }, [
          el('button', { class: 'btn-sm btn-blue', text: '📤 Upload a new picture', onclick: function () { file.click(); } }),
          (d.logos || {})[c] ? el('button', { class: 'btn-sm', text: bank ? '🗑 Remove the picture' : '↩️ Back to the CamFeed picture', onclick: function () {
            if (!confirm(bank ? 'Remove the picture of ' + c + '? Its name is shown instead.' : 'Use the picture that comes with CamFeed for ' + c + ' again?')) return;
            adm('/api/admin/carrier-logo', { carrier: c, reset: true }).then(function (x) { if (x.success) monCarrierLogos(body); else alert(x.error || 'Failed'); });
          } }) : null].filter(Boolean)));
        kids.push(out);
        return el('div', { style: 'display:inline-block;vertical-align:top;margin:0 18px 18px 0' }, kids);
      }
    });
  }
  function monWallet(body) {
    var out = el('div', { id: 'monOut', style: 'display:none' });
    var who = el('input', { class: 'at-in', id: 'mwWho', placeholder: 'Phone number, Gmail or 15-digit ID of the creator' });
    var amount = el('input', { class: 'at-in', id: 'mwAmount', type: 'number', step: '0.01', placeholder: 'Amount in $ (negative = take back)' });
    var kind = el('select', { class: 'at-in', id: 'mwKind' }, [el('option', { value: 'bonus', text: '🎁 Gift (creator gets a notification)' }), el('option', { value: 'adjustment', text: 'Correction' })]);
    var pocket = el('select', { class: 'at-in', id: 'mwPocket' }, [el('option', { value: 'gift', text: '🎁 Gift money pocket' }), el('option', { value: 'content', text: '🎬 Content money pocket' })]);
    var note = el('input', { class: 'at-in', id: 'mwNote', placeholder: 'Reason (the creator sees it), e.g. "Launch contest winner"' });
    var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px', text: 'Add to wallet', onclick: function () {
      if (!confirm('Change the wallet of ' + who.value + ' by ' + amount.value + ' $ ?')) return; btn.disabled = true;
      adm('/api/admin/wallet/credit', { identifier: who.value, amount: amount.value, kind: kind.value, pocket: pocket.value, note: note.value }).then(function (d) { btn.disabled = false; msg(out, d.success, d.success ? '✅ ' + (d.name || 'The creator') + ' now has ' + money(d.balance) : '❌ ' + (d.error || 'Failed')); if (d.success) { amount.value = ''; note.value = ''; } });
    } });
    body.appendChild(el('div', { style: 'max-width:520px' }, [el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Only a Super Admin can change a wallet. Use it for prizes and contest rewards. Every change is written to the Activity Log.' }), el('div', { class: 'at-lbl', text: 'Creator' }), who, el('div', { class: 'at-lbl', text: 'Amount' }), amount, el('div', { class: 'at-lbl', text: 'Type' }), kind, el('div', { class: 'at-lbl', text: 'Pocket' }), pocket, el('div', { class: 'at-lbl', text: 'Reason' }), note, el('div', { style: 'margin-top:12px' }, [btn]), out]));
  }
  window.loadMonetizationAdmin = loadMonetizationAdmin;


  // ---------- Sponsored ads (local advertising) ----------
  function setLiveBadge(n) { var b = document.getElementById('tabBtn-live'); if (!b) return; b.textContent = '🔴 Live' + (n > 0 ? '  (' + n + ')' : ''); }
  function loadSoundsAdmin() {
    var p = document.getElementById('panel-sounds'); if (!p) return; p.textContent = '';
    var out = el('div'), form = el('div', { style: 'background:#fff;border:1px solid #e4e6eb;border-radius:10px;padding:12px;margin-bottom:12px;max-width:560px' }), list = el('div');
    p.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Music for Stories AND for 🎉 Party Rooms (the room owner / helpers play these songs in their room; every phone plays them in step). Only add songs you are ALLOWED to use (royalty-free / your own / licensed). Turn a song off here to remove it everywhere. Upload an .mp3 or .m4a (up to 100 MB).' }));
    var title = el('input', { class: 'at-in', maxlength: '100', placeholder: 'Song name' }), artist = el('input', { class: 'at-in', maxlength: '80', placeholder: 'Artist (optional)' });
    var file = el('input', { type: 'file', accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,audio/wav,.mp3,.m4a,.aac,.ogg,.wav', style: 'font-size:13px;margin-top:6px' }), st = el('div', { style: 'font-size:12.5px;color:#65676b;margin-top:4px' });
    var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:8px', text: 'Upload & add', onclick: function () {
      if (!title.value.trim()) { msg(out, false, '❌ Please write the song name.'); return; } if (!file.files[0]) { msg(out, false, '❌ Please choose the audio file.'); return; }
      btn.disabled = true; st.textContent = 'Uploading…'; var f = file.files[0], fd = new FormData(); fd.append('user_email', currentUser.email); fd.append('file', f);
      var dur = 30; try { var au = new Audio(URL.createObjectURL(f)); au.onloadedmetadata = function () { if (isFinite(au.duration)) dur = Math.round(au.duration); }; } catch (e) {}
      setTimeout(function () {
        fetch('/api/videos/upload-direct', { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (u) {
          if (!u.publicUrl) throw new Error(u.error || 'Upload failed');
          return adm('/api/admin/sounds/add', { title: title.value, artist: artist.value, audioUrl: u.publicUrl, duration: dur });
        }).then(function (x) { btn.disabled = false; st.textContent = ''; msg(out, x.success, x.success ? '✅ Added' : '❌ ' + (x.error || 'Failed')); if (x.success) loadSoundsAdmin(); })
          .catch(function (e) { btn.disabled = false; st.textContent = ''; msg(out, false, '❌ ' + (e.message || 'Upload failed')); });
      }, 600);
    } });
    [title, artist, file, st, btn].forEach(function (x) { form.appendChild(x); }); p.appendChild(form); p.appendChild(out);
    p.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin:0 0 8px', text: '⚡ Auto = this sound may be added by itself to new photos (when none is marked, the most used sounds are chosen).' }));
    p.appendChild(list); list.appendChild(empty('Loading…'));
    adm('/api/admin/sounds', {}).then(function (d) {
      list.textContent = ''; if (!d.success) { list.appendChild(empty(d.error || 'Could not load.')); return; } if (!d.sounds.length) { list.appendChild(empty('No sounds yet.')); return; }
      d.sounds.forEach(function (sn) {
        var tg = el('button', { class: 'btn-sm ' + (sn.active ? 'btn-red' : 'btn-blue'), text: sn.active ? 'Turn off' : 'Turn on', onclick: function () { adm('/api/admin/sounds/toggle', { id: sn.id, active: !sn.active }).then(function () { loadSoundsAdmin(); }); } });
        var ab = el('button', { class: 'btn-sm ' + (sn.auto ? 'btn-blue' : ''), text: sn.auto ? '⚡ Auto ✓' : '⚡ Auto', onclick: function () { adm('/api/admin/sounds/auto', { id: sn.id, on: !sn.auto }).then(function () { loadSoundsAdmin(); }); } });
        var au = el('audio', { controls: 'controls', preload: 'none', src: sn.url, style: 'height:32px;max-width:220px' });
        list.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid #e4e6eb;border-radius:10px;padding:8px 12px;margin-bottom:6px' }, [
          el('div', { style: 'flex:1;min-width:140px' }, [el('b', { text: (sn.active ? '' : '⛔ ') + (sn.original ? 'From a video of ' + sn.owner : sn.title) }), el('div', { style: 'font-size:12px;color:#65676b', text: (sn.artist ? sn.artist + ' · ' : '') + sn.duration + 's · used ' + sn.uses + '×' })]), au, ab, tg]));
      });
    });
  }
  function loadLiveAdmin() {
    var p = document.getElementById('panel-live'); if (!p) return; p.textContent = '';
    var out = el('div'), reqBox = el('div'), box = el('div'); p.appendChild(out); p.appendChild(reqBox); p.appendChild(box); box.appendChild(empty('Loading…'));
    var PURP = { news: 'News / journalism', business: 'Business', event: 'Event', education: 'Education', other: 'Other' };
    adm('/api/admin/live/requests', {}).then(function (q) {
      reqBox.textContent = ''; if (!q.success) return;
      setLiveBadge(q.pending);
      reqBox.appendChild(el('div', { style: 'font-weight:800;margin:4px 0 8px', text: '📝 Live requests (' + q.pending + ' waiting)' }));
      var shown = q.requests.filter(function (r) { return r.status === 'pending'; });
      if (!shown.length) reqBox.appendChild(empty('No requests waiting.'));
      shown.forEach(function (r) {
        var ok = el('button', { class: 'btn-sm btn-blue', text: 'Approve', onclick: function () { adm('/api/admin/live/decide', { id: r.id, approve: true }).then(function (x) { msg(out, x.success, x.success ? '✅ Approved' : '❌ ' + (x.error || 'Failed')); loadLiveAdmin(); }); } });
        var no = el('button', { class: 'btn-sm btn-red', text: 'Refuse', onclick: function () { var why = prompt('Reason for refusing (the person will see it):', ''); if (!why) return; adm('/api/admin/live/decide', { id: r.id, approve: false, note: why }).then(function (x) { msg(out, x.success, x.success ? '✅ Refused' : '❌ ' + (x.error || 'Failed')); loadLiveAdmin(); }); } });
        reqBox.appendChild(el('div', { style: 'background:#fffaf0;border:1px solid #f5d9a8;border-radius:10px;padding:10px 12px;margin-bottom:8px' }, [
          el('div', { style: 'font-weight:700', text: r.name + (r.public_id ? ' · ID ' + r.public_id : '') + ' — ' + (PURP[r.purpose] || r.purpose) }),
          el('div', { style: 'font-size:13.5px;margin:4px 0;white-space:pre-wrap', text: r.message }),
          el('div', { style: 'font-size:12.5px;color:#65676b', text: (r.channelName ? 'Name to show: ' + r.channelName + ' · ' : '') + (r.link ? 'Link: ' + r.link + ' · ' : '') + 'sent ' + ago(r.requested_at) }),
          el('div', { style: 'margin-top:8px' }, [ok, no])]));
      });
    });
    adm('/api/admin/live', {}).then(function (d) {
      box.textContent = ''; if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      p.insertBefore(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: (d.configured ? '✅ Live is switched on.' : '⚠️ Live is OFF: add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_TOKEN in Render.') + ' Max ' + d.maxViewers + ' viewers per live, max ' + d.maxMinutes + ' minutes. Lives are never recorded. Only approved Creators can go live.' }), out);
      if (!d.lives.length) { box.appendChild(empty('No lives yet.')); return; }
      d.lives.forEach(function (l) {
        var on = l.status !== 'ended';
        var stop = el('button', { class: 'btn-sm btn-red', text: 'Stop', onclick: function () {
          var why = prompt('Reason (the Creator will see it):', ''); if (why === null) return;
          var blk = confirm('Also turn Live OFF for this Creator? (OK = yes, Cancel = only stop this live)');
          adm('/api/admin/live/stop', { id: l.id, reason: why, block: blk }).then(function (x) { msg(out, x.success, x.success ? '✅ Stopped' : '❌ ' + (x.error || 'Failed')); loadLiveAdmin(); }); } });
        var allow = el('button', { class: 'btn-sm btn-blue', text: l.live_blocked ? 'Allow Live again' : 'Block Live', onclick: function () {
          adm('/api/admin/live/allow', { id: l.id, blocked: !l.live_blocked }).then(function (x) { msg(out, x.success, x.success ? '✅ Saved' : '❌ ' + (x.error || 'Failed')); loadLiveAdmin(); }); } });
        box.appendChild(el('div', { style: 'background:#fff;border:1px solid #e4e6eb;border-radius:10px;padding:10px 12px;margin-bottom:8px' }, [
          el('div', { style: 'font-weight:700', text: (on ? '🔴 ' : '⚪ ') + nm({ first_name: l.name }) + (l.title ? ' — ' + l.title : '') + (l.live_blocked ? ' (Live blocked)' : '') }),
          el('div', { style: 'font-size:12.5px;color:#65676b;margin:3px 0 8px', text: (on ? 'On air since ' + fmt(l.started_at) : 'Ended ' + ago(l.ended_at) + (l.ended_by ? ' · stopped by admin' : '') + (l.end_reason ? ' · ' + l.end_reason : '')) + ' · peak ' + l.peak + ' · ' + l.total + ' people watched' }),
          el('div', { style: 'display:flex;gap:8px' }, (on ? [stop, allow] : [allow]))]));
      });
    });
  }
  // 💰 the owner's Telegram: payments to check come there with ✅ / ❌ (ads and coin top-ups)
  // 💳 the ad wallets: ABA PayWay on / off, the money each advertiser has, the top-ups, adding / taking money by hand (Super Admin)
  function adWalletCard(p) {
    var box = el('div', { class: 'at-card', style: 'margin-bottom:14px' }); p.appendChild(box);
    var ST = { pending: AT('⏳ រង់ចាំ', '⏳ waiting'), paid: AT('✅ បានបង់', '✅ paid'), expired: AT('⌛ ផុតកំណត់', '⌛ ended'), failed: AT('❌ QR មិនបាន', '❌ QR failed'), rejected: AT('❌ មិនទាន់ទទួល', '❌ not received') };
    function usd(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }
    function draw() {
      adm('/api/admin/ad-wallet', { action: 'list' }).then(function (d) {
        box.textContent = '';
        box.appendChild(el('div', { class: 'at-h', text: AT('💳 កាបូបពាណិជ្ជកម្ម (ABA PayWay)', '💳 Ad wallets (ABA PayWay)') }));
        if (!d.success) { box.appendChild(el('div', { text: d.error || AT('មិនបាន', 'Failed') })); return; }
        box.appendChild(el('div', { style: 'font-size:13.5px;line-height:1.7;color:#444', text: d.payway
          ? (d.sandbox ? AT('🧪 PayWay បើកហើយ — កំពុងសាកល្បង (Sandbox) មិនមែនលុយពិត។ ពេលរួចរាល់ ប្ដូរ KEY ទាំង ៥ ក្នុង Render ទៅជា Production។', '🧪 PayWay is on — testing (Sandbox), not real money. When ready, change the 5 KEYs in Render to Production.')
            : AT('✅ PayWay បើកហើយ (លុយពិត)។ អ្នកផ្សាយបញ្ចូលលុយតាម KHQR ហើយលុយចូលកាបូបដោយខ្លួនឯង បន្ទាប់ពី CamFeed សួរ PayWay ម្ដងទៀត។', '✅ PayWay is on (real money). Advertisers add money by KHQR; it goes in by itself after CamFeed asks PayWay again.'))
          : AT('PayWay មិនទាន់បើកទេ។ ដាក់ក្នុង Render › Environment៖ PAYWAY_MERCHANT_ID, PAYWAY_API_KEY, PAYWAY_API_URL (និង RSA ពីរ)។ ពេលបិទ ការបង់ប្រាក់ធ្វើតាមវិធីចាស់ (ពិនិត្យដោយដៃក្នុង Telegram)។', 'PayWay is not on yet. Put in Render › Environment: PAYWAY_MERCHANT_ID, PAYWAY_API_KEY, PAYWAY_API_URL (and the two RSA keys). While it is off, payments use the old way (checked by hand in Telegram).') }));
        if (d.lastError) box.appendChild(el('div', { style: 'font-size:12.5px;color:#b42318;margin-top:6px', text: AT('⚠️ បញ្ហាចុងក្រោយ៖ ', '⚠️ Last problem: ') + d.lastError }));
        // 📲 the simple way: CamFeed's own ABA link + ✅ in Telegram
        var lk = el('input', { class: 'at-in', type: 'url', value: d.abaLink || '', placeholder: 'https://link.payway.com.kh/…', style: 'flex:1;min-width:220px' });
        box.appendChild(el('div', { style: 'font-weight:800;margin-top:12px', text: AT('📲 បង់តាម QR / link ABA (ពាណិជ្ជកម្ម និងទិញពេជ្រ · ពិនិត្យក្នុង Telegram)', '📲 Pay by ABA QR / link (ads and diamonds · checked in Telegram)') }));
        box.appendChild(el('div', { style: 'font-size:13px;color:#555;line-height:1.6', text: d.manual
          ? AT('✅ កំពុងប្រើ៖ អ្នកផ្សាយស្កេន QR ឬបើក link ហើយបង់ រួចដាក់រូបវិក្កយបត្រ។ Telegram ផ្ញើរូបវិក្កយបត្រ ✅ / ❌ មកអ្នក។ ដក link និងរូប QR ចេញ ដើម្បីប្រើ QR PayWay វិញ។', '✅ In use: advertisers scan the QR or open the link, pay, and add the receipt photo. Telegram sends you the receipt with ✅ / ❌. Remove the link and the QR picture to use the PayWay QR again.')
          : AT('ដាក់ link ABA និង/ឬ រូប QR ABA របស់អ្នក ដើម្បីឲ្យអ្នកផ្សាយបង់តាមវា (ប្រើជំនួស QR PayWay)។', 'Put your ABA link and/or ABA QR picture so advertisers pay by it (used instead of the PayWay QR).') }));
        box.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center' }, [lk,
          d.isSuperAdmin ? el('button', { class: 'btn-sm', text: AT('💾 រក្សាទុក', '💾 Save'), onclick: function () { adm('/api/admin/ad-wallet', { action: 'settings', abaLink: lk.value.trim() }).then(function (x) { if (!x.success) alert(x.error || 'Failed'); draw(); }); } }) : el('span')]));
        // the picture of CamFeed's ABA QR (shown to advertisers to scan)
        var qrRow = el('div', { class: 'at-row', style: 'gap:10px;margin-top:8px;flex-wrap:wrap;align-items:center' });
        if (d.abaQr) qrRow.appendChild(el('img', { src: d.abaQr, alt: 'QR', style: 'width:110px;height:110px;object-fit:contain;border:1px solid #e4e6eb;border-radius:10px;background:#fff' }));
        if (d.isSuperAdmin) {
          var qf = el('input', { type: 'file', accept: 'image/*', style: 'font-size:13px' }), qm = el('span', { style: 'font-size:12.5px;color:#65676b' });
          qf.addEventListener('change', function () {
            var f = qf.files && qf.files[0]; if (!f) return; qm.textContent = AT('កំពុងអាប់ឡូត…', 'Uploading…');
            fetch('/api/videos/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: currentUser.email, file_name: f.name || 'aba-qr.jpg', content_type: f.type || 'image/jpeg' }) })
              .then(function (r) { return r.json(); })
              .then(function (u) {
                if (!u.uploadUrl) throw new Error(u.error || 'Upload not allowed');
                return fetch(u.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.type || 'image/jpeg' }, body: f }).then(function (r) {
                  if (!r.ok) throw new Error('Upload failed (' + r.status + ')');
                  return adm('/api/admin/ad-wallet', { action: 'settings', abaQr: u.publicUrl });
                });
              }).then(function (x) { if (x && !x.success) alert(x.error || 'Failed'); draw(); })
              .catch(function (e) { qm.textContent = '❌ ' + e.message; });
          });
          qrRow.appendChild(el('span', { style: 'font-size:13px;font-weight:700', text: AT('🖼️ រូប QR ABA របស់ CamFeed៖', '🖼️ CamFeed\'s ABA QR picture:') }));
          qrRow.appendChild(qf); qrRow.appendChild(qm);
          if (d.abaQr) qrRow.appendChild(el('button', { class: 'btn-sm btn-gray', text: AT('🗑️ ដករូប QR', '🗑️ Remove QR'), onclick: function () { if (confirm(AT('ដករូប QR មែនទេ?', 'Remove the QR picture?'))) adm('/api/admin/ad-wallet', { action: 'settings', abaQr: '' }).then(draw); } }));
        }
        box.appendChild(qrRow);
        // 📋 for ABA support: the last requests / answers of PayWay (hash hidden, no keys)
        if (d.isSuperAdmin) {
          var lg = el('textarea', { class: 'at-in', rows: '8', readonly: 'readonly', style: 'width:100%;font-family:monospace;font-size:11.5px' });
          lg.value = (d.talks && d.talks.length) ? JSON.stringify(d.talks, null, 2) : AT('មិនទាន់មានទេ។ សូមសាកបង្កើត QR PayWay ម្ដងសិន (លុប link និងរូប QR ចេញបណ្ដោះអាសន្ន) រួចចុចមើលម្ដងទៀត។', 'Nothing yet. Make one PayWay QR first (remove the link and QR picture for a moment), then look again.');
          box.appendChild(el('details', { style: 'margin-top:12px' }, [
            el('summary', { style: 'cursor:pointer;font-weight:800', text: AT('📋 កំណត់ត្រា PayWay (សម្រាប់ផ្ញើទៅ ABA)', '📋 PayWay log (to send to ABA)') }),
            el('div', { style: 'font-size:12.5px;color:#555;margin:6px 0', text: AT('មិនមាន KEY ឬលេខសម្ងាត់ទេ (hash ត្រូវបានលាក់)។ អាចចម្លងផ្ញើទៅ ABA បាន។', 'No KEY or secret inside (the hash is hidden). Safe to copy and send to ABA.') }),
            lg,
            el('button', { class: 'btn-sm', text: AT('📋 ចម្លង', '📋 Copy'), onclick: function () { lg.select(); try { navigator.clipboard.writeText(lg.value); } catch (e) { document.execCommand('copy'); } } })
          ]));
        }
        // the rules
        var mn = el('input', { class: 'at-in', type: 'number', min: '1', value: d.cfg.minUsd, style: 'max-width:110px' }), mx = el('input', { class: 'at-in', type: 'number', min: '1', value: d.cfg.maxUsd, style: 'max-width:110px' });
        box.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center' }, [
          el('span', { text: AT('បញ្ចូលតិចបំផុត $', 'Smallest top-up $') }), mn, el('span', { text: AT('ច្រើនបំផុត $', 'Biggest $') }), mx,
          d.isSuperAdmin ? el('button', { class: 'btn-sm', text: AT('💾 រក្សាទុក', '💾 Save'), onclick: function () { adm('/api/admin/ad-wallet', { action: 'settings', minUsd: Number(mn.value), maxUsd: Number(mx.value) }).then(draw); } }) : el('span')
        ]));
        // the wallets
        box.appendChild(el('div', { style: 'font-weight:800;margin-top:14px', text: AT('កាបូបរបស់អ្នកផ្សាយ', 'Advertisers\' wallets') + ' (' + d.people.length + ')' }));
        d.people.forEach(function (u) {
          var row = el('div', { class: 'at-row', style: 'gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #f0f2f5;padding-bottom:6px' }, [
            el('span', { style: 'flex:1;min-width:180px', text: ((u.first_name || '') + ' ' + (u.last_name || '')).trim() + ' · ' + usd(u.balance) })
          ]);
          if (d.isSuperAdmin) row.appendChild(el('button', { class: 'btn-sm btn-gray', text: AT('± កែលុយ', '± Change'), onclick: function () {
            var v = prompt(AT('ចំនួន (ដុល្លារ) — បូក = បញ្ចូល, ដក (−) = ដកចេញ', 'Amount (USD) — plus = add, minus (−) = take')); if (!v) return;
            var why = prompt(AT('មូលហេតុ (អ្នកផ្សាយនឹងឃើញ)', 'Reason (the advertiser will see it)')); if (!why) return;
            adm('/api/admin/ad-wallet', { action: 'adjust', targetEmail: u.email, usd: Number(String(v).replace('−', '-').replace('$', '')), note: why }).then(function (x) { if (!x.success) alert(x.error || 'Failed'); draw(); });
          } }));
          box.appendChild(row);
        });
        // the top-ups
        box.appendChild(el('div', { style: 'font-weight:800;margin-top:14px', text: AT('ការបញ្ចូលលុយចុងក្រោយ', 'Latest top-ups') }));
        d.topups.slice(0, 30).forEach(function (t) {
          var row = el('div', { class: 'at-row', style: 'gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center;font-size:13.5px' }, [
            el('span', { style: 'flex:1;min-width:200px', text: 'W' + t.id + ' · ' + ((t.first_name || '') + ' ' + (t.last_name || '')).trim() + ' · ' + usd(t.cents) + ' · ' + (ST[t.status] || t.status) + ' · ' + (t.created_at ? new Date(t.created_at).toLocaleString() : '') })
          ]);
          if (t.method === 'manual') {
            var rc = String(t.note || '').split(' · ').filter(function (x) { return /^https:\/\//.test(x); })[0], rf = String(t.note || '').split(' · ').filter(function (x) { return !/^https:\/\//.test(x); }).join(' · ');
            row.firstChild.textContent += ' · 📲 ABA' + (rf ? ' · 🧾 ' + rf : '');
            if (rc) row.appendChild(el('a', { href: rc, target: '_blank', rel: 'noopener noreferrer', text: AT('🖼️ វិក្កយបត្រ', '🖼️ Receipt'), style: 'font-size:13px' }));
          }
          if (d.isSuperAdmin && t.method === 'manual' && t.status === 'pending') {
            row.appendChild(el('button', { class: 'btn-sm', text: AT('✅ បានទទួល', '✅ Received'), onclick: function () { if (confirm(AT('ឃើញលុយ ' + usd(t.cents) + ' ចូល ABA ហើយមែនទេ?', 'Did you see ' + usd(t.cents) + ' in ABA?'))) adm('/api/admin/ad-wallet', { action: 'decide', id: t.id, ok: true }).then(function (x) { if (!x.success) alert(x.error || 'Failed'); draw(); }); } }));
            row.appendChild(el('button', { class: 'btn-sm btn-gray', text: AT('❌ មិនទាន់ទទួល', '❌ Not received'), onclick: function () { adm('/api/admin/ad-wallet', { action: 'decide', id: t.id, ok: false }).then(function (x) { if (!x.success) alert(x.error || 'Failed'); draw(); }); } }));
          } else if (d.isSuperAdmin && t.method !== 'manual' && (t.status === 'pending' || t.status === 'expired')) row.appendChild(el('button', { class: 'btn-sm btn-gray', text: AT('🔄 សួរ PayWay ម្ដងទៀត', '🔄 Ask PayWay again'), onclick: function () { adm('/api/admin/ad-wallet', { action: 'recheck', id: t.id }).then(draw); } }));
          box.appendChild(row);
        });
      });
    }
    draw();
  }

  function tgPayCard(p) {
    var box = el('div', { class: 'at-card', style: 'margin-bottom:14px' }); p.appendChild(box);
    function draw() {
      adm('/api/admin/tg-pay', {}).then(function (d) {
        box.textContent = '';
        box.appendChild(el('div', { class: 'at-h', text: AT('💰 Telegram សម្រាប់ពិនិត្យការបង់ប្រាក់', '💰 Telegram for checking payments') }));
        if (!d.success) { box.appendChild(el('div', { text: d.error || AT('មិនបាន', 'Failed') })); return; }
        if (!d.on) {
          box.appendChild(el('div', { style: 'font-size:13.5px;color:#444;line-height:1.7;white-space:pre-wrap', text: AT(
            'មិនទាន់បើកទេ។\n១) ក្នុង Telegram បើក @BotFather → /newbot → បង្កើត Bot ថ្មីមួយសម្រាប់តែការបង់ប្រាក់។\n២) Render › Camfeed-1 › Environment៖ បន្ថែម KEY ឈ្មោះ TG_PAY_BOT_TOKEN ហើយដាក់ Token ដែល BotFather ផ្ដល់ឲ្យ (កុំផ្ញើ Token ទៅអ្នកណាទាល់តែសោះ)។\n៣) Deploy រួចត្រឡប់មកទីនេះវិញ ហើយចុច «ភ្ជាប់ Telegram របស់ខ្ញុំ»។',
            'Off.\n1) In Telegram open @BotFather → /newbot → make a NEW bot only for payments.\n2) Render › Camfeed-1 › Environment: add the KEY TG_PAY_BOT_TOKEN with the token from BotFather (never send the token to anyone).\n3) Deploy, come back here and press "Link my Telegram".') }));
          return;
        }
        if (!d.bot) box.appendChild(el('div', { style: 'font-size:13px;color:#b42318;margin-bottom:8px;white-space:pre-wrap', text: AT('⚠️ Telegram មិនទទួលស្គាល់ Bot ទេ។ ', '⚠️ Telegram did not accept the bot. ') + (d.botError || '') + '\nToken: ' + (d.tokenShape || '') + (/401/.test(d.botError || '') ? AT('\n→ 401 = Token ខុស។ ចម្លងម្ដងទៀតពី @BotFather › /mybots › Bot របស់អ្នក › API Token។', '\n→ 401 = the token is wrong. Copy it again from @BotFather › /mybots › your bot › API Token.') : '') }));
        if (d.hook && d.hook.lastError) box.appendChild(el('div', { style: 'font-size:12.5px;color:#92400e;margin-bottom:6px', text: AT('បញ្ហាចុងក្រោយ (Telegram → CamFeed)៖ ', 'Last problem (Telegram → CamFeed): ') + d.hook.lastError + (d.hook.pending ? ' · ' + d.hook.pending + AT(' កំពុងរង់ចាំ', ' waiting') : '') + AT(' (បាត់ទៅវិញពេលសារបន្ទាប់ដំណើរការ)', ' (it clears after the next message works)') }));
        box.appendChild(el('div', { style: 'font-size:13.5px;color:#444;margin-bottom:8px;line-height:1.6', text: 'Bot: @' + (d.bot || '?') + ' · ' + AT(
          'ពេលអ្នកផ្សាយពាណិជ្ជកម្មចុច «ខ្ញុំបានបង់ហើយ» ឬមាននរណាម្នាក់ទិញពេជ្រ សារមួយនឹងមកដល់ Telegram ខាងក្រោម ជាមួយប៊ូតុង ✅ បានទទួលប្រាក់ / ❌ មិនទាន់ទទួល។ ចុច ✅ = ពាណិជ្ជកម្មចាប់ផ្ដើម ឬពេជ្រចូលគណនីភ្លាម។',
          'When an advertiser presses "I paid" or someone buys diamonds, a message comes to the Telegram accounts below with ✅ received / ❌ not received. Pressing ✅ starts the ad / adds the diamonds at once.') }));
        (d.chats || []).forEach(function (c) {
          box.appendChild(el('div', { class: 'at-row', style: 'gap:8px;padding:6px 0;border-bottom:1px solid #eef0f2' }, [el('b', { text: '✅ ' + (c.name || c.chat_id) }), el('span', { style: 'font-size:12px;color:#65676b;flex:1', text: AT('ភ្ជាប់ដោយ ', 'linked by ') + (c.linked_by || '—') + ' · ' + ago(c.linked_at) }),
            el('button', { class: 'btn-sm btn-gray', text: AT('ផ្ដាច់', 'Unlink'), onclick: function () { if (confirm(AT('ផ្ដាច់ Telegram នេះមែនទេ?', 'Unlink this Telegram?'))) adm('/api/admin/tg-pay', { action: 'unlink', chat_id: c.chat_id }).then(draw); } })]));
        });
        if (!(d.chats || []).length) box.appendChild(el('div', { style: 'font-size:13px;color:#b42318', text: AT('មិនទាន់ភ្ជាប់ Telegram ណាមួយទេ។', 'No Telegram linked yet.') }));
        var info = el('div', { style: 'margin-top:8px;font-size:13px' });
        box.appendChild(el('div', { class: 'at-row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, [
          el('button', { class: 'btn-sm', text: AT('🔗 ភ្ជាប់ Telegram របស់ខ្ញុំ', '🔗 Link my Telegram'), onclick: function () {
            adm('/api/admin/tg-pay', { action: 'link' }).then(function (x) {
              info.textContent = ''; if (!x.success) { info.textContent = x.error || AT('មិនបាន', 'Failed'); return; }
              info.appendChild(el('div', { text: AT('បើកតំណនេះនៅលើទូរស័ព្ទដែលមាន Telegram របស់អ្នក (ប្រើបាន ១៥ នាទី និងតែម្ដង)៖', 'Open this on the phone that has YOUR Telegram (works for 15 minutes, one time):') }));
              if (x.link) info.appendChild(el('a', { href: x.link, target: '_blank', rel: 'noopener', style: 'font-weight:700;word-break:break-all', text: x.link }));
              info.appendChild(el('div', { style: 'margin-top:4px', text: AT('ឬផ្ញើបន្ទាត់នេះទាំងមូលទៅ Bot៖', 'Or send this whole line to the bot:') }));
              info.appendChild(el('code', { text: '/start ' + x.code }));
              info.appendChild(el('div', { style: 'color:#65676b', text: AT('បន្ទាប់មកចុច ↻ នៅទីនេះ។', 'Then press ↻ here.') }));
            });
          } }),
          el('button', { class: 'btn-sm btn-gray', text: AT('🧪 ផ្ញើសារសាកល្បង', '🧪 Send a test'), onclick: function () { adm('/api/admin/tg-pay', { action: 'test' }); } }),
          el('button', { class: 'btn-sm btn-gray', text: '↻', onclick: draw })]));
        box.appendChild(info);
      });
    }
    draw();
  }
  // ⚙️ how ads are shown: the Admin changes these numbers at any time (no new app needed)
  function adSettingsCard(p) {
    var box = el('div', { class: 'at-card', style: 'margin-bottom:14px' }); p.appendChild(box);
    var ROWS = [
      ['firstAfter', AT('ពាណិជ្ជកម្មដំបូង៖ បង្ហាញក្រោយការបង្ហោះទីប៉ុន្មាន', 'First ad: shown after how many posts'), AT('ឧ. 6 = អ្នកប្រើអូសមើលការបង្ហោះ 6 ហើយទើបឃើញពាណិជ្ជកម្មដំបូង។', 'e.g. 6 = people scroll past 6 posts, then see the first ad.')],
      ['every', AT('ពាណិជ្ជកម្មបន្ទាប់ៗ៖ ម្ដងក្នុងរៀងរាល់ប៉ុន្មានការបង្ហោះ', 'Next ads: once every how many posts'), AT('ឧ. 50 = ក្រោយពាណិជ្ជកម្មដំបូង ពាណិជ្ជកម្មបន្ទាប់លេចឡើងរៀងរាល់ 50 ការបង្ហោះ។ លេខធំ = ពាណិជ្ជកម្មតិច។', 'e.g. 50 = after the first ad, the next one comes every 50 posts. Bigger number = fewer ads.')],
      ['reelFirst', AT('🎬 វីដេអូ៖ ពាណិជ្ជកម្មដំបូង បង្ហាញក្រោយវីដេអូទីប៉ុន្មាន', '🎬 Videos: first ad after how many videos'), AT('ឧ. 6 = មើលវីដេអូ 6 ហើយទើបឃើញពាណិជ្ជកម្មដំបូង។', 'e.g. 6 = watch 6 videos, then the first ad.')],
      ['reelEvery', AT('🎬 វីដេអូ៖ ពាណិជ្ជកម្មបន្ទាប់ៗ ម្ដងក្នុងរៀងរាល់ប៉ុន្មានវីដេអូ', '🎬 Videos: next ads once every how many videos'), AT('ឧ. 10', 'e.g. 10')],
      ['reelGapMin', AT('🎬 វីដេអូ៖ យ៉ាងតិចប៉ុន្មាននាទី រវាងពាណិជ្ជកម្មពីរ', '🎬 Videos: at least how many minutes between two ads'), AT('ឧ. 5 = ទោះអូសលឿនក៏ដោយ ពាណិជ្ជកម្មមិនលោតញឹកជាង 5 នាទីម្ដង។', 'e.g. 5 = even when scrolling fast, not more than one ad every 5 minutes.')],
      ['reelEarnersOnly', AT('🎬 វីដេអូ៖ ពាណិជ្ជកម្មលើវីដេអូរបស់អ្នកណា? 0 = អ្នកប្រើទាំងអស់ · 1 = តែអ្នកមានសិទ្ធិរកលុយ', '🎬 Videos: ads on whose videos? 0 = everyone · 1 = only creators who can earn'), AT('1 = ពាណិជ្ជកម្មមុនវីដេអូ លោតតែលើវីដេអូរបស់អ្នកដែលបានអនុម័តឲ្យរកលុយ។ 0 = លោតលើវីដេអូទាំងអស់។', '1 = video ads only come before videos of creators approved to earn. 0 = before every video.')],
      ['storyEvery', AT('📖 ស្តូរី៖ ពាណិជ្ជកម្មម្ដងក្នុងរៀងរាល់ប៉ុន្មានមនុស្ស', '📖 Stories: one ad every how many people'), AT('ឧ. 4', 'e.g. 4')],
      ['sameMax', AT('ពាណិជ្ជកម្មមួយដដែល៖ មនុស្សម្នាក់ឃើញច្រើនបំផុតប៉ុន្មានដងក្នុងមួយថ្ងៃ', 'One same ad: the most times one person sees it in a day'), AT('រួមទាំងការឃើញលើកដំបូង។ ឧ. 3។', 'Including the first time. e.g. 3.')],
      ['gapMin', AT('ពាណិជ្ជកម្មមួយដដែល៖ ត្រូវរង់ចាំប៉ុន្មាននាទី ទើបឃើញម្ដងទៀត', 'One same ad: minutes to wait before the same person sees it again'), AT('ឧ. 180 = 3 ម៉ោង · 60 = 1 ម៉ោង · ពេលសាកល្បង ដាក់ 2 ឬ 5 នាទី។', 'e.g. 180 = 3 hours · 60 = 1 hour · for testing put 2 or 5 minutes.')],
      ['totalPerDay', AT('ពាណិជ្ជកម្មសរុប៖ មនុស្សម្នាក់ឃើញច្រើនបំផុតប៉ុន្មានក្នុងមួយថ្ងៃ', 'All ads together: the most one person sees in a day'), AT('ទោះមានអ្នកផ្សាយច្រើនប៉ុណ្ណាក៏ដោយ។ ឧ. 20។', 'However many advertisers there are. e.g. 20.')],
      ['cpmFeed', AT('តម្លៃ (ដុល្លារ) ក្នុង 1,000 ដងបង្ហាញ នៅទំព័រដើម', 'Price (USD) per 1,000 views in the home feed'), AT('ឧ. 0.50', 'e.g. 0.50')],
      ['cpmVideo', AT('តម្លៃ (ដុល្លារ) ក្នុង 1,000 ដងបង្ហាញ មុនវីដេអូ', 'Price (USD) per 1,000 views before videos'), AT('ឧ. 0.80', 'e.g. 0.80')],
      ['minBudget', AT('ថវិកាតិចបំផុតសម្រាប់ពាណិជ្ជកម្មមួយ (ដុល្លារ)', 'Smallest budget for one ad (USD)'), AT('ឧ. 2', 'e.g. 2')],
    ];
    adm('/api/admin/ads/settings', {}).then(function (d) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'at-h', text: AT('⚙️ ការកំណត់ការបង្ហាញពាណិជ្ជកម្ម', '⚙️ How ads are shown') }));
      if (!d.success) { box.appendChild(el('div', { text: d.error || AT('មិនបាន', 'Failed') })); return; }
      box.appendChild(el('div', { style: 'font-size:13.5px;color:#444;margin-bottom:10px;line-height:1.6', text: AT('ពាណិជ្ជកម្មដែលអ្នកប្រើមិនទាន់ធ្លាប់ឃើញ បង្ហាញមុនគេ។ ពាណិជ្ជកម្មដែលធ្លាប់ឃើញហើយ បង្ហាញម្ដងទៀតបាន តាមចំនួនដង និងម៉ោងខាងក្រោម។ ប្ដូរលេខណាមួយហើយចុច «រក្សាទុក»។ App មិនចាំបាច់ Build ថ្មីទេ។',
        'Ads a person has never seen come first. Ads already seen can come back, within the times and hours below. Change any number and press "Save". No new app is needed.') }));
      var inputs = {};
      ROWS.forEach(function (r) {
        var lim = (d.limits || {})[r[0]] || [0, 1000];
        var inp = el('input', { class: 'at-in', type: 'number', step: ['cpmFeed', 'cpmVideo', 'minBudget'].indexOf(r[0]) >= 0 ? '0.01' : '1', min: String(lim[0]), max: String(lim[1]), value: String(d.settings[r[0]]), style: 'max-width:140px' });
        inputs[r[0]] = inp;
        box.appendChild(el('div', { style: 'padding:10px 0;border-bottom:1px solid #eef0f2' }, [
          el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:3px', text: r[1] }),
          el('div', { style: 'font-size:12.5px;color:#65676b;margin-bottom:6px', text: r[2] + ' ' + AT('(ចន្លោះ ', '(from ') + lim[0] + AT(' ដល់ ', ' to ') + lim[1] + ')' }), inp]));
      });
      var msg = el('div', { style: 'margin-top:8px;font-size:13px' });
      box.appendChild(el('div', { style: 'margin-top:12px' }, [el('button', { class: 'btn-sm', text: AT('💾 រក្សាទុក', '💾 Save'), onclick: function () {
        var set = {}; Object.keys(inputs).forEach(function (k) { set[k] = Number(inputs[k].value); });
        adm('/api/admin/ads/settings', { set: set }).then(function (x) { msg.textContent = x.success ? AT('✅ បានរក្សាទុក។', '✅ Saved.') : ('❌ ' + (x.error || '')); if (x.success) Object.keys(inputs).forEach(function (k) { inputs[k].value = String(x.settings[k]); }); });
      } }), msg]));
    });
  }
  // 📜 what may never be advertised (⛔) or only to adults (🔞 18+); the AI checks each new ad against this list
  function adRulesCard(p) {
    var box = el('div', { class: 'at-card', style: 'margin-bottom:14px' }); p.appendChild(box);
    function ruleSel(v) { var x = el('select', { class: 'at-in', style: 'flex:1;min-width:150px' }, [el('option', { value: 'block', text: AT('⛔ មិនអនុញ្ញាត', '⛔ Not allowed') }), el('option', { value: 'adult', text: AT('🔞 តែអ្នកអាយុ 18+', '🔞 18+ only') })]); x.value = v || 'block'; return x; }
    function draw(d) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'at-h', text: AT('📜 គោលការណ៍ពាណិជ្ជកម្ម', '📜 Ad rules') }));
      box.appendChild(el('div', { style: 'font-size:13.5px;color:#444;margin-bottom:8px;line-height:1.6', text: AT(
        'AI ពិនិត្យពាណិជ្ជកម្មថ្មីនីមួយៗ (រូប និងអត្ថបទ) ហើយប្រាប់អ្នកក្នុង Telegram ប្រសិនបើវាទំនងជាប៉ះពាល់នឹងប្រភេទណាមួយខាងក្រោម។ ⛔ = មិនអនុញ្ញាតទាល់តែសោះ។ 🔞 = បង្ហាញតែអ្នកដែលយើងដឹងថាមានអាយុ 18 ឡើងទៅ។ AI គ្រាន់តែព្រមាន៖ អ្នកជាអ្នកសម្រេចដោយចុច ✅ ឬ ❌។ សូមឲ្យអ្នកជំនាញច្បាប់ពិនិត្យបញ្ជីនេះ មុនដាក់ជូនក្រសួង។',
        'The AI looks at every new ad (pictures + text) and tells you in Telegram if it seems to touch one of these. ⛔ = never allowed. 🔞 = shown only to people we know are 18 or older. The AI only warns: you decide with ✅ / ❌. Have a lawyer check this list before you send it to a ministry.') }));
      (d.rules || []).forEach(function (r) {
        var km = el('input', { class: 'at-in', value: r.name_km, placeholder: AT('ឈ្មោះជាភាសាខ្មែរ', 'Khmer name'), style: 'flex:2;min-width:140px' }), en = el('input', { class: 'at-in', value: r.name_en, placeholder: AT('ឈ្មោះជាភាសាអង់គ្លេស', 'English name'), style: 'flex:2;min-width:140px' });
        var rule = ruleSel(r.rule);
        box.appendChild(el('div', { class: 'at-row', style: 'gap:6px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid #eef0f2' }, [km, en, rule,
          el('button', { class: 'btn-sm', text: AT('💾 រក្សាទុក', '💾 Save'), onclick: function () { adm('/api/admin/ad-rules', { action: 'edit', id: r.id, name_km: km.value, name_en: en.value, rule: rule.value }).then(function (x) { if (x.success) draw(x); }); } }),
          el('button', { class: 'btn-sm btn-gray', text: AT('🗑 លុប', '🗑 Delete'), onclick: function () { if (confirm(AT('លុបគោលការណ៍នេះមែនទេ?', 'Delete this rule?'))) adm('/api/admin/ad-rules', { action: 'delete', id: r.id }).then(function (x) { if (x.success) draw(x); }); } })]));
      });
      var nkm = el('input', { class: 'at-in', placeholder: AT('ឈ្មោះជាភាសាខ្មែរ', 'Khmer name'), style: 'flex:2;min-width:140px' }), nen = el('input', { class: 'at-in', placeholder: AT('ឈ្មោះជាភាសាអង់គ្លេស', 'English name'), style: 'flex:2;min-width:140px' });
      var nr = ruleSel('block');
      box.appendChild(el('div', { class: 'at-row', style: 'gap:6px;flex-wrap:wrap;margin-top:8px' }, [nkm, nen, nr, el('button', { class: 'btn-sm', text: AT('➕ បន្ថែម', '➕ Add'), onclick: function () { adm('/api/admin/ad-rules', { action: 'add', name_km: nkm.value, name_en: nen.value, rule: nr.value }).then(function (x) { if (x.success) draw(x); }); } })]));
    }
    adm('/api/admin/ad-rules', {}).then(function (d) { if (d && d.success) draw(d); else box.textContent = (d && d.error) || AT('មិនបាន', 'Failed'); });
  }
  function loadAdsAdmin() {
    var p = document.getElementById('panel-ads'); if (!p) return;
    p.textContent = '';
    tgPayCard(p);
    adWalletCard(p);
    adSettingsCard(p);
    adRulesCard(p);
    var out = el('div', { id: 'adMsg' });
    var name = el('input', { class: 'at-in', maxlength: '80', placeholder: 'e.g. RS Shop Cam' });
    var place = el('select', { class: 'at-in' }, [el('option', { value: 'feed_banner', text: '📱 Banner in the Feed (one after every 6 posts)' }), el('option', { value: 'video_preroll', text: '🎬 Video ad before reels (with Skip button)' })]);
    var cap = el('textarea', { class: 'at-in', rows: '2', maxlength: '500', placeholder: 'Special offer 50% today!' });
    var target = el('input', { class: 'at-in', placeholder: 'https://t.me/yourshop (optional)' });
    var media = el('input', { class: 'at-in', placeholder: 'Upload a file below, or paste a media.camfeedkh.com link' });
    var skip = el('input', { class: 'at-in', type: 'number', value: '5', min: '3', max: '15' });
    var file = el('input', { type: 'file', accept: 'image/*,video/mp4,video/webm,video/quicktime', style: 'font-size:13px' });
    var upMsg = el('div', { style: 'font-size:12.5px;color:#65676b;margin-top:4px' });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      upMsg.textContent = 'Uploading…';
      fetch('/api/videos/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: currentUser.email, file_name: f.name, content_type: f.type || 'application/octet-stream' }) })
        .then(function (r) { return r.json(); })
        .then(function (u) {
          if (!u.uploadUrl) throw new Error(u.error || 'Upload not allowed');
          return fetch(u.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f }).then(function (r) { if (!r.ok) throw new Error('Upload failed (' + r.status + ')'); media.value = u.publicUrl; upMsg.textContent = '✅ Uploaded'; });
        }).catch(function (e) { upMsg.textContent = '❌ ' + e.message; });
    });
    var launch = el('button', { class: 'btn-sm btn-blue', text: '🚀 Launch ad', onclick: function () {
      launch.disabled = true;
      adm('/api/admin/ads/create', { advertiser_name: name.value, placement: place.value, caption: cap.value, target_url: target.value, media_url: media.value, skip_seconds: skip.value }).then(function (d) {
        launch.disabled = false; msg(out, d.success, d.success ? '✅ Ad is live (#' + d.id + ')' : '❌ ' + (d.error || 'Failed'));
        if (d.success) { name.value = ''; cap.value = ''; target.value = ''; media.value = ''; file.value = ''; upMsg.textContent = ''; loadAdsList(); }
      });
    } });
    p.appendChild(el('div', { class: 'at-h', text: '📢 Create a Sponsored ad' }));
    p.appendChild(el('div', { class: 'at-grid' }, [el('div', {}, [el('div', { class: 'at-lbl', text: 'Advertiser / campaign' }), name]), el('div', {}, [el('div', { class: 'at-lbl', text: 'Where it shows' }), place]),
      el('div', {}, [el('div', { class: 'at-lbl', text: 'Link when tapped' }), target]), el('div', {}, [el('div', { class: 'at-lbl', text: 'Skip after (seconds, video ads)' }), skip])]));
    p.appendChild(el('div', { class: 'at-lbl', text: 'Caption' })); p.appendChild(cap);
    p.appendChild(el('div', { class: 'at-lbl', text: 'Picture or video' })); p.appendChild(file); p.appendChild(upMsg); p.appendChild(media);
    p.appendChild(el('div', { style: 'margin-top:12px' }, [launch])); p.appendChild(out);
    p.appendChild(el('div', { class: 'at-h', text: '📥 Requests from advertisers' })); p.appendChild(el('div', { id: 'adReqs' }));
    p.appendChild(el('div', { class: 'at-h', text: '📊 All campaigns' })); p.appendChild(el('div', { id: 'adsList' }));
    loadAdRequests(); loadAdsList();
  }
  var PLACE_TXT = { feed_banner: '📱 feed', video_preroll: '🎬 video (skip)', both: '✨ feed + video' };
  function adReportModal(id) {
    adm('/api/admin/ads/report', { id: id }).then(function (d) {
      if (!d.success) { alert(d.error || 'No report'); return; }
      var r = d.report, lines = ['Views: ' + r.views + ' (feed ' + r.feedViews + ', video ' + r.videoViews + ')', 'Reach: ' + r.reach, 'Clicks: ' + r.clicks + ' (CTR ' + r.ctr + '%)', 'Messages: ' + r.messages,
        'Skips: ' + r.skips + (r.skipRate !== null ? ' (' + r.skipRate + '%)' : '') + ', completed: ' + r.completes, 'Spent: $' + r.spent.toFixed(2) + ' of $' + r.budget.toFixed(2)];
      if (r.engagement) lines.push('Engagement: ' + r.engagement.reactions + ' reactions, ' + r.engagement.comments + ' comments, ' + r.engagement.shares + ' shares');
      alert('Ad #' + id + ' (' + r.status + ')\n\n' + lines.join('\n'));
    });
  }
  function loadAdRequests() {
    var box = document.getElementById('adReqs'); if (!box) return; box.textContent = ''; box.appendChild(empty('Loading…'));
    adm('/api/admin/ad-requests/list').then(function (d) {
      box.textContent = ''; if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      if (!d.requests.length) { box.appendChild(empty('No requests yet.')); return; }
      d.requests.forEach(function (r) {
        var price = el('input', { class: 'at-in', type: 'number', min: '0', step: '0.01', placeholder: 'Price USD', style: 'max-width:130px', value: r.price_cents ? (r.price_cents / 100).toFixed(2) : (r.budget_cents ? (r.budget_cents / 100).toFixed(2) : '') });
        var note = el('input', { class: 'at-in', placeholder: 'Note to advertiser (optional)', maxlength: '300', style: 'flex:1;min-width:160px' });
        var acts = el('div', { class: 'at-row', style: 'margin:8px 0 0' });
        var open = r.status === 'pending' || r.status === 'quoted' || r.status === 'payment_sent';
        if (r.status === 'pending' || r.status === 'quoted') { acts.appendChild(price); acts.appendChild(note); acts.appendChild(el('button', { class: 'btn-sm btn-blue', text: r.status === 'quoted' ? 'Update price' : 'Approve & ask payment', onclick: function () { adm('/api/admin/ad-requests/quote', { id: r.id, price_usd: price.value, note: note.value }).then(function (x) { if (!x.success) alert(x.error); loadAdRequests(); }); } })); }
        if ((r.status === 'quoted' || r.status === 'payment_sent') && d.isSuperAdmin) acts.appendChild(el('button', { class: 'btn-sm btn-blue', text: '✅ Money received - start ad', onclick: function () { if (confirm('Start this ad for ' + r.days + ' days? Only do this after the money is in your account.')) adm('/api/admin/ad-requests/activate', { id: r.id }).then(function (x) { if (!x.success) alert(x.error); loadAdRequests(); loadAdsList(); }); } }));
        if (open) acts.appendChild(el('button', { class: 'btn-sm btn-gray', text: 'Reject', onclick: function () { adm('/api/admin/ad-requests/reject', { id: r.id, note: note.value }).then(loadAdRequests); } }));
        box.appendChild(el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin-bottom:10px' }, [
          el('div', { style: 'display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap' }, [el('b', { text: '#' + r.id + ' ' + r.business_name }), el('span', { class: 'badge badge-pending', text: r.status })]),
          el('div', { style: 'font-size:13px;color:#65676b;margin-top:4px', text: (PLACE_TXT[r.placement] || r.placement) + ' · goal: ' + (r.objective || '—') + ' · ' + r.days + ' days · budget: $' + ((r.budget_cents || 0) / 100).toFixed(2) + (r.budget_note ? ' (' + r.budget_note + ')' : '') + ' · country: ' + (r.country || 'all') + ' · interests: ' + (r.interests || 'all') + (r.post_id ? ' · 🚀 BOOST post #' + r.post_id : '') + ' · contact: ' + r.contact + ' · by ' + ((r.first_name || '') + ' ' + (r.last_name || '')).trim() }),
          r.caption ? el('div', { style: 'margin-top:6px;font-size:13.5px', text: r.caption }) : null,
          r.target_url ? el('div', { style: 'margin-top:4px;font-size:12.5px;color:#65676b', text: 'Link: ' + r.target_url }) : null,
          (r.media_url || r.post_media_url) ? el('a', { href: r.media_url || r.post_media_url, target: '_blank', rel: 'noopener noreferrer', style: 'font-size:12.5px;color:#1877f2', text: 'Open picture / video ↗' }) : null,
          r.price_cents ? el('div', { style: 'margin-top:4px;font-weight:700', text: 'Quoted: $' + (r.price_cents / 100).toFixed(2) }) : null,
          r.pay_ref ? el('div', { style: 'margin-top:4px;font-weight:700;color:#92580a', text: '💳 Payment reference from advertiser: ' + r.pay_ref }) : null,
          r.ai_note ? el('div', { style: 'margin-top:4px;font-weight:700;color:' + (/⛔/.test(r.ai_note) ? '#b42318' : (/🔞/.test(r.ai_note) ? '#92580a' : '#176f35')), text: r.ai_note }) : null,
          acts]));
      });
    });
  }
  function loadAdsList() {
    var box = document.getElementById('adsList'); if (!box) return; box.textContent = ''; box.appendChild(empty('Loading…'));
    adm('/api/admin/ads/list').then(function (d) {
      box.textContent = ''; if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      if (!d.ads.length) { box.appendChild(empty('No ads yet.')); return; }
      var rows = d.ads.map(function (a) {
        var ctr = a.impressions ? (a.clicks / a.impressions * 100).toFixed(1) + '%' : '—';
        return el('tr', {}, [el('td', { text: '#' + a.id }), el('td', { text: a.advertiser_name }), el('td', { text: (PLACE_TXT[a.placement] || a.placement) + (a.post_id ? ' 🚀' : '') }), el('td', { text: (a.caption || '').slice(0, 40) }), el('td', { text: a.budget_cents ? '$' + (a.spent_cents / 100).toFixed(2) + ' / $' + (a.budget_cents / 100).toFixed(2) : 'no limit' }),
          el('td', { text: String(a.impressions) }), el('td', { text: a.clicks + ' (' + ctr + ')' }), el('td', { text: a.status }),
          el('td', {}, [el('button', { class: 'btn-sm btn-blue', style: 'margin-right:4px', text: '📊', onclick: function () { adReportModal(a.id); } }), el('button', { class: 'btn-sm btn-gray', text: a.status === 'active' ? 'Pause' : 'Resume', onclick: function () { adm('/api/admin/ads/status', { id: a.id, status: a.status === 'active' ? 'paused' : 'active' }).then(loadAdsList); } }),
            el('button', { class: 'btn-sm btn-gray', style: 'margin-left:4px', text: '🗑️', onclick: function () { if (confirm('Delete this ad?')) adm('/api/admin/ads/delete', { id: a.id }).then(loadAdsList); } })])]);
      });
      box.appendChild(el('div', { style: 'overflow-x:auto' }, [table(['ID', 'Advertiser', 'Where', 'Caption', 'Spent', 'Views', 'Clicks', 'Status', ''], rows)]));
    });
  }
  window.loadAdsAdmin = loadAdsAdmin;

  // ---------- Inbox: everything waiting for an admin, in one place ----------
  var KIND = { withdrawal: '💸', reissue: '🔑', creator: '💰', report: '🚩', ad: '📢', live: '🔴', coins: '💎', party: '🎉', star: '⭐', challenge: '🎯' };
  var BASE = { 'tabBtn-monetization': '💰 Monetization', 'tabBtn-reports': '🚩 Reports Queue', 'tabBtn-ads': '📢 Ads', 'tabBtn-live': '🔴 Live', 'tabBtn-inbox': '🔔 Inbox', 'tabBtn-coins': '💎 Diamonds & Gifts', 'tabBtn-party': '🎉 Party Room', 'tabBtn-stars': '⭐ Stars', 'tabBtn-challenges': '🎯 Challenges', 'tabBtn-copyright': '©️ Copyright' };
  var lastTotal = -1, baseTitle = document.title;
  function setBadge(id, n) { var b = document.getElementById(id); if (b && BASE[id]) b.textContent = BASE[id] + (n > 0 ? '  (' + n + ')' : ''); }   // (a name missing here showed "undefined")
  function applyInbox(d) {
    var c = d.counts;
    setBadge('tabBtn-inbox', d.total); setBadge('tabBtn-monetization', c.withdrawals + c.reissue + c.creators); setBadge('tabBtn-reports', (c.reports || 0) + (c.chatReports || 0)); setBadge('tabBtn-ads', c.ads); setBadge('tabBtn-live', c.live); setBadge('tabBtn-coins', c.coins || 0); setBadge('tabBtn-party', c.party || 0); setBadge('tabBtn-stars', (c.stars || 0) + (c.starBonus || 0)); setBadge('tabBtn-challenges', c.challengeRewards || 0); setBadge('tabBtn-copyright', (c.copyrightClaims || 0) + (c.copyrightDups || 0));
    document.title = (d.total > 0 ? '(' + d.total + ') ' : '') + baseTitle;
    var ib = document.getElementById('tabBtn-inbox'); if (ib) ib.style.color = d.total > 0 ? '#e41e3f' : '';
    if (lastTotal >= 0 && d.total > lastTotal) { try { var ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain(); o.connect(g); g.connect(ac.destination); o.frequency.value = 880; g.gain.value = 0.05; o.start(); o.stop(ac.currentTime + 0.18); } catch (e) {} }
    lastTotal = d.total;
  }
  function loadInbox() {
    var p = document.getElementById('panel-inbox'); if (!p) return; p.textContent = ''; p.appendChild(empty('Loading…'));
    adm('/api/admin/inbox').then(function (d) {
      p.textContent = '';
      if (!d.success) { p.appendChild(empty(d.error || 'Could not load.')); return; }
      applyInbox(d); var c = d.counts;
      p.appendChild(el('div', { class: 'at-row' }, [el('button', { class: 'btn-sm btn-gray', text: '↻ Refresh', onclick: loadInbox })]));
      var chips = [['💸 Withdrawals', c.withdrawals, 'monetization'], ['🔑 New payout code', c.reissue, 'monetization'], ['💰 Creator applications', c.creators, 'monetization'], ['🚩 Reports', c.reports, 'reports'], ['💬 Chat reports', c.chatReports || 0, 'reports'], ['📢 Ad requests', c.ads, 'ads'], ['🔴 Live requests', c.live, 'live'], ['💎 Diamond top-ups', c.coins || 0, 'coins'], ['🎉 Room reports', c.party || 0, 'party'], ['⭐ Star applications', c.stars || 0, 'stars'], ['💵 Star bonuses to pay', c.starBonus || 0, 'stars'], ['🎯 Challenge money to pay', c.challengeRewards || 0, 'challenges'], ['©️ Copyright claims', c.copyrightClaims || 0, 'copyright'], ['🔁 Possible copies', c.copyrightDups || 0, 'copyright'], ['🔍 Views to check', c.viewReviews || 0, 'views']];
      p.appendChild(el('div', { class: 'at-chips' }, chips.map(function (x) {          // 3 columns
        return el('button', { class: 'btn-sm ' + (x[1] > 0 ? '' : 'btn-gray'), style: x[1] > 0 ? 'background:#e41e3f;color:#fff' : '', text: x[0] + ': ' + x[1], onclick: function () { switchAdminTab(x[2]); } });
      })));
      if (!d.items.length) { p.appendChild(empty('✅ Nothing is waiting. All requests are handled.')); return; }
      d.items.forEach(function (it) {
        p.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e4e6eb;border-radius:10px;margin-bottom:8px;background:#fff' }, [
          el('div', { style: 'font-size:22px', text: KIND[it.kind] || '🔔' }),
          el('div', { style: 'flex:1;min-width:0' }, [el('div', { style: 'font-weight:700;font-size:14px', text: it.title }), el('div', { style: 'font-size:12px;color:#65676b', text: it.sub + ' · ' + ago(it.at) })]),
          el('button', { class: 'btn-sm', text: 'Open', onclick: function () { switchAdminTab(it.tab); } })]));
      });
    });
  }
  function pollInbox() { try { if (typeof savedAdminKey !== 'undefined' && savedAdminKey && document.getElementById('tabBtn-inbox')) adm('/api/admin/inbox', {}).then(function (d) { if (d && d.success) applyInbox(d); }); } catch (e) {} }

  // ---------- Chats: limit who may start chats, review chats (reason + logged), send notices ----------
  var LIMIT_LABEL = { '': 'No limit', reply_only: 'Reply only (cannot start a chat / group / call first)', banned: 'Banned from chat & calls' };
  function loadChatsAdmin() {
    var p = document.getElementById('panel-chats'); if (!p) return; p.textContent = '';
    p.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px;max-width:760px;line-height:1.5', text: 'Chat safety. You can limit a person who spams, send them a notice, and — only to handle reports, scams or rule-breaking — read their chats and see the photos/videos. Reading needs a reason and is saved in the Activity Log with your name.' }));
    var q = el('input', { class: 'at-in', id: 'chatQ', placeholder: 'Search a person: name, e-mail, phone or ID', style: 'max-width:340px' }), box = el('div', { style: 'margin-top:8px' });
    function go() {
      box.textContent = ''; box.appendChild(empty('Searching…'));
      adm('/api/admin/users/search', { query: q.value.trim(), limit: 15 }).then(function (d) {
        box.textContent = ''; if (!d.success) { box.appendChild(empty(d.error || 'Could not search.')); return; }
        if (!d.users.length) { box.appendChild(empty('Nobody found.')); return; }
        d.users.forEach(function (u) {
          box.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e4e6eb;border-radius:10px;margin-bottom:6px;background:#fff' }, [
            el('div', { style: 'flex:1;min-width:0' }, [el('div', { style: 'font-weight:700', text: nm(u) }), el('div', { style: 'font-size:12px;color:#65676b', text: u.contact + ' · ID ' + (u.public_id || '—') })]),
            el('button', { class: 'btn-sm btn-blue', text: 'Open', onclick: function () { openChatConsole(u); } })]));
        });
      });
    }
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    p.appendChild(el('div', { class: 'at-row' }, [q, el('button', { class: 'btn-sm btn-blue', text: '🔍 Search', onclick: go })]));
    p.appendChild(box); p.appendChild(el('div', { id: 'chatConsole', style: 'margin-top:14px' }));
  }
  function cleanMsg(m) {
    var t = String(m.message || ''); if (t === '__CAMFEED_MSG_DELETED__') return '🚫 (deleted)'; if (t.indexOf('__CAMFEED_EDITED__:') === 0) t = t.slice(19);
    if (t.indexOf('CALL:') === 0) { var c = t.split(':'); return '📞 call (' + c[1] + ', ' + c[2] + ')'; }
    return t;
  }
  function openChatConsole(u) {
    if (!document.getElementById('chatQ')) { var pn = document.getElementById('panel-chats'); if (pn) { loadChatsAdmin(); } }
    var c = document.getElementById('chatConsole'); if (!c) return; c.textContent = '';
    var out = el('div'); var card = el('div', { style: 'background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px;max-width:820px' });
    card.appendChild(el('div', { style: 'font-size:18px;font-weight:800', text: '💬 ' + nm(u) })); card.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin-bottom:8px', text: u.contact || u.email })); card.appendChild(out);
    // 1 limit
    card.appendChild(el('div', { class: 'at-h', text: '1) Limit this person’s chat' }));
    var sel = el('select', { class: 'at-in', style: 'max-width:420px' }, Object.keys(LIMIT_LABEL).map(function (k) { return el('option', { value: k, text: LIMIT_LABEL[k] }); }));
    var why = el('input', { class: 'at-in', placeholder: 'Reason (shown to the person)', maxlength: '200', style: 'margin-top:6px;max-width:420px' });
    card.appendChild(sel); card.appendChild(why);
    card.appendChild(el('button', { class: 'btn-sm btn-red', style: 'margin-top:8px;padding:8px 14px', text: 'Apply limit', onclick: function () {
      adm('/api/admin/chat/limit', { target: u.email, limit: sel.value, reason: why.value }).then(function (r) { msg(out, r.success, r.success ? '✅ Saved: ' + LIMIT_LABEL[r.limit || ''] : '❌ ' + (r.error || 'Failed')); });
    } }));
    adm('/api/admin/chat/status', { target: u.email }).then(function (r) { if (r.success) sel.value = r.limit || ''; });
    // 2 notice
    card.appendChild(el('div', { class: 'at-h', text: '2) Send a notice (shows in their notification bell)' }));
    var kind = el('select', { class: 'at-in', style: 'max-width:260px' }, [el('option', { value: 'warning', text: '⚠️ Warning' }), el('option', { value: 'message', text: '📢 Message' })]);
    var note = el('textarea', { class: 'at-in', rows: '2', maxlength: '400', placeholder: 'Write the message…' });
    card.appendChild(kind); card.appendChild(note);
    card.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'margin-top:8px;padding:8px 14px', text: 'Send notice', onclick: function () {
      if (!note.value.trim()) { msg(out, false, '❌ Write a message first.'); return; }
      adm('/api/admin/notice', { targetEmail: u.email, kind: kind.value, note: note.value }).then(function (r) { msg(out, r.success, r.success ? '✅ Notice sent' : '❌ ' + (r.error || 'Failed')); if (r.success) note.value = ''; });
    } }));
    // 3 review
    card.appendChild(el('div', { class: 'at-h', text: '3) Review chats (reason required, logged)' }));
    var rsn = el('input', { class: 'at-in', placeholder: 'Reason, e.g. “report #12: scam / money request” (min 5 letters)', maxlength: '250' }), list = el('div', { style: 'margin-top:10px' }), thread = el('div', { style: 'margin-top:10px' });
    card.appendChild(rsn);
    card.appendChild(el('button', { class: 'btn-sm btn-gray', style: 'margin-top:8px;padding:8px 14px', text: '📂 Show their conversations', onclick: function () {
      list.textContent = ''; thread.textContent = ''; list.appendChild(empty('Loading…'));
      adm('/api/admin/chat/conversations', { target: u.email, reason: rsn.value }).then(function (d) {
        list.textContent = ''; if (!d.success) { msg(out, false, '❌ ' + (d.error || 'Failed')); return; } msg(out, true, '');
        if (!d.peers.length && !d.groups.length) { list.appendChild(empty('No chats.')); return; }
        d.peers.forEach(function (x) { list.appendChild(row('👤 ' + (((x.first_name || '') + ' ' + (x.last_name || '')).trim() || x.peer), x.n + ' msgs · ' + ago(x.last_at), function () { openThread({ peer: x.peer }); })); });
        d.groups.forEach(function (g) { list.appendChild(row('👥 ' + g.name, g.members + ' members · ' + g.n + ' msgs', function () { openThread({ groupId: g.id }); })); });
      });
    } }));
    function row(t, sub, fn) { return el('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e4e6eb;border-radius:10px;margin-bottom:6px;cursor:pointer;background:#fafbfc', onclick: fn }, [el('div', { style: 'flex:1;min-width:0' }, [el('div', { style: 'font-weight:700', text: t }), el('div', { style: 'font-size:12px;color:#65676b', text: sub })]), el('span', { text: '›' })]); }
    function openThread(which) {
      thread.textContent = ''; thread.appendChild(empty('Loading…'));
      adm('/api/admin/chat/thread', Object.assign({ target: u.email, reason: rsn.value }, which)).then(function (d) {
        thread.textContent = ''; if (!d.success) { msg(out, false, '❌ ' + (d.error || 'Failed')); return; }
        var me = u.email.toLowerCase(), wrap = el('div', { style: 'background:#f0f2f5;border-radius:12px;padding:10px;max-height:480px;overflow-y:auto' });
        if (!d.messages.length) wrap.appendChild(empty('No messages.'));
        d.messages.forEach(function (m) {
          var mine = String(m.sender_email).toLowerCase() === me; var body = el('div', { style: 'display:inline-block;max-width:80%;background:' + (mine ? '#d8e7ff' : '#fff') + ';border-radius:12px;padding:7px 10px;font-size:13.5px;word-break:break-word;white-space:pre-wrap' });
          if (m.media_url && /^https?:/.test(m.media_url)) {
            if (m.message_type === 'video') body.appendChild(el('video', { src: m.media_url, controls: 'controls', preload: 'metadata', style: 'max-width:240px;max-height:260px;display:block;border-radius:8px' }));
            else if (m.message_type === 'audio') body.appendChild(el('audio', { src: m.media_url, controls: 'controls', style: 'max-width:240px' }));
            else body.appendChild(el('a', { href: m.media_url, target: '_blank', rel: 'noopener' }, [el('img', { src: m.media_url, style: 'max-width:240px;max-height:260px;display:block;border-radius:8px' })]));
          }
          var t = cleanMsg(m); if (t && !(m.media_url && /^\[(Photo|Video|Voice Message|Image Message|Video Message|Sticker)\]$/.test(t))) body.appendChild(el('div', { text: t }));
          var who = (m.first_name || m.last_name) ? ((m.first_name || '') + ' ' + (m.last_name || '')).trim() : m.sender_email;
          var del = el('button', { class: 'btn-sm btn-gray', style: 'margin-left:6px;padding:2px 7px;font-size:11px', text: '🗑', title: 'Delete this message', onclick: function () {
            var r = prompt('Reason for deleting this message?'); if (!r) return;
            adm('/api/admin/chat/delete-message', { kind: d.kind, id: m.id, reason: r, notify: true }).then(function (x) { if (x.success) openThread(which); else msg(out, false, '❌ ' + (x.error || 'Failed')); });
          } });
          wrap.appendChild(el('div', { style: 'text-align:' + (mine ? 'right' : 'left') + ';margin-bottom:8px' }, [el('div', { style: 'font-size:11px;color:#65676b;margin-bottom:2px', text: (mine ? 'Them' : who) + ' · ' + fmt(m.created_at) }), body, del]));
        });
        thread.appendChild(wrap); setTimeout(function () { wrap.scrollTop = wrap.scrollHeight; }, 50);
      });
    }
    card.appendChild(list); card.appendChild(thread); c.appendChild(card); c.scrollIntoView({ behavior: 'smooth' });
  }

  // ---------- 🔐 rights by section: hide what this admin can not use; Super Admin sets them in 👮 Admins & rights ----------
  var TAB_SECTION = { copyright: 'content', keywords: 'content', inbox: 'inbox', overview: 'overview', audit: 'audit', umanage: 'users', users: 'users', accounts: 'users', chats: 'chats', reports: 'content', content: 'content', posts: 'content',
    live: 'live', sounds: 'sounds', ads: 'ads', monetization: 'money', coins: 'coins', party: 'party', challenges: 'challenges', stars: 'stars', system: 'system', appcfg: 'system' };
  var SECTION_NAME = { inbox: '🔔 Inbox', overview: '📊 Overview', audit: '🧾 Activity Log', users: '👥 Users', chats: '💬 Chats', content: '🛡️ Content & reports', live: '🔴 Live', sounds: '🎵 Sounds', ads: '📢 Ads',
    money: '💰 Money (withdrawals, creators, referrals)', coins: '💎 Diamonds & Gifts', party: '🎉 Party Room', challenges: '🎯 Challenges', stars: '⭐ Stars', system: '⚙️ System' };
  function applyPerms() {
    adm('/api/admin/my-perms', {}).then(function (d) {
      if (!d || !d.success) return;
      var pb = document.getElementById('tabBtn-perms'); if (pb) pb.style.display = d.isSuperAdmin ? '' : 'none';
      if (d.isSuperAdmin || !d.limited) return;
      Object.keys(TAB_SECTION).forEach(function (t) {
        var sec = TAB_SECTION[t], b = document.getElementById('tabBtn-' + t);
        if (b && sec !== 'inbox' && !d.sections[sec]) b.style.display = 'none';
      });
      document.querySelectorAll('.nav-group').forEach(function (g) {          // a group with nothing left: hide its title too
        var any = Array.prototype.some.call(g.querySelectorAll('.tab-btn'), function (b) { return b.style.display !== 'none'; });
        g.style.display = any ? '' : 'none';
      });
    });
  }
  // ---------- 🧩 App features & lists: turn parts of the app on or off and change lists, without a new app ----------
  function appConfigAdmin(body) {
    var box = el('div', { class: 'at-card' }); body.appendChild(box);
    var FEAT = [['partyRoom', '🎉 Party Room'], ['challenge', '🎯 Challenge button'], ['wallet', '💰 My wallet (in the menu)'], ['coins', '💎 Diamonds button (Party Room)'],
      ['vip', '👑 VIP & levels button'], ['frames', '🖼️ Profile frames button'], ['checkin', '📅 Daily check-in'], ['stars', '⭐ Stars'], ['ranking', '🏆 Ranking'],
      ['partyFollowers', '❤️ Room followers list'], ['roomClock', '⏱️ Room clock'], ['saveSound', '🎵 Use the sound of a video'], ['watchHistory', '🕘 Watch history'], ['chatFiles', '📎 Send files in chat'], ['beauty', '✨ Beauty in video calls (test: it closed the app on some phones)'], ['chatBubbles', '💬 Chat bubbles (new messages float over other apps)'], ['liteNoMusic', '🧪 Weak phones: no music in Party Room'], ['liteNoVoiceFx', '🧪 Weak phones: no voice cleaning (noise/echo)'], ['liteNoVoice', '🧪 Weak phones: no voice at all (test only)'], ['liteHwOff', '🧪 Weak phones: voice without the phone\'s own echo/noise chip'], ['liteMediaAudio', '🧪 Weak phones: voice played like music (not like a phone call)'], ['nativeCamera', '🎥 CamFeed camera (➕ › Record a video, Android)'], ['cameraLong', '🎥 CamFeed camera: 5-minute videos'], ['cameraPhoto', '📸 CamFeed camera: take photos'], ['mirrorFront', '🪞 Front camera: turn the picture left-right (only if phones save it the other way round)'], ['autoSound', '🎵 A sound is added by itself to a new photo']];
    var cfgNow = {};
    var REASONS = [['post', '📝 Report a post or video'], ['chat', '💬 Report a chat message or person'], ['room', '🎉 Report a Party Room']];
    function call(extra) { return adm('/api/admin/app-config', extra || {}).then(function (x) { if (x && x.success) draw(x); else { box.textContent = ''; box.appendChild(empty((x && x.error) || 'Could not load.')); } return x; }); }
    function numList(v) { return String(v || '').split(/[\s,]+/).filter(function (t) { return t !== ''; }).map(Number).filter(function (n) { return isFinite(n); }); }
    function draw(d) {
      box.textContent = '';
      var c = d.config || {}, sup = !!d.isSuperAdmin; cfgNow = c;
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '🧩 App features & lists' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'The app reads these when it opens (and every few minutes). No new app is needed. Turned-off parts are hidden in the app; people never see the word "Admin".' + (sup ? '' : ' Only a Super Admin can change them.') }));
      function h(t) { box.appendChild(el('div', { style: 'font-weight:800;font-size:15px;margin:14px 0 6px', text: t })); }
      h('1. Parts of the app (on or off)');
      var grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px' }), feats = {};
      FEAT.forEach(function (f) { var x = el('input', { type: 'checkbox' }); x.checked = (c.features || {})[f[0]] !== false; x.disabled = !sup; feats[f[0]] = x; grid.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;padding:6px 8px;background:#f7f8fa;border-radius:8px' }, [x, el('span', { text: f[1] })])); });
      box.appendChild(grid);
      h('2. Report reasons (one per line: Khmer | English)');
      box.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin-bottom:6px', text: 'Example: 🔞 អាសអាភាស | 🔞 Nudity. For chat you may add a short code at the start: code | Khmer | English (letters a–z only). Max 15 lines.' }));
      var areas = {};
      REASONS.forEach(function (r) {
        var list = ((c.reportReasons || {})[r[0]] || []);
        var t = el('textarea', { class: 'at-in', rows: String(Math.max(4, list.length + 1)), style: 'width:100%;font-family:inherit' });
        t.value = list.map(function (x) { return (r[0] === 'chat' ? x.id + ' | ' : '') + x.km + ' | ' + x.en; }).join('\n'); t.disabled = !sup;
        areas[r[0]] = t; box.appendChild(el('div', { style: 'font-weight:700;margin:6px 0 2px', text: r[1] })); box.appendChild(t);
      });
      h('3. Numbers and lists');
      function field(label, val, hint) { var i = el('input', { class: 'at-in', value: String(val), style: 'width:220px;display:inline-block' }); i.disabled = !sup; box.appendChild(el('label', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0' }, [el('span', { style: 'min-width:280px', text: label }), i, el('span', { style: 'color:#65676b;font-size:12px', text: hint || '' })])); return i; }
      var p = c.party || {};
      var fTtl = field('⏳ Chat "messages disappear after" choices (hours)', (c.chatTtlHours || []).join(', '), '0 = off · 24 = 1 day · 168 = 7 days · 720 = 1 month');
      var fGift = field('🎁 Gift amount buttons (Party Room)', (c.giftCounts || []).join(', '), 'e.g. 1, 10, 99');
      var fSnd = field('🎵 Story sound length (seconds)', c.storySoundSeconds, '5–30');
      var fWatch = field('🕘 Keep watch history (days)', c.watchHistoryDays, '1–3650');
      var fMetM = field('🤝 "Met in a room" after (minutes together)', p.metMinutes, '1–600');
      var fMetD = field('🤝 Keep "met in a room" for (days)', p.metDays, '1–365');
      var fNote = field('🔔 Tell room followers again after (minutes)', p.followNotifyMinutes, '0 = every time the room opens');
      var fMin = field('🎯 Room minutes count when at least N other people are in the room', p.challengeMinOthers, '0 = count even alone');
      var fFeed = field('📰 Seen posts: "seen long ago" means more than (days)', (c.feed || {}).reshowDays, 'after "all caught up" the feed goes on with posts of people you follow and older ones; seen longer ago (up to these days) come first · 1–365');
      var fl = c.files || {};
      var fMax = field('📎 Biggest file in chat (MB)', fl.maxMB, '1–500 · bigger files cost more storage');
      var fDay = field('📎 Files one person may send a day', fl.perDay, '1–1000');
      var fBlk = field('📎 File endings that can not be sent', (fl.blocked || []).join(', '), 'e.g. apk, exe (web pages like html/svg/js are always refused)');
      var mx = (c.feed || {}).mix || {};
      h('4. What the Feed shows (share of each page, %)');
      box.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin-bottom:6px', text: 'Posts not seen yet are put in groups and each page is filled by these shares. They do not need to add up to 100 (they are shares of the total). 0 = that group only when nothing else is left. Seen posts still come after "all caught up".' }));
      var mxF = {};
      [['friends', '👫 Friends (follow each other)'], ['follow', '➕ People I follow'], ['trending', '🔥 Trending (many likes, comments, shares in a short time)'], ['interest', '🎯 My interests (the kinds I watch and react to)'], ['fresh', '🆕 New posts of other people'], ['discover', '🎲 Others (to meet new people)']].forEach(function (g) { mxF[g[0]] = field(g[1], mx[g[0]], '0–100'); });
      var fFreshH = field('🆕 "New" means posted in the last (hours)', mx.freshHours, '1–168');
      var fTrendMin = field('🔥 Trending needs at least (likes + comments×2 + shares×3)', mx.trendMin, '1–1000');
      var fPplRnd = field('👥 "People you may know": share chosen by chance (%)', (c.people || {}).randomPct, '0–100 · the rest are people with mutual friends or who follow you');
      if (!sup) return;
      function reasonsOf(k) {
        var out = [];
        areas[k].value.split('\n').forEach(function (line) {
          var parts = line.split('|').map(function (t) { return t.trim(); }); if (!line.trim()) return;
          if (k === 'chat') { if (parts.length === 2) parts.unshift(parts[1].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)); if (parts.length >= 3) out.push({ id: parts[0], km: parts[1], en: parts[2] }); }
          else if (parts.length >= 2) { var old = ((cfgNow.reportReasons || {})[k] || []).filter(function (x) { return x.km === parts[0]; })[0]; out.push({ id: old ? old.id : (k === 'post' ? parts[1].replace(/^[^A-Za-z]+/, '') + ' (' + parts[0].replace(/^[^\u1780-\u17FF]+/, '') + ')' : parts[0]), km: parts[0], en: parts[1] }); }
        });
        return out;
      }
      var bar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px' });
      bar.appendChild(el('button', { class: 'btn-sm btn-blue', text: '💾 Save', onclick: function () {
        var f = {}; Object.keys(feats).forEach(function (k) { f[k] = feats[k].checked; });
        var rr = {}; Object.keys(areas).forEach(function (k) { var l = reasonsOf(k); if (l.length) rr[k] = l; });
        call({ action: 'save', config: { features: f, reportReasons: rr, chatTtlHours: numList(fTtl.value), giftCounts: numList(fGift.value), storySoundSeconds: Number(fSnd.value), watchHistoryDays: Number(fWatch.value),
          party: { metMinutes: Number(fMetM.value), metDays: Number(fMetD.value), followNotifyMinutes: Number(fNote.value), challengeMinOthers: Number(fMin.value) },
          feed: { reshowDays: Number(fFeed.value), mix: (function () { var m = {}; Object.keys(mxF).forEach(function (k) { m[k] = Number(mxF[k].value); }); m.freshHours = Number(fFreshH.value); m.trendMin = Number(fTrendMin.value); return m; })() },
          people: { randomPct: Number(fPplRnd.value) },
          files: { maxMB: Number(fMax.value), perDay: Number(fDay.value), blocked: String(fBlk.value || '').split(/[\s,]+/).filter(function (t) { return t !== ''; }) } } });
      } }));
      bar.appendChild(el('button', { class: 'btn-sm', style: 'background:#e4e6eb', text: '↩️ Back to the original settings', onclick: function () { if (confirm('Put every setting on this page back to the original?')) call({ action: 'reset' }); } }));
      box.appendChild(bar);
    }
    call({ action: 'list' });
  }
  function permsAdmin(body) {
    var box = el('div', { class: 'at-card' }); body.appendChild(box);
    function call(extra) { return adm('/api/admin/perms', extra || {}).then(function (x) { if (x.success) draw(x); else { box.textContent = ''; box.appendChild(empty(x.error || 'Could not load.')); } return x; }); }
    function draw(d) {
      box.textContent = '';
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '👮 Admins & rights (by section)' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Choose what each admin may use: 👁 Look = only see, ✏️ Change = see and change, 💵 Money = also approve and pay money (withdrawals, top-ups, bonuses, challenge rewards). "All sections" = not limited (as before). Super Admins always have everything. Make someone an admin in 👥 Users first.' }));
      (d.admins || []).forEach(function (a) {
        var card = el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin:10px 0' });
        card.appendChild(el('div', { style: 'font-weight:800;font-size:15px', text: nm(a) + ' · ' + a.email + (a.super ? ' · SUPER ADMIN (everything)' : '') }));
        if (a.super) { box.appendChild(card); return; }
        var all = el('input', { type: 'checkbox' }); all.checked = !a.limited;
        var grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px;margin-top:8px' });
        var sels = {};
        (d.sections || []).forEach(function (sec) {
          if (sec === 'inbox') return;
          var x = el('select', { class: 'at-in', style: 'width:120px;display:inline-block' });
          [['', '— none'], ['view', '👁 Look'], ['edit', '✏️ Change'], ['approve', '💵 Money']].forEach(function (o) { var op = el('option', { value: o[0], text: o[1] }); if ((a.sections || {})[sec] === o[0] || (!(a.sections || {})[sec] && !o[0])) op.selected = true; x.appendChild(op); });
          sels[sec] = x;
          grid.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;justify-content:space-between;padding:4px 8px;background:#f7f8fa;border-radius:8px' }, [el('span', { text: SECTION_NAME[sec] || sec }), x]));
        });
        function show() { grid.style.opacity = all.checked ? '.4' : '1'; Object.keys(sels).forEach(function (k) { sels[k].disabled = all.checked; }); }
        all.addEventListener('change', show); show();
        card.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;margin-top:6px;font-weight:700' }, [all, el('span', { text: 'All sections (not limited)' })]));
        card.appendChild(grid);
        card.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'margin-top:8px', text: '💾 Save rights', onclick: function () {
          var sec = {}; Object.keys(sels).forEach(function (k) { if (sels[k].value) sec[k] = sels[k].value; });
          call({ set: { target: a.email, unlimited: all.checked, sections: sec } });
        } }));
        if (a.updated_by) card.appendChild(el('div', { style: 'color:#65676b;font-size:12px;margin-top:4px', text: 'Last changed by ' + a.updated_by + ' · ' + ago(a.updated_at) }));
        box.appendChild(card);
      });
      if (!(d.admins || []).length) box.appendChild(empty('No admin yet.'));
    }
    call();
  }

  // ---------- wiring ----------
  window.onAdminTab = function (tab) {
    if (tab === 'inbox') loadInbox(); else if (tab === 'overview') loadOverview(); else if (tab === 'umanage') { if (!document.getElementById('uQuery')) buildUsers(); } else if (tab === 'content') { if (!document.getElementById('cQuery')) buildContent(); } else if (tab === 'audit') loadAudit(true); else if (tab === 'system') loadSystem(); else if (tab === 'monetization') loadMonetizationAdmin(); else if (tab === 'ads') loadAdsAdmin(); else if (tab === 'live') loadLiveAdmin(); else if (tab === 'sounds') loadSoundsAdmin(); else if (tab === 'party') { var pp = document.getElementById('panel-party'); pp.textContent = ''; partyAdmin(pp); } else if (tab === 'coins') { var pc = document.getElementById('panel-coins'); pc.textContent = ''; coinsAdmin(pc); } else if (tab === 'stars') { var ps = document.getElementById('panel-stars'); ps.textContent = ''; starsAdmin(ps); } else if (tab === 'challenges') { var pg = document.getElementById('panel-challenges'); pg.textContent = ''; challengesAdmin(pg); } else if (tab === 'appcfg') { var pa = document.getElementById('panel-appcfg'); pa.textContent = ''; appConfigAdmin(pa); } else if (tab === 'perms') { var pp2 = document.getElementById('panel-perms'); pp2.textContent = ''; permsAdmin(pp2); } else if (tab === 'reports') { chatReportsAdmin(); } else if (tab === 'copyright') { var pcr = document.getElementById('panel-copyright'); pcr.textContent = ''; copyrightAdmin(pcr); } else if (tab === 'views') { var pvw = document.getElementById('panel-views'); pvw.textContent = ''; viewsAdmin(pvw); } else if (tab === 'chats') { if (!document.getElementById('chatQ')) loadChatsAdmin(); } else if (tab === 'keywords') { var pkw = document.getElementById('panel-keywords'); pkw.textContent = ''; keywordsAdmin(pkw); } else if (tab === 'verify') { var pvf = document.getElementById('panel-verify'); pvf.textContent = ''; verifyAdmin(pvf); }
  };
  window.onAdminUnlocked = function () {
    switchAdminTab('inbox');
    applyPerms();
    // the Chats tab is for Super Admins only
    adm('/api/admin/chat/status', {}).then(function (r) { var b = document.getElementById('tabBtn-chats'); if (b) b.style.display = (r && r.success) ? '' : 'none'; });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
  function pollLiveBadge() { return; }
  function _oldPollLive() { try { if (typeof savedAdminKey !== 'undefined' && savedAdminKey && document.getElementById('tabBtn-live')) adm('/api/admin/live/requests', {}).then(function (q) { if (q && q.success) setLiveBadge(q.pending); }); } catch (e) {} }
  setTimeout(pollInbox, 3000); setInterval(pollInbox, 60000);
})();
