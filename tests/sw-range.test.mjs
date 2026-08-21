import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 直接从 sw.js 源码提取被测函数，保证测试覆盖的是真正上线的实现。
// （sw.js 刻意保持 classic script 以兼容不支持模块 Service Worker 的浏览器，
//   因此无法通过 import 复用；修改 sw.js 内的 parseByteRange 后务必跑本测试。）
const src = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const fnSrc = src.match(/function parseByteRange[\s\S]*?\n}/)?.[0];
assert.ok(fnSrc, 'sw.js 中应能提取到 parseByteRange');
const parseByteRange = new Function(`${fnSrc};\nreturn parseByteRange;`)();

function extractFunction(name) {
  let start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `sw.js 中应存在 ${name}`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`无法提取 ${name}`);
}

const SIZE = 1000;

test('新缓存完整安装后立即接管，并刷新仍在运行的旧版本页面', () => {
  assert.match(src, /await self\.skipWaiting\(\)/);
  assert.match(src, /await self\.clients\.claim\(\)/);
  assert.match(src, /if \(staleKeys\.length\)/);
  assert.match(src, /self\.clients\.matchAll\(\{ type: 'window' \}\)/);
  assert.match(src, /client\.navigate\(client\.url\)/);
});

test('Range 头缺失或非 bytes 单位时回退整包', () => {
  assert.deepEqual(parseByteRange(null, SIZE), { kind: 'full' });
  assert.deepEqual(parseByteRange(undefined, SIZE), { kind: 'full' });
  assert.deepEqual(parseByteRange('', SIZE), { kind: 'full' });
  assert.deepEqual(parseByteRange('items=0-5', SIZE), { kind: 'full' });
  // 多段区间不支持：回退整包最稳妥
  assert.deepEqual(parseByteRange('bytes=0-1,3-4', SIZE), { kind: 'full' });
});

test('合法区间正确解析并按资源尺寸裁剪', () => {
  assert.deepEqual(parseByteRange('bytes=0-', SIZE), { kind: 'slice', start: 0, end: 999 });
  assert.deepEqual(parseByteRange('bytes=100-', SIZE), { kind: 'slice', start: 100, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-100', SIZE), { kind: 'slice', start: 900, end: 999 });
  assert.deepEqual(parseByteRange('bytes=100-200', SIZE), { kind: 'slice', start: 100, end: 200 });
  // 结束值超出资源长度：裁剪到末尾（RFC 9110 允许）
  assert.deepEqual(parseByteRange('bytes=100-2000', SIZE), { kind: 'slice', start: 100, end: 999 });
  assert.deepEqual(parseByteRange('bytes=999-999', SIZE), { kind: 'slice', start: 999, end: 999 });
});

test('语法非法或越界的区间应返回 error（416）', () => {
  assert.deepEqual(parseByteRange('bytes=', SIZE), { kind: 'error' });
  assert.deepEqual(parseByteRange('bytes=abc', SIZE), { kind: 'error' });
  assert.deepEqual(parseByteRange('bytes=5-2', SIZE), { kind: 'error' });
  assert.deepEqual(parseByteRange('bytes=1000-', SIZE), { kind: 'error' });   // start >= size
  assert.deepEqual(parseByteRange('bytes=-0', SIZE), { kind: 'error' });      // 后缀长度为 0 不可满足
});

test('并发 Range 请求共用同一个整包下载', async () => {
  const cacheFullAudioSrc = extractFunction('cacheFullAudio');
  const ensureFullAudioCachedSrc = extractFunction('ensureFullAudioCached');
  let fetchCalls = 0;
  let resolveFetch;
  let stored = null;
  const cache = {
    match: async () => stored,
    put: async (_url, response) => { stored = response; },
  };
  const factory = new Function(
    'caches', 'fetch', 'MEDIA_CACHE', 'trimCache', 'audioBytesMemo',
    `const fullAudioFetches = new Map();
     ${cacheFullAudioSrc}
     ${ensureFullAudioCachedSrc}
     return { ensureFullAudioCached, fullAudioFetches };`,
  );
  const { ensureFullAudioCached, fullAudioFetches } = factory(
    { open: async () => cache },
    () => {
      fetchCalls++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    'media',
    async () => {},
    new Map(),
  );

  const first = ensureFullAudioCached('https://example.test/audio.mp3');
  const second = ensureFullAudioCached('https://example.test/audio.mp3');
  assert.equal(first, second);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCalls, 1);

  resolveFetch(new Response('audio', { status: 200 }));
  await Promise.all([first, second]);
  assert.equal(fullAudioFetches.size, 0);

  await ensureFullAudioCached('https://example.test/audio.mp3');
  assert.equal(fetchCalls, 1, '已有缓存时不应再下载');
});

test('无 Range 请求复用首个响应写缓存', async () => {
  const handleAudioSrc = extractFunction('handleAudio');
  let fetchCalls = 0;
  let cacheWrites = 0;
  let ensureCalls = 0;
  const waits = [];
  let responsePromise;
  const factory = new Function(
    'fetch', 'caches', 'MEDIA_CACHE', 'cacheFullAudio',
    'ensureFullAudioCached', 'rangeFromCachedAudio',
    `${handleAudioSrc}; return handleAudio;`,
  );
  const handleAudio = factory(
    async () => {
      fetchCalls++;
      return new Response('audio', { status: 200 });
    },
    { open: async () => ({ match: async () => null }) },
    'media',
    async (_cache, _url, response) => {
      cacheWrites++;
      assert.equal(await response.text(), 'audio');
    },
    async () => { ensureCalls++; },
    async () => null,
  );
  const event = {
    waitUntil(promise) { waits.push(promise); },
    respondWith(promise) { responsePromise = promise; },
  };

  handleAudio(event, new Request('https://example.test/audio.mp3'));
  const response = await responsePromise;
  await Promise.all(waits);
  assert.equal(await response.text(), 'audio');
  assert.equal(fetchCalls, 1);
  assert.equal(cacheWrites, 1);
  assert.equal(ensureCalls, 0);
});
