/**
 * sw.js — 应用壳预缓存 + 运行时缓存
 *
 * 核心资源严格预缓存；导航与代码 network-first；图片 stale-while-revalidate；
 * 音频正常播放不等待缓存写入，离线时可从已缓存的完整响应生成 Range 响应。
 */

const CACHE_PREFIX = 'love-sky';
const VERSION = '20260818-1';
const CORE_CACHE = `${CACHE_PREFIX}-core-${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${VERSION}`;

const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/static/css/main.css',
  '/static/js/main.js',
  '/static/js/utils.js',
  '/static/js/fx/sky.js',
  '/static/js/fx/layer.js',
  '/static/js/fx/webgpu-burst.js',
  '/static/js/audio/engine.js',
  '/static/js/ui/viz.js',
  '/static/images/apple-touch-icon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(`${CACHE_PREFIX}-`) && ![CORE_CACHE, RUNTIME_CACHE].includes(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, cacheName, fallback = request) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    return (await caches.match(fallback)) || (await caches.match(request)) || Response.error();
  }
}

function staleWhileRevalidate(event, request) {
  const network = fetch(request).then(async (fresh) => {
    if (fresh.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, fresh.clone());
    }
    return fresh;
  });
  event.waitUntil(network.catch(() => {}));
  return caches.match(request).then((cached) => cached || network).catch(() => Response.error());
}

async function rangeFromCachedAudio(request) {
  const cached = await caches.match(request.url);
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
    event.respondWith(fetch(request).catch(async () =>
      (await rangeFromCachedAudio(request)) || Response.error()));
    return;
  }

  const network = fetch(request);
  // 克隆发生在响应体被播放器消费前；缓存写入不阻塞首帧播放。
  const cacheUpdate = network.then((fresh) => {
    if (fresh.ok && fresh.status === 200) {
      const copy = fresh.clone();
      return caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
    }
    return undefined;
  }).catch(() => {});
  event.waitUntil(cacheUpdate);
  event.respondWith(network.catch(async () =>
    (await caches.match(request)) || Response.error()));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (request.destination === 'audio' || url.pathname.startsWith('/static/music/')) {
    handleAudio(event, request);
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, CORE_CACHE, '/'));
    return;
  }

  if (/\.(?:js|css)$/.test(url.pathname) || url.pathname === '/favicon.svg') {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, request));
});
