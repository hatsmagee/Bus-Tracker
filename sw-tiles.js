'use strict';

const CACHE = 'heleon-map-tiles-v1';
const MAX_ENTRIES = 2500;

const TILE_HOST_RE = /(?:api\.maptiler\.com|tiles\.maptiler\.com|elevation-tiles-prod(?:\.[^/]+)?)/i;

function isTileRequest(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (!TILE_HOST_RE.test(u.hostname)) return false;
    return /\/\d+\/\d+\/\d+/.test(u.pathname) || u.pathname.includes('terrarium');
  } catch {
    return false;
  }
}

async function trimCache(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_ENTRIES;
  if (extra <= 0) return;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('heleon-map-tiles-') && n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (!isTileRequest(e.request.url)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    if (hit) return hit;

    const res = await fetch(e.request);
    if (res && (res.ok || res.type === 'opaque')) {
      try {
        await cache.put(e.request, res.clone());
        await trimCache(cache);
      } catch { /* quota or opaque clone edge */ }
    }
    return res;
  })());
});
