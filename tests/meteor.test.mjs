import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  advanceBeatGate,
  createMeteorTrajectory,
  createRadiant,
  Layer,
  layerTargetFps,
  meteorDelaySeconds,
} from '../static/js/fx/layer.js';

function seededRandom(initial = 0x6d2b79f5) {
  let seed = initial >>> 0;
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('自然流星间隔来自有边界的指数分布', () => {
  assert.equal(meteorDelaySeconds(0), 24);
  assert.equal(meteorDelaySeconds(0.999999), 180);
  assert.ok(meteorDelaySeconds(0.5) > 45 && meteorDelaySeconds(0.5) < 60);
  assert.ok(meteorDelaySeconds(0.9) > meteorDelaySeconds(0.5));
});

test('Canvas 动画按交互状态和指针类型分级降帧', () => {
  assert.equal(layerTargetFps(false, true), 60);
  assert.equal(layerTargetFps(false, false), 30);
  assert.equal(layerTargetFps(true, true), 30);
  assert.equal(layerTargetFps(true, false), 20);
});

test('流星轨迹反向延长后汇聚辐射点，同时保留左右方向变化', () => {
  const random = seededRandom();
  const radiant = createRadiant(1440, 900, random);
  const trajectories = Array.from(
    { length: 160 },
    () => createMeteorTrajectory(1440, 900, radiant, 0.6, random),
  );

  let left = 0;
  let right = 0;
  for (const meteor of trajectories) {
    assert.ok(meteor.vy > 0);
    assert.ok(meteor.x >= -57.7 && meteor.x <= 1497.7);
    assert.ok(meteor.y >= 13.4 && meteor.y <= 414.1);
    assert.ok(meteor.maxLife >= 0.52 && meteor.maxLife <= 1.12);
    assert.ok(meteor.len > 0 && meteor.brightness > 0);

    const radialX = meteor.x - radiant.x;
    const radialY = meteor.y - radiant.y;
    const cross = radialX * meteor.vy - radialY * meteor.vx;
    const scale = Math.hypot(radialX, radialY) * Math.hypot(meteor.vx, meteor.vy);
    assert.ok(Math.abs(cross) / scale < 1e-12, `cross=${cross}`);
    assert.ok(radialX * meteor.vx + radialY * meteor.vy > 0);
    if (meteor.vx < 0) left++;
    if (meteor.vx > 0) right++;
  }
  assert.ok(left > 20 && right > 20, `left=${left}, right=${right}`);
});

test('节拍蓄能有冷却时间，隐藏状态会丢弃而不是积聚', () => {
  let state = { charge: 0, threshold: 0.95, lastMeteorAt: 0 };
  state = advanceBeatGate(state, 1, 1000);
  assert.equal(state.spawn, false);
  state = advanceBeatGate(state, 1, 1500);
  assert.equal(state.spawn, true);

  state = advanceBeatGate(state, 1, 1900, { inactive: true });
  assert.equal(state.spawn, false);
  assert.equal(state.charge, 0);
  assert.equal(state.lastMeteorAt, 1900);

  state = advanceBeatGate(state, 1, 2000);
  assert.equal(state.spawn, false, '恢复后不能补发隐藏期间的节拍');
});

test('Git 原版鼠标短尾按 22px 节流并在触屏或减少动态时停用', () => {
  const nativeDocument = globalThis.document;
  globalThis.document = { hidden: false };
  try {
    const layer = Object.assign(Object.create(Layer.prototype), {
      inactive: false,
      reduced: false,
      coarse: false,
      trail: [],
      w: 800,
      h: 600,
      started: false,
      start() { this.started = true; },
    });

    assert.equal(layer.pushTrail(100, 100), true);
    assert.equal(layer.pushTrail(110, 110), false, '距离不足 22px 时不应生成重复圆点');
    assert.equal(layer.pushTrail(140, 100), true);
    assert.equal(layer.trail.length, 2);
    assert.equal(layer.started, true);
    assert.ok(layer.trail.every((point) => point.maxLife >= 0.4 && point.maxLife <= 0.7));
    assert.ok(layer.trail.every((point) => point.size >= 1.2 && point.size <= 2.4));

    layer.coarse = true;
    assert.equal(layer.pushTrail(200, 100), false);
    layer.coarse = false;
    layer.reduced = true;
    assert.equal(layer.pushTrail(240, 100), false);
  } finally {
    if (nativeDocument === undefined) delete globalThis.document;
    else globalThis.document = nativeDocument;
  }
});

test('生命周期代码会在隐藏时取消自然过程、气泡和三击流星雨定时器', async () => {
  const source = await readFile(new URL('../static/js/fx/layer.js', import.meta.url), 'utf8');
  const suspend = source.match(/suspend\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  const clearTransient = source.match(/clearTransient\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  assert.match(suspend, /clearTimeout\(this\.ambientTimer\)/);
  assert.match(suspend, /clearTimeout\(this\.bubbleTimer\)/);
  assert.match(suspend, /clearTransient\(\)/);
  assert.match(clearTransient, /this\.showerTimers/);
  assert.match(clearTransient, /this\.meteors\.length = 0/);
  assert.match(clearTransient, /this\.bubbles\.length = 0/);
  assert.match(clearTransient, /this\.trail\.length = 0/);
});
