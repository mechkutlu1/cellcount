/* CellCount service worker. Bump CACHE on every deploy. */
const CACHE = 'cellcount-v1';
const SHELL = ['.', 'index.html', 'app.js', 'count-engine.js', 'synth.js', 'manifest.json',
               'icon-192.png', 'icon-512.png', 'icon-maskable-192.png',
               'icon-maskable-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  else e.respondWith(fetch(e.request).then(r => {
    const c2 = r.clone(); caches.open(CACHE).then(c => c.put(e.request, c2)).catch(() => {}); return r;
  }).catch(() => caches.match(e.request)));
});
