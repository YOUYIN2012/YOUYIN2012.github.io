/**
 * sky.js — WebGL2 全屏片元着色器天空（冷色 / 清晰 / 克制）
 *
 * 极简构成：纵向冷色渐变 + 单条缓慢极光带 +
 * 固定满月意象 + 桌面 360° 地平全景 / 移动端窄视窗 GL_POINTS 真星图。
 * 音频能量（uBeat）轻微驱动极光与月晕。
 *
 * 天文：亮星位置与时段调色板来自 astro.js 的实时计算；月相功能已移除。
 * 流星只在 Canvas2D 层绘制，避免着色器与节拍系统重复生成、方向不一致。
 *
 * 清晰度策略：目标 DPR 上限 2，并受总像素预算约束；星星为紧致圆点。
 * 性能策略：FBM 3 octave（降档 2）、粗指针设备 30fps、页面隐藏即停、
 * 上下文丢失恢复、FPS 看门狗按负载降档并在稳定后回升、
 * Compute Pressure 提供降档下限（setPressureFloor）、
 * prefers-reduced-motion 冻结时间轴并按需重绘（静止后完全休眠，不再空转耗电）。
 */

import {
  clamp, lerp, mixRGB, prefersReducedMotion, isCoarsePointer, rafThrottle, FpsGuard,
} from '../utils.js';
import {
  DEFAULT_VIEW, PANORAMA_VIEW, horizontalCoords, projectStars,
  paletteForSun, sunEquatorial, localSolarHour,
} from '../astro.js';

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform float uQuality;   // 1 = 3 octave, 0 = 2 octave
uniform float uBeat;      // 音频能量 0..1
uniform vec3  uTop, uMid, uBot;
uniform vec3  uAuroraA, uAuroraB;
uniform vec3  uMoonCol;

out vec4 fragColor;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i),             hash21(i + vec2(1, 0)), u.x),
    mix(hash21(i + vec2(0,1)), hash21(i + vec2(1, 1)), u.x),
    u.y);
}

