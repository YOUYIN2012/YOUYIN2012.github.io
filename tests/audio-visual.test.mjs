import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('暂停环境音绕过音乐分析链，且天空只接收播放态能量', async () => {
  const engine = await readFile(new URL('../static/js/audio/engine.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../static/js/main.js', import.meta.url), 'utf8');

  assert.match(engine, /new AmbientSynth\(this\.ctx, this\.ctx\.destination\)/);
  assert.match(engine, /if \(!this\.playing\) return;/);
  assert.match(engine, /if \(!this\.ready \|\| !this\.playing\)/);
  assert.match(main, /sky\.setAudioEnergy\(engine\.playing \? engine\.energy : 0\)/);
  assert.doesNotMatch(main, /engine\.synthActive/);
});

test('真实辐射点 provider 的时间基准区分实时与回放', async () => {
  const main = await readFile(new URL('../static/js/main.js', import.meta.url), 'utf8');
  // 实时模式（含 CSS 降级，astroDateMs 冻结在页面加载时刻）必须取 Date.now()，
  // 否则辐射点方位以 15°/小时漂移；?date= 回放（astroLive=false）固定观测时刻。
  assert.match(main, /const at = sky\.astroLive \? Date\.now\(\) : sky\.astroDateMs;/);
  assert.doesNotMatch(main, /sky\.astroDateMs \?\? Date\.now\(\)/);
});

