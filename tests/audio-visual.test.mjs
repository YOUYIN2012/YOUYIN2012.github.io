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
