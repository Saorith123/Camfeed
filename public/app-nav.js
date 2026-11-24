/* 📱 The website's top bar drawn like the CamFeed app: clean line icons with a small name under each, a round blue ＋,
   a grid menu button and a line bell. Only the look changes: every button keeps its id, its click and its badge. */
(function () {
  'use strict';
  var KM = (function () { try { return (localStorage.getItem('camfeed_lang') || 'km') !== 'en'; } catch (e) { return true; } })();
  var S = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
  var ICON = {
    menuFeed: '<svg viewBox="0 0 24 24" ' + S + '><path class="fillable" d="M3.5 10.2 12 3.5l8.5 6.7V19.5a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z"/></svg>',
    menuVideos: '<svg viewBox="0 0 24 24" ' + S + '><rect class="fillable" x="3" y="5" width="18" height="14" rx="3"/><path d="M10.2 9.2 15 12l-4.8 2.8z" fill="currentColor"/></svg>',
    menuFriends: '<svg viewBox="0 0 24 24" ' + S + '><circle class="fillable" cx="9" cy="8.5" r="3.4"/><path d="M2.8 19.5c.9-3.3 3.3-5 6.2-5s5.3 1.7 6.2 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16.4 14.3c2.3.2 4 1.7 4.8 4.4"/></svg>',
    menuChat: '<svg viewBox="0 0 24 24" ' + S + '><path class="fillable" d="M4.5 5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H9l-4.5 3.5z"/></svg>'
  };
  var NAME = { menuFeed: ['ទំព័រដើម', 'Home'], menuVideos: ['វីដេអូ', 'Videos'], menuFriends: ['មិត្តភក្តិ', 'Friends'], menuChat: ['ឆាត', 'Chats'] };

  var css = '' +
    '.nav-menus{height:58px!important;border-top:1px solid #eef0f3!important}' +
    '.nav-menus .menu-btn{flex-direction:column;gap:2px;font-size:0!important;color:#65676b!important;border-bottom:none!important;border-radius:12px!important;margin:4px 2px;height:auto!important;padding:5px 0 4px}' +
    '.nav-menus .menu-btn:hover{background:#f2f3f5!important}' +
    '.nav-menus .menu-btn svg{width:26px;height:26px;display:block}' +
    '.nav-menus .menu-btn .nv-lbl{font-size:11.5px;font-weight:600;line-height:1.2;white-space:nowrap}' +
    '.nav-menus .menu-btn.active{color:#1877f2!important}' +
    '.nav-menus .menu-btn.active .nv-lbl{font-weight:800}' +
    '.nav-menus .menu-btn.active .fillable{fill:currentColor}' +
    '.nav-menus .menu-btn.active #menuVideosPlay{fill:#fff}' +
    '.nav-menus .menu-btn .notif-badge{top:2px!important;right:calc(50% - 22px)!important}' +
    '.top-left .unified-plus-btn{width:38px!important;height:38px!important;min-width:38px;border-radius:50%!important;background:#1877f2!important;box-shadow:0 2px 8px rgba(24,119,242,.35)!important;font-size:0!important;padding:0;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer}' +
    '.top-left .unified-plus-btn svg{width:22px;height:22px}' +
    '.nav-menus .nv-party{flex-direction:column;gap:2px;background:none;border:none;cursor:pointer;flex:1;display:flex;align-items:center;justify-content:center;padding:4px 0;color:#7c3aed}' +
    '.nav-menus .nv-party .pill{width:56px;height:32px;border-radius:16px;background:linear-gradient(135deg,#7c3aed,#ec4899);display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(124,58,237,.35);transition:transform .15s}' +
    '.nav-menus .nv-party:hover .pill{transform:scale(1.06)}' +
    '.nav-menus .nv-party svg{width:22px;height:22px}' +
    '.nav-menus .nv-party .nv-lbl{font-size:11.5px;font-weight:700;line-height:1.2;color:#65676b}' +
    '.top-bar-row1 .menu-icon-btn{background:#eef3fd!important;color:#1877f2!important;font-size:0!important}' +
    '.top-bar-row1 .menu-icon-btn svg{width:20px;height:20px}' +
    '.top-right-icons .icon-circle-btn.nv-bell{background:transparent!important;color:#1c1e21;font-size:0!important}' +
    '.top-right-icons .icon-circle-btn.nv-bell:hover{background:#f0f2f5!important}' +
    '.top-right-icons .icon-circle-btn.nv-bell svg{width:25px;height:25px}' +
    '@media (max-width:600px){.top-bar-row1 .logo-nav{font-size:22px!important}.top-left{gap:6px!important}' +
    '.search-box-wrapper.nv-small{background:transparent!important;border:none!important;padding:0!important}' +
    '.search-box-wrapper.nv-small .search-input{display:none}' +
    '.search-box-wrapper.nv-small .search-submit-btn{background:transparent!important;color:#1c1e21!important;width:38px;height:38px;border-radius:50%!important;padding:0!important}' +
    '.search-box-wrapper.nv-small .search-submit-btn svg{width:23px!important;height:23px!important}' +
    '.search-box-wrapper.nv-open{position:absolute!important;left:10px;right:10px;top:7px;z-index:1200;background:#fff!important;border-color:#1877f2!important;box-shadow:0 2px 10px rgba(0,0,0,.12)}' +
    '.search-box-wrapper.nv-open .search-input{flex:1;width:auto!important;font-size:15px!important;padding:8px 6px!important}}' +
    '@media (prefers-color-scheme:dark){html.dark .nav-menus .menu-btn:hover{background:#3a3b3c!important}}';

  function keepBadges(btn) { return Array.prototype.filter.call(btn.children, function (c) { return /badge/.test(c.className || '') || /Badge/.test(c.id || ''); }); }

  function dress() {
    if (!document.querySelector('.nav-menus') || document.getElementById('appNavCss')) return;
    var st = document.createElement('style'); st.id = 'appNavCss'; st.textContent = css; document.head.appendChild(st);
    Object.keys(ICON).forEach(function (id) {
      var b = document.getElementById(id); if (!b) return;
      var badges = keepBadges(b);
      b.innerHTML = ICON[id] + '<span class="nv-lbl"></span>';
      b.querySelector('.nv-lbl').textContent = NAME[id][KM ? 0 : 1];
      b.setAttribute('aria-label', NAME[id][KM ? 0 : 1]);
      badges.forEach(function (x) { b.appendChild(x); });
    });
    var v = document.querySelector('#menuVideos path[fill]'); if (v) v.id = 'menuVideosPlay';
    // ＋ (new post) goes up next to the name, like the app: [＋] CamFeed [menu]; the middle of the bar becomes 🎉 Party Room
    var plus = document.querySelector('.nav-menus .unified-plus-btn'), left = document.querySelector('.top-bar-row1 .top-left'), logo = left && left.querySelector('.logo-nav');
    var menu = document.querySelector('.top-bar-row1 .menu-icon-btn');
    if (plus && left && logo) {
      var slot = plus.parentNode;
      plus.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
      plus.setAttribute('aria-label', KM ? 'បង្កើតការបង្ហោះ' : 'Create a post'); plus.title = KM ? 'បង្កើតការបង្ហោះ' : 'Create a post';
      left.insertBefore(plus, left.firstChild);
      if (menu) left.insertBefore(menu, logo.nextSibling);
      var party = document.createElement('button');
      party.type = 'button'; party.className = 'nv-party'; party.setAttribute('aria-label', KM ? 'បន្ទប់' : 'Rooms');
      party.innerHTML = '<span class="pill"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 8.5 8.5l7 7z"/><path d="M14 4.5c.4 1.2.2 2.3-.6 3.2M19.5 10c-1.2-.4-2.3-.2-3.2.6M17 3.5v1.6M20.5 7h-1.6M12.5 2.8l.6.6"/></svg></span><span class="nv-lbl"></span>';
      party.querySelector('.nv-lbl').textContent = KM ? 'បន្ទប់' : 'Rooms';
      party.onclick = function () { location.href = 'party.html'; };
      if (slot && slot.classList.contains('center-plus-slot')) slot.parentNode.replaceChild(party, slot); else document.querySelector('.nav-menus').insertBefore(party, document.getElementById('menuFriends'));
    }
    if (menu) menu.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2.2"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="2.2"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="2.2"/><rect x="13" y="13" width="7.5" height="7.5" rx="2.2"/></svg>';
    var sb = document.querySelector('.top-bar-row1 .search-submit-btn');
    if (sb) sb.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="display:block"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/></svg>';
    // 📱 a small screen: only the 🔍 button (like the app); a tap opens the search box over the bar
    var wrap = document.querySelector('.top-bar-row1 .search-box-wrapper'), inp = wrap && wrap.querySelector('.search-input');
    if (wrap && inp && sb) {
      var small = function () { return window.matchMedia('(max-width:600px)').matches; };
      var fit = function () { if (small() && !wrap.classList.contains('nv-open')) wrap.classList.add('nv-small'); if (!small()) wrap.classList.remove('nv-small', 'nv-open'); };
      fit(); window.addEventListener('resize', fit);
      sb.addEventListener('click', function (e) {
        if (!small() || wrap.classList.contains('nv-open') && inp.value.trim()) return;      // open with a word: search
        e.preventDefault(); e.stopImmediatePropagation();
        if (wrap.classList.contains('nv-open')) { wrap.classList.remove('nv-open'); wrap.classList.add('nv-small'); return; }
        wrap.classList.remove('nv-small'); wrap.classList.add('nv-open'); inp.focus();
      }, true);
      inp.addEventListener('blur', function () { setTimeout(function () { if (small() && !inp.value.trim()) { wrap.classList.remove('nv-open'); wrap.classList.add('nv-small'); } }, 150); });
    }
    var bell = document.querySelector('.top-right-icons .icon-circle-btn[onclick*="toggleNotifications"]');
    if (bell) {
      var bb = keepBadges(bell);
      bell.classList.add('nv-bell');
      bell.innerHTML = '<svg viewBox="0 0 24 24" ' + S + '><path d="M6 16.5v-5.2a6 6 0 0 1 12 0v5.2l1.8 1.8H4.2z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>';
      bb.forEach(function (x) { bell.appendChild(x); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', dress); else dress();
})();
