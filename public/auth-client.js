/* CamFeed auth client: adds the login token to every /api request (fetch, XHR, sendBeacon)
   so existing pages keep working without editing each call. Load it first in <head>. */
(function () {
  'use strict';
  var TOKEN_KEY = 'camfeed_token', USER_KEY = 'camfeed_user';
  var TOKEN_PATHS = ['/api/login', '/api/register', '/api/settings/password', '/api/telegram/exchange', '/api/telegram/complete'];
  var NO_REDIRECT_PATHS = ['/api/login', '/api/register', '/api/telegram/exchange', '/api/telegram/complete'];

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
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
        if (d && typeof d.token === 'string') setToken(d.token);
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

  window.CamAuth = { getToken: getToken, setToken: setToken, logout: function () { clearSession(); window.location.href = 'index.html'; } };
})();
