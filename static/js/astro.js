/**
 * astro.js — 天文历法引擎
 *
 * 让星空“是真的”：太阳高度角、本地视恒星时与亮星表按观测地实时投影。
 * 恒星包含岁差、视恒星时、大气折射和地平消光；月亮由天空层作为固定视觉意象绘制。
 * 这是浏览器端视觉星历（不是航海/掩星级天文软件），全部纯函数、零依赖、Node 可测。
 *
 * 坐标约定：
 *   赤经 ra 以小时或弧度（见函数签名），赤纬 dec / 高度 alt / 方位 az 以度；
 *   az 从正北起向东量（0=北 90=东 180=南 270=西）。
 */

export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;
const norm24 = (h) => ((h % 24) + 24) % 24;
export const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * URL 参数 → 观测地点。缺失、空值、非数值和越界值均回落到安全默认值；
 * 0° 是合法坐标，不能用真假值短路判断。
 */
export function observerLocationFromParams(params, timezoneOffsetMinutes = new Date().getTimezoneOffset()) {
  const read = (key, min, max, fallback) => {
    if (!params?.has?.(key)) return fallback;
    const raw = params.get(key)?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  const inferredLon = Math.round((-timezoneOffsetMinutes / 60) * 15);
  return {
    latDeg: read('lat', -90, 90, 35),
    lonDeg: read('lon', -180, 180, inferredLon),
  };
}

/* ---------- 时间 ---------- */

/** Unix 毫秒 → 儒略日 */
export function julianDate(dateMs) {
  return dateMs / 86400000 + 2440587.5;
}

/** J2000.0（2000-01-01T12:00Z）以来的天数 */
export function daysSinceJ2000(dateMs) {
  return julianDate(dateMs) - 2451545.0;
}

/** 格林尼治平恒星时（小时），IAU 1982 多项式。 */
export function gmstHours(dateMs) {
  const d = daysSinceJ2000(dateMs);
  const T = d / 36525;
  const degrees = 280.46061837 + 360.98564736629 * d
    + 0.000387933 * T * T - T * T * T / 38710000;
  return norm24(degrees / 15);
}

/** 主要章动项（度）与真黄赤交角，足以消除平/视恒星时之间约秒级的偏差。 */
export function nutationState(dateMs) {
  const T = daysSinceJ2000(dateMs) / 36525;
  const sunMeanLon = deg2rad(norm360(280.4665 + 36000.7698 * T));
  const moonMeanLon = deg2rad(norm360(218.3165 + 481267.8813 * T));
  const ascendingNode = deg2rad(norm360(125.04452 - 1934.136261 * T));
  const dPsi = (
    -17.2 * Math.sin(ascendingNode)
    - 1.32 * Math.sin(2 * sunMeanLon)
    - 0.23 * Math.sin(2 * moonMeanLon)
    + 0.21 * Math.sin(2 * ascendingNode)
  ) / 3600;
  const dEpsilon = (
    9.2 * Math.cos(ascendingNode)
    + 0.57 * Math.cos(2 * sunMeanLon)
    + 0.1 * Math.cos(2 * moonMeanLon)
    - 0.09 * Math.cos(2 * ascendingNode)
  ) / 3600;
  const seconds = 21.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T;
  const meanObliquity = 23 + 26 / 60 + seconds / 3600;
  return {
    dPsi,
    dEpsilon,
    meanObliquity,
    trueObliquity: meanObliquity + dEpsilon,
  };
}

/** 格林尼治视恒星时（小时）。 */
export function gastHours(dateMs) {
  const { dPsi, trueObliquity } = nutationState(dateMs);
  return norm24(gmstHours(dateMs) + dPsi * Math.cos(deg2rad(trueObliquity)) / 15);
}

/** 本地视恒星时（小时）：GAST + 经度/15。 */
export function lstHours(dateMs, lonDeg) {
  return norm24(gastHours(dateMs) + lonDeg / 15);
}

/** 观测经度对应的平均太阳时（小时），不依赖查看者设备的系统时区。 */
export function localSolarHour(dateMs, lonDeg) {
  return norm24(dateMs / 3600000 + lonDeg / 15);
}

/* ---------- 赤道 ↔ 地平 ---------- */

/**
 * 赤道坐标 → 地平坐标。
 * @returns {{alt:number, az:number}} alt/az 单位度，az 自北向东。
 */
export function horizontalCoords(raRad, decRad, dateMs, latDeg, lonDeg) {
  const H = deg2rad(lstHours(dateMs, lonDeg) * 15) - raRad;
  const phi = deg2rad(latDeg);
  const sinAlt =
    Math.sin(phi) * Math.sin(decRad) +
    Math.cos(phi) * Math.cos(decRad) * Math.cos(H);
  const alt = rad2deg(Math.asin(clamp(sinAlt, -1, 1)));
  // Meeus：A 自南起向西量 → 转为自北向东
  const A = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(decRad) * Math.cos(phi),
  );
  const az = norm360(rad2deg(A) + 180);
  return { alt, az };
}

