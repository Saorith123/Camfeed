/* CamFeed service worker: makes the site installable as an app and shows a friendly page when there is no internet.
   It deliberately does NOT cache pages, scripts or data, so you always get the newest version after an update and
   private data (API answers) is never stored on the device. */
const VERSION = 'camfeed-v1';
const PRECACHE = ['/offline.html', '/icons/icon-192.png', '/logo-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only our own pages are handled. Never touched: other sites (videos on media.camfeedkh.com, fonts), /api, /auth,
// uploads and anything that is not a plain GET.
function isOurPageRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return false;
  return request.mode === 'navigate';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isOurPageRequest(request)) return;                       // let the browser handle everything else normally
  event.respondWith(
    fetch(request).catch(() => caches.match('/offline.html').then((r) => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
  );
});
