/**
 * main.js — 单屏应用入口 / 总编排
 *
 * 层次：WebGL2 天空（底）→ Canvas2D 交互层（星尘/爆发/流星/拖尾）
 * → WebGPU 爆发画布（可用时叠加）→ 音乐球。
 *
 * 编排：每帧 engine.tick() 采样一次，音频能量同时驱动
 * 极光呼吸（sky）与频谱环（fabViz）；
 * 指针/陀螺仪视差、三连击流星雨、双击/长按切歌、
 * 自动时段调色板、Service Worker 离线。
 */

import { $, clamp, rafThrottle, haptic, isCoarsePointer } from './utils.js';
import { Sky, autoPaletteForHour } from './fx/sky.js';
import { Layer } from './fx/layer.js';
import { WebGPUBurst } from './fx/webgpu-burst.js';
import { AudioEngine } from './audio/engine.js';
import { FabViz } from './ui/viz.js';

const coarse = isCoarsePointer();
const params = new URLSearchParams(location.search);
const skyCanvas = $('#sky');
const stage = $('#stage');
const audioFab = $('#audioFab');

/* ===================== 天空与交互层 ===================== */
const sky = new Sky(skyCanvas);
if (sky.gl) sky.start();
else document.body.classList.add('no-webgl');

const layer = new Layer(stage);

/* WebGPU 爆发路由（不可用回落 Canvas 2D；?webgpu=0 可强制关闭） */
let burstAt = (x, y, opts) => layer.burst(x, y, opts);
const forceCanvas = params.get('webgpu') === '0';

const initWebGPU = async () => {
  if (forceCanvas || !('gpu' in navigator)) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'layer';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.zIndex = '2';
  canvas.style.pointerEvents = 'none';
  const gpu = new WebGPUBurst(canvas);
  const inited = await gpu.init();
  if (inited) {
    document.body.appendChild(canvas);
    burstAt = (x, y, opts) => {
      layer.ring(x, y);               // 光环始终由 2D 层绘制
      if (!gpu.burst(x, y, opts)) layer.burst(x, y, opts);
    };
  } else {
    canvas.remove();
  }
};
// WebGPU 探测不阻塞首屏；初始化前的点击自然走 Canvas 2D 回退。
if ('requestIdleCallback' in window) requestIdleCallback(initWebGPU, { timeout: 1500 });
else setTimeout(initWebGPU, 0);

/* ===================== 音频 ===================== */
const engine = new AudioEngine($('#audio'));
const fabViz = new FabViz($('#fabViz'), engine);

engine.onState = ({ playing }) => {
  audioFab.setAttribute('aria-pressed', String(playing));
  fabViz.poke();
  if (playing || engine.energy > 0.002) startEnergyLoop();
};

/* 音乐球手势：单击 播放/暂停 · 双击 下一首 · 长按 上一首 */
{
  const fab = audioFab;
  let clickTimer = 0;
  let pressTimer = 0;
  let longFired = false;

  const fireToggle = () => { haptic(6); engine.toggle(); };
  const fireNext = () => { haptic(8); engine.next(); };
  const firePrev = () => { haptic(8); engine.prev(); };

  fab.addEventListener('pointerdown', () => {
    longFired = false;
    pressTimer = setTimeout(() => { longFired = true; firePrev(); }, 600);
  });
  fab.addEventListener('pointerup', () => clearTimeout(pressTimer));
  fab.addEventListener('pointercancel', () => clearTimeout(pressTimer));
  fab.addEventListener('pointerleave', () => clearTimeout(pressTimer));

  fab.addEventListener('click', () => {
    if (longFired) { longFired = false; return; }
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      // 等待可能的第二次点击（双击）
      fireToggle();
    }, 280);
  });
  fab.addEventListener('dblclick', () => {
    clearTimeout(clickTimer);
    fireNext();
  });
  fab.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fireToggle(); }
    if (e.key === 'ArrowRight') fireNext();
    if (e.key === 'ArrowLeft') firePrev();
  });
}

