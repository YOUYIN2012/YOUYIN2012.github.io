import test from 'node:test';
import assert from 'node:assert/strict';

import { clamp, lerp, mixRGB, FpsGuard } from '../static/js/utils.js';
import { autoPaletteForHour } from '../static/js/fx/sky.js';

test('数值工具保持边界与插值语义', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.deepEqual(mixRGB([0, 10, 20], [10, 20, 30], 0.5), [5, 15, 25]);
});

test('时段调色板覆盖所有边界', () => {
  assert.equal(autoPaletteForHour(4), 'night');
  assert.equal(autoPaletteForHour(5), 'dawn');
  assert.equal(autoPaletteForHour(9), 'day');
  assert.equal(autoPaletteForHour(17), 'dusk');
  assert.equal(autoPaletteForHour(20), 'night');
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
