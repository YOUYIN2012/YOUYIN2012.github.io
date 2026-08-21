import test from 'node:test';
import assert from 'node:assert/strict';

import {
  atmosphericRefractionDeg,
  daysSinceJ2000,
  gastHours,
  gmstHours,
  horizontalCoords,
  julianDate,
  localSolarHour,
  lstHours,
  observerLocationFromParams,
  PANORAMA_VIEW,
  paletteForSun,
  precessJ2000,
  projectHorizontal,
  projectStars,
  STARS,
  sunAltitudeDeg,
} from '../static/js/astro.js';
import { computeAstroState, starViewForDevice } from '../static/js/fx/sky.js';

const deg2rad = (degrees) => degrees * Math.PI / 180;
const angularHours = (a, b) => Math.abs(((a - b + 12) % 24 + 24) % 24 - 12);

test('观测地点参数区分缺省值、合法零值与非法输入', () => {
  assert.deepEqual(observerLocationFromParams(new URLSearchParams(), -480), {
    latDeg: 35,
    lonDeg: 120,
  });
  assert.deepEqual(observerLocationFromParams(new URLSearchParams('lat=0&lon=0'), -480), {
    latDeg: 0,
    lonDeg: 0,
  });
  assert.deepEqual(observerLocationFromParams(new URLSearchParams('lat=&lon=oops'), -480), {
    latDeg: 35,
    lonDeg: 120,
  });
  assert.deepEqual(observerLocationFromParams(new URLSearchParams('lat=91&lon=-181'), -480), {
    latDeg: 35,
    lonDeg: 120,
  });
});

test('儒略日、平恒星时与视恒星时具有正确锚点', () => {
  const j2000 = Date.UTC(2000, 0, 1, 12);
  assert.equal(daysSinceJ2000(j2000), 0);
  assert.equal(julianDate(j2000), 2451545);
  assert.ok(Math.abs(gmstHours(j2000) - 18.697374558) < 1e-9);

  const t = Date.UTC(2026, 7, 22, 0);
  assert.ok(angularHours(gastHours(t), gmstHours(t)) < 0.001);
  assert.ok(angularHours(lstHours(t, 90), gastHours(t) + 6) < 1e-9);
  const oneHour = ((gmstHours(t + 3600_000) - gmstHours(t) + 24) % 24);
  assert.ok(Math.abs(oneHour - 1.0027) < 0.001);
});

test('当地太阳时由经度而非测试进程时区决定', () => {
  const noonUtc = Date.UTC(2024, 0, 1, 12);
  assert.ok(Math.abs(localSolarHour(noonUtc, 0) - 12) < 1e-9);
  assert.ok(Math.abs(localSolarHour(noonUtc, 90) - 18) < 1e-9);
  assert.ok(Math.abs(localSolarHour(noonUtc, -90) - 6) < 1e-9);
});

test('赤道转地平坐标在中天和北极星附近符合几何关系', () => {
  const t = Date.UTC(2026, 7, 22, 12);
  const raOnMeridian = deg2rad(lstHours(t, 0) * 15);
  const meridian = horizontalCoords(raOnMeridian, deg2rad(-1.94), t, 40, 0);
  assert.ok(Math.abs(meridian.alt - 48.06) < 0.01);
  assert.ok(Math.abs(meridian.az - 180) < 0.01);

  const polaris = horizontalCoords(deg2rad(2.53 * 15), deg2rad(89.26), t, 40, 110);
  assert.ok(Math.abs(polaris.alt - 40) < 1.2);
});

test('岁差与大气折射修正连续且量级合理', () => {
  const ra = deg2rad(6.75 * 15);
  const dec = deg2rad(-16.72);
  const atEpoch = precessJ2000(ra, dec, Date.UTC(2000, 0, 1, 12));
  assert.ok(Math.abs(atEpoch.ra - ra) < 1e-12);
  assert.ok(Math.abs(atEpoch.dec - dec) < 1e-12);
  const at2050 = precessJ2000(ra, dec, Date.UTC(2050, 0, 1, 0));
  assert.ok(Math.hypot(at2050.ra - ra, at2050.dec - dec) > deg2rad(0.3));
  assert.ok(Math.hypot(at2050.ra - ra, at2050.dec - dec) < deg2rad(1.2));

  assert.ok(atmosphericRefractionDeg(0) > 0.45);
  assert.ok(atmosphericRefractionDeg(0) < 0.6);
  assert.ok(atmosphericRefractionDeg(45) > 0);
  assert.ok(atmosphericRefractionDeg(45) < 0.03);
  assert.equal(atmosphericRefractionDeg(-2), 0);
});

