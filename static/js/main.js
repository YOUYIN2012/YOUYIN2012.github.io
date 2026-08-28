/**
 * main.js — 纯静态实时星空入口
 *
 * 页面只暴露音乐播放/暂停。天文位置、流星与画质管理均自动运行，
 * 不依赖后端、账号、远程接口或运行时配置。
 */

import {
  $, haptic, isCoarsePointer, rafThrottle,
} from './utils.js';
import {
  horizontalCoords, meteorShowerRadiant, observerDateFromParams,
  observerLocationFromParams, projectHorizontal,
} from './astro.js';
import { Sky, starViewForDevice } from './fx/sky.js';
import { Layer } from './fx/layer.js';
import { AudioEngine } from './audio/engine.js';
import { FabViz } from './ui/viz.js';

const skyCanvas = $('#sky');
const stage = $('#stage');
const audioFab = $('#audioFab');
const status = $('#status');
const coarse = isCoarsePointer();
const params = new URLSearchParams(location.search);
const observer = observerLocationFromParams(params);
const dateMs = observerDateFromParams(params);

const sky = new Sky(skyCanvas, {
  ...observer,
  dateMs,
  disabled: params.get('webgl') === '0',
});
if (sky.ready) sky.start();
else document.body.classList.add('no-webgl');

// 真实流星雨活跃期（峰值 ±3 天）把辐射点对齐天象：辐射点高于地平线 5° 且
// 投影在当前视窗内时使用真实屏幕坐标，否则返回 null 让 Layer 回落到随机辐射点。
const view = starViewForDevice(coarse);
const radiantProvider = () => {
  // 实时模式（含 CSS 降级：refreshRealtimeSky 直接 return，astroDateMs 冻结在
  // 页面加载时刻）必须取当前时刻，否则辐射点方位以 15°/小时随页面停留漂移；
  // ?date= 回放（astroLive=false）沿用固定观测时刻。
  const at = sky.astroLive ? Date.now() : sky.astroDateMs;
  const shower = meteorShowerRadiant(at);
  if (!shower) return null;
  const hor = horizontalCoords(shower.raRad, shower.decRad, at, observer.latDeg, observer.lonDeg);
  if (hor.alt < 5) return null;   // 辐射点在地平线下：不做掠地模型，回落随机
  const p = projectHorizontal(hor.alt, hor.az, view);
  if (!p) return null;            // 在视窗外（如移动端窄窗背对辐射点）回落
  return { x: (p.x * 0.5 + 0.5) * layer.w, y: (0.5 - p.y * 0.5) * layer.h };
};
const layer = new Layer(stage, { radiantProvider });
const engine = new AudioEngine($('#audio'));
const fabViz = new FabViz($('#fabViz'), engine);
const baseTitle = document.title;
const debugEnabled = params.get('debug') === '1';
let debugTimer = 0;

function updateDebugTitle() {
  if (!debugEnabled) return;
  const renderer = sky.ready ? `WebGL q${sky.qualityLevel}` : 'CSS fallback';
  const canvasState = layer.running || layer.showerTimers.size
    ? `Canvas ${layer.meteors.length}M/${layer.bubbles.length}B/${layer.showerTimers.size}Q`
    : 'Canvas idle';
  const audioState = engine.playing ? 'music' : 'ambient';
  document.title = `${baseTitle} · ${renderer} · ${canvasState} · ${audioState}`;
}

function scheduleDebugTitle() {
  clearTimeout(debugTimer);
  debugTimer = 0;
  if (!debugEnabled || document.hidden) return;
  updateDebugTitle();
  debugTimer = setTimeout(scheduleDebugTitle, 300);
}

function stopDebugTitle() {
  clearTimeout(debugTimer);
  debugTimer = 0;
}

let toastTimer = 0;
function announce(message, duration = 3200) {
  clearTimeout(toastTimer);
  status.textContent = message;
  status.classList.toggle('is-visible', Boolean(message));
  if (message && duration > 0) {
    toastTimer = setTimeout(() => status.classList.remove('is-visible'), duration);
  }
}

// 音乐按钮之外仅保留两种直接手势：单击星光、短时间三击流星雨。
let skyTaps = [];
addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary || event.composedPath().includes(audioFab)) return;
  layer.spark(event.clientX, event.clientY);
  haptic(3);
  const now = performance.now();
  skyTaps = skyTaps.filter((tapAt) => now - tapAt < 900);
  skyTaps.push(now);
  if (skyTaps.length >= 3) {
    skyTaps = [];
    if (layer.meteorShower()) haptic([7, 36, 7]);
  }
}, { passive: true });

// Git 原版桌面鼠标轨迹：帧级节流后交给 Layer 按移动距离生成冷色短尾。
if (!coarse) {
  addEventListener('pointermove', rafThrottle((event) => {
    layer.pushTrail(event.clientX, event.clientY);
  }), { passive: true });
}

engine.onState = ({ playing, track }) => {
  audioFab.setAttribute('aria-pressed', String(playing));
  audioFab.setAttribute('aria-label', track
    ? `${playing ? '暂停' : '播放'}背景音乐：${track.title}`
    : '播放背景音乐');
  fabViz.poke();
  if (playing || engine.energy > 0.002) startEnergyLoop();
  // 版本切换被音频播放推迟时，这里是最自然的重试时机。
  tryVersionRefresh();
};

