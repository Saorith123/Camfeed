/* CamFeed Admin Center: Overview, Users (search + manage), Content moderation, Activity log, System check.
   Everything shown comes from the server as TEXT (never inserted as HTML). Uses the page's currentUser / savedAdminKey. */
(function () {
  'use strict';
  var TABS = [['overview', '📊 Overview'], ['umanage', '👥 Users'], ['content', '📝 Content'], ['audit', '🧾 Activity Log'], ['ads', '📢 Ads'], ['system', '⚙️ System']];

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
  function adm(path, body, method) {
    var payload = Object.assign({ adminEmail: currentUser.email, adminKey: savedAdminKey }, body || {});
    return fetch(path, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) { return r.json().catch(function () { return { success: false, error: 'Bad answer from the server.' }; }); })
      .catch(function () { return { success: false, error: 'Server connection error.' }; });
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

  var css = el('style', { text: '.at-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}' +
    '.at-card{background:#fff;border-radius:14px;max-width:760px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.35)}' +
    '.at-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.at-in{width:100%;padding:9px 11px;border:1px solid #ccd0d5;border-radius:8px;font-size:14px;background:#fff}' +
    '.at-lbl{font-size:12px;font-weight:700;color:#65676b;margin:8px 0 3px}.at-h{font-size:15px;font-weight:800;margin:18px 0 8px}' +
    '.at-bars{display:flex;align-items:flex-end;gap:5px;height:110px;margin-top:8px}.at-bar{flex:1;background:#1877f2;border-radius:4px 4px 0 0;min-height:3px;position:relative}' +
    '.at-bar span{position:absolute;top:-16px;left:0;right:0;text-align:center;font-size:10.5px;color:#65676b}.at-days{display:flex;gap:5px;margin-top:4px}.at-days div{flex:1;text-align:center;font-size:10px;color:#65676b}' +
    '.at-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.at-ok{color:#176f35;font-weight:800}.at-warn{color:#b45309;font-weight:800}' +
    '.at-chk{display:flex;gap:12px;align-items:flex-start;padding:11px 4px;border-bottom:1px solid #f0f2f5}.at-chk b{display:block}.at-chk small{color:#65676b}' });
  document.head.appendChild(css);

  // ---------- tabs ----------
  function build() {
    var bar = document.querySelector('.tabs-bar'), dash = document.getElementById('adminDashboard'); if (!bar || !dash) return;
    TABS.forEach(function (t) {
      bar.insertBefore(el('button', { class: 'tab-btn', id: 'tabBtn-' + t[0], text: t[1], onclick: function () { switchAdminTab(t[0]); } }), bar.firstChild && t[0] === 'overview' ? bar.firstChild : null);
      dash.appendChild(el('div', { class: 'panel', id: 'panel-' + t[0], style: 'display:none' }));
    });
    // keep the order: Overview, Users, Content, (existing: Monetization, Reports, All Users, Posts, Accounts), Activity Log, System
    var order = ['overview', 'umanage', 'content', 'monetization', 'ads', 'reports', 'users', 'posts', 'accounts', 'audit', 'system'];
    order.forEach(function (id) { var b = document.getElementById('tabBtn-' + id); if (b) bar.appendChild(b); });
    var panels = {}; order.forEach(function (id) { panels[id] = document.getElementById('panel-' + id); });
    order.forEach(function (id) { if (panels[id]) dash.appendChild(panels[id]); });
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
      act('⭐ Make Creator', 'btn-green', function () {
        if (!confirm('Put ' + nm(u) + ' in the Creator Program (no need to meet the requirements)?')) return;
        adm('/api/admin/monetization-action', { targetEmail: u.email, status: 'approved', note: 'Invited by an admin' }).then(function (r) { msg(out, r.success, r.success ? '✅ ' + nm(u) + ' is now a Creator' : '❌ ' + (r.error || 'Failed')); });
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
      Object.keys(HINTS).forEach(function (k) {
        var ok = k === 'supportTelegram' ? !!c[k] : !!c[k]; var extra = k === 'database' && c.databaseMs !== null ? ' (' + c.databaseMs + ' ms)' : (k === 'supportTelegram' && c[k] ? ' ' + c[k] : '');
        p.appendChild(el('div', { class: 'at-chk' }, [el('span', { class: ok ? 'at-ok' : 'at-warn', text: ok ? '✅' : '⚠️' }), el('div', {}, [el('b', { text: HINTS[k][0] + extra }), el('small', { text: ok ? 'Working' : HINTS[k][1] })])]));
      });
      var more = [['Feed order', c.feedMode === 'ranked' ? 'Ranked by popularity and interests' : 'Newest first'], ['Video feed order', c.videoFeedMode === 'ranked' ? 'Ranked' : 'Newest first'], ['Hide e-mails behind IDs', c.maskUserIds ? 'On' : 'OFF'], ['Show server error texts', c.debugErrors ? 'ON (turn off after debugging)' : 'Off'], ['Strict security policy (CSP)', c.cspEnforced ? 'Enforced' : 'Report only'], ['Server running for', c.uptimeMinutes + ' min'], ['Memory', c.memoryMb + ' MB'], ['Node', c.node]];
      p.appendChild(el('div', { class: 'at-h', text: 'Settings in use' })); more.forEach(function (m) { p.appendChild(el('div', { class: 'at-chk' }, [el('span', { text: '•' }), el('div', {}, [el('b', { text: m[0] }), el('small', { text: m[1] })])])); });
    });
  }


  // ---------- Monetization (Creator Program, wallets, withdrawals) ----------
  var mon = { view: 'apps' };
  function money(n) { return '$' + Number(n || 0).toFixed(2); }
  function statusBadge(s) { return el('span', { class: 'badge ' + (s === 'approved' || s === 'paid' ? 'badge-resolved' : s === 'pending' ? 'badge-pending' : 'badge-banned'), text: s }); }
  function loadMonetizationAdmin() {
    var p = document.getElementById('panel-monetization'); if (!p) return;
    p.textContent = '';
    var bar = el('div', { class: 'at-row' }, [['apps', '⭐ Applications'], ['ref', '🎁 Invitations'], ['wd', '💵 Withdrawals'], ['wallet', '👛 Wallet bonus']].map(function (v) {
      return el('button', { class: 'btn-sm ' + (mon.view === v[0] ? 'btn-blue' : 'btn-gray'), text: v[1], onclick: function () { mon.view = v[0]; loadMonetizationAdmin(); } });
    }));
    p.appendChild(bar); var body = el('div', { id: 'monBody' }); p.appendChild(body);
    if (mon.view === 'apps') monApps(body); else if (mon.view === 'ref') monReferrals(body); else if (mon.view === 'wd') monWithdrawals(body); else monWallet(body);
  }
  function monApps(body) {
    body.appendChild(empty('Loading…'));
    adm('/api/admin/monetization-requests').then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      d.requests = d.requests || []; var pending = d.requests.filter(function (r) { return r.status === 'pending'; }).length; var sm = document.getElementById('statMonetize'); if (sm) sm.textContent = String(pending);
      var c = d.criteria || { followers: 0, views: 0, posts: 0, ageDays: 0 };
      body.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Requirements: ' + c.followers + ' followers · ' + c.views + ' views · ' + c.posts + ' posts · ' + c.ageDays + ' days old (set with CREATOR_MIN_* in Render). You may approve anyone: open Users → Manage → "Make Creator".' }));
      if (!d.requests.length) { body.appendChild(empty('No application yet.')); return; }
      body.appendChild(table(['Creator', 'Followers', 'Views', 'Posts', 'Age', 'Wallet', 'Status', 'Decision', ''], d.requests.map(function (r) {
        function decide(status, askNote) {
          var note = ''; if (askNote) { note = prompt('Reason (shown to the creator):', '') || ''; } else if (!confirm((status === 'approved' ? 'Approve ' : 'Reset ') + nm(r) + '?')) return;
          adm('/api/admin/monetization-action', { targetEmail: r.user_email, status: status, note: note }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
        }
        var acts = el('td', {}, r.status === 'pending' ? [el('button', { class: 'btn-sm btn-green', text: 'Approve', onclick: function () { decide('approved', false); } }), el('button', { class: 'btn-sm btn-red', text: 'Reject', onclick: function () { decide('rejected', true); } })]
          : [el('button', { class: 'btn-sm btn-gray', text: 'Reset to pending', onclick: function () { decide('pending', false); } })]);
        function stat(have, need) { return el('td', { text: Number(have).toLocaleString() + ' / ' + Number(need).toLocaleString(), style: have >= need ? 'color:#176f35;font-weight:700' : '' }); }
        return el('tr', {}, [el('td', {}, [el('div', { style: 'font-weight:700', text: nm(r) }), el('div', { style: 'font-size:11.5px;color:#65676b', text: r.public_id || '' })]), stat(r.followers_count, c.followers), stat(r.total_views, c.views), stat(r.posts_count, c.posts), stat(r.age_days, c.ageDays), el('td', { text: money(r.balance) }),
          el('td', {}, [statusBadge(r.status)]), el('td', { style: 'font-size:12px;color:#65676b', text: (r.decided_by ? 'by ' + r.decided_by + ' · ' : '') + (r.note || '') }), acts]);
      })));
    });
  }
  function monReferrals(body) {
    body.appendChild(empty('Loading…'));
    adm('/api/admin/referrals').then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      d.referrals = d.referrals || []; var rl = d.rules || { rewardCents: 20, days: 3, posts: 3, windowDays: 14 };
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
  function monWithdrawals(body) {
    body.appendChild(empty('Loading…'));
    adm('/api/admin/withdrawals').then(function (d) {
      body.textContent = ''; if (!d.success) { body.appendChild(empty(d.error || 'Could not load.')); return; }
      body.appendChild(el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: d.isSuperAdmin ? 'Pay the person yourself (ABA / Wing / KHQR), then press "Mark paid". "Reject" gives the money back to their wallet.' : 'Only a Super Admin can pay or refuse a withdrawal.' }));
      d.withdrawals = d.withdrawals || []; if (!d.withdrawals.length) { body.appendChild(empty('No withdrawal request yet.')); return; }
      body.appendChild(table(['Creator', 'Amount', 'Pay with', 'Account name', 'Account number', 'Asked', 'Status', ''], d.withdrawals.map(function (w) {
        function decide(status) {
          var note = prompt(status === 'paid' ? 'Bank reference / note (optional):' : 'Reason for refusing (shown to the creator):', '') ; if (note === null) return;
          if (!confirm((status === 'paid' ? 'Mark ' + money(w.amount) + ' as PAID to ' : 'Refuse and refund ' + money(w.amount) + ' to ') + nm(w) + '?')) return;
          adm('/api/admin/withdrawals/decide', { id: w.id, status: status, note: note }).then(function (x) { if (x.success) loadMonetizationAdmin(); else alert(x.error || 'Failed'); });
        }
        var acts = el('td', {}, w.status === 'pending' && d.isSuperAdmin ? [el('button', { class: 'btn-sm btn-green', text: 'Mark paid', onclick: function () { decide('paid'); } }), el('button', { class: 'btn-sm btn-red', text: 'Reject', onclick: function () { decide('rejected'); } })] : [el('span', { style: 'font-size:12px;color:#65676b', text: w.note || '' })]);
        return el('tr', {}, [el('td', {}, [el('div', { style: 'font-weight:700', text: nm(w) }), el('div', { style: 'font-size:11.5px;color:#65676b', text: w.public_id || '' })]), el('td', { style: 'font-weight:800', text: money(w.amount) }), el('td', { text: w.method }), el('td', { text: w.account_name || '' }), el('td', { text: w.account_number || '' }), el('td', { text: fmt(w.created_at) }), el('td', {}, [statusBadge(w.status)]), acts]);
      })));
    });
  }
  function monWallet(body) {
    var out = el('div', { id: 'monOut', style: 'display:none' });
    var who = el('input', { class: 'at-in', id: 'mwWho', placeholder: 'Phone number, Gmail or 15-digit ID of the creator' });
    var amount = el('input', { class: 'at-in', id: 'mwAmount', type: 'number', step: '0.01', placeholder: 'Amount in $ (negative = take back)' });
    var kind = el('select', { class: 'at-in', id: 'mwKind' }, [el('option', { value: 'bonus', text: 'Bonus / prize' }), el('option', { value: 'adjustment', text: 'Correction' })]);
    var note = el('input', { class: 'at-in', id: 'mwNote', placeholder: 'Reason (the creator sees it), e.g. "Launch contest winner"' });
    var btn = el('button', { class: 'btn-sm btn-blue', style: 'padding:10px 16px', text: 'Add to wallet', onclick: function () {
      if (!confirm('Change the wallet of ' + who.value + ' by ' + amount.value + ' $ ?')) return; btn.disabled = true;
      adm('/api/admin/wallet/credit', { identifier: who.value, amount: amount.value, kind: kind.value, note: note.value }).then(function (d) { btn.disabled = false; msg(out, d.success, d.success ? '✅ ' + (d.name || 'The creator') + ' now has ' + money(d.balance) : '❌ ' + (d.error || 'Failed')); if (d.success) { amount.value = ''; note.value = ''; } });
    } });
    body.appendChild(el('div', { style: 'max-width:520px' }, [el('div', { style: 'color:#65676b;font-size:13px;margin-bottom:10px', text: 'Only a Super Admin can change a wallet. Use it for prizes and contest rewards. Every change is written to the Activity Log.' }), el('div', { class: 'at-lbl', text: 'Creator' }), who, el('div', { class: 'at-lbl', text: 'Amount' }), amount, el('div', { class: 'at-lbl', text: 'Type' }), kind, el('div', { class: 'at-lbl', text: 'Reason' }), note, el('div', { style: 'margin-top:12px' }, [btn]), out]));
  }
  window.loadMonetizationAdmin = loadMonetizationAdmin;


  // ---------- Sponsored ads (local advertising) ----------
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
  function loadAdRequests() {
    var box = document.getElementById('adReqs'); if (!box) return; box.textContent = ''; box.appendChild(empty('Loading…'));
    adm('/api/admin/ad-requests/list').then(function (d) {
      box.textContent = ''; if (!d.success) { box.appendChild(empty(d.error || 'Could not load.')); return; }
      if (!d.requests.length) { box.appendChild(empty('No requests yet.')); return; }
      d.requests.forEach(function (r) {
        var price = el('input', { class: 'at-in', type: 'number', min: '0', step: '0.01', placeholder: 'Price USD', style: 'max-width:130px', value: r.price_cents ? (r.price_cents / 100).toFixed(2) : '' });
        var note = el('input', { class: 'at-in', placeholder: 'Note to advertiser (optional)', maxlength: '300', style: 'flex:1;min-width:160px' });
        var acts = el('div', { class: 'at-row', style: 'margin:8px 0 0' });
        var open = r.status === 'pending' || r.status === 'quoted' || r.status === 'payment_sent';
        if (r.status === 'pending' || r.status === 'quoted') { acts.appendChild(price); acts.appendChild(note); acts.appendChild(el('button', { class: 'btn-sm btn-blue', text: r.status === 'quoted' ? 'Update price' : 'Send price', onclick: function () { adm('/api/admin/ad-requests/quote', { id: r.id, price_usd: price.value, note: note.value }).then(function (x) { if (!x.success) alert(x.error); loadAdRequests(); }); } })); }
        if ((r.status === 'quoted' || r.status === 'payment_sent') && d.isSuperAdmin) acts.appendChild(el('button', { class: 'btn-sm btn-blue', text: '✅ Money received - start ad', onclick: function () { if (confirm('Start this ad for ' + r.days + ' days? Only do this after the money is in your account.')) adm('/api/admin/ad-requests/activate', { id: r.id }).then(function (x) { if (!x.success) alert(x.error); loadAdRequests(); loadAdsList(); }); } }));
        if (open) acts.appendChild(el('button', { class: 'btn-sm btn-gray', text: 'Reject', onclick: function () { adm('/api/admin/ad-requests/reject', { id: r.id, note: note.value }).then(loadAdRequests); } }));
        box.appendChild(el('div', { style: 'border:1px solid #e4e6eb;border-radius:12px;padding:12px;margin-bottom:10px' }, [
          el('div', { style: 'display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap' }, [el('b', { text: '#' + r.id + ' ' + r.business_name }), el('span', { class: 'badge badge-pending', text: r.status })]),
          el('div', { style: 'font-size:13px;color:#65676b;margin-top:4px', text: (r.placement === 'video_preroll' ? '🎬 video' : '📱 feed') + ' · ' + r.days + ' days · budget: ' + (r.budget_note || '—') + ' · contact: ' + r.contact + ' · by ' + ((r.first_name || '') + ' ' + (r.last_name || '')).trim() }),
          r.caption ? el('div', { style: 'margin-top:6px;font-size:13.5px', text: r.caption }) : null,
          r.target_url ? el('div', { style: 'margin-top:4px;font-size:12.5px;color:#65676b', text: 'Link: ' + r.target_url }) : null,
          el('a', { href: r.media_url, target: '_blank', rel: 'noopener noreferrer', style: 'font-size:12.5px;color:#1877f2', text: 'Open picture / video ↗' }),
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
        return el('tr', {}, [el('td', { text: '#' + a.id }), el('td', { text: a.advertiser_name }), el('td', { text: a.placement === 'video_preroll' ? '🎬 video' : '📱 feed' }), el('td', { text: (a.caption || '').slice(0, 40) }),
          el('td', { text: String(a.impressions) }), el('td', { text: a.clicks + ' (' + ctr + ')' }), el('td', { text: a.status }),
          el('td', {}, [el('button', { class: 'btn-sm btn-gray', text: a.status === 'active' ? 'Pause' : 'Resume', onclick: function () { adm('/api/admin/ads/status', { id: a.id, status: a.status === 'active' ? 'paused' : 'active' }).then(loadAdsList); } }),
            el('button', { class: 'btn-sm btn-gray', style: 'margin-left:4px', text: '🗑️', onclick: function () { if (confirm('Delete this ad?')) adm('/api/admin/ads/delete', { id: a.id }).then(loadAdsList); } })])]);
      });
      box.appendChild(el('div', { style: 'overflow-x:auto' }, [table(['ID', 'Advertiser', 'Where', 'Caption', 'Views', 'Clicks', 'Status', ''], rows)]));
    });
  }
  window.loadAdsAdmin = loadAdsAdmin;

  // ---------- wiring ----------
  window.onAdminTab = function (tab) {
    if (tab === 'overview') loadOverview(); else if (tab === 'umanage') { if (!document.getElementById('uQuery')) buildUsers(); } else if (tab === 'content') { if (!document.getElementById('cQuery')) buildContent(); } else if (tab === 'audit') loadAudit(true); else if (tab === 'system') loadSystem(); else if (tab === 'monetization') loadMonetizationAdmin(); else if (tab === 'ads') loadAdsAdmin();
  };
  window.onAdminUnlocked = function () { switchAdminTab('overview'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