/** Saemundsson 大气折射近似（度）；低于 -1° 时不再外推。 */
export function atmosphericRefractionDeg(altDeg) {
  if (!Number.isFinite(altDeg) || altDeg < -1 || altDeg >= 90) return 0;
  const correction = 1.02 / Math.tan(deg2rad(altDeg + 10.3 / (altDeg + 5.11))) / 60;
  return clamp(correction, 0, 1);
}

/** J2000 赤道坐标岁差到观测历元，IAU 1976 模型（数百年尺度内足够本项目）。 */
export function precessJ2000(raRad, decRad, dateMs) {
  const T = daysSinceJ2000(dateMs) / 36525;
  const zeta = deg2rad((2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) / 3600);
  const z = deg2rad((2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) / 3600);
  const theta = deg2rad((2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) / 3600);
  const A = Math.cos(decRad) * Math.sin(raRad + zeta);
  const B = Math.cos(theta) * Math.cos(decRad) * Math.cos(raRad + zeta)
    - Math.sin(theta) * Math.sin(decRad);
  const C = Math.sin(theta) * Math.cos(decRad) * Math.cos(raRad + zeta)
    + Math.cos(theta) * Math.sin(decRad);
  return {
    ra: norm360(rad2deg(Math.atan2(A, B) + z)) * Math.PI / 180,
    dec: Math.asin(clamp(C, -1, 1)),
  };
}

/* ---------- 太阳 ---------- */

function eclipticToEquatorial(lambdaRad, betaRad, epsRad) {
  const ra = Math.atan2(
    Math.sin(lambdaRad) * Math.cos(epsRad) - Math.tan(betaRad) * Math.sin(epsRad),
    Math.cos(lambdaRad),
  );
  const dec = Math.asin(
    Math.sin(betaRad) * Math.cos(epsRad) +
    Math.cos(betaRad) * Math.sin(epsRad) * Math.sin(lambdaRad),
  );
  return { ra, dec };
}

/** 太阳视黄经（弧度），含中心差与主要章动/光行差修正。 */
export function sunEclipticLongitude(dateMs) {
  const T = daysSinceJ2000(dateMs) / 36525;
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = deg2rad(norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T));
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M);
  const omega = deg2rad(norm360(125.04 - 1934.136 * T));
  return deg2rad(norm360(L0 + C - 0.00569 - 0.00478 * Math.sin(omega)));
}

/** 太阳赤道坐标（弧度） */
export function sunEquatorial(dateMs) {
  return eclipticToEquatorial(
    sunEclipticLongitude(dateMs),
    0,
    deg2rad(nutationState(dateMs).trueObliquity),
  );
}

/** 太阳高度角（度）。负值 = 地平线下；-6 民用昏影 / -12 天文晨昏 / -18 完全黑夜。 */
export function sunAltitudeDeg(dateMs, latDeg, lonDeg) {
  const { ra, dec } = sunEquatorial(dateMs);
  return horizontalCoords(ra, dec, dateMs, latDeg, lonDeg).alt;
}

/* ---------- 星表 ----------
 * J2000，[ra 小时, dec 度, 视星等]，坐标四舍五入到 ~1'/0.1°——装饰级精度足够辨认星座。
 * 冷色审美：不区分色指数，统一冰蓝白。
 */
