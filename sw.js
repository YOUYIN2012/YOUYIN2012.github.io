/**
 * sw.js — 轻量应用壳缓存
 *
 * 版本化应用壳（含导航）cache-first；延迟模块与普通图片
 * stale-while-revalidate；音频保持流式网络优先，仅在已有完整响应时提供离线 Range。
 */

const CACHE_PREFIX = 'love-sky';
const VERSION = '20260820-1';
const CORE_CACHE = `${CACHE_PREFIX}-core-${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${VERSION}`;
const MEDIA_CACHE = `${CACHE_PREFIX}-media-${VERSION}`;

const CORE_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/static/css/main.css',
  '/static/js/main.js',
  '/static/js/utils.js',
  '/static/js/fx/sky.js',
  '/static/js/fx/layer.js',
  '/static/js/audio/engine.js',
  '/static/js/ui/viz.js',
  '/static/images/apple-touch-icon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
];

const CORE_PATHS = new Set(CORE_ASSETS.map((url) => new URL(url, self.location.origin).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    // no-cache 会复用本地响应体并向服务器校验新鲜度，避免 reload 强制重复传输。
    const requests = CORE_ASSETS.map((url) => new Request(url, { cache: 'no-cache' }));
    await cache.addAll(requests);
    // 不主动 skipWaiting，避免旧页面在会话中途混用新旧模块。
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, RUNTIME_CACHE, MEDIA_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(`${CACHE_PREFIX}-`) && !keep.has(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - maxEntries))
    .map((key) => cache.delete(key)));
}

async function cacheFirst(request) {
  const cache = await caches.open(CORE_CACHE);
  const key = new URL(request.url);
  key.search = '';
  const cached = await cache.match(key.href);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(key.href, fresh.clone());
    return fresh;
  } catch {
    return Response.error();
  }
}

async function navigationCacheFirst(request) {
  const cached = await caches.match('/');
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const cache = await caches.open(CORE_CACHE);
      await cache.put('/', fresh.clone());
      return fresh;
    }
    return fresh;
  } catch {
    return Response.error();
  }
}

function staleWhileRevalidate(event, request) {
  const update = fetch(request).then(async (fresh) => {
    if (fresh.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, fresh.clone());
      await trimCache(RUNTIME_CACHE, 24);
    }
    return fresh;
  });
  event.waitUntil(update.catch(() => {}));
  return caches.open(RUNTIME_CACHE)
    .then(async (cache) => (await cache.match(request)) || update)
    .catch(() => Response.error());
}

async function rangeFromCachedAudio(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request.url);
  if (!cached) return null;

  const bytes = await cached.arrayBuffer();
  const size = bytes.byteLength;
  const match = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (!match) return cached;

  const suffixLength = match[1] === '' && match[2] !== '' ? Number(match[2]) : 0;
  const start = suffixLength ? Math.max(0, size - suffixLength) : Number(match[1] || 0);
  const end = match[2] && !suffixLength ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }

  const body = bytes.slice(start, end + 1);
  const headers = new Headers(cached.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(body.byteLength));
  return new Response(body, { status: 206, statusText: 'Partial Content', headers });
}

function handleAudio(event, request) {
  if (request.headers.has('range')) {
    event.respondWith(fetch(request).then((fresh) => {
      if (fresh.ok) return fresh;
      return rangeFromCachedAudio(request).then((cached) => cached || fresh);
    }).catch(async () => (await rangeFromCachedAudio(request)) || Response.error()));
    return;
  }

  const network = fetch(request);
  const cacheUpdate = network.then(async (fresh) => {
    if (fresh.ok && fresh.status === 200) {
      const cache = await caches.open(MEDIA_CACHE);
      await cache.put(request, fresh.clone());
      await trimCache(MEDIA_CACHE, 3);
    }
  }).catch(() => {});
  event.waitUntil(cacheUpdate);
  event.respondWith(network.catch(async () => {
    const cache = await caches.open(MEDIA_CACHE);
    return (await cache.match(request)) || Response.error();
  }));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // HTML 与同版本模块一起切换，避免新页面混用旧缓存代码。
    event.respondWith(navigationCacheFirst(request));
    return;
  }

  if (request.destination === 'audio' || url.pathname.startsWith('/static/music/')) {
    handleAudio(event, request);
    return;
  }

  if (CORE_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (/\.(?:js|css|png|jpe?g|svg|webp|avif)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});
