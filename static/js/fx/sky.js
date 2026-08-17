/**
 * sky.js — WebGL2 全屏片元着色器天空（冷色 / 清晰 / 克制）
 *
 * 极简构成：纵向冷色渐变 + 单条缓慢极光带 + 单层稀疏 crisp 星野 +
 * 抗锯齿月亮 + 低频流星。音频能量（uBeat）轻微驱动极光与月晕。
 *
 * 清晰度策略：全 DPR 渲染（上限 2），不做升采样；星星为紧致圆点。
 * 性能策略：FBM 3 octave（降档 2）、页面隐藏即停、上下文丢失恢复、
 * FPS 看门狗先降 octave 再降分辨率（0.85 / 0.7）、
 * prefers-reduced-motion 冻结时间轴。
 */

import { clamp, lerp, mixRGB, prefersReducedMotion, rafThrottle, FpsGuard } from '../utils.js';

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uPointer;   // [-1,1] 视差
uniform float uStorm;     // 流星雨强度 0..1
uniform float uQuality;   // 1 = 3 octave, 0 = 2 octave
uniform float uBeat;      // 音频能量 0..1
uniform vec3  uTop, uMid, uBot;
uniform vec3  uAuroraA, uAuroraB;
uniform vec3  uMoonCol;

out vec4 fragColor;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
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

/* 单层 crisp 星野：按物理像素取小尺寸（直径约为月亮的 2–5%），
   少数亮星带纤细十字衍射 */
vec3 stars(vec2 p, float grid, float density, float t) {
  vec3 col = vec3(0.0);
  vec2 cell = floor(p * grid);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(i, j);
      if (hash21(c + 7.7) > density) continue;
      vec2 rnd = hash22(c);
      vec2 sp = (c + 0.2 + 0.6 * rnd) / grid;
      float d = length(p - sp);
      // 像素级小星：1.2–2.8 设备像素半径，与分辨率无关地「小」
      float size = (1.2 + 1.6 * hash11(rnd.x * 91.7)) / uRes.y;
      float tw = 0.72 + 0.28 * sin(t * (0.5 + rnd.y * 1.6) + rnd.x * 6.28);
      float m = (1.0 - smoothstep(size * 0.4, size, d)) * tw; // 紧致边缘 → crisp
      float bright = step(0.96, hash11(rnd.y * 57.3));
      vec2 dir = normalize(p - sp + 1e-5);
      float cross = (max(0.0, 1.0 - abs(dir.x) * 14.0) + max(0.0, 1.0 - abs(dir.y) * 14.0))
                  * (1.0 - smoothstep(size * 2.0, size * 7.0, d));
      m += bright * cross * 0.5;
      col += mix(vec3(0.88, 0.93, 1.0), vec3(0.75, 0.85, 1.0), rnd.y) * m;
    }
  }
  return col;
}