/* 音频采样仅在播放或能量衰减期间运行，空闲后完全休眠。 */
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
function energyLoop(ts) {
  const dt = lastEnergyTs ? Math.min((ts - lastEnergyTs) / 1000, 0.1) : 1 / 60;
  lastEnergyTs = ts;
  engine.tick(dt);
  if (sky.gl) sky.setAudioEnergy(engine.energy);
  if (engine.playing || engine.energy > 0.002) {
    energyRaf = requestAnimationFrame(energyLoop);
  } else {
    energyRaf = 0;
    if (sky.gl) sky.setAudioEnergy(0);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopEnergyLoop();
  else if (engine.playing || engine.energy > 0.002) startEnergyLoop();
});

/* ===================== 指针 / 陀螺仪视差 ===================== */
if (sky.gl) {
  if (!coarse) {
    addEventListener('pointermove', rafThrottle((e) => {
      sky.setPointer((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
      layer.pushTrail(e.clientX, e.clientY);
    }), { passive: true });
  }
  const onOrientation = (e) => {
    if (e.beta === null || e.gamma === null) return;
    sky.setPointer(clamp(e.gamma / 40, -1, 1), clamp((e.beta - 45) / 40, -1, 1));
  };
  let orientationBound = false;
  const bindOrientation = () => {
    if (orientationBound) return;
    orientationBound = true;
    addEventListener('deviceorientation', onOrientation, { passive: true });
  };
  const orientation = window.DeviceOrientationEvent;
  if (typeof orientation?.requestPermission !== 'function') {
    bindOrientation();
  } else {
    const requestOrientation = async () => {
      stage.removeEventListener('pointerdown', requestOrientation);
      audioFab.removeEventListener('pointerdown', requestOrientation);
      try {
        if (await orientation.requestPermission() === 'granted') bindOrientation();
      } catch { /* 用户拒绝或平台不允许 */ }
    };
    stage.addEventListener('pointerdown', requestOrientation, { passive: true });
    audioFab.addEventListener('pointerdown', requestOrientation, { passive: true });
  }
}

/* ===================== 交互：轻触星光 / 三连击流星雨 ===================== */
{
  let taps = [];
  let storming = false;

  const storm = () => {
    if (storming) return;
    storming = true;
    sky.gl && sky.meteorStorm(true);
    layer.meteorShower();
    haptic([8, 40, 8]);
    setTimeout(() => {
      sky.gl && sky.meteorStorm(false);
      storming = false;
    }, 5200);
  };

  stage.addEventListener('pointerdown', (e) => {
    burstAt(e.clientX, e.clientY, { power: 0.85 });
    haptic(4);

    const now = performance.now();
    taps = taps.filter((t) => now - t < 850);
    taps.push(now);
    if (taps.length >= 3) {
      taps = [];
      storm();
    }
  }, { passive: true });
}

/* ===================== 调试 / 演示钩子 ===================== */
const DEBUG = params.get('debug') === '1';
/* ?demo=storm —— 加载 0.8s 后自动来一场流星雨（也用于自检流星管线） */
if (params.get('demo') === 'storm') {
  setTimeout(() => {
    layer.meteorShower(20, 4);
    if (sky.gl) sky.meteorStorm(true);
  }, 800);
  setTimeout(() => { if (sky.gl) sky.meteorStorm(false); }, 6200);
}
if (DEBUG) {
  setInterval(() => {
    const m0 = layer.meteors[0];
    document.title = `G${sky.gl ? '✓' : '✗'}L${layer.running ? '▶' : '⏸'}q${layer.meteorQueue}w${layer.meteorWindow?.toFixed(1)}m${layer.meteors.length}b${layer.bursts.length}` +
      (m0 ? ` M@${Math.round(m0.x)},${Math.round(m0.y)}v${Math.round(m0.vx)},${Math.round(m0.vy)}a${Math.round(m0.life * 100)}/${Math.round(m0.maxLife * 100)}` : '');
  }, 300);
}

/* ===================== 自动时段调色板 ===================== */
if (sky.gl) {
  const apply = () => sky.setPalette(autoPaletteForHour(new Date().getHours()));
  apply();
  setInterval(apply, 5 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) apply();
  });
}

/* ===================== Service Worker ===================== */
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => { /* 静默 */ });
  });
}
