/**
 * main.js — 纯静态实时星空入口
 *
 * 页面只暴露音乐播放/暂停。天文位置、流星与画质管理均自动运行，
 * 不依赖后端、账号、远程接口或运行时配置。
 */

import {
  $, haptic, isCoarsePointer, rafThrottle,
} from './utils.js';
import { observerLocationFromParams } from './astro.js';
import { Sky } from './fx/sky.js';
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

const sky = new Sky(skyCanvas, {
  ...observer,
  disabled: params.get('webgl') === '0',
});
if (sky.ready) sky.start();
else document.body.classList.add('no-webgl');

const layer = new Layer(stage);
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
};

engine.onError = () => announce('音乐暂时无法播放，已切换为浏览器合成音景。');
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
  }
}

function refreshRealtimeSky() {
  if (sky.ready) sky.setSkyTime(null, observer.latDeg, observer.lonDeg);
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

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}
