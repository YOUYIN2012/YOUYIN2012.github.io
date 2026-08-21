import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const errors = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const files = await walk(ROOT);
const sourceFiles = files.filter((file) => ['.js', '.mjs'].includes(extname(file)));

for (const removed of [
  'static/js/ui/pair.js',
  'static/js/ui/pip.js',
  'static/js/ui/constellation.js',
  'static/js/ui/xr.js',
  'static/js/fx/sky-webgpu.js',
  'static/js/fx/webgpu-burst.js',
  'static/js/fx/wasm-kernel.js',
]) {
  if (existsSync(join(ROOT, removed))) errors.push(`${removed}: 已移除的独立模式不应重新出现`);
}

for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) errors.push(`${relative(ROOT, file)}: ${result.stderr.trim()}`);
}

for (const jsonFile of ['package.json', 'manifest.webmanifest']) {
  try {
    JSON.parse(await readFile(join(ROOT, jsonFile), 'utf8'));
  } catch (error) {
    errors.push(`${jsonFile}: JSON 无效（${error.message}）`);
  }
}

const references = new Set();
const readableFiles = files.filter((file) =>
  ['.html', '.css', '.js', '.mjs', '.webmanifest'].includes(extname(file)));
const textByFile = new Map();

for (const file of readableFiles) {
  const text = await readFile(file, 'utf8');
  textByFile.set(file, text);

  // 引号内任意同源 static 路径，包括 canonical/OG 的绝对 URL。
  const staticRef = /["'`]([^"'`]*?static\/[^"'`]+?\.(?:js|css|png|jpe?g|svg|webp|avif|mp3|woff2?|ttf))["'`]/gu;
  for (const match of text.matchAll(staticRef)) {
    const start = match[1].indexOf('static/');
    references.add(decodeURIComponent(match[1].slice(start)));
  }

  // new URL('./x', import.meta.url) 形式的运行时引用（例如 AudioWorklet）。
  const urlRef = /new\s+URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu;
  for (const match of text.matchAll(urlRef)) {
    const target = resolve(dirname(file), match[1]);
    if (existsSync(target)) {
      references.add(relative(ROOT, target).split(/[\\/]/).join('/'));
    }
  }

  // 音乐文件通过 musicUrl(name) 在运行时生成 URL。
  const musicRef = /musicUrl\((['"])(.*?)\1\)/gu;
  for (const match of text.matchAll(musicRef)) references.add(`static/music/${match[2]}`);

  // 校验相对静态 import 与动态 import。
  const importRef = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/gu;
  for (const match of text.matchAll(importRef)) {
    if (!match[1].startsWith('.')) continue;
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target)) errors.push(`${relative(ROOT, file)}: import 不存在 ${match[1]}`);
  }
}

const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.avif', '.mp3', '.woff', '.woff2', '.ttf']);
for (const file of files.filter((item) => item.startsWith(join(ROOT, 'static')) && assetExtensions.has(extname(item)))) {
  const asset = relative(ROOT, file);
  if (!references.has(asset)) errors.push(`${asset}: 未被任何源码引用`);
}

const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
const coreBlock = sw.match(/const CORE_ASSETS = \[([\s\S]*?)\];/)?.[1] || '';
for (const match of coreBlock.matchAll(/['"](\/[^'"]*)['"]/g)) {
  const asset = match[1] === '/' ? 'index.html' : match[1].slice(1);
  if (!existsSync(join(ROOT, asset))) errors.push(`sw.js: 预缓存资源不存在 ${match[1]}`);
}
// 预缓存闭包校验：从 main.js 出发的静态 import 图必须全部列入 CORE_ASSETS。
// 缺了这条检查，新增模块忘记预缓存时在线无感、离线首访才会 404。
{
  const precached = new Set(
    [...coreBlock.matchAll(/['"](\/[^'"]*)['"]/g)].map((match) => match[1]),
  );
  const seen = new Set();
  const queue = [join(ROOT, 'static/js/main.js')];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = textByFile.get(file);
    if (text === undefined) {
      errors.push(`${relative(ROOT, file)}: 在静态 import 图中但无法读取`);
      continue;
    }
    for (const match of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec);
      const asset = `/${relative(ROOT, target).split(/[\\/]/).join('/')}`;
      if (!precached.has(asset)) {
        errors.push(`sw.js: 静态依赖未列入 CORE_ASSETS 预缓存 ${asset}（来自 ${relative(ROOT, file)}）`);
      }
      queue.push(target);
    }
  }
}

const html = await readFile(join(ROOT, 'index.html'), 'utf8');
for (const id of [
  'sky', 'stage', 'audioFab', 'fabViz', 'status', 'audio',
]) {
  if (!html.includes(`id="${id}"`)) errors.push(`index.html: 缺少 #${id}`);
}
for (const id of [
  'panelToggle', 'controlPanel', 'stormButton', 'constellationButton',
  'skyDateInput', 'latitudeInput', 'longitudeInput', 'applySkyButton',
]) {
  if (html.includes(`id="${id}"`)) errors.push(`index.html: 已删除的 #${id} 不应重新出现`);
}
const buttons = [...html.matchAll(/<button\b/gu)];
if (buttons.length !== 1 || !html.includes('<button id="audioFab"')) {
  errors.push('index.html: 页面应只保留音乐按钮这一个可见控件');
}
const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
if (!jsonLd) {
  errors.push('index.html: 缺少 JSON-LD');
} else {
  const hash = createHash('sha256').update(jsonLd).digest('base64');
  if (!html.includes(`'sha256-${hash}'`)) errors.push('index.html: CSP 中的 JSON-LD 哈希已过期');
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`检查通过：${sourceFiles.length} 个脚本、${references.size} 个静态资源引用。`);
