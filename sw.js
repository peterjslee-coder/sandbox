/* Sandbox service worker — network-first so a push always wins,
   cache as the offline fallback. Bump CACHE on any release. */

const CACHE = 'sandbox-v1';

const PRECACHE = [
  './',
  './index.html',
  './apps.json',
  './manifest.webmanifest',
  './assets/shell.css',
  './assets/shell.js',
  './apps/meeting-fit/',
  './apps/meeting-fit/index.html',
  './apps/meeting-fit/app.css',
  './apps/meeting-fit/app.js',
  './apps/meeting-fit/model.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