float fbm(vec2 p, int oct) {
  float v = 0.0, a = 0.55;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    if (i >= oct) break;
    v += a * vnoise(p);
    p = rot * p * 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (frag - 0.5 * uRes) / uRes.y;

  float t = uTime;

  /* 纵向冷色渐变 */
  float grad = clamp(uv.y, 0.0, 1.0);
  vec3 sky = mix(uBot, uTop, smoothstep(0.0, 0.92, grad));
  sky = mix(sky, uMid, 0.30 * smoothstep(0.25, 0.65, grad) * (1.0 - smoothstep(0.65, 0.95, grad)));

  /* 单条极光带：域扭曲 + 音频呼吸 */
  vec2 q = p * vec2(0.8, 1.15) + vec2(t * 0.006, t * 0.003);
  float warp = fbm(q + 0.9 * fbm(q * 1.6, 2), uQuality > 0.5 ? 3 : 2);
  float band = 0.5 + 0.5 * sin(warp * 4.2 + uv.x * 2.4 + t * 0.05);
  float mask = smoothstep(0.18, 0.62, warp)
             * smoothstep(0.10, 0.50, band)
             * smoothstep(0.06, 0.42, grad) * (1.0 - smoothstep(0.62, 1.0, grad));
  vec3 aurora = mix(uAuroraA, uAuroraB, 0.5 + 0.5 * sin(warp * 2.6 + t * 0.04));
  sky += aurora * mask * (0.10 + uBeat * 0.12);

  /* 月亮：恢复固定满月意象，不再绘制月相明暗界线。 */
  vec2 moonPos = vec2(0.36 * aspect, 0.34);
  float md = length(p - moonPos);
  float moonR = 0.075;
  float aa = 1.5 / uRes.y;
  float moon = 1.0 - smoothstep(moonR - aa, moonR + aa, md);
  if (moon > 0.0) {
    float shade = fbm((p - moonPos) * 7.0, 2);
    moon *= 0.88 + 0.12 * shade;
  }
  float halo = exp(-max(0.0, md - moonR) * 20.0) * (0.22 + uBeat * 0.10)
             + exp(-max(0.0, md - moonR) * 5.0) * 0.06;
  sky += uMoonCol * halo;
  sky += uMoonCol * moon;

  /* 轻暗角 + 抖动去色带（不糊化画面） */
  float vig = 1.0 - smoothstep(0.4, 1.3, length(p * vec2(0.82, 1.05)));
  sky *= mix(0.80, 1.0, vig);
  sky += (hash21(frag + fract(t)) - 0.5) / 255.0 * 1.6;

  fragColor = vec4(sky, 1.0);
}
`;

/* GL_POINTS 真星图通道：顶点数据来自 astro.projectStars；每颗星独立模拟大气闪烁。 */
const STAR_VERT = `#version 300 es
layout(location=0) in vec4 aStar;   // xClip, yClip, brightness, seed
uniform float uDpr;
uniform float uTime;
out float vBright;
out float vSeed;
void main() {
  float displayBright = sqrt(max(aStar.z, 0.0));
  float twSlow = 0.5 + 0.5 * sin(
    uTime * (0.28 + aStar.w * 0.75) + aStar.w * 6.2831
  );
  float twFast = 0.5 + 0.5 * sin(
    uTime * (1.31 + aStar.w * 2.37) + aStar.w * 17.17
    + sin(uTime * 0.19 + aStar.w * 9.3) * 0.38
  );
  float flash = pow(max(0.0, sin(
    uTime * (0.23 + aStar.w * 0.31) + aStar.w * 31.7
  )), 10.0);
  float twinkle = clamp(0.30 + twSlow * 0.40 + twFast * 0.20 + flash * 0.18, 0.28, 1.08);
  // 暗星受大气闪烁影响更明显，亮星保持稳定辨识度。
  float twinkleAmount = mix(0.78, 0.42, clamp(displayBright, 0.0, 1.0));
  float brightnessPulse = mix(1.0, twinkle, twinkleAmount);
  vBright = displayBright * brightnessPulse;
  vSeed = aStar.w;
  gl_PointSize = max(
    mix(2.1, 7.2, displayBright) * uDpr * (0.90 + twinkle * 0.12),
    1.0
  );
  gl_Position = vec4(aStar.xy, 0.0, 1.0);
}
`;

const STAR_FRAG = `#version 300 es
precision highp float;
in float vBright;
in float vSeed;
out vec4 fragColor;
void main() {
  if (vBright <= 0.004) discard;
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float d = length(pc);
  float core = 1.0 - smoothstep(0.12, 0.85, d);
  // 最亮的星带纤细十字衍射，与背景星野的画法呼应
  float flare = (max(0.0, 1.0 - abs(pc.x) * 6.0) + max(0.0, 1.0 - abs(pc.y) * 6.0))
              * (1.0 - smoothstep(0.15, 1.0, d))
              * smoothstep(0.55, 0.95, vBright) * 0.45;
  float a = (core + flare) * vBright;
  vec3 col = mix(vec3(0.87, 0.92, 1.0), vec3(0.72, 0.83, 1.0), fract(vSeed * 7.31));
  fragColor = vec4(col * a, a);
}
`;

/* ---------- 冷色时段调色板（sRGB 0..1） ---------- */
export const PALETTES = {
  night: {
    top: [0.020, 0.045, 0.140], mid: [0.050, 0.100, 0.260], bot: [0.008, 0.018, 0.070],
    auroraA: [0.22, 0.72, 0.95], auroraB: [0.42, 0.48, 1.00],
    moon: [0.92, 0.96, 1.00],
  },
  dawn: {
    top: [0.100, 0.170, 0.360], mid: [0.220, 0.300, 0.520], bot: [0.040, 0.070, 0.160],
    auroraA: [0.55, 0.78, 1.00], auroraB: [0.40, 0.60, 1.00],
    moon: [0.95, 0.97, 1.00],
  },
  day: {
    top: [0.150, 0.320, 0.620], mid: [0.300, 0.500, 0.780], bot: [0.090, 0.170, 0.340],
    auroraA: [0.60, 0.85, 1.00], auroraB: [0.55, 0.70, 1.00],
    moon: [1.00, 1.00, 0.99],
  },
  dusk: {
    top: [0.060, 0.090, 0.260], mid: [0.150, 0.180, 0.420], bot: [0.020, 0.035, 0.120],
    auroraA: [0.20, 0.78, 0.88], auroraB: [0.48, 0.45, 1.00],
    moon: [0.90, 0.94, 1.00],
  },
};

/** 两套调色板的逐键插值（paletteForSun 的连续过渡落到具体颜色）。 */
export function blendPalettes(a, b, t) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = mixRGB(a[key], b[key], t);
  return out;
}

/**
 * 天文状态计算：真实亮星 clip 数据与太阳高度调色板。
 */
export function computeAstroState(ms, latDeg, lonDeg, view = DEFAULT_VIEW) {
  const sun = sunEquatorial(ms);
  const sunHor = horizontalCoords(sun.ra, sun.dec, ms, latDeg, lonDeg);
  const state = {
    starData: projectStars(ms, latDeg, lonDeg, view),
    paletteTarget: PALETTES.night,
  };

  /* 时段调色板：太阳高度角连续混合 */
  const hourLocal = localSolarHour(ms, lonDeg);
  const alt = sunHor.alt;
  const { a, b, t } = paletteForSun(alt, hourLocal);
  state.paletteTarget = t <= 0 ? PALETTES[a] : blendPalettes(PALETTES[a], PALETTES[b], t);

  // 民用暮光开始后才逐渐显星；白天不把星图简单叠在蓝天上。
  const starVisibility = clamp((-alt - 4) / 8, 0, 1);
  for (let i = 2; i < state.starData.length; i += 4) {
    state.starData[i] *= starVisibility;
  }
  return state;
}

/** 精细指针设备视为桌面并展开完整地平方位；粗指针设备保留窄视窗。 */
export function starViewForDevice(coarsePointer) {
  return coarsePointer ? DEFAULT_VIEW : PANORAMA_VIEW;
}

export class Sky {
  constructor(canvas, { disabled = false, latDeg = 35, lonDeg = 116, dateMs = null } = {}) {
    this.canvas = canvas;
    this.gl = null;
    this.ready = false;
    this.running = false;
    this.rafId = 0;
    this.timerId = 0;
    this.qualityLevel = 0;
    this.guardLevel = 0;
    this.pressureFloor = 0;
    this.coarse = isCoarsePointer();
    this.starView = starViewForDevice(this.coarse);
    this.targetFps = this.coarse ? 30 : 60;
    this.maxPixels = this.coarse ? 2_200_000 : 4_000_000;
    // 先减少 FBM octave，再逐级降低内部渲染分辨率。
    this.scaleSteps = [1.0, 1.0, 0.85, 0.7];
    this.beat = 0;
    this.beatTarget = 0;
    this.time = 0;
    this.lastFrameTs = 0;
    this.palette = structuredClone(PALETTES.night);
    this.paletteTarget = PALETTES.night;
    this.frozen = prefersReducedMotion();
    this.frame = this.loop.bind(this);
    this.handleResize = rafThrottle(() => this.resize());
    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    this.handleVisibility = () => {
      document.hidden ? this.stop() : this.start();
    };
    this.handleMotionChange = (event) => {
      this.frozen = event.matches;
      this.fpsGuard.reset();
      // 冻结休眠后 running 可能已是 false，必须无条件重启才能立即反映偏好变化。
      this.stop();
      this.start();
    };
    this.handleContextLost = (event) => {
      event.preventDefault();
      this.ready = false;
      this.canvas.classList.add('is-unavailable');
      this.stop();
    };
    this.handleContextRestored = () => {
      if (this.init()) {
        this.canvas.classList.remove('is-unavailable');
        this.resize();
        this.updateAstro(true);
        this.start();
      }
    };

    /* 天文状态 */
    this.latDeg = latDeg;
    this.lonDeg = lonDeg;
    this.astroDateMs = dateMs ?? Date.now();
    this.astroLive = dateMs == null;
    this.lastAstroMs = 0;
    this.fpsGuard = new FpsGuard({
      badMs: this.coarse ? 42 : 28,
      maxLevel: this.scaleSteps.length - 1,
      onDegrade: (level) => { this.guardLevel = level; this.applyQuality(); },
      onRecover: (level) => { this.guardLevel = level; this.applyQuality(); },
    });

    if (disabled || !this.init()) return;
    this.resize();
    this.updateAstro(true);
    this.bindEvents();
  }

  init() {
    this.ready = false;
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power', preserveDrawingBuffer: false,
    });
    if (!gl) { this.gl = null; return false; }

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[sky] shader error:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const link = (vsSrc, fsSrc) => {
      const vs = compile(gl.VERTEX_SHADER, vsSrc);
      const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
      if (!vs || !fs) {
        if (vs) gl.deleteShader(vs);
        if (fs) gl.deleteShader(fs);
        return null;
      }
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('[sky] link error:', gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        return null;
      }
      return prog;
    };

    const prog = link(VERT, FRAG);
    const starProg = link(STAR_VERT, STAR_FRAG);
    if (!prog || !starProg) {
      if (prog) gl.deleteProgram(prog);
      if (starProg) gl.deleteProgram(starProg);
      this.gl = null;
      return false;
    }
    gl.useProgram(prog);
    this.gl = gl;
    this.ready = true;
    this.prog = prog;
    this.starProg = starProg;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.quadBuf = buf;

    this.starBuf = gl.createBuffer();
    this.starCount = 0;

    this.u = {};
    for (const name of ['uRes', 'uTime', 'uQuality', 'uBeat',
      'uTop', 'uMid', 'uBot', 'uAuroraA', 'uAuroraB', 'uMoonCol']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    this.su = {};
    for (const name of ['uDpr', 'uTime']) {
      this.su[name] = gl.getUniformLocation(starProg, name);
    }
    return true;
  }

  bindEvents() {
    addEventListener('resize', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.motionQuery.addEventListener?.('change', this.handleMotionChange);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  /** 释放全局监听与 WebGL 资源。 */
  destroy() {
    this.stop();
    this.handleResize.cancel?.();
    removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.motionQuery.removeEventListener?.('change', this.handleMotionChange);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    const gl = this.gl;
    if (gl) {
      if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
      if (this.starBuf) gl.deleteBuffer(this.starBuf);
      if (this.prog) gl.deleteProgram(this.prog);
      if (this.starProg) gl.deleteProgram(this.starProg);
    }
    this.ready = false;
    this.gl = null;
  }

  resize() {
    const cssW = this.canvas.clientWidth || innerWidth;
    const cssH = this.canvas.clientHeight || innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const requestedPixels = cssW * cssH * dpr * dpr;
    const budgetScale = Math.min(1, Math.sqrt(this.maxPixels / Math.max(1, requestedPixels)));
    const scale = this.scaleSteps[this.qualityLevel] * budgetScale;
    const w = Math.max(1, Math.round(cssW * dpr * scale));
    const h = Math.max(1, Math.round(cssH * dpr * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.gl) this.gl.viewport(0, 0, w, h);
    // 纵横比变了，星图缓冲与固定月亮位置需立即重绘。
    this.updateAstro(true);
    this.wake();   // 尺寸变化后至少重绘一帧
  }

  applyQuality() {
    const q = Math.min(Math.max(this.guardLevel, this.pressureFloor), this.scaleSteps.length - 1);
    if (q !== this.qualityLevel) {
      this.qualityLevel = q;
      this.resize();
    }
  }

  /** Compute Pressure API：系统压力直接抬高降档下限，FPS 看门狗退居兜底。 */
  setPressureFloor(level) {
    this.pressureFloor = clamp(level | 0, 0, this.scaleSteps.length - 1);
    this.applyQuality();
  }

  /* ---------- 天文驱动 ---------- */

  /** 更新观测时刻/地点；dateMs=null 表示实时，数值表示固定日期回放。 */
  setSkyTime(dateMs = null, latDeg = this.latDeg, lonDeg = this.lonDeg) {
    this.astroLive = dateMs == null;
    this.astroDateMs = dateMs ?? Date.now();
    this.latDeg = latDeg;
    this.lonDeg = lonDeg;
    this.updateAstro(true);
    this.wake();
  }

  updateAstro(force = false) {
    if (!this.ready) return;
    const now = performance.now();
    if (!force && now - this.lastAstroMs < 1000) return;
    this.lastAstroMs = now;

    const ms = this.astroLive ? Date.now() : this.astroDateMs;
    const state = computeAstroState(ms, this.latDeg, this.lonDeg, this.starView);

    const gl = this.gl;
    this.starCount = state.starData.length / 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.bufferData(gl.ARRAY_BUFFER, state.starData, gl.DYNAMIC_DRAW);
    this.paletteTarget = state.paletteTarget;
  }

  setPalette(name) {
    if (!PALETTES[name]) return;
    this.paletteTarget = PALETTES[name];
    this.wake();
  }
  setAudioEnergy(v) { this.beatTarget = clamp(v, 0, 1); this.wake(); }

  /** 唤醒渲染：frozen 模式下仅在确有变化时重绘，静止后彻底休眠。 */
  wake() {
    if (!this.ready || !this.gl) return;
    if (this.frozen) this.dirty = true;
    this.start();
  }

  /** frozen 模式的休眠判定：所有过渡都已收敛且无新输入。 */
  isSettled() {
    if (this.dirty) return false;
    if (Math.abs(this.beat - this.beatTarget) > 1e-3) return false;
    const t = this.paletteTarget;
    return ['top', 'mid', 'bot', 'auroraA', 'auroraB', 'moon'].every((key) => {
      const a = this.palette[key], b = t[key];
      return Math.abs(a[0] - b[0]) < 1e-3 &&
             Math.abs(a[1] - b[1]) < 1e-3 &&
             Math.abs(a[2] - b[2]) < 1e-3;
    });
  }

  start() {
    if (this.running || !this.ready || !this.gl || document.hidden) return;
    this.running = true;
    this.lastFrameTs = 0;
    this.schedule(true);
  }
  schedule(immediate = false) {
    if (!this.running) return;
    const fps = this.frozen ? 4 : this.targetFps;
    if (!immediate && fps < 55) {
      const interval = 1000 / fps;
      const elapsed = this.lastFrameTs ? performance.now() - this.lastFrameTs : interval;
      const delay = Math.max(0, interval - elapsed - 8);
      this.timerId = setTimeout(() => {
        this.timerId = 0;
        this.rafId = requestAnimationFrame(this.frame);
      }, delay);
    } else {
      this.rafId = requestAnimationFrame(this.frame);
    }
  }
  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timerId) clearTimeout(this.timerId);
    this.rafId = this.timerId = 0;
    this.fpsGuard.reset();
  }

  loop(ts) {
    if (!this.running) return;
    this.rafId = this.timerId = 0;

    const dt = this.lastFrameTs
      ? Math.min((ts - this.lastFrameTs) / 1000, this.frozen ? 0.3 : 0.1)
      : 0.016;
    this.lastFrameTs = ts;

    // 低动效模式主动降到 4fps，不参与 FPS 看门狗，避免被误判为性能不足。
    if (!this.frozen) this.fpsGuard.tick(ts);
    if (!this.frozen) this.time += dt;

    this.updateAstro();

    const beatK = 1 - Math.exp(-dt * 8.0);
    this.beat = lerp(this.beat, this.beatTarget, beatK);

    const k = 1 - Math.exp(-dt * 1.2);
    for (const key of ['top', 'mid', 'bot', 'auroraA', 'auroraB', 'moon']) {
      this.palette[key] = mixRGB(this.palette[key], this.paletteTarget[key], k);
    }

    const gl = this.gl, u = this.u;
    // 星点通道上一帧改写了 location=0 的顶点属性，画背景前先还原到全屏三角形。
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(this.prog);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uQuality, this.qualityLevel === 0 ? 1 : 0);
    gl.uniform1f(u.uBeat, this.beat);
    gl.uniform3fv(u.uTop, this.palette.top);
    gl.uniform3fv(u.uMid, this.palette.mid);
    gl.uniform3fv(u.uBot, this.palette.bot);
    gl.uniform3fv(u.uAuroraA, this.palette.auroraA);
    gl.uniform3fv(u.uAuroraB, this.palette.auroraB);
    gl.uniform3fv(u.uMoonCol, this.palette.moon);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* 真星图叠加（加色混合，与 Canvas 层的 'lighter' 一致） */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.starProg);
    gl.uniform1f(this.su.uDpr, Math.min(devicePixelRatio || 1, 2));
    gl.uniform1f(this.su.uTime, this.time);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.drawArrays(gl.POINTS, 0, this.starCount);

    // 冻结模式下画面本应静止：所有过渡收敛后停止调度，等待下一次 wake()。
    if (this.frozen) {
      if (this.isSettled()) { this.stop(); return; }
      this.dirty = false;
    }
    this.schedule();
  }
}
