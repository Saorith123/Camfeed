/* CamFeed Admin Center: Overview, Users (search + manage), Content moderation, Activity log, System check.
   Everything shown comes from the server as TEXT (never inserted as HTML). Uses the page's currentUser / savedAdminKey. */
(function () {
  'use strict';
  var TABS = [['inbox', '🔔 Inbox'], ['overview', '📊 Overview'], ['umanage', '👥 Users'], ['chats', '💬 Chats'], ['content', '📝 Content'], ['audit', '🧾 Activity Log'], ['live', '🔴 Live'], ['sounds', '🎵 Sounds'], ['ads', '📢 Ads'], ['party', '🎉 Party Room'], ['coins', '🪙 Coins & Gifts'], ['stars', '⭐ Stars'], ['challenges', '🎯 Challenges'], ['system', '⚙️ System'], ['appcfg', '🧩 App features & lists'], ['perms', '👮 Admins & rights']];
  // the menu, in groups (left side on a computer, on top on a phone)
  var GROUPS = [
    ['🏠 Start', ['inbox', 'overview', 'audit']],
    ['👥 People', ['umanage', 'users', 'accounts', 'chats']],
    ['🛡️ Content & safety', ['reports', 'content', 'posts', 'live']],
    ['💰 Money', ['monetization', 'coins', 'ads']],
    ['🎉 Fun', ['party', 'challenges', 'stars', 'sounds']],
    ['⚙️ Settings', ['system', 'appcfg', 'perms']],
  ];

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
    '@media (max-width:900px){.admin-layout{display:block}.admin-layout>.tabs-bar{position:static;flex-direction:row;overflow-x:auto;max-height:none;margin-bottom:14px}' +
    '.nav-group{min-width:170px}}' }));

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
      var f = el('div', { class: 'at-grid' }, [field('First name', 'ufFirst', u.first_name), field('Last name', 'ufLast', u.last_name), field('Country', 'ufCountry', u.country), field('Location', 'ufLocation', pf.location), field('Work', 'ufWork', pf.work), field('Relationship', 'ufRel', pf.relationship_status), field('Profile phone', 'ufPhone', pf.phone),
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
    aiCategories: ['AI post categories (Gemini)', 'Without it every post is "General", so the feed can not learn what people like.'], supportTelegram: ['Support Telegram link', 'Set SUPPORT_TELEGRAM so people can message you from the sign-up page.'] };
  function loadSystem() {
    var p = document.getElementById('panel-system'); p.textContent = ''; p.appendChild(empty('Checking…'));
    adm('/api/admin/system').then(function (d) {
      p.textContent = ''; if (!d.success) { p.appendChild(empty(d.error || 'Could not load.')); return; }
      p.appendChild(el('div', { class: 'at-row' }, [el('button', { class: 'btn-sm btn-gray', text: '↻ Check again', onclick: loadSystem }), el('span', { style: 'color:#65676b;font-size:13px', text: 'Only yes / no is shown here. Secret values are never displayed.' })]));
      var c = d.checks;
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
    var bar = el('div', { class: 'at-row' }, [['inv', '✉️ Invited by CamFeed'], ['apps', '📋 Applications (requirements)'], ['rules', '⚙️ Conditions'], ['ref', '🎁 Friend invitations'], ['wd', '💵 Withdrawals'], ['rate', '💲 Pay per view'], ['wallet', '👛 Wallet bonus']].map(function (v) {
      return el('button', { class: 'btn-sm ' + (mon.view === v[0] ? 'btn-blue' : 'btn-gray'), text: v[1], onclick: function () { mon.view = v[0]; loadMonetizationAdmin(); } });
    }));
    p.appendChild(bar); var body = el('div', { id: 'monBody' }); p.appendChild(body);
    if (mon.view === 'inv') monApps(body, 'invited'); else if (mon.view === 'apps') monApps(body, 'applied'); else if (mon.view === 'rules') monRules(body, 'creator'); else if (mon.view === 'ref') monReferrals(body); else if (mon.view === 'wd') monWithdrawals(body); else if (mon.view === 'rate') monRate(body); else monWallet(body);
  }
  // the settings of one way to earn (its own price, daily limit, switch and text)
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
      var rpm = el('input', { class: 'at-in', type: 'number', step: '0.01', min: '0', value: d.rpm, placeholder: 'empty = common ($' + d.commonRpm + ')' });
      var cap = el('input', { class: 'at-in', type: 'number', step: '0.1', min: '0', value: d.dailyCap, placeholder: 'empty = common ($' + d.commonCap + ')' });
      var sw = el('input', { type: 'checkbox' }); sw.checked = src === 'invited' ? d.mustAccept : d.open;
      var tx = el('textarea', { class: 'at-in', rows: '3', placeholder: 'Text people see (empty = the standard text)' }); tx.value = d.text || '';
      [rpm, cap, sw, tx].forEach(function (x) { x.disabled = dis; });
      wrap.appendChild(el('div', { class: 'at-lbl', text: 'Price per 1,000 views ($) — now: $' + d.effRpm }));  wrap.appendChild(rpm);
      wrap.appendChild(el('div', { class: 'at-lbl', text: 'Daily limit per creator ($) — now: $' + d.effCap })); wrap.appendChild(cap);
      wrap.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14px' }, [sw, el('span', { text: src === 'invited' ? 'The person must ACCEPT the invitation first' : 'Applying is OPEN (off = the requirements card is hidden)' })]));
      wrap.appendChild(el('div', { class: 'at-lbl', text: 'Text shown to people' })); wrap.appendChild(tx);
      if (!dis) {
        var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:10px', text: 'Save', onclick: function () {
          var body2 = { source: src, set: true, rpm: rpm.value, dailyCap: cap.value, text: tx.value };
          if (src === 'invited') body2.mustAccept = sw.checked; else body2.open = sw.checked;
          btn.disabled = true; adm('/api/admin/creator-path', body2).then(function (x) { btn.disabled = false; if (x.success) { draw(x); } else msg(out, false, '❌ ' + (x.error || 'Failed')); });
        } });
        wrap.appendChild(btn);
      } else wrap.appendChild(el('div', { style: 'margin-top:10px;font-size:13px;color:#b45309', text: 'Only a Super Admin can change these.' }));
      wrap.appendChild(out);
    }
    adm('/api/admin/creator-path', { source: src }).then(draw);
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
  // ---------- 🪙 Coins & 🎁 gifts: top-ups waiting, packs, receiver share, waiting days, payment details, the gift list ----------
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
      box.appendChild(row('Star share of gift value (%) — normal people get the Coins share', sh));
      box.appendChild(row('Days needed in a month (days with the minimum session)', md));
      box.appendChild(row('Minimum minutes for a day to count', ms));
      box.appendChild(row('Most minutes counted in one day', mx));
      box.appendChild(row('Listeners needed in the room for minutes to count', ml));
      box.appendChild(row('Bonus % when coins are reached but hours / days are not', hf));
      box.appendChild(row('Trial days after approval (0 = star at once)', tr_));
      box.appendChild(el('div', { style: 'font-weight:800;margin:10px 0 4px', text: 'Monthly bonus tiers (hours + gift coins received → $)' }));
      var tiers = (s.tiers || []).map(function (t) { return { h: num(t.hours), c: num(t.coins, 110), u: el('input', { class: 'at-in', value: (Number(t.cents || 0) / 100).toFixed(2), style: 'width:80px' }) }; });
      if (su) tiers.push({ h: num(''), c: num('', 110), u: el('input', { class: 'at-in', value: '', style: 'width:80px', placeholder: '$' }) });
      tiers.forEach(function (t) { ins.push(t.h, t.c, t.u); });
      box.appendChild(table(['⭐', 'Hours', 'Gift coins received', 'Bonus $'], tiers.map(function (t, i) { return el('tr', {}, [el('td', { text: '⭐' + (i + 1) }), el('td', {}, [t.h]), el('td', {}, [t.c]), el('td', {}, [t.u])]); })));
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
            el('div', { text: 'This month: ' + m.hours + ' h · ' + m.days + ' / ' + ru.minDays + ' days · ' + m.coins + ' coins · tier ' + ((m.tier || {}).tier || '—') }),
            el('div', { text: 'Last month: ' + pm.hours + ' h · ' + pm.days + ' days · ' + pm.coins + ' coins · tier ' + ((pm.tier || {}).tier || '—') }),
            el('div', { text: 'Now: ' + (lv.counting ? '🟢 counting' : (lv.inRoom ? (lv.seated ? '⏸ ' + lv.others + ' listeners (needs ' + ru.minListeners + ')' : '⏸ in a room, not on a seat') : '⏸ not in a room')) }),
            table(['Day', 'Minutes', 'Counts'], (r.days || []).slice().reverse().map(function (dd) {
              return el('tr', {}, [el('td', { text: dd.day }), el('td', { text: String(dd.minutes) }), el('td', { text: dd.minutes >= ru.minSession ? '✅' : '—' })]);
            })),
            el('button', { class: 'btn-sm btn-gray', text: 'Close', onclick: function () { daysBox.textContent = ''; } })]));
          daysBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      box.appendChild(daysBox);
      box.appendChild(table(['Name', 'Status', 'This month: hours / days / coins', 'Warnings', 'Note', ''], others.map(function (x) {
        var m = x.month || {};
        var acts = !su ? [el('button', { class: 'btn-sm', text: '📊 Days', onclick: function () { showDays(x); } })] : [
          el('button', { class: 'btn-sm', text: '📊 Days', onclick: function () { showDays(x); } }),
          x.status !== 'star' && x.status !== 'rejected' ? el('button', { class: 'btn-sm btn-blue', text: '⭐ Star', onclick: function () { call({ action: 'status', user: x.user_email, status: 'star' }); } }) : '',
          x.status === 'star' || x.status === 'trial' ? el('button', { class: 'btn-sm', text: '⚠️ Warn', onclick: function () { var r = prompt('Warning (the person sees it):'); if (r) call({ action: 'status', user: x.user_email, status: 'warn', note: r }); } }) : '',
          x.status === 'star' || x.status === 'trial' ? el('button', { class: 'btn-sm', text: '⏸ Pause', onclick: function () { var r = prompt('Why paused (the person sees it):'); if (r !== null) call({ action: 'status', user: x.user_email, status: 'paused', note: r }); } }) : '',
          x.status !== 'removed' && x.status !== 'rejected' ? el('button', { class: 'btn-sm', text: '🗑 Remove', onclick: function () { var r = prompt('Why removed (the person sees it):'); if (r !== null && confirm('Remove ' + nm(x) + ' from Stars?')) call({ action: 'status', user: x.user_email, status: 'removed', note: r }); } }) : ''];
        return el('tr', {}, [el('td', { text: nm(x) }), el('td', { text: x.status + (x.trial_until && x.status === 'trial' ? ' (until ' + String(x.trial_until).slice(0, 10) + ')' : '') }),
          el('td', { text: x.month ? (m.hours + ' h / ' + m.days + ' d / ' + m.coins + ' coins') : '—' }), el('td', { text: String(x.warnings || 0) }), el('td', { text: x.note || '' }), el('td', {}, acts)]);
      })));
      // bonuses
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: '💵 Monthly bonuses (worked out at the start of each month — check, then pay into the wallet)' }));
      box.appendChild(table(['Name', 'Month', 'Hours / days / coins', 'Tier', 'Amount', 'Status', ''], (d.bonuses || []).map(function (b) {
        return el('tr', {}, [el('td', { text: nm(b) }), el('td', { text: b.month }), el('td', { text: b.hours + ' h / ' + b.days + ' d / ' + b.coins }), el('td', { text: b.tier ? '⭐' + b.tier + (b.half ? ' (half)' : '') : '—' }),
          el('td', { text: '$' + (Number(b.amount_cents || 0) / 100).toFixed(2) }), el('td', { text: b.status }),
          el('td', {}, su && b.status === 'pending' ? [el('button', { class: 'btn-sm btn-blue', text: 'Pay', onclick: function () { if (confirm('Pay $' + (b.amount_cents / 100).toFixed(2) + ' to ' + nm(b) + '?')) call({ action: 'bonus', id: b.id, pay: true }); } }), ' ',
            el('button', { class: 'btn-sm', text: 'Cancel', onclick: function () { if (confirm('Cancel this bonus?')) call({ action: 'bonus', id: b.id, pay: false }); } })] : [])]);
      })));
    }
    call();
  }

  // ---------- 🎯 Challenges: goals for a time with steps (tier 1, 2, 3…) and/or Top N places; rewards = coins / frame / VIP / XP / a note / money ----------
  var CH_METRIC = { gift_recv: '🎁 Gift coins received', gift_sent: '🎁 Gift coins sent', room_minutes: '⏱️ Minutes in rooms (seat or listening)', seat_minutes: '🎤 Minutes on a seat', xp: '⚡ XP gained', checkins: '📅 Check-in days', room_followers: '❤️ New room followers', video_views: '▶️ Video views (Monetize)', posts: '📝 Posts made', followers: '👥 New followers' };
  var CH_REWARD = { coins: '🪙 Coins', money: '💵 Money ($, Admin approves)', frame: '🖼️ Frame', vip: '👑 VIP days', xp: '⚡ XP', note: '📝 Note only (e.g. a chance to become a Star)' };
  function challengesAdmin(body) {
    var box = el('div', { class: 'at-card' }); body.appendChild(box);
    var frames = [];
    function call(extra) { return adm('/api/admin/challenges', extra || {}).then(function (x) { if (x.success) draw(x); else alert(x.error || 'Failed'); return x; }); }
    function local(d) { if (!d) return ''; var x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); }
    function rewardTxt(r) { r = r || {}; var n = Number(r.amount) || 0; return r.type === 'money' ? '$' + (n / 100).toFixed(2) : r.type === 'coins' ? n + ' coins' : r.type === 'vip' ? 'VIP ' + n + ' days' : r.type === 'xp' ? n + ' XP' : r.type === 'frame' ? 'Frame #' + r.frame_id + ' ' + (r.days || 7) + ' days' : (r.label || '—'); }
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
      c = c || { icon: '🎯', area: 'party', metric: 'gift_recv', join_mode: 'join', max_people: 50, tiers: [{ need: 1000, reward: { type: 'coins', amount: 50 } }, { need: 5000, reward: { type: 'coins', amount: 300 } }, { need: 20000, reward: { type: 'money', amount: 500 } }], ranks: [], status: 'live',
        starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 7 * 86400000).toISOString() };
      var f = el('div', { style: 'border:2px solid #7c3aed;border-radius:14px;padding:12px;margin:10px 0;background:#faf7ff' });
      function inp(v, w, ph, type) { return el('input', { class: 'at-in', value: v == null ? '' : String(v), placeholder: ph || '', type: type || 'text', style: 'width:' + (w || 220) + 'px;display:inline-block' }); }
      function sel(map, v) { var x = el('select', { class: 'at-in', style: 'width:auto;display:inline-block' }); Object.keys(map).forEach(function (k) { var o = el('option', { value: k, text: map[k] }); if (k === v) o.selected = true; x.appendChild(o); }); return x; }
      function row(label, kids) { return el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0' }, [el('span', { style: 'min-width:170px;font-weight:700', text: label })].concat(kids)); }
      var icon = inp(c.icon, 60), tk = inp(c.title_km, 320, 'ចំណងជើង (ខ្មែរ)'), te = inp(c.title_en, 320, 'Title (English)');
      var bk = el('textarea', { class: 'at-in', rows: '3', style: 'width:100%', placeholder: 'អ្វីដែលអ្នកចូលរួមទទួលបាន (ខ្មែរ) — ឧ. ឱកាសក្លាយជាតារា ឱកាសរកលុយពីវីដេអូ…' }); bk.value = c.body_km || '';
      var be = el('textarea', { class: 'at-in', rows: '2', style: 'width:100%', placeholder: 'What people get (English)' }); be.value = c.body_en || '';
      var area = sel({ party: '🎉 Party Room', monetize: '💰 Monetize', both: 'Both' }, c.area), metric = sel(CH_METRIC, c.metric);
      var st = inp(local(c.starts_at), 200, '', 'datetime-local'), en = inp(local(c.ends_at), 200, '', 'datetime-local');
      var jm = sel({ join: 'People press "Join" (places can be limited)', auto: 'Everybody is in automatically' }, c.join_mode), mp = inp(c.max_people, 90, '0 = no limit', 'number');
      var ml = inp(c.min_level, 70, '0', 'number'), md = inp(c.min_days, 70, '0', 'number'), so = inp(c.sort, 70, '0', 'number');
      var stt = sel({ live: '🟢 Live', draft: '📝 Draft (hidden)', paused: '⏸ Paused (hidden)' }, c.status === 'ended' ? 'live' : c.status);
      var notify = el('input', { type: 'checkbox' });
      var tiersBox = el('div'), ranksBox = el('div'), tiers = [], ranks = [];
      function addTier(t) { t = t || {}; var need = inp(t.need, 100, 'need', 'number'), rw = rewardEditor(t.reward), line = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0' }); var o = { need: need, rw: rw };
        line.appendChild(el('b', { text: 'Step ' + (tiers.length + 1) + ': reach' })); line.appendChild(need); line.appendChild(el('span', { text: '→' })); line.appendChild(rw);
        line.appendChild(el('button', { class: 'btn-sm btn-gray', text: '✕', onclick: function () { tiers.splice(tiers.indexOf(o), 1); line.remove(); } })); tiers.push(o); tiersBox.appendChild(line); }
      function addRank(r) { r = r || {}; var fr = inp(r.from || (ranks.length + 1), 60, 'from', 'number'), to = inp(r.to || r.from || (ranks.length + 1), 60, 'to', 'number'), rw = rewardEditor(r.reward), line = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0' }); var o = { fr: fr, to: to, rw: rw };
        line.appendChild(el('b', { text: 'Place' })); line.appendChild(fr); line.appendChild(el('span', { text: 'to' })); line.appendChild(to); line.appendChild(el('span', { text: '→' })); line.appendChild(rw);
        line.appendChild(el('button', { class: 'btn-sm btn-gray', text: '✕', onclick: function () { ranks.splice(ranks.indexOf(o), 1); line.remove(); } })); ranks.push(o); ranksBox.appendChild(line); }
      (c.tiers || []).forEach(addTier); (c.ranks || []).forEach(addRank);
      f.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:6px', text: c.id ? '✏️ Edit challenge #' + c.id : '➕ New challenge' }));
      f.appendChild(row('Icon + title', [icon, tk, te]));
      f.appendChild(el('div', { style: 'font-weight:700;margin-top:6px', text: 'What people get (shown to them)' })); f.appendChild(bk); f.appendChild(be);
      f.appendChild(row('Shown in', [area]));
      f.appendChild(row('What is counted', [metric]));
      f.appendChild(row('Start → end', [st, el('span', { text: '→' }), en]));
      f.appendChild(row('Who takes part', [jm, el('span', { text: 'places:' }), mp]));
      f.appendChild(row('Needs (0 = none)', [el('span', { text: 'level Lv ≥' }), ml, el('span', { text: 'account age (days) ≥' }), md]));
      f.appendChild(el('div', { style: 'font-weight:800;margin:10px 0 2px', text: '🪜 Steps — reach the number → get the reward (everybody who reaches it)' })); f.appendChild(tiersBox);
      f.appendChild(el('button', { class: 'btn-sm', text: '+ Step', onclick: function () { addTier(); } }));
      f.appendChild(el('div', { style: 'font-weight:800;margin:10px 0 2px', text: '🏆 Top places — given when the challenge ends' })); f.appendChild(ranksBox);
      f.appendChild(el('button', { class: 'btn-sm', text: '+ Place', onclick: function () { addRank(); } }));
      f.appendChild(row('Status / order', [stt, el('span', { text: 'order' }), so]));
      if (!c.id) f.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;margin:6px 0' }, [notify, el('span', { text: '🔔 Tell everybody active in the last 30 days (a notification)' })]));
      f.appendChild(el('div', { style: 'color:#65676b;font-size:12.5px;margin:6px 0', text: 'Joining is always free. Coins, frames, VIP and XP are given at once; money waits here for a Super Admin to pay. Gifts between the same person\'s accounts should be checked before paying money.' }));
      f.appendChild(el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
        el('button', { class: 'btn-sm btn-blue', text: c.id ? '💾 Save' : '✅ Create', onclick: function () {
          var data = { id: c.id, icon: icon.value, title_km: tk.value, title_en: te.value, body_km: bk.value, body_en: be.value, area: area.value, metric: metric.value,
            starts_at: new Date(st.value).toISOString(), ends_at: new Date(en.value).toISOString(), join_mode: jm.value, max_people: mp.value, min_level: ml.value, min_days: md.value, status: stt.value, sort: so.value,
            tiers: tiers.map(function (t) { return { need: Number(t.need.value), reward: t.rw.read() }; }), ranks: ranks.map(function (r) { return { from: Number(r.fr.value), to: Number(r.to.value), reward: r.rw.read() }; }) };
          if (!st.value || !en.value) return alert('Choose the start and end time.');
          call({ action: 'save', challenge: data, notify: notify.checked });
        } }),
        el('button', { class: 'btn-sm btn-gray', text: 'Cancel', onclick: function () { f.remove(); } })]));
      return f;
    }
    function draw(d) {
      box.textContent = ''; frames = d.frames || [];
      var su = d.isSuperAdmin;
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '🎯 Challenges' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'The 🎯 Challenge button in the app (Party Room top right) and the Monetize page show the live ones. Everything here can change at any time without an app update.' }));
      var formBox = el('div'); box.appendChild(formBox);
      if (su) box.appendChild(el('button', { class: 'btn-sm btn-blue', text: '➕ New challenge', onclick: function () { formBox.textContent = ''; formBox.appendChild(form()); } }));
      var peopleBox = el('div');
      box.appendChild(table(['', 'Challenge', 'Counts', 'When', 'Who', 'Joined', 'Rewards', 'Status', ''], (d.challenges || []).map(function (c) {
        return el('tr', {}, [el('td', { text: c.icon }), el('td', { text: c.title_km + (c.title_en ? ' · ' + c.title_en : '') + ' (' + c.area + ')' }), el('td', { text: CH_METRIC[c.metric] || c.metric }),
          el('td', { text: new Date(c.starts_at).toLocaleString() + ' → ' + new Date(c.ends_at).toLocaleString() }), el('td', { text: c.join_mode === 'join' ? 'Join' + (c.max_people ? ' (max ' + c.max_people + ')' : '') : 'Everybody' }),
          el('td', { text: c.join_mode === 'join' ? String(c.joined) : '—' }), el('td', { text: String(c.rewards) }), el('td', { text: c.status }),
          el('td', {}, [
            el('button', { class: 'btn-sm', text: '👥 People', onclick: function () { adm('/api/admin/challenges', { action: 'people', id: c.id }).then(function (r) {
              peopleBox.textContent = ''; if (!r.success) return;
              peopleBox.appendChild(el('div', { style: 'font-weight:800;margin:12px 0 4px', text: '👥 ' + c.title_km + ' — numbers now' }));
              peopleBox.appendChild(table(['#', 'Person', 'Number'], r.people.map(function (p) { return el('tr', {}, [el('td', { text: String(p.place) }), el('td', { text: nm(p) + ' · ' + p.user_email }), el('td', { text: String(p.value) })]); })));
              peopleBox.scrollIntoView({ behavior: 'smooth' }); }); } }),
            su ? el('button', { class: 'btn-sm', text: '✏️ Edit', onclick: function () { formBox.textContent = ''; formBox.appendChild(form(c)); formBox.scrollIntoView({ behavior: 'smooth' }); } }) : '',
            su && c.status === 'live' ? el('button', { class: 'btn-sm', text: '⏸ Pause', onclick: function () { call({ action: 'status', id: c.id, status: 'paused' }); } }) : '',
            su && (c.status === 'paused' || c.status === 'draft') ? el('button', { class: 'btn-sm btn-blue', text: '▶ Live', onclick: function () { call({ action: 'status', id: c.id, status: 'live' }); } }) : '',
            su && c.status === 'live' ? el('button', { class: 'btn-sm btn-red', text: '⏹ End now', onclick: function () { if (confirm('End "' + c.title_km + '" now and give the Top places?')) call({ action: 'status', id: c.id, status: 'end' }); } }) : '',
            su && !Number(c.rewards) ? el('button', { class: 'btn-sm btn-gray', text: '🗑', onclick: function () { if (confirm('Delete this challenge?')) call({ action: 'status', id: c.id, status: 'delete' }); } }) : ''])]);
      })));
      box.appendChild(peopleBox);
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: '💵 Rewards (money waits here; others were given at once)' }));
      box.appendChild(table(['Person', 'Challenge', 'For', 'Number', 'Reward', 'Status', ''], (d.rewards || []).map(function (r) {
        return el('tr', {}, [el('td', { text: nm(r) + ' · ' + r.user_email }), el('td', { text: r.title_km }), el('td', { text: r.kind === 'rank' ? 'Place ' + r.level : 'Step ' + r.level }), el('td', { text: String(r.value) }),
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
      box.appendChild(el('div', { style: 'font-size:16px;font-weight:800;margin-bottom:4px', text: '🪙 Coins & 🎁 gifts (Party Room)' }));
      if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      var tt = d.totals || {};
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: '1 coin = $0.01. Sold on the website so far: $' + Number(tt.sold_usd || 0).toFixed(2) + ' · coins spent on gifts: ' + Number(tt.gift_coins || 0).toLocaleString() + ' · paid to receivers: $' + (Number(tt.receiver_cents || 0) / 100).toFixed(2) + '. People buy on camfeedkh.com/coins.html.' }));
      var su = !!d.isSuperAdmin;
      // top-ups waiting
      box.appendChild(el('div', { style: 'font-weight:800;margin:10px 0 6px', text: 'Top-ups waiting (' + d.pending.length + ')' }));
      if (!d.pending.length) box.appendChild(empty('Nothing waiting.'));
      else box.appendChild(table(['Person', 'Pack', 'Paid with', 'Transaction', 'Receipt', 'Sent', ''], d.pending.map(function (x) {
        return el('tr', {}, [el('td', { text: nm(x) + ' · ' + x.user_email }), el('td', { text: '$' + Number(x.usd).toFixed(2) + ' → ' + x.coins + ' coins' }), el('td', { text: x.method }), el('td', { text: x.payer_ref || '—' }),
          el('td', {}, [x.receipt_url ? el('a', { href: x.receipt_url, target: '_blank', text: '🖼️ Open' }) : el('span', { text: '—' })]), el('td', { text: ago(x.created_at) }),
          el('td', {}, su ? [
            el('button', { class: 'btn-sm btn-blue', text: 'Approve', onclick: function () { if (confirm('Add ' + x.coins + ' coins to ' + nm(x) + '? Check that the money arrived first.')) call({ action: 'decide', id: x.id, status: 'approved' }); } }), ' ',
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
        var r = el('div', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0' }, [el('span', { text: '$' }), u, el('span', { text: 'website coins' }), w, el('span', { text: 'in-app coins (later)' }), a,
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
      box.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;margin:10px 0;font-weight:700' }, [wOn, el('span', { text: '💰 People can change wallet money into coins (same coins as the website packs, at once)' })]));
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
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:6px', text: 'People buy a frame with coins for some days; it shows around their picture on the seats, in the room chat and the room list. Colours: #RRGGBB, comma between (2–4). Move: none / pulse / spin.' }));
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
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:6px', text: 'Level = XP (like Bigo). XP comes from: coins spent (gifts, frames, VIP), gift coins received, minutes in rooms (a seat gives more, up to a daily limit) and the daily check-in; VIP gets extra XP for time and check-in. Write the XP where each level starts, comma between, first is 0 (Level 1). VIP: N days bought with coins: 👑 badge, golden name, a big "VIP came in" banner, first in the ✋ list, a helper can not send them out.' }));
      var lv = el('input', { class: 'at-in', value: (st.levels || []).join(','), style: 'width:100%' });
      var xr = st.xp || {}, pk = st.perks || {};
      function xin(v) { var i = el('input', { class: 'at-in', type: 'number', value: String(v == null ? '' : v), style: 'width:80px' }); if (!su) i.disabled = true; return i; }
      var xSpend = xin(xr.spend), xRecv = xin(xr.receive), xListen = xin(xr.listen), xSeat = xin(xr.seat), xMax = xin(xr.roomMax), xCk = xin(xr.checkin), xVip = xin(xr.vipBonus), pName = xin(pk.nameColor), pEntry = xin(pk.entry);
      function xrow(label, i) { return el('div', { style: 'display:flex;gap:8px;align-items:center;margin:3px 0' }, [el('span', { style: 'min-width:330px', text: label }), i]); }
      box.appendChild(el('div', { style: 'font-weight:700;margin:8px 0 4px', text: 'How much XP' }));
      box.appendChild(xrow('XP for 1 coin spent', xSpend));
      box.appendChild(xrow('XP for 1 gift coin received', xRecv));
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
        el('span', { text: 'VIP price (coins)' }), vp, el('span', { text: 'days' }), vd,
        su ? el('button', { class: 'btn-sm btn-blue', text: 'Save VIP & levels', onclick: function () { call({ action: 'vip', levels: lv.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean), vipPrice: vp.value, vipDays: vd.value, vipOn: vo.checked,
          xp: { spend: xSpend.value, receive: xRecv.value, listen: xListen.value, seat: xSeat.value, roomMax: xMax.value, checkin: xCk.value, vipBonus: xVip.value }, perks: { nameColor: pName.value, entry: pEntry.value } }); } }) : '']));
      // 📅 daily check-in
      box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 2px', text: '📅 Daily check-in (today: ' + (d.checkinToday || 0) + ' people · coins given in 30 days: ' + Number(d.checkinCoins30 || 0).toLocaleString() + ')' }));
      box.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:6px', text: 'Once a day people open a 🎁 gift box (+ the check-in XP set in VIP & levels). Coins go round between people: only N winners a day get coins (picked by chance through the whole day), a winner waits some days before winning again, everybody else finds the box empty. Prize of a winner: coins:weight, e.g. 1:3,2:2 = 1 coin (3 of 5) or 2 coins (2 of 5). Careful: coins can be gifted, and gifts turn into real money for the receiver — keep them small.' }));
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
        box.appendChild(el('div', { style: 'font-weight:800;margin:16px 0 6px', text: 'Give or take coins by hand' }));
        var who = el('input', { class: 'at-in', placeholder: 'e-mail, phone account or 15-digit id' }), n = el('input', { class: 'at-in', type: 'number', placeholder: '+100 or -100' }), why = el('input', { class: 'at-in', placeholder: 'Note (kept in the audit log)' });
        box.appendChild(who); box.appendChild(n); box.appendChild(why);
        box.appendChild(el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px;margin-top:10px', text: 'Apply', onclick: function () {
          if (!confirm('Change coins of ' + who.value + ' by ' + n.value + '?')) return;
          call({ action: 'adjust', user: who.value, coins: n.value, note: why.value }).then(function (x) { if (x.success) alert('✅ Done'); });
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
        return el('tr', {}, [el('td', { text: '#' + r.room_id + ' ' + (r.title || '') }), el('td', { text: r.status || '—' }), el('td', { text: r.owner_email || '' }), el('td', { text: r.reason || '' }),
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
        box.appendChild(table(['Emoji', 'Khmer', 'English', 'Move', 'Coins (0 = free)', 'Order', 'On', ''], rows));
      });
    }
    adm('/api/admin/party', {}).then(draw);
  }
  // the rules: Creator Program (who may ask to earn) and, separately, the invitation reward. Super Admin can change them at any time.
  var RULE_LABEL = {
    CREATOR_MIN_FOLLOWERS: 'Followers at least', CREATOR_MIN_VIEWS: 'Total views at least', CREATOR_MIN_POSTS: 'Posts at least', CREATOR_MIN_ACCOUNT_DAYS: 'Account age at least (days)', MIN_WITHDRAW_USD: 'Smallest withdrawal ($)',
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
          adm('/api/admin/withdrawals/decide', { id: w.id, status: status, note: note, code: code }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
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
        var hot = w.reissue_requested_at ? 'background:#fff4e5' : '';
        return el('tr', { style: hot }, [el('td', {}, [el('div', { style: 'font-weight:700', text: nm(w) }), el('div', { style: 'font-size:11.5px;color:#65676b', text: w.public_id || '' })]), el('td', { style: 'font-weight:800', text: money(w.amount) }), el('td', { text: ML[w.method] || w.method }), el('td', { text: w.account_name || '' }), el('td', { text: w.account_number || '' }), el('td', { text: fmt(w.created_at) }), el('td', {}, [statusBadge(w.status)]), el('td', {}, kids)]);
      })));
    });
  }
  function monWallet(body) {
    var out = el('div', { id: 'monOut', style: 'display:none' });
    var who = el('input', { class: 'at-in', id: 'mwWho', placeholder: 'Phone number, Gmail or 15-digit ID of the creator' });
    var amount = el('input', { class: 'at-in', id: 'mwAmount', type: 'number', step: '0.01', placeholder: 'Amount in $ (negative = take back)' });
    var kind = el('select', { class: 'at-in', id: 'mwKind' }, [el('option', { value: 'bonus', text: '🎁 Gift (creator gets a notification)' }), el('option', { value: 'adjustment', text: 'Correction' })]);
    var note = el('input', { class: 'at-in', id: 'mwNote', placeholder: 'Reason (the creator sees it), e.g. "Launch contest winner"' });
    var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px', text: 'Add to wallet', onclick: function () {
      if (!confirm('Change the wallet of ' + who.value + ' by ' + amount.value + ' $ ?')) return; btn.disabled = true;
      adm('/api/admin/wallet/credit', { identifier: who.value, amount: amount.value, kind: kind.value, note: note.value }).then(function (d) { btn.disabled = false; msg(out, d.success, d.success ? '✅ ' + (d.name || 'The creator') + ' now has ' + money(d.balance) : '❌ ' + (d.error || 'Failed')); if (d.success) { amount.value = ''; note.value = ''; } });
    } });
    body.appendChild(el('div', { style: 'max-width:520px' }, [el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Only a Super Admin can change a wallet. Use it for prizes and contest rewards. Every change is written to the Activity Log.' }), el('div', { class: 'at-lbl', text: 'Creator' }), who, el('div', { class: 'at-lbl', text: 'Amount' }), amount, el('div', { class: 'at-lbl', text: 'Type' }), kind, el('div', { class: 'at-lbl', text: 'Reason' }), note, el('div', { style: 'margin-top:12px' }, [btn]), out]));
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
    [title, artist, file, st, btn].forEach(function (x) { form.appendChild(x); }); p.appendChild(form); p.appendChild(out); p.appendChild(list); list.appendChild(empty('Loading…'));
    adm('/api/admin/sounds', {}).then(function (d) {
      list.textContent = ''; if (!d.success) { list.appendChild(empty(d.error || 'Could not load.')); return; } if (!d.sounds.length) { list.appendChild(empty('No sounds yet.')); return; }
      d.sounds.forEach(function (sn) {
        var tg = el('button', { class: 'btn-sm ' + (sn.active ? 'btn-red' : 'btn-blue'), text: sn.active ? 'Turn off' : 'Turn on', onclick: function () { adm('/api/admin/sounds/toggle', { id: sn.id, active: !sn.active }).then(function () { loadSoundsAdmin(); }); } });
        var au = el('audio', { controls: 'controls', preload: 'none', src: sn.url, style: 'height:32px;max-width:220px' });
        list.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid #e4e6eb;border-radius:10px;padding:8px 12px;margin-bottom:6px' }, [
          el('div', { style: 'flex:1;min-width:140px' }, [el('b', { text: (sn.active ? '' : '⛔ ') + sn.title }), el('div', { style: 'font-size:12px;color:#65676b', text: (sn.artist ? sn.artist + ' · ' : '') + sn.duration + 's · used ' + sn.uses + '×' })]), au, tg]));
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
  function loadAdsAdmin() {
    var p = document.getElementById('panel-ads'); if (!p) return;
    p.textContent = '';
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
  var KIND = { withdrawal: '💸', reissue: '🔑', creator: '💰', report: '🚩', ad: '📢', live: '🔴', coins: '🪙', party: '🎉', star: '⭐', challenge: '🎯' };
  var BASE = { 'tabBtn-monetization': '💰 Monetization', 'tabBtn-reports': '🚩 Reports Queue', 'tabBtn-ads': '📢 Ads', 'tabBtn-live': '🔴 Live', 'tabBtn-inbox': '🔔 Inbox', 'tabBtn-coins': '🪙 Coins & Gifts', 'tabBtn-party': '🎉 Party Room', 'tabBtn-stars': '⭐ Stars', 'tabBtn-challenges': '🎯 Challenges' };
  var lastTotal = -1, baseTitle = document.title;
  function setBadge(id, n) { var b = document.getElementById(id); if (b) b.textContent = BASE[id] + (n > 0 ? '  (' + n + ')' : ''); }
  function applyInbox(d) {
    var c = d.counts;
    setBadge('tabBtn-inbox', d.total); setBadge('tabBtn-monetization', c.withdrawals + c.reissue + c.creators); setBadge('tabBtn-reports', (c.reports || 0) + (c.chatReports || 0)); setBadge('tabBtn-ads', c.ads); setBadge('tabBtn-live', c.live); setBadge('tabBtn-coins', c.coins || 0); setBadge('tabBtn-party', c.party || 0); setBadge('tabBtn-stars', (c.stars || 0) + (c.starBonus || 0)); setBadge('tabBtn-challenges', c.challengeRewards || 0);
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
      var chips = [['💸 Withdrawals', c.withdrawals, 'monetization'], ['🔑 New payout code', c.reissue, 'monetization'], ['💰 Creator applications', c.creators, 'monetization'], ['🚩 Reports', c.reports, 'reports'], ['💬 Chat reports', c.chatReports || 0, 'reports'], ['📢 Ad requests', c.ads, 'ads'], ['🔴 Live requests', c.live, 'live'], ['🪙 Coin top-ups', c.coins || 0, 'coins'], ['🎉 Room reports', c.party || 0, 'party'], ['⭐ Star applications', c.stars || 0, 'stars'], ['💵 Star bonuses to pay', c.starBonus || 0, 'stars'], ['🎯 Challenge money to pay', c.challengeRewards || 0, 'challenges']];
      p.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 14px' }, chips.map(function (x) {
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
  var TAB_SECTION = { inbox: 'inbox', overview: 'overview', audit: 'audit', umanage: 'users', users: 'users', accounts: 'users', chats: 'chats', reports: 'content', content: 'content', posts: 'content',
    live: 'live', sounds: 'sounds', ads: 'ads', monetization: 'money', coins: 'coins', party: 'party', challenges: 'challenges', stars: 'stars', system: 'system', appcfg: 'system' };
  var SECTION_NAME = { inbox: '🔔 Inbox', overview: '📊 Overview', audit: '🧾 Activity Log', users: '👥 Users', chats: '💬 Chats', content: '🛡️ Content & reports', live: '🔴 Live', sounds: '🎵 Sounds', ads: '📢 Ads',
    money: '💰 Money (withdrawals, creators, referrals)', coins: '🪙 Coins & Gifts', party: '🎉 Party Room', challenges: '🎯 Challenges', stars: '⭐ Stars', system: '⚙️ System' };
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
    var FEAT = [['partyRoom', '🎉 Party Room'], ['challenge', '🎯 Challenge button'], ['wallet', '💰 My wallet (in the menu)'], ['coins', '🪙 Coins button (Party Room)'],
      ['vip', '👑 VIP & levels button'], ['frames', '🖼️ Profile frames button'], ['checkin', '📅 Daily check-in'], ['stars', '⭐ Stars'], ['ranking', '🏆 Ranking'],
      ['partyFollowers', '❤️ Room followers list'], ['roomClock', '⏱️ Room clock'], ['saveSound', '🎵 Use the sound of a video'], ['watchHistory', '🕘 Watch history'], ['chatFiles', '📎 Send files in chat']];
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
      var fFeed = field('📰 A post already seen may come back in the feed after (days)', (c.feed || {}).reshowDays, 'only after "all caught up", never on top · 1–365');
      var fl = c.files || {};
      var fMax = field('📎 Biggest file in chat (MB)', fl.maxMB, '1–500 · bigger files cost more storage');
      var fDay = field('📎 Files one person may send a day', fl.perDay, '1–1000');
      var fBlk = field('📎 File endings that can not be sent', (fl.blocked || []).join(', '), 'e.g. apk, exe (web pages like html/svg/js are always refused)');
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
          feed: { reshowDays: Number(fFeed.value) },
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
    if (tab === 'inbox') loadInbox(); else if (tab === 'overview') loadOverview(); else if (tab === 'umanage') { if (!document.getElementById('uQuery')) buildUsers(); } else if (tab === 'content') { if (!document.getElementById('cQuery')) buildContent(); } else if (tab === 'audit') loadAudit(true); else if (tab === 'system') loadSystem(); else if (tab === 'monetization') loadMonetizationAdmin(); else if (tab === 'ads') loadAdsAdmin(); else if (tab === 'live') loadLiveAdmin(); else if (tab === 'sounds') loadSoundsAdmin(); else if (tab === 'party') { var pp = document.getElementById('panel-party'); pp.textContent = ''; partyAdmin(pp); } else if (tab === 'coins') { var pc = document.getElementById('panel-coins'); pc.textContent = ''; coinsAdmin(pc); } else if (tab === 'stars') { var ps = document.getElementById('panel-stars'); ps.textContent = ''; starsAdmin(ps); } else if (tab === 'challenges') { var pg = document.getElementById('panel-challenges'); pg.textContent = ''; challengesAdmin(pg); } else if (tab === 'appcfg') { var pa = document.getElementById('panel-appcfg'); pa.textContent = ''; appConfigAdmin(pa); } else if (tab === 'perms') { var pp2 = document.getElementById('panel-perms'); pp2.textContent = ''; permsAdmin(pp2); } else if (tab === 'reports') { chatReportsAdmin(); } else if (tab === 'chats') { if (!document.getElementById('chatQ')) loadChatsAdmin(); }
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
