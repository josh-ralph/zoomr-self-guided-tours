/* Zoomr Tours — offline service worker.
   Caches the app shell + tour data (photos/audio are embedded in tours.json)
   + map tiles, so a tour keeps working on spotty/no signal. Live AI-guide and
   routing calls are never cached (they degrade gracefully on their own).
   Bump CACHE_VER to force clients onto a new version. */
const CACHE_VER = 'v1';
const SHELL = 'zoomr-shell-' + CACHE_VER;
const TILES = 'zoomr-tiles-' + CACHE_VER;
const TILE_MAX = 1200;            // cap cached tiles (LRU-ish) to bound storage
let putN = 0;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', './index.html']).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

function isTile(url) {
  // OSM-style tile request: a /z/x/y.png path on a tile host
  return /\/\d+\/\d+\/\d+(\.png|@2x\.png)?($|\?)/.test(url) &&
         /(tile|basemap|osm)/i.test(url);
}
function isLive(url) {
  // never cache the AI guide, routing, or geocoding — they must hit the network
  return /workers\.dev|api\.anthropic\.com|openrouteservice\.org|nominatim/i.test(url);
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  const over = keys.length - TILE_MAX;
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);   // delete oldest
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;            // POSTs (AI/routing) pass through
  const url = req.url;
  if (isLive(url)) return;                      // live-only endpoints

  // map tiles: cache-first, capped runtime cache (works offline once seen)
  if (isTile(url)) {
    e.respondWith(caches.open(TILES).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        cache.put(req, res.clone());
        if ((++putN % 40) === 0) trimTiles(cache);
        return res;
      } catch (err) { return hit || Response.error(); }
    }));
    return;
  }

  // tour data: network-first (fresh when online), fall back to last-cached offline
  if (/tours\.json/i.test(url)) {
    e.respondWith(
      fetch(req).then(res => { const cp = res.clone(); caches.open(SHELL).then(c => c.put(req, cp)); return res; })
                .catch(() => caches.match(req))
    );
    return;
  }

  // app shell / navigations: network-first, fall back to cached index.html offline
  if (req.mode === 'navigate' || /index\.html(\?|$)/i.test(url)) {
    e.respondWith(
      fetch(req).then(res => { const cp = res.clone(); caches.open(SHELL).then(c => c.put(req, cp)); return res; })
                .catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
    );
    return;
  }

  // everything else same-origin: cache, then network
  e.respondWith(caches.match(req).then(m => m || fetch(req)).catch(() => caches.match(req)));
});