vec3 shootingStar(vec2 p, float t, float period, float seed) {
  // 每条轨道使用独立时间偏移与随机种子，避免风暴轨道同步出现。
  float localT = t + seed * 2.731;
  float seg = floor(localT / period);
  float phase = fract(localT / period);
  float key = seg + seed * 41.0;
  float r1 = hash11(key * 12.9898);
  float r2 = hash11(key * 78.233);
  float r3 = hash11(key * 37.719);
  float r4 = hash11(key * 19.193);
  float r5 = hash11(key * 53.117);
  float r6 = hash11(key * 91.731);

  // 约 14% 的时段留空，让节奏保持稀疏而非机械等间隔。
  if (r6 < 0.14) return vec3(0.0);

  float aspect = uRes.x / uRes.y;
  // 约 72% 从上边缘进入，其余从左边缘进入；两种入口最终都向右下移动。
  vec2 topStart = vec2(mix(-0.48 * aspect, 0.30 * aspect, r1), mix(0.48, 0.62, r2));
  vec2 leftStart = vec2(mix(-0.62 * aspect, -0.48 * aspect, r1), mix(0.08, 0.48, r2));
  vec2 start = mix(leftStart, topStart, step(0.28, r5));

  // 着色器坐标 y 向上：x 始终为正、y 始终为负，即屏幕上的左上 → 右下。
  vec2 dir = normalize(vec2(mix(0.68, 1.0, r3), -mix(0.38, 0.82, r4)));
  float speed = mix(1.35, 2.25, r5);
  float travel = mix(0.85, 1.30, r6);
  vec2 pos = start + dir * phase * speed * travel;

  float visibility = smoothstep(0.0, 0.07, phase)
                   * (1.0 - smoothstep(0.62, 0.96, phase));
  float headRadius = mix(0.0022, 0.0042, r2);
  float dHead = distance(p, pos);
  float head = (1.0 - smoothstep(headRadius * 0.25, headRadius, dHead)) * visibility;

  float tailLen = mix(0.09, 0.23, r1);
  vec2 pa = pos - dir * tailLen, pb = pos;   // pa=尾 pb=头
  vec2 ap = p - pa, ab = pb - pa;
  float h = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);  // 0=尾 1=头
  float dLine = length(ap - ab * h);
  float width = mix(0.0006, mix(0.0026, 0.0042, r3), h); // 头粗尾细
  float trail = (1.0 - smoothstep(width * 0.35, width, dLine))
              * pow(h, mix(1.15, 1.75, r4)) * visibility;
  vec3 color = mix(vec3(0.72, 0.86, 1.0), vec3(0.92, 0.96, 1.0), r2);
  float brightness = mix(0.72, 1.18, r5);
  return color * brightness * (head * 1.55 + trail * 0.82);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (frag - 0.5 * uRes) / uRes.y;

  float t = uTime;
  vec2 drift = uPointer * 0.010;

  /* 纵向冷色渐变 */
  float grad = clamp(uv.y + drift.y * 1.6, 0.0, 1.0);
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

  /* 星野（单层，随极光微亮） */
  sky += stars(p + drift * 2.2, 29.0, 0.09, t) * (1.0 + uBeat * 0.15);

  /* 月亮：AA 圆 + 轻微纹理 + 双层光晕 */
  vec2 moonPos = vec2(0.36 * aspect, 0.34) - drift * 6.0;
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

  /* 固定周期保证风暴开关不重算相位；风暴轨道仅改变数量与亮度。 */
  vec2 meteorP = p + drift * 4.0;
  sky += shootingStar(meteorP, t, 4.5, 1.0);
  if (uStorm > 0.05) {
    sky += shootingStar(meteorP, t, 1.05, 11.0) * 0.72 * uStorm;
    sky += shootingStar(meteorP, t, 1.38, 23.0) * 0.62 * uStorm;
    sky += shootingStar(meteorP, t, 1.82, 37.0) * 0.52 * uStorm;
  }

  /* 轻暗角 + 抖动去色带（不糊化画面） */
  float vig = 1.0 - smoothstep(0.4, 1.3, length(p * vec2(0.82, 1.05)));
  sky *= mix(0.80, 1.0, vig);
  sky += (hash21(frag + fract(t)) - 0.5) / 255.0 * 1.6;

  fragColor = vec4(sky, 1.0);
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

