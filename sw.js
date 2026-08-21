/**
 * sw.js — 轻量应用壳缓存
 *
 * 刻意保持 classic script：模块化 Service Worker 在 Firefox ≤ 146（含现行 ESR）
 * 上不受支持，register({ type: 'module' }) 会静默失败并丢失全部离线能力。
 *
 * 版本化应用壳（含导航）cache-first；延迟模块与普通图片
 * stale-while-revalidate；音频网络优先，同时在后台补齐整包缓存以支持离线 Range。
 */

const CACHE_PREFIX = 'love-sky';
const VERSION = '20260822-10';
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
  '/static/js/astro.js',
  '/static/js/fx/sky.js',
  '/static/js/fx/layer.js',
  '/static/js/audio/engine.js',
  '/static/js/audio/beat-worklet.js',
  '/static/js/audio/synth.js',
  '/static/js/audio/track-store.js',
  '/static/js/ui/viz.js',
  '/static/images/apple-touch-icon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
  '/static/images/icon-512-maskable.png',
];

const CORE_PATHS = new Set(CORE_ASSETS.map((url) => new URL(url, self.location.origin).pathname));

/* 允许缺席的资源：缺席只影响观感，运行时策略会补齐。其余（HTML/CSS/JS/manifest）
   是离线可用性的底线，任何一个失败都必须让安装失败——否则 activate 会删掉
   旧版本的完整缓存，离线用户将拿到残缺应用。 */
const OPTIONAL_PRECACHE = new Set([
  '/favicon.svg',
  '/static/images/apple-touch-icon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
  '/static/images/icon-512-maskable.png',
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    const failed = new Set();
    await Promise.all(CORE_ASSETS.map(async (url) => {
      try {
        // no-cache 会复用本地响应体并向服务器校验新鲜度，避免 reload 强制重复传输。
        const fresh = await fetch(new Request(url, { cache: 'no-cache' }));
        if (fresh.ok) await cache.put(url, fresh);
        else failed.add(url);
      } catch { failed.add(url); }
    }));
    const criticalFailed = [...failed].filter((url) => !OPTIONAL_PRECACHE.has(url));
    if (criticalFailed.length || !await cache.match('/')) {
      throw new Error(`core precache incomplete: ${criticalFailed.join(', ') || 'missing navigation'}`);
    }
    // 核心依赖全部入缓存后立即激活，避免旧 Worker 长期停在 waiting 状态。
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, RUNTIME_CACHE, MEDIA_CACHE]);
    const keys = await caches.keys();
    const staleKeys = keys
      .filter((key) => key.startsWith(`${CACHE_PREFIX}-`) && !keep.has(key));
    await Promise.all(staleKeys.map((key) => caches.delete(key)));
    await self.clients.claim();
    if (staleKeys.length) {
      // 仅升级时刷新旧页面；首次安装没有旧缓存，不打断当前导航。
      const windows = await self.clients.matchAll({ type: 'window' });
      await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => null)));
    }
  })());
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const stale = keys.slice(0, Math.max(0, keys.length - maxEntries));
  await Promise.all(stale.map((key) => cache.delete(key)));
  if (cacheName === MEDIA_CACHE && stale.length) audioBytesMemo.clear();
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

/* 首次访问即离线且无缓存时的极简兜底页（自带样式，不依赖任何外部资源）。 */
const OFFLINE_FALLBACK = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>爱意随风起 · 离线</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #060b1e; color: #e9f0fb;
         font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
         text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .6rem; }
  p { margin: 0; opacity: .7; line-height: 1.7; }
</style>
</head>
<body>
<main>
  <h1>星河暂不可见</h1>
  <p>当前处于离线状态，联网后刷新即可回到星空。</p>
