// CranCapital's offline cache. The game's files, street tiles, fonts and city
// data are kept on the device after the first visit, so the game opens fast
// even on slow school or home wifi. Game data (money, businesses) always
// comes live from the server: only our own static files are cached.
//
// ?v= is the build: a new build starts a fresh code cache. ?d= is the data
// version: bump it in main.tsx when tiles or city data change.
const params = new URL(self.location.href).searchParams;
const CODE = 'cc-code-' + (params.get('v') || '0');
const DATA = 'cc-data-' + (params.get('d') || '0');

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cc-') && k !== CODE && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) cache.put(req, res.clone());
  return res;
}

// The page itself: the newest from the network, or the saved copy if the
// network is slow (4 s) or down.
async function networkFirst(req) {
  const cache = await caches.open(CODE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return fetch(req);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req));
  } else if (path.includes('/assets/')) {
    // Built files have their content hash in the name: they never change.
    e.respondWith(cacheFirst(CODE, req));
  } else if (/\/(tiles|glyphs|cities|world|models|sounds)\//.test(path) || path.endsWith('.svg') || path.endsWith('.png')) {
    e.respondWith(cacheFirst(DATA, req));
  }
});