// prettier-ignore
export const STARS = [
  /* 小熊座 */ [2.53, 89.26, 2.0], [17.54, 86.59, 4.4], [16.77, 82.04, 4.2], [15.73, 77.79, 4.3],
  [16.29, 75.76, 4.9], [14.85, 74.16, 2.1], [15.35, 71.83, 3.0],
  /* 大熊座（北斗） */ [11.06, 61.75, 1.8], [11.03, 56.38, 2.4], [11.90, 53.69, 2.4], [12.26, 57.03, 3.3],
  [12.90, 55.96, 1.8], [13.42, 54.93, 2.2], [13.79, 49.31, 1.9],
  /* 猎犬 / 天龙 */ [12.93, 38.32, 2.9], [17.94, 51.49, 2.2], [15.42, 58.97, 3.3], [11.00, 64.38, 3.7],
  /* 仙后座 W */ [0.15, 59.15, 2.3], [0.68, 56.54, 2.2], [0.95, 60.72, 2.2], [1.43, 60.24, 2.7], [1.91, 63.67, 3.4],
  /* 仙女 / 飞马 */ [0.14, 29.09, 2.1], [1.16, 35.62, 2.1], [2.06, 42.33, 2.3], [23.08, 15.21, 2.5],
  [23.06, 28.08, 2.4], [0.22, 15.18, 2.8], [21.74, 9.88, 2.4],
  /* 英仙 / 御夫 / 金牛 */ [3.41, 49.86, 1.8], [3.14, 40.96, 2.1], [5.28, 46.00, 0.1], [6.00, 44.95, 1.9],
  [5.00, 37.21, 2.6], [5.44, 28.61, 1.7], [3.79, 24.11, 2.9], [4.60, 16.51, 0.9],
  /* 双子 */ [7.58, 31.89, 1.6], [7.76, 28.03, 1.1], [6.73, 25.13, 3.0], [6.63, 16.40, 1.9],
  /* 牧夫 / 北冕 */ [14.26, 19.18, -0.05], [14.75, 27.07, 2.4], [14.53, 38.31, 3.0], [13.91, 18.40, 2.7], [15.58, 26.71, 2.2],
  /* 天琴 / 天鹅 / 天鹰 */ [18.62, 38.78, 0.03], [18.83, 33.36, 3.5], [18.98, 32.69, 3.2], [20.69, 45.28, 1.25],
  [20.37, 40.26, 2.2], [20.77, 33.97, 2.5], [19.75, 45.13, 2.9], [19.51, 27.96, 3.1],
  [19.85, 8.87, 0.77], [19.77, 10.61, 2.7], [19.92, 6.41, 3.7],
  /* 蛇夫 / 巨蛇 / 天秤 */ [17.58, 12.56, 2.1], [15.74, 6.43, 2.6], [14.85, -16.04, 2.8], [15.28, -9.38, 2.6],
  /* 天蝎 */ [16.49, -26.43, 1.0], [16.09, -19.81, 2.6], [16.01, -22.62, 2.3], [15.98, -26.11, 2.9],
  [17.62, -43.00, 1.9], [17.56, -37.10, 1.6], [17.51, -37.30, 2.7],
  /* 人马（茶壶） */ [18.40, -34.38, 1.8], [18.92, -26.30, 2.0], [18.35, -29.83, 2.7],
  /* 室女 / 乌鸦 */ [13.42, -11.16, 0.97], [12.69, -1.45, 2.7], [13.04, 10.96, 2.8], [12.93, 3.40, 3.4],
  [12.26, -17.54, 2.6], [12.49, -16.52, 2.9], [12.57, -23.40, 2.6],
  /* 长蛇 / 狮子 */ [9.46, -8.66, 2.0], [10.14, 11.97, 1.4], [11.82, 14.57, 2.1], [10.33, 19.84, 2.0],
  [11.24, 20.52, 2.6], [11.24, 15.43, 3.3], [10.28, 23.42, 3.4], [9.88, 26.68, 3.9], [9.76, 23.77, 3.0],
  /* 小犬 / 大犬 */ [7.65, 5.22, 0.34], [7.45, 8.29, 2.9], [6.75, -16.72, -1.46], [6.38, -17.96, 1.98],
  [7.14, -26.39, 1.8], [6.98, -28.97, 1.5], [7.40, -29.30, 2.4],
  /* 猎户 */ [5.92, 7.41, 0.45], [5.24, -8.20, 0.18], [5.42, 6.35, 1.6], [5.53, -0.30, 2.2],
  [5.60, -1.20, 1.7], [5.68, -1.94, 1.8], [5.80, -9.67, 2.1],
  /* 波江 / 鲸鱼 / 宝瓶 / 南鱼 / 凤凰 / 天鹤 */ [1.63, -57.24, 0.45], [3.97, -13.51, 2.8], [2.97, -40.30, 3.1],
  [0.74, -17.99, 2.0], [3.04, 4.09, 2.5], [22.10, -0.32, 3.0], [21.53, -5.57, 2.9],
  [21.78, -16.13, 2.9], [22.96, -29.62, 1.16], [22.14, -46.96, 1.7], [0.44, -42.31, 2.4],
  /* 船底 / 船帆 */ [6.40, -52.70, -0.74], [9.22, -69.72, 1.7], [8.38, -59.51, 1.9], [9.28, -59.28, 2.2],
  [8.15, -47.34, 1.8], [9.37, -40.47, 1.96],
  /* 南十字 / 半人马 / 孔雀 / 南三角 */ [12.44, -63.10, 0.77], [12.80, -59.69, 1.25], [12.52, -57.11, 1.6],
  [12.25, -58.75, 2.8], [12.36, -60.40, 3.6], [14.66, -60.83, -0.27], [14.06, -60.37, 0.61],
  [14.11, -36.37, 2.06], [20.43, -56.74, 1.9], [16.81, -69.03, 1.9],
  /* 白羊 */ [2.12, 23.46, 2.0], [1.91, 20.81, 2.6],
];