// fallback 由引擎按「合成音床是否存在」给出：ensureContext 失败时 synth 为 null，
// 没有合成音景可切换，只能提示稍后再试，不能承诺「已切换为浏览器合成音景」。
engine.onError = (error, { fallback = false } = {}) => announce(fallback
  ? '音乐暂时无法播放，已切换为浏览器合成音景。'
  : '音乐暂时无法播放，请稍后再试。');
engine.onBeat = (strength) => layer.meteorFromBeat(strength);

audioFab.addEventListener('click', () => {
  haptic(6);
  engine.toggle();
});

let energyRaf = 0;
let lastEnergyTs = 0;

function startEnergyLoop() {
  if (energyRaf || document.hidden) return;
  lastEnergyTs = 0;
  energyRaf = requestAnimationFrame(energyLoop);
}

function stopEnergyLoop() {
  if (energyRaf) cancelAnimationFrame(energyRaf);
  energyRaf = 0;
  lastEnergyTs = 0;
}

function energyLoop(timestamp) {
  const dt = lastEnergyTs ? Math.min((timestamp - lastEnergyTs) / 1000, 0.1) : 1 / 60;
  lastEnergyTs = timestamp;
  engine.tick(dt);
  if (sky.ready) sky.setAudioEnergy(engine.playing ? engine.energy : 0);
  if (engine.playing || engine.energy > 0.002) {
    energyRaf = requestAnimationFrame(energyLoop);
  } else {
    energyRaf = 0;
    if (sky.ready) sky.setAudioEnergy(0);
    // 播放中升级、暂停时能量尚未归零而被推迟的版本刷新：能量此后在 tick 里
    // 指数衰减归零，不会再触发 onState，必须在这里补最后一次重试。
    tryVersionRefresh();
  }
}

function refreshRealtimeSky() {
  // ?date= 回放模式固定观测时刻：恒星时校准、标签页恢复等所有实时入口
  // 都不能把固定时刻覆盖回“现在”。
  if (dateMs != null || !sky.ready) return;
  sky.setSkyTime(null, observer.latDeg, observer.lonDeg);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopEnergyLoop();
    stopDebugTitle();
    layer.suspend();
    return;
  }
  layer.resume();
  refreshRealtimeSky();
  if (engine.playing || engine.energy > 0.002) startEnergyLoop();
  scheduleDebugTitle();
});

addEventListener('pagehide', () => {
  stopEnergyLoop();
  stopDebugTitle();
  layer.suspend();
});

addEventListener('pageshow', (event) => {
  if (!document.hidden) {
    layer.resume();
    if (event.persisted) refreshRealtimeSky();
  }
});

// 恒星时每分钟校准；画面中的星星会随地球自转连续改变位置。
// ?date= 回放模式下 refreshRealtimeSky 直接跳过，固定观测时刻不会被覆盖。
setInterval(refreshRealtimeSky, 60_000);

// 无界面验收入口：自动演示一次与三击手势相同的物理流星雨。
if (params.get('demo') === 'storm') {
  setTimeout(() => {
    if (!document.hidden) layer.meteorShower();
  }, 800);
}

// 仅在 ?debug=1 时把渲染、画布与音频状态写入标题，普通访问零开销。
scheduleDebugTitle();

// Compute Pressure 是主动降档信号；不可用时 Sky 内部的 FPS 看门狗继续兜底。
const activePressureObservers = [];
if ('PressureObserver' in globalThis && sky.ready) {
  try {
    const pressureLevel = { nominal: 0, fair: 0, serious: 1, critical: 2 };
    const pressureObserver = new globalThis.PressureObserver((records) => {
      const level = pressureLevel[records.at(-1)?.state];
      if (Number.isFinite(level)) sky.setPressureFloor(level);
    });
    activePressureObservers.push(pressureObserver);
    pressureObserver.observe('cpu', { sampleInterval: 2000 }).catch(() => {});
  } catch { /* API 存在但当前上下文没有权限时，继续使用 FPS 看门狗。 */ }
}

/* SW 版本切换不再由 Service Worker navigate 强刷页面——那会立刻打断正在播放
   的音乐。旧壳存续期间本页全部模块已加载完毕，音频请求走网络优先策略，因此
   不存在新旧版本混用的路径；只需在本页完全空闲（未播放且能量已归零）时一次性
   重载，让新壳尽快接管。 */
let pendingVersionRefresh = false;
let versionRefreshDone = false;
function tryVersionRefresh() {
  if (!pendingVersionRefresh || versionRefreshDone) return;
  // 正在播放或能量尚未回落时推迟；onState 与 energyLoop 的归零分支都会再次尝试。
  if (!engine.playing && engine.energy < 0.002) {
    versionRefreshDone = true;   // 一次性：防止重复 reload 形成刷新循环
    location.reload();
  }
}

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  // 必须在 register 之前捕获：首次安装完成后的 claim 同样会触发
  // controllerchange，但那是首次接管而非版本切换，不能因此刷新页面。
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    pendingVersionRefresh = true;
    tryVersionRefresh();
  });
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}
