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

import {
  $, clamp, rafThrottle, haptic, isCoarsePointer, prefersReducedMotion,
} from './utils.js';
import { Sky, autoPaletteForHour } from './fx/sky.js';
import { Layer } from './fx/layer.js';
import { AudioEngine } from './audio/engine.js';
import { FabViz } from './ui/viz.js';

const coarse = isCoarsePointer();
const params = new URLSearchParams(location.search);
const skyCanvas = $('#sky');
const stage = $('#stage');
const audioFab = $('#audioFab');
const stormButton = $('#stormButton');
const status = $('#status');

/* ===================== 天空与交互层 ===================== */
const sky = new Sky(skyCanvas, { disabled: params.get('webgl') === '0' });
if (sky.ready) sky.start();
else document.body.classList.add('no-webgl');

const layer = new Layer(stage);

/* WebGPU 爆发路由（不可用回落 Canvas 2D；?webgpu=0 可强制关闭） */
let burstAt = (x, y, opts) => layer.burst(x, y, opts);
const forceCanvas = params.get('webgpu') === '0';
let webgpuInitPromise = null;

const initWebGPU = async () => {
  if (forceCanvas || prefersReducedMotion() || !('gpu' in navigator)) return false;
  try {
    const { WebGPUBurst } = await import('./fx/webgpu-burst.js');
    const canvas = document.createElement('canvas');
    canvas.className = 'layer gpu-burst';
    canvas.setAttribute('aria-hidden', 'true');
    const gpu = new WebGPUBurst(canvas);
    const inited = await gpu.init();
    if (!inited) { canvas.remove(); return false; }

    document.body.appendChild(canvas);
    burstAt = (x, y, opts) => {
      if (prefersReducedMotion() || !gpu.burst(x, y, opts)) {
        layer.burst(x, y, opts);
      } else {
        layer.ring(x, y);             // GPU 成功时只补一层 Canvas 光环
      }
    };
    return true;
  } catch (err) {
    console.warn('[webgpu] lazy load failed:', err);
    return false;
  }
};
// 首次交互仍走 Canvas；空闲时再按需加载 WebGPU，避免首帧与设备初始化争抢主线程。
const warmWebGPU = () => {
  if (webgpuInitPromise) return;
  webgpuInitPromise = new Promise((resolve) => {
    const run = () => initWebGPU().then(resolve);
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1400 });
    else setTimeout(run, 800);
  });
};

/* ===================== 音频 ===================== */
const engine = new AudioEngine($('#audio'));
const fabViz = new FabViz($('#fabViz'), engine);

engine.onState = ({ playing, track }) => {
  audioFab.setAttribute('aria-pressed', String(playing));
  audioFab.setAttribute('aria-label', track
    ? `${playing ? '暂停' : '播放'}背景音乐：${track.title}（双击下一首，长按上一首）`
    : '播放背景音乐（双击下一首，长按上一首）');
  fabViz.poke();
  if (playing || engine.energy > 0.002) startEnergyLoop();
};
engine.onError = () => {
  status.textContent = '音乐加载失败，请检查网络后重试。';
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
    // 第一次播放必须留在用户激活窗口内，避免部分移动浏览器拦截延迟播放。
    if (engine.index < 0) { fireToggle(); return; }
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
    // 阻止 button 的后续默认 click，由此处准确切换一次。
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fireToggle(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); fireNext(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); firePrev(); }
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
  if (sky.ready) sky.setAudioEnergy(engine.energy);
  if (engine.playing || engine.energy > 0.002) {
    energyRaf = requestAnimationFrame(energyLoop);
  } else {
    energyRaf = 0;
    if (sky.ready) sky.setAudioEnergy(0);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopEnergyLoop();
  else if (engine.playing || engine.energy > 0.002) startEnergyLoop();
});

/* ===================== 指针 / 陀螺仪视差 ===================== */
if (!coarse) {
  addEventListener('pointermove', rafThrottle((e) => {
    if (sky.ready) {
      sky.setPointer((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    }
    layer.pushTrail(e.clientX, e.clientY);
  }), { passive: true });
}

if (sky.ready) {
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
let taps = [];
let storming = false;

const storm = () => {
  if (storming) return;
  storming = true;
  if (prefersReducedMotion()) {
    layer.burst(innerWidth / 2, innerHeight * 0.38, { count: 8, power: 0.45 });
    status.textContent = '已用低动态星光反馈替代流星雨。';
    haptic(8);
    setTimeout(() => { storming = false; }, 700);
    return;
  }

  if (sky.ready) sky.meteorStorm(true);
  layer.meteorShower();
  status.textContent = '流星雨已触发。';
  haptic([8, 40, 8]);
  setTimeout(() => {
    if (sky.ready) sky.meteorStorm(false);
    storming = false;
  }, 5200);
};

stage.addEventListener('pointerdown', (e) => {
  burstAt(e.clientX, e.clientY, { power: 0.85 });
  warmWebGPU();
  haptic(4);

  // 多指触控只让主指针参与三击计数，避免三指同时落下误触流星雨。
  if (e.isPrimary) {
    const now = performance.now();
    taps = taps.filter((t) => now - t < 850);
    taps.push(now);
    if (taps.length >= 3) {
      taps = [];
      storm();
    }
  }
}, { passive: true });

stormButton.addEventListener('click', storm);

/* ===================== 调试 / 演示钩子 ===================== */
const DEBUG = params.get('debug') === '1';
/* ?demo=storm —— 加载 0.8s 后自动来一场流星雨（也用于自检流星管线） */
if (params.get('demo') === 'storm') {
  setTimeout(() => {
    layer.meteorShower(20, 4);
    if (sky.ready && !prefersReducedMotion()) sky.meteorStorm(true);
  }, 800);
  setTimeout(() => { if (sky.ready) sky.meteorStorm(false); }, 6200);
}
if (DEBUG) {
  setInterval(() => {
    const m0 = layer.meteors[0];
    document.title = `G${sky.ready ? '✓' : '✗'}L${layer.running ? '▶' : '⏸'}q${layer.meteorQueue}w${layer.meteorWindow?.toFixed(1)}m${layer.meteors.length}b${layer.bursts.length}` +
      (m0 ? ` M@${Math.round(m0.x)},${Math.round(m0.y)}v${Math.round(m0.vx)},${Math.round(m0.vy)}a${Math.round(m0.life * 100)}/${Math.round(m0.maxLife * 100)}` : '');
  }, 300);
}

/* ===================== 自动时段调色板 ===================== */
if (sky.ready) {
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
