/* Sandbox service worker.
   GitHub Pages serves everything with Cache-Control: max-age=600 and gives no
   way to change it, so a browser that has seen the site will happily show a
   ten-minute-old build. GitHub *does* purge its CDN on every deploy — so the
   fix is to stop the browser consulting its own HTTP cache and go to the CDN
   every time. That is what cache:'reload' below does. The Cache Storage copy
   is kept purely as the offline fallback. */

const CACHE = 'sandbox-v10';

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
  './apps/meeting-fit/seed.json',
  './demo/',
  './demo/index.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(
        PRECACHE.map((u) => fetch(new Request(u, { cache: 'reload' })).then((r) => c.put(u, r))),
      ))
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

  // 'reload' skips the browser HTTP cache entirely and revalidates at the CDN
  const fresh = new Request(req, { cache: 'reload', mode: req.mode === 'navigate' ? 'same-origin' : req.mode });

  e.respondWith(
    fetch(fresh)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