test('音乐球频谱画布扩出按钮且轨道为短刺预留空间', async () => {
  const css = await readFile(new URL('../static/css/main.css', import.meta.url), 'utf8');
  const viz = await readFile(new URL('../static/js/ui/viz.js', import.meta.url), 'utf8');

  const fab = css.match(/\.fab \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const canvas = css.match(/\.fab-viz \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(fab, /overflow: visible/);
  assert.match(canvas, /inset: -14px/);
  assert.match(viz, /this\.dpr \* 12/);
});

test('真实星点异步明灭，底部粒子沿用 Git 原版冷色星尘画法', async () => {
  const sky = await readFile(new URL('../static/js/fx/sky.js', import.meta.url), 'utf8');
  const layer = await readFile(new URL('../static/js/fx/layer.js', import.meta.url), 'utf8');

  assert.match(sky, /float twSlow/);
  assert.match(sky, /float twFast/);
  assert.match(sky, /float flash/);
  assert.match(sky, /float twinkleAmount/);
  assert.match(layer, /const AMBIENT_COLORS/);
  assert.match(layer, /bubble\.x \+= Math\.sin/);
  assert.match(layer, /ctx\.globalCompositeOperation = 'lighter'/);
  assert.doesNotMatch(layer, /createRadialGradient/);
  assert.doesNotMatch(layer, /fireflyPulse/);
});

test('桌面鼠标轨迹沿用 Git 原版的距离节流与冷色短尾', async () => {
  const main = await readFile(new URL('../static/js/main.js', import.meta.url), 'utf8');
  const layer = await readFile(new URL('../static/js/fx/layer.js', import.meta.url), 'utf8');

  assert.match(main, /addEventListener\('pointermove', rafThrottle/);
  assert.match(main, /layer\.pushTrail\(event\.clientX, event\.clientY\)/);
  assert.match(layer, /Math\.hypot\(x - last\.x, y - last\.y\) < 22/);
  assert.match(layer, /maxLife: randomBetween\(0\.4, 0\.7\)/);
  assert.match(layer, /size: randomBetween\(1\.2, 2\.4\)/);
  assert.match(layer, /ctx\.globalAlpha = 0\.4 \* \(1 - t\)/);
});

test('全屏画布隔离渲染，URL 诊断入口不增加可见控件', async () => {
  const css = await readFile(new URL('../static/css/main.css', import.meta.url), 'utf8');
  const main = await readFile(new URL('../static/js/main.js', import.meta.url), 'utf8');
  const layerBlock = css.match(/\.layer \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.match(layerBlock, /contain: strict/);
  assert.match(main, /params\.get\('webgl'\) === '0'/);
  assert.match(main, /params\.get\('demo'\) === 'storm'/);
  assert.match(main, /params\.get\('debug'\) === '1'/);
  assert.match(main, /document\.title = `\$\{baseTitle\}/);
  assert.doesNotMatch(main, /debug-panel|debugPanel/);
});

test('ended→next 自动连播衔接处的 pause 事件不启动环境音床', async () => {
  const engine = await readFile(new URL('../static/js/audio/engine.js', import.meta.url), 'utf8');
  const pauseBlock = engine.match(/addEventListener\('pause', \(\) => \{[\s\S]*?\n {4}\}\)/)?.[0] ?? '';
  assert.ok(pauseBlock, '应能提取 pause 事件回调');
  assert.match(pauseBlock, /if \(this\.audio\.ended\) \{ this\._releaseWakeLock\(\); return; \}/);
  assert.match(pauseBlock, /this\.synth\?\.on\(\)/);
});

test('星点尺寸跟随内部渲染比例，降档后物理尺寸保持恒定', async () => {
  const sky = await readFile(new URL('../static/js/fx/sky.js', import.meta.url), 'utf8');
  const resizeBlock = sky.match(/resize\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  assert.match(resizeBlock, /this\.renderScale = w \/ Math\.max\(1, cssW\)/);
  assert.match(sky, /gl\.uniform1f\(this\.su\.uDpr, this\.renderScale\)/);
  assert.doesNotMatch(sky, /uniform1f\(this\.su\.uDpr, Math\.min\(devicePixelRatio/);
});

test('减少动效且完全空闲时音乐球可视化彻底休眠', async () => {
  const viz = await readFile(new URL('../static/js/ui/viz.js', import.meta.url), 'utf8');
  const loopBody = viz.match(/loop\(ts\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  assert.ok(loopBody, '应能提取 loop 方法体');
  assert.match(loopBody, /this\.reduced && !this\.engine\.playing && this\.engine\.energy < 0\.002/);
  assert.match(loopBody, /this\.stop\(\)/);
  assert.match(loopBody, /ctx\.clearRect/);
});

test('onError 携带 fallback 标记，main.js 按有无合成音床分流文案', async () => {
  const engine = await readFile(new URL('../static/js/audio/engine.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../static/js/main.js', import.meta.url), 'utf8');

  // ensureContext 失败时 synth 为 null（没有合成音景可切换），错误回调必须把
  // 这一事实告诉调用方，文案不能做虚假承诺；分流也不得引用 synthActive 旧属性。
  assert.match(engine, /this\.onError\?\.\(error, \{ fallback: Boolean\(this\.synth\) \}\)/);
  assert.match(main, /engine\.onError = \(error, \{ fallback = false \} = \{\}\)/);
  assert.match(main, /已切换为浏览器合成音景/);
  assert.match(main, /音乐暂时无法播放，请稍后再试/);
  assert.doesNotMatch(main, /engine\.synthActive/);
});

test('_persistCurrent 在 fetch 前复查 OPFS，避免 _warmLocalCopies 竞态下的冗余下载', async () => {
  const engine = await readFile(new URL('../static/js/audio/engine.js', import.meta.url), 'utf8');

  const persist = engine.match(/async _persistCurrent\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  assert.ok(persist, '应能提取 _persistCurrent 方法体');
  // 构造期预解析未完成时 _localUrl 仍是空，守卫旗标全部未置位；fetch 前必须
  // 再查一次 OPFS，否则点播会把已入库的整曲（约 5MB）重新下载一遍。
  assert.match(persist, /await this\.store\.has\(trackFilename\(track\.src\)\)/);
  assert.ok(
    persist.indexOf('store.has') < persist.indexOf('fetch(track.src)'),
    'store.has 复查必须发生在 fetch 之前',
  );
});

test('pagehide 挂起未播放的 AudioContext，重新可见时成对恢复', async () => {
  const engine = await readFile(new URL('../static/js/audio/engine.js', import.meta.url), 'utf8');

  const hideBlock = engine.match(/addEventListener\('pagehide', \(\) => \{([\s\S]*?)\n {4}\}\)/)?.[1] ?? '';
  assert.ok(hideBlock, '应能提取 pagehide 事件回调');
  assert.match(hideBlock, /if \(this\.ctx && !this\.playing\) this\.ctx\.suspend\(\)/);

  const visibleBlock = engine.match(/document\.addEventListener\('visibilitychange', \(\) => \{([\s\S]*?)\n {4}\}\)/)?.[1] ?? '';
  assert.ok(visibleBlock, '应能提取 visibilitychange 事件回调');
  // 恢复条件刻意不带 !this.playing：播放在途时 pagehide 挂起、返回后仍排除
  // 播放态会留下「正在播放但静音」且无法自愈；ctx 存在即已通过手势解锁。
  assert.match(visibleBlock, /if \(!document\.hidden && this\.ctx\?\.state === 'suspended'\)/);
  assert.doesNotMatch(visibleBlock, /!this\.playing && this\.ctx\?\.state/);
  assert.match(visibleBlock, /this\.ctx\.resume\(\)/);
});