test('太阳高度角：2024 春分两地中天高度正确', () => {
  const greenwich = sunAltitudeDeg(Date.UTC(2024, 2, 20, 12), 51.48, 0);
  assert.ok(greenwich > 36 && greenwich < 41, `greenwich=${greenwich}`);
  const sydney = sunAltitudeDeg(Date.UTC(2024, 2, 20, 1, 30), -33.87, 151.21);
  assert.ok(sydney > 52 && sydney < 60, `sydney=${sydney}`);
});

test('天空天文状态只保留真实星图与太阳高度调色板，不再包含月相状态', () => {
  const state = computeAstroState(Date.UTC(2026, 7, 21, 16), 35, 120, PANORAMA_VIEW);
  assert.equal(Object.hasOwn(state, 'moon'), false);
  assert.equal(state.starData.length, STARS.length * 4);
  assert.ok(Array.isArray(state.paletteTarget.top));
});

test('131 颗亮星投影确定、会随恒星时变化且不显示地平线下星体', () => {
  assert.equal(STARS.length, 131);
  const t = Date.UTC(2024, 11, 21, 13);
  const a = projectStars(t, 35, 120);
  const same = projectStars(t, 35, 120);
  const later = projectStars(t + 6 * 3600_000, 35, 120);
  assert.deepEqual(a, same);
  assert.equal(a.length, STARS.length * 4);

  let visible = 0;
  let moved = 0;
  for (let i = 0; i < STARS.length; i++) {
    const offset = i * 4;
    const brightness = a[offset + 2];
    assert.ok(brightness >= 0 && brightness <= 1);
    assert.ok(Math.abs(a[offset]) <= 1.075);
    assert.ok(Math.abs(a[offset + 1]) <= 1.126);
    if (brightness > 0) visible++;
    if (brightness > 0 && later[offset + 2] > 0 &&
        Math.hypot(a[offset] - later[offset], a[offset + 1] - later[offset + 1]) > 0.05) {
      moved++;
    }
  }
  assert.ok(visible > 8 && visible < 40, `visible=${visible}`);
  assert.ok(moved > 5, `moved=${moved}`);
});

test('窄视窗以南方 32° 高度为中心，裁掉侧后方与过低星体', () => {
  assert.deepEqual(projectHorizontal(32, 180), { x: 0, y: 0 });
  assert.equal(projectHorizontal(32, 60), null);
  assert.equal(projectHorizontal(-7, 180), null);
  assert.deepEqual(projectHorizontal(64, 180), { x: 0, y: 1 });
});

test('桌面视野覆盖完整 360° 地平方位并延伸至天顶', () => {
  assert.equal(starViewForDevice(false), PANORAMA_VIEW);
  assert.deepEqual(projectHorizontal(45, 180, PANORAMA_VIEW), { x: 0, y: 0 });
  assert.deepEqual(projectHorizontal(45, 0, PANORAMA_VIEW), { x: -1, y: 0 });
  assert.deepEqual(projectHorizontal(45, 270, PANORAMA_VIEW), { x: 0.5, y: 0 });
  assert.equal(projectHorizontal(-3, 180, PANORAMA_VIEW), null);
  const zenith = projectHorizontal(90, 180, PANORAMA_VIEW);
  assert.ok(Math.abs(zenith.y - 0.9) < 1e-9);

  const stars = projectStars(Date.UTC(2024, 11, 21, 13), 35, 120, PANORAMA_VIEW);
  let visible = 0;
  for (let i = 2; i < stars.length; i += 4) if (stars[i] > 0) visible++;
  assert.ok(visible > 25, `visible=${visible}`);
});

test('太阳高度角调色板保持连续过渡', () => {
  assert.deepEqual(paletteForSun(20, 14), { a: 'day', b: 'day', t: 0 });
  assert.deepEqual(paletteForSun(-20, 2), { a: 'night', b: 'night', t: 0 });
  const dawn = paletteForSun(4, 6);
  assert.equal(dawn.a, 'dawn');
  assert.ok(dawn.t > 0 && dawn.t < 1);
  const dusk = paletteForSun(4, 18);
  assert.equal(dusk.a, 'dusk');
  const deep = paletteForSun(-6, 22);
  assert.equal(deep.a, 'night');
  assert.ok(deep.t > 0 && deep.t < 1);
});
