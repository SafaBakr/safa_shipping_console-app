// Safa Shipping Console — service worker (network-first for pages, cache-first for static assets)
const CACHE = 'safa-erp-v10';
const ASSETS = [
  './', 'index.html', 'guide.html', 'manifest.webmanifest', 'vendor/xlsx.full.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png',
  ...[400, 500, 600, 700].flatMap((w) => ['arabic', 'latin'].map((s) => `fonts/ibm-plex-sans-arabic-${s}-${w}-normal.woff2`)),
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return; // never cache API or other origins
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (isPage) {
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })));
});
