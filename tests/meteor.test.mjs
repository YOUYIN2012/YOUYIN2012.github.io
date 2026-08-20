import test from 'node:test';
import assert from 'node:assert/strict';

// layer.js 在模块初始化时构造 Path2D；数值测试只需要一个最小替身。
const NativePath2D = globalThis.Path2D;
globalThis.Path2D = class {
  moveTo() {}
  quadraticCurveTo() {}
  closePath() {}
};
const { Layer } = await import('../static/js/fx/layer.js');
globalThis.Path2D = NativePath2D;

test('流星始终从左上方向右下飞行，并保留足够随机性', () => {
  const nativeRandom = Math.random;
  let seed = 0x6d2b79f5;
  Math.random = () => {
    seed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61);
    return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296;
  };

  try {
    const layer = Object.assign(Object.create(Layer.prototype), {
      coarse: false,
      w: 1280,
      h: 720,
      meteors: [],
    });
    const generated = [];
    for (let i = 0; i < 120; i++) {
      layer.spawnMeteor();
      generated.push({ ...layer.meteors.at(-1) });
    }

    assert.equal(layer.meteors.length, 48, '活跃流星数量应受上限保护');
    assert.ok(generated.every((meteor) => meteor.vx > 0 && meteor.vy > 0));
    assert.ok(generated.every((meteor) => {
      const degrees = Math.atan2(meteor.vy, meteor.vx) * 180 / Math.PI;
      return degrees >= 22 && degrees <= 50;
    }));

    assert.ok(generated.some((meteor) => meteor.x > 0), '应包含从顶部进入的流星');
    assert.ok(generated.some((meteor) => meteor.y > 0), '应包含从左侧进入的流星');
    assert.ok(new Set(generated.map((meteor) => Math.round(Math.hypot(meteor.vx, meteor.vy)))).size > 40);
    assert.ok(new Set(generated.map((meteor) => Math.round(meteor.len))).size > 30);
    assert.ok(new Set(generated.map((meteor) => meteor.colors.join(','))).size > 1);
  } finally {
    Math.random = nativeRandom;
  }
});