/* ---------- 投影到屏幕平面 ----------
 * 桌面使用完整 360° 地平方位全景，移动端使用南向 110° × 64° 窄天窗；
 * 两者都等距投影为 [-1,1] 屏幕空间（y 向上）。
 */

export const DEFAULT_VIEW = {
  centerAz: 180, centerAlt: 32, fovX: 110, fovY: 64,
  azMargin: 4, minAlt: -6, maxAlt: 68,
};

export const PANORAMA_VIEW = {
  centerAz: 180, centerAlt: 45, fovX: 360, fovY: 100,
  azMargin: 0, minAlt: -2, maxAlt: 90.5,
};

/** 单个地平坐标 → 屏幕空间；返回 null 表示在视窗外。 */
export function projectHorizontal(altDeg, azDeg, view = DEFAULT_VIEW) {
  const dAz = wrap180(azDeg - view.centerAz);
  const azMargin = view.azMargin ?? 4;
  const minAlt = view.minAlt ?? -6;
  const maxAlt = view.maxAlt ?? view.centerAlt + view.fovY / 2 + 4;
  if (Math.abs(dAz) > view.fovX / 2 + azMargin || altDeg < minAlt || altDeg > maxAlt) {
    return null;
  }
  return {
    x: dAz / (view.fovX / 2),
    y: (altDeg - view.centerAlt) / (view.fovY / 2),
  };
}

/**
 * 全星表投影。返回 Float32Array(n*4)：[xNdc, yNdc, brightness, twinkleSeed]*n，
 * 不可见的星 brightness=0。坐标即 clip/NDC 空间（[-1,1] 覆盖全屏宽高）。
 */
export function projectStars(dateMs, latDeg, lonDeg, view = DEFAULT_VIEW) {
  const out = new Float32Array(STARS.length * 4);
  for (let i = 0; i < STARS.length; i++) {
    const [raH, dec, mag] = STARS[i];
    const epoch = precessJ2000(deg2rad(raH * 15), deg2rad(dec), dateMs);
    const geometric = horizontalCoords(epoch.ra, epoch.dec, dateMs, latDeg, lonDeg);
    const alt = geometric.alt + atmosphericRefractionDeg(geometric.alt);
    const p = projectHorizontal(alt, geometric.az, view);
    const o = i * 4;
    if (!p) continue;
    // 视星等 → 亮度；地平线附近按气团消光连续淡出，地平线下不再保底发亮。
    const extinction = clamp((alt + 1) / 13, 0, 1);
    if (extinction <= 0) continue;
    // 对数星等映射后做显示伽马；保留亮度级差，同时让宽屏上的暗星仍可辨认。
    let b = clamp(10 ** (-0.2 * (mag + 1.46)), 0.09, 1);
    b *= extinction;
    out[o] = p.x;
    out[o + 1] = p.y;
    out[o + 2] = b;
    out[o + 3] = (i * 2654435761) % 1000 / 1000;   // 确定性 twinkle 种子
  }
  return out;
}

/* ---------- 时段调色板（连续版） ----------
 * 用太阳高度角取代小时分段：≥8° 白昼，0..8° 黄昏/黎明过渡，-12..0° 深暮，<-12° 夜。
 * dawn/dusk 由当地太阳时正午前后区分。
 */
export function paletteForSun(sunAltDeg, localHour) {
  const evening = localHour >= 12;
  const mid = evening ? 'dusk' : 'dawn';
  if (sunAltDeg >= 8) return { a: 'day', b: 'day', t: 0 };
  if (sunAltDeg >= 0) return { a: mid, b: 'day', t: (sunAltDeg / 8) ** 1.4 };
  if (sunAltDeg >= -12) return { a: 'night', b: mid, t: 1 - (sunAltDeg / -12) ** 1.2 };
  return { a: 'night', b: 'night', t: 0 };
}
