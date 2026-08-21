import test from 'node:test';
import assert from 'node:assert/strict';

import { clamp, lerp, mixRGB, FpsGuard } from '../static/js/utils.js';

test('数值工具保持边界与插值语义', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.deepEqual(mixRGB([0, 10, 20], [10, 20, 30], 0.5), [5, 15, 25]);
});

test('FPS 看门狗可降档并在稳定后恢复', () => {
  const changes = [];
  const guard = new FpsGuard({
    sampleFrames: 2,
    badMs: 20,
    coolDownMs: 0,
    recoverSamples: 1,
    recoverRatio: 0.8,
    maxLevel: 1,
    onDegrade: (level) => changes.push(`down:${level}`),
    onRecover: (level) => changes.push(`up:${level}`),
  });

  guard.tick(1);
  guard.tick(41);
  guard.tick(81);
  assert.equal(guard.level, 1);

  guard.lastDegradeAt = Date.now() - 10;
  guard.tick(91);
  guard.tick(101);
  assert.equal(guard.level, 0);
  assert.deepEqual(changes, ['down:1', 'up:0']);
});

test('FPS 看门狗忽略超长帧间隔（调试器暂停 / 后台恢复）', () => {
  let degraded = false;
  const guard = new FpsGuard({
    sampleFrames: 2,
    badMs: 20,
    maxLevel: 1,
    onDegrade: () => { degraded = true; },
  });

  guard.tick(1);
  guard.tick(1000);   // dt=999ms：重置采样而非记为坏帧
  guard.tick(1030);
  assert.equal(guard.level, 0);
  assert.equal(degraded, false);
});

test('FPS 看门狗冷却期内不重复降档', () => {
  let degrades = 0;
  const guard = new FpsGuard({
    sampleFrames: 2,
    badMs: 20,
    coolDownMs: 60_000,
    maxLevel: 2,
    onDegrade: () => degrades++,
  });

  guard.tick(1);
  guard.tick(41);
  guard.tick(81);     // 持续卡顿 → 降档一次
  assert.equal(guard.level, 1);

  guard.tick(121);
  guard.tick(161);    // 仍然卡顿，但处于冷却期
  assert.equal(guard.level, 1);
  assert.equal(degrades, 1);
});