</main>
</body>
</html>`;

async function navigationCacheFirst(request) {
  // ignoreSearch：即使链接携带无关查询参数，也始终命中同一个单页应用壳。
  const cached = await caches.match('/', { ignoreSearch: true });
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
    return new Response(OFFLINE_FALLBACK, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
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

/**
 * 解析 HTTP Range: bytes 头。
 * 返回 { kind: 'full' }              —— 无 Range 头 / 非 bytes 单位 / 多段区间，应回整包
 *      { kind: 'slice', start, end } —— 合法闭区间，end 已按 size 裁剪
 *      { kind: 'error' }             —— 语法非法或越界，应回 416
 * 本实现内联于此（classic script 无法 import），语义由 tests/sw-range.test.mjs
 * 直接从本文件源码提取并覆盖；修改时务必同步运行测试。
 */
function parseByteRange(header, size) {
  if (!header || !header.trim().startsWith('bytes=')) return { kind: 'full' };
  const trimmed = header.trim();
  if (trimmed.includes(',')) return { kind: 'full' }; // 多段区间不支持：回退整包最稳妥
  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'error' };

  const suffix = match[1] === '' && match[2] !== '';
  const suffixLength = suffix ? Number(match[2]) : 0;
  const start = suffix ? Math.max(0, size - suffixLength) : Number(match[1] || 0);
  const end = match[2] && !suffix ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { kind: 'error' };
  }
  return { kind: 'slice', start, end };
}

/* 离线切片用的整包字节备忘：避免播放/跳转期间每个 Range 请求都重新物化多 MB 响应体。 */
const audioBytesMemo = new Map();
/* 同一 URL 的整包下载只允许一个在途任务，避免并发 Range 请求放大流量。 */
const fullAudioFetches = new Map();

function readFullAudioBytes(url, cached) {
  if (audioBytesMemo.has(url)) return Promise.resolve(audioBytesMemo.get(url));
  return cached.arrayBuffer().then((bytes) => {
    audioBytesMemo.set(url, bytes);
    return bytes;
  });
}

async function cacheFullAudio(cache, url, fresh) {
  if (fresh.ok && fresh.status === 200) {
    await cache.put(url, fresh);
    await trimCache(MEDIA_CACHE, 3);
    audioBytesMemo.delete(url);     // 缓存内容已更新，丢弃旧切片底稿
  }
}

/** 后台补齐整包缓存。浏览器几乎总是携带 Range 头请求媒体，
    若只在无 Range 分支写缓存，MEDIA_CACHE 将永远为空、离线音频无从谈起。 */
function ensureFullAudioCached(url) {
  const existing = fullAudioFetches.get(url);
  if (existing) return existing;

  let task;
  task = (async () => {
    try {
      const cache = await caches.open(MEDIA_CACHE);
      if (await cache.match(url)) return;
      const fresh = await fetch(url);   // 不带 Range 头：完整 200 响应
      await cacheFullAudio(cache, url, fresh);
    } finally {
      if (fullAudioFetches.get(url) === task) fullAudioFetches.delete(url);
    }
  })();
  fullAudioFetches.set(url, task);
  return task;
}

async function rangeFromCachedAudio(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request.url);
  if (!cached) return null;

  const bytes = await readFullAudioBytes(request.url, cached);
  const size = bytes.byteLength;
  const range = parseByteRange(request.headers.get('range'), size);

  if (range.kind === 'error') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }
  if (range.kind === 'full') return cached;

  const body = bytes.slice(range.start, range.end + 1);
  const headers = new Headers(cached.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('Content-Length', String(body.byteLength));
  return new Response(body, { status: 206, statusText: 'Partial Content', headers });
}

function handleAudio(event, request) {
  if (request.headers.has('range')) {
    // 在线时透传 Range 请求保持流式；同时后台补齐整包缓存供离线切片。
    event.waitUntil(ensureFullAudioCached(request.url).catch(() => {}));
    event.respondWith(fetch(request).then((fresh) => {
      if (fresh.ok) return fresh;
      return rangeFromCachedAudio(request).then((cached) => cached || fresh);
    }).catch(async () => (await rangeFromCachedAudio(request)) || Response.error()));
    return;
  }

  // 无 Range 时首个网络响应就是整包，直接克隆入缓存，不再发起第二次下载。
  const network = fetch(request);
  const cacheUpdate = network.then(async (fresh) => {
    if (!fresh.ok || fresh.status !== 200) return;
    const cache = await caches.open(MEDIA_CACHE);
    await cacheFullAudio(cache, request.url, fresh.clone());
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
