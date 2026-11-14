/* CamFeed auth client: adds the login token to every /api request (fetch, XHR, sendBeacon)
   so existing pages keep working without editing each call. Load it first in <head>. */
(function () {
  'use strict';
  var TOKEN_KEY = 'camfeed_token', USER_KEY = 'camfeed_user', TOKENS_KEY = 'camfeed_tokens_v1', SAVED_KEY = 'camfeed_saved_accounts_v1';
  var ID_RE = /^1\d{14}$/;   // people are known by a random 15-digit id, not by e-mail
  var TOKEN_PATHS = ['/api/login', '/api/register', '/api/settings/password', '/api/settings/logout-all', '/api/password/reset', '/api/telegram/exchange', '/api/telegram/complete'];
  var NO_REDIRECT_PATHS = ['/api/login', '/api/register', '/api/telegram/exchange', '/api/telegram/complete'];

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function readJson(key, fallback) { try { var v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; } }
  // one token per saved account, so switching accounts also switches who the server thinks you are
  function rememberToken(token, id) {
    if (!id) { var cu = readJson(USER_KEY, null); id = cu && cu.email; }
    if (!id) return;
    var map = readJson(TOKENS_KEY, {}); map[id] = token;
    try { localStorage.setItem(TOKENS_KEY, JSON.stringify(map)); } catch (e) {}
  }
  function setToken(t, id) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} rememberToken(t, id); }
  function useAccount(id) {                       // switch to a saved account; false if we no longer hold its login
    var map = readJson(TOKENS_KEY, {});
    if (!id || typeof map[id] !== 'string' || !map[id]) return false;
    try { localStorage.setItem(TOKEN_KEY, map[id]); } catch (e) { return false; }
    return true;
  }
  function forgetAccount(id) { var map = readJson(TOKENS_KEY, {}); delete map[id]; try { localStorage.setItem(TOKENS_KEY, JSON.stringify(map)); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch (e) {} }

  // Old versions stored the user's password inside camfeed_user: wipe it and force a fresh login.
  try {
    var raw = localStorage.getItem(USER_KEY);
    if (raw) {
      var u = JSON.parse(raw);
      if (u && Object.prototype.hasOwnProperty.call(u, 'password')) clearSession();
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch (e) { clearSession(); }

  // Before this update the stored user carried the real e-mail. Swap it for the public id once, before any page code runs.
  try {
    var stored = readJson(USER_KEY, null), tok = getToken();
    if (stored && stored.email && !ID_RE.test(String(stored.email)) && tok && localStorage.getItem('camfeed_idmode') !== 'plain') {
      var x = new XMLHttpRequest();
      x.open('GET', '/api/user-profile?email=' + encodeURIComponent(stored.email) + '&viewerEmail=' + encodeURIComponent(stored.email), false);
      x.setRequestHeader('Authorization', 'Bearer ' + tok);
      x.send();
      if (x.status === 401) { clearSession(); }
      else if (x.status === 200) {
        var d = JSON.parse(x.responseText);
        if (d && d.success && d.user && ID_RE.test(String(d.user.email))) {
          stored.email = d.user.email;
          if (d.user.contact_mail) stored.contact_mail = d.user.contact_mail;
          localStorage.setItem(USER_KEY, JSON.stringify(stored));
          rememberToken(tok, stored.email);
          var saved = readJson(SAVED_KEY, []);   // older saved accounts carry the old e-mail and no stored login: they must be added again
          if (Array.isArray(saved)) localStorage.setItem(SAVED_KEY, JSON.stringify(saved.filter(function (s) { return s && ID_RE.test(String(s.email)); })));
        } else if (d && d.success && d.user) { localStorage.setItem('camfeed_idmode', 'plain'); }   // the server is not hiding e-mails (switch is off): leave everything as it is
      }
    }
  } catch (e) { /* offline or an old server: pages keep working with what they have */ }

  function apiPath(url) {
    try {
      var a = new URL(String(url), window.location.href);
      if (a.origin === window.location.origin && a.pathname.indexOf('/api/') === 0) return a.pathname;
    } catch (e) {}
    return null;
  }

  function onLoggedOut() {
    clearSession();
    var p = window.location.pathname;
    if (!(p === '/' || /\/index\.html$/.test(p))) window.location.href = 'index.html';
  }

  // ---- fetch ----
  var origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var url = (typeof input === 'string' || input instanceof URL) ? String(input) : (input && input.url) || '';
    var path = apiPath(url);
    if (!path) return origFetch(input, init);

    var headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    var token = getToken();
    if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);

    var res;
    if (input instanceof Request && !init) res = await origFetch(new Request(input, { headers: headers }));
    else res = await origFetch(input, Object.assign({}, init, { headers: headers }));

    if (res.status === 401 && NO_REDIRECT_PATHS.indexOf(path) === -1) {
      onLoggedOut();
    } else if (res.ok && TOKEN_PATHS.indexOf(path) !== -1) {
      try {
        var d = await res.clone().json();   // awaited so the token is saved before the page's next call
        if (d && typeof d.token === 'string') setToken(d.token, d.user && d.user.email);
      } catch (e) {}
    }
    return res;
  };

  // ---- XMLHttpRequest (upload progress bars) ----
  var xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__camApi = apiPath(url);
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__camApi) {
      var t = getToken();
      if (t) { try { this.setRequestHeader('Authorization', 'Bearer ' + t); } catch (e) {} }
      this.addEventListener('load', function () { if (this.status === 401) onLoggedOut(); });
    }
    return xSend.apply(this, arguments);
  };

  // ---- sendBeacon cannot set headers: use a keepalive fetch instead (still works while the page closes) ----
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (apiPath(url)) {
        try {
          var h = { 'Content-Type': (data && data.type) || 'application/json' };
          var t = getToken();
          if (t) h.Authorization = 'Bearer ' + t;
          origFetch(url, { method: 'POST', body: data, headers: h, keepalive: true }).catch(function () {});
          return true;
        } catch (e) {}
      }
      return origBeacon(url, data);
    };
  }

  // Escapes text before it is put into page HTML (names, posts, comments ...). Use esc(value) inside templates.
  window.esc = function (v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"'`]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch];
    });
  };


  // Makes web links clickable in posts, comments and chat. Text is escaped FIRST, then only http(s):// and www. links are wrapped,
  // so nobody can slip in HTML or javascript: links. Use linkify(value) instead of esc(value) where links should be clickable.
  window.linkify = function (v) {
    var safe = window.esc(v);
    return safe.replace(/(^|[\s(>])((?:https?:\/\/|www\.)[^\s<>"']+)/gi, function (all, pre, url) {
      var tail = '';
      var m = /[.,;:!?)\]]+$/.exec(url); if (m) { tail = m[0]; url = url.slice(0, url.length - tail.length); }
      if (!url) return all;
      var href = /^www\./i.test(url) ? 'https://' + url : url;
      return pre + '<a href="' + href + '" target="_blank" rel="noopener noreferrer nofollow ugc" class="cf-link" onclick="event.stopPropagation()">' + url + '</a>' + tail;
    });
  };
  (function () { try { var st = document.createElement('style'); st.textContent = 'a.cf-link{color:#1877f2;text-decoration:underline;word-break:break-all}'; (document.head || document.documentElement).appendChild(st); } catch (e) {} })();

  // For values inside an inline handler such as onclick="f('...')": use  decodeURIComponent('${ea(value)}')
  window.ea = function (v) {
    return encodeURIComponent(String(v === null || v === undefined ? '' : v)).replace(/[!'()*]/g, function (ch) { return '%' + ch.charCodeAt(0).toString(16).toUpperCase(); });
  };

  // ---- Dark mode: one switch for every page. Pages without their own dark colours are inverted (pictures / videos are turned back). ----
  (function () {
    function apply(v) { try { document.documentElement.setAttribute('data-theme', v === 'dark' ? 'dark' : 'light'); } catch (e) {} }
    var saved = 'light'; try { saved = localStorage.getItem('camfeed_theme') === 'dark' ? 'dark' : 'light'; } catch (e) {}
    apply(saved);
    try {
      var st = document.createElement('style'); st.id = 'camfeed-dark-style';
      st.textContent = 'html[data-theme="dark"]:not([data-native-dark]){filter:invert(1) hue-rotate(180deg);background:#fff}' +
        'html[data-theme="dark"]:not([data-native-dark]) img,html[data-theme="dark"]:not([data-native-dark]) video,html[data-theme="dark"]:not([data-native-dark]) canvas,' +
        'html[data-theme="dark"]:not([data-native-dark]) iframe,html[data-theme="dark"]:not([data-native-dark]) picture,html[data-theme="dark"]:not([data-native-dark]) [style*="background-image"]{filter:invert(1) hue-rotate(180deg)}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
    window.CamTheme = {
      get: function () { try { return localStorage.getItem('camfeed_theme') === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } },
      set: function (v) { try { localStorage.setItem('camfeed_theme', v === 'dark' ? 'dark' : 'light'); } catch (e) {} apply(v); }
    };
    try { window.addEventListener('storage', function (e) { if (e.key === 'camfeed_theme') apply(e.newValue); }); } catch (e) {}   // another tab changed it
  })();

  window.CamAuth = { getToken: getToken, setToken: setToken, useAccount: useAccount, forgetAccount: forgetAccount, logout: function () { clearSession(); window.location.href = 'index.html'; } };
})();
