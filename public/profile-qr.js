/* After scanning somebody's QR code (profile.html?email=<id>&qr=1): a one-tap sheet "Follow & message". */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  if (params.get('qr') !== '1') return;
  var id = params.get('email'), me = null;
  try { me = JSON.parse(localStorage.getItem('camfeed_user')); } catch (e) {}
  if (!me || !/^1\d{14}$/.test(String(id)) || id === me.email) return;
  var km = (function () { var l = localStorage.getItem('camfeed_lang'); return !(l === 'en' || (l && l !== 'km')); })();
  var T = km ? { follow: 'តាមដាន និងជជែក', message: 'ផ្ញើសារ', view: 'មើលប្រវត្តិរូបតែប៉ុណ្ណោះ', hint: 'ស្កេន QR ជោគជ័យ' } : { follow: 'Follow & message', message: 'Message', view: 'Just view the profile', hint: 'QR code scanned' };
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; }
  function close() { var s = document.getElementById('qrSheet'); if (s) s.remove(); try { params.delete('qr'); history.replaceState(null, '', location.pathname + '?' + params.toString()); } catch (e) {} }
  function chat() { location.href = 'messages.html?chat=' + encodeURIComponent(id); }
  function render(u) {
    if (document.getElementById('qrSheet') || !document.body) return;
    var sheet = el('div', 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff;color:#1c1e21;border-radius:20px 20px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.35);padding:18px 18px calc(18px + env(safe-area-inset-bottom,0px));max-width:520px;margin:0 auto;font-family:"Plus Jakarta Sans","Noto Sans Khmer",sans-serif');
    sheet.id = 'qrSheet';
    var top = el('div', 'display:flex;align-items:center;gap:12px;margin-bottom:12px');
    var av = el('div', 'width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#1877f2,#42a5ff);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;overflow:hidden;flex-shrink:0');
    if (u.profile_pic) { var im = document.createElement('img'); im.alt = ''; im.src = u.profile_pic; im.style.cssText = 'width:100%;height:100%;object-fit:cover'; im.onerror = function () { av.textContent = ((u.first_name || '?')[0] || '?').toUpperCase(); }; av.appendChild(im); } else av.textContent = ((u.first_name || '?')[0] || '?').toUpperCase();
    var tx = el('div', 'min-width:0'); tx.appendChild(el('div', 'font-weight:800;font-size:18px;word-break:break-word', ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || 'CamFeed')); tx.appendChild(el('div', 'font-size:13px;color:#65676b', T.hint));
    top.appendChild(av); top.appendChild(tx); sheet.appendChild(top);
    var primary = el('button', 'width:100%;padding:13px;border:0;border-radius:12px;background:#1877f2;color:#fff;font-weight:800;font-size:16px;cursor:pointer', u.is_following ? T.message : T.follow); primary.type = 'button';
    primary.addEventListener('click', function () {
      if (u.is_following) return chat();
      primary.disabled = true;
      fetch('/api/follow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ followerEmail: me.email, followingEmail: id, action: 'follow' }) })
        .then(function (r) { return r.json(); }).then(function () { chat(); }).catch(function () { primary.disabled = false; });
    });
    var view = el('button', 'width:100%;margin-top:8px;padding:12px;border:0;border-radius:12px;background:#e4e6eb;color:#1c1e21;font-weight:700;font-size:15px;cursor:pointer', T.view); view.type = 'button'; view.addEventListener('click', close);
    sheet.appendChild(primary); sheet.appendChild(view); document.body.appendChild(sheet);
  }
  function start() {
    fetch('/api/user-profile?email=' + encodeURIComponent(id) + '&viewerEmail=' + encodeURIComponent(me.email)).then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.success && d.user) render(d.user); }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