export function autoPaletteForHour(hour) {
  if (hour >= 5 && hour < 9) return 'dawn';
  if (hour >= 9 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  return 'night';
}

export class Sky {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.running = false;
    this.rafId = 0;
    this.timerId = 0;
    this.qualityLevel = 0;
    // 先减少 FBM octave，再逐级降低内部渲染分辨率。
    this.scaleSteps = [1.0, 1.0, 0.85, 0.7];
    this.pointer = { x: 0, y: 0 };
    this.pointerTarget = { x: 0, y: 0 };
    this.storm = 0;
    this.stormTarget = 0;
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

    this.fpsGuard = new FpsGuard({
      maxLevel: this.scaleSteps.length - 1,
      onDegrade: (level) => {
        this.qualityLevel = Math.min(level, this.scaleSteps.length - 1);
        this.resize();
      },
    });

    if (!this.init()) return;
    this.resize();
    this.bindEvents();
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power', preserveDrawingBuffer: false,
    });
    if (!gl) return false;
    this.gl = gl;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[sky] shader error:', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[sky] link error:', gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const name of ['uRes', 'uTime', 'uPointer', 'uStorm', 'uQuality', 'uBeat',
      'uTop', 'uMid', 'uBot', 'uAuroraA', 'uAuroraB', 'uMoonCol']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    return true;
  }

  bindEvents() {
    addEventListener('resize', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      document.hidden ? this.stop() : this.start();
    });
    this.motionQuery.addEventListener?.('change', (event) => {
      this.frozen = event.matches;
      this.fpsGuard.reset();
      if (this.running) { this.stop(); this.start(); }
    });
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.stop(); });
    this.canvas.addEventListener('webglcontextrestored', () => {
      if (this.init()) { this.resize(); this.start(); }
    });
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const scale = this.scaleSteps[this.qualityLevel];
    const w = Math.round(this.canvas.clientWidth * dpr * scale) || Math.round(innerWidth * dpr * scale);
    const h = Math.round(this.canvas.clientHeight * dpr * scale) || Math.round(innerHeight * dpr * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.gl) this.gl.viewport(0, 0, w, h);
  }

  setPalette(name) {
    if (!PALETTES[name]) return;
    this.paletteTarget = PALETTES[name];
  }
  setPointer(x, y) {
    this.pointerTarget.x = clamp(x, -1, 1);
    this.pointerTarget.y = clamp(y, -1, 1);
  }
  meteorStorm(on) { this.stormTarget = on ? 1 : 0; }
  setAudioEnergy(v) { this.beatTarget = clamp(v, 0, 1); }

  start() {
    if (this.running || !this.gl || document.hidden) return;
    this.running = true;
    this.lastFrameTs = 0;
    this.schedule();
  }
  schedule() {
    if (!this.running) return;
    if (this.frozen) {
      this.timerId = setTimeout(() => {
        this.timerId = 0;
        this.rafId = requestAnimationFrame(this.frame);
      }, 250);
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
    this.rafId = 0;
    this.schedule();

    const dt = this.lastFrameTs
      ? Math.min((ts - this.lastFrameTs) / 1000, this.frozen ? 0.3 : 0.1)
      : 0.016;
    this.lastFrameTs = ts;

    // 低动效模式主动降到 4fps，不参与 FPS 看门狗，避免被误判为性能不足。
    if (!this.frozen) this.fpsGuard.tick(ts);
    if (!this.frozen) this.time += dt;

    this.pointer.x = lerp(this.pointer.x, this.pointerTarget.x, 0.045);
    this.pointer.y = lerp(this.pointer.y, this.pointerTarget.y, 0.045);
    this.storm = lerp(this.storm, this.stormTarget, 0.02);
    this.beat = lerp(this.beat, this.beatTarget, 0.12);

    const k = 1 - Math.exp(-dt * 1.2);
    for (const key of ['top', 'mid', 'bot', 'auroraA', 'auroraB', 'moon']) {
      this.palette[key] = mixRGB(this.palette[key], this.paletteTarget[key], k);
    }

    const gl = this.gl, u = this.u;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform2f(u.uPointer, this.pointer.x, this.pointer.y);
    gl.uniform1f(u.uStorm, this.storm);
    gl.uniform1f(u.uQuality, this.qualityLevel === 0 ? 1 : 0);
    gl.uniform1f(u.uBeat, this.beat);
    gl.uniform3fv(u.uTop, this.palette.top);
    gl.uniform3fv(u.uMid, this.palette.mid);
    gl.uniform3fv(u.uBot, this.palette.bot);
    gl.uniform3fv(u.uAuroraA, this.palette.auroraA);
    gl.uniform3fv(u.uAuroraB, this.palette.auroraB);
    gl.uniform3fv(u.uMoonCol, this.palette.moon);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
