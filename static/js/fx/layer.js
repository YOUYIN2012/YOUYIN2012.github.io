/**
 * layer.js — 物理一致的 Canvas2D 流星层、底部冷色星尘与鼠标短尾
 *
 * 自然流星按泊松过程稀疏出现；同一会话中的轨迹反向延长后汇聚到同一辐射点，
 * 并用离辐射点的角距离近似透视速度。音乐节拍只改变到达时刻与亮度，不改变
 * 运动方向。页面隐藏时清空动画、节拍蓄能和定时器，恢复后从新过程开始。
 */

import {
  clamp, prefersReducedMotion, isCoarsePointer, rafThrottle,
} from '../utils.js';

const MAX_METEORS = 8;
const MAX_SPARKS = 56;
const MAX_RINGS = 10;
const MAX_BUBBLES = 8;
const MAX_TRAIL = 40;
const MEAN_ARRIVAL_SECONDS = 75;
const MIN_ARRIVAL_SECONDS = 24;
const MAX_ARRIVAL_SECONDS = 180;
const BEAT_COOLDOWN_MS = 1350;
const METEOR_COLORS = [
  [166, 205, 255],
  [188, 218, 255],
  [154, 215, 246],
  [210, 228, 255],
];
const AMBIENT_COLORS = ['#9fd8ff', '#7fb0ff', '#a8c8ff', '#cfe6ff'];

const randomBetween = (min, max, random = Math.random) => min + (max - min) * random();

/**
 * 指数分布的到达间隔（泊松过程），边界防止页面刚打开立即出现或长时间毫无反馈。
 */
export function meteorDelaySeconds(randomValue = Math.random()) {
  const u = clamp(Number.isFinite(randomValue) ? randomValue : 0.5, 1e-6, 1 - 1e-6);
  const seconds = -Math.log(1 - u) * MEAN_ARRIVAL_SECONDS;
  return clamp(seconds, MIN_ARRIVAL_SECONDS, MAX_ARRIVAL_SECONDS);
}

/**
 * 只有星光、流星或鼠标短尾需要高帧率；底部星尘独自运行时自动进入省电档。
 */
export function layerTargetFps(coarsePointer, interactive) {
  if (interactive) return coarsePointer ? 30 : 60;
  return coarsePointer ? 20 : 30;
}

/** 屏幕上方的流星雨辐射点。轨迹反向延长后都应穿过这里。 */
export function createRadiant(width, height, random = Math.random) {
  return {
    x: Math.max(1, width) * randomBetween(0.18, 0.82, random),
    y: -Math.max(1, height) * randomBetween(0.04, 0.16, random),
  };
}

/**
 * 生成单颗流星。起点在上半屏，速度从辐射点向外；角距离越大，投影速度和拖尾越长。
 */
export function createMeteorTrajectory(
  width,
  height,
  radiant,
  strength = 0.35,
  random = Math.random,
) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const diagonal = Math.hypot(w, h);
  const startX = randomBetween(-0.04 * w, 1.04 * w, random);
  const startY = randomBetween(0.015 * h, 0.46 * h, random);
  const dx = startX - radiant.x;
  const dy = Math.max(1, startY - radiant.y);
  const distance = Math.hypot(dx, dy);
  const ux = dx / distance;
  const uy = dy / distance;
  const perspective = clamp(distance / (diagonal * 0.58), 0.35, 1.15);
  const pulse = clamp(strength, 0, 1);
  const speed = diagonal
    * randomBetween(0.34, 0.48, random)
    * (0.72 + perspective * 0.42)
    * (0.96 + pulse * 0.12);
  const length = diagonal
    * randomBetween(0.065, 0.115, random)
    * (0.76 + perspective * 0.38);

  return {
    x: startX,
    y: startY,
    vx: ux * speed,
    vy: uy * speed,
    len: length,
    width: randomBetween(0.85, 1.75, random) * (0.92 + pulse * 0.28),
    maxLife: clamp((length / speed) * randomBetween(3.1, 4.2, random), 0.52, 1.12),
    brightness: randomBetween(0.64, 0.88, random) + pulse * 0.12,
    colors: METEOR_COLORS[Math.floor(random() * METEOR_COLORS.length)] ?? METEOR_COLORS[0],
  };
}

/**
 * 节拍蓄能器的纯函数版本，便于验证后台状态不会累计事件。
 */
export function advanceBeatGate(
  state,
  strength,
  nowMs,
  { inactive = false } = {},
) {
  const previous = {
    charge: Number.isFinite(state?.charge) ? state.charge : 0,
    threshold: Number.isFinite(state?.threshold) ? state.threshold : 1.05,
    lastMeteorAt: Number.isFinite(state?.lastMeteorAt) ? state.lastMeteorAt : -Infinity,
  };
  if (inactive) {
    return { ...previous, charge: 0, lastMeteorAt: nowMs, spawn: false };
  }

  const beatStrength = Number.isFinite(strength) ? strength : 0;
  const impulse = clamp((beatStrength - 0.16) / 0.84, 0, 1);
  const charge = Math.min(2.4, previous.charge + impulse * 0.58);
  const cooledDown = nowMs - previous.lastMeteorAt >= BEAT_COOLDOWN_MS;
  if (cooledDown && charge >= previous.threshold) {
    return {
      ...previous,
      charge: Math.max(0, charge - previous.threshold),
      lastMeteorAt: nowMs,
      spawn: true,
    };
  }
  return { ...previous, charge, spawn: false };
}

export class Layer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.coarse = isCoarsePointer();
    this.reduced = prefersReducedMotion();
    this.maxPixels = this.coarse ? 2_000_000 : 4_000_000;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.running = false;
    this.inactive = document.hidden;
    this.rafId = 0;
    this.ambientTimer = 0;
    this.bubbleTimer = 0;
    this.lastTs = 0;
    this.lastMeteorAt = performance.now();
    this.meteors = [];
    this.sparks = [];
    this.rings = [];
    this.bubbles = [];
    this.trail = [];
    this.showerTimers = new Set();
    this.radiant = { x: 0, y: -1 };
    this.beatGate = { charge: 0, threshold: 1.05, lastMeteorAt: performance.now() };
    this.frame = this.loop.bind(this);
    this.handleResize = rafThrottle(() => this.resize());
    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

    this.resize();
    addEventListener('resize', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.suspend();
      else this.resume();
    });
    this.motionQuery.addEventListener?.('change', (event) => {
      this.reduced = event.matches;
      this.clearTransient();
      if (this.reduced) {
        clearTimeout(this.ambientTimer);
        this.ambientTimer = 0;
        clearTimeout(this.bubbleTimer);
        this.bubbleTimer = 0;
      } else if (!document.hidden) {
        this.resume();
      }
    });

    if (!this.inactive) this.resume();
  }

  resize() {
    this.w = this.canvas.clientWidth || innerWidth;
    this.h = this.canvas.clientHeight || innerHeight;
    const requestedDpr = Math.min(devicePixelRatio || 1, 2);
    const requestedPixels = this.w * this.h * requestedDpr * requestedDpr;
    this.dpr = requestedDpr * Math.min(1, Math.sqrt(this.maxPixels / Math.max(1, requestedPixels)));
    const width = Math.max(1, Math.round(this.w * this.dpr));
    const height = Math.max(1, Math.round(this.h * this.dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.radiant = createRadiant(this.w, this.h);
    this.clearTransient();
  }

  clearTransient() {
    this.meteors.length = 0;
    this.sparks.length = 0;
    this.rings.length = 0;
    this.bubbles.length = 0;
    this.trail.length = 0;
    for (const timer of this.showerTimers) clearTimeout(timer);
    this.showerTimers.clear();
    this.beatGate.charge = 0;
    this.lastTs = 0;
    this.stop();
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  suspend() {
    this.inactive = true;
    clearTimeout(this.ambientTimer);
    this.ambientTimer = 0;
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = 0;
    this.clearTransient();
    const now = performance.now();
    this.lastMeteorAt = now;
    this.beatGate.lastMeteorAt = now;
  }

  resume() {
    if (document.hidden) return;
    const wasInactive = this.inactive;
    this.inactive = false;
    if (wasInactive) {
      this.radiant = createRadiant(this.w, this.h);
      this.beatGate = { charge: 0, threshold: randomBetween(0.94, 1.22), lastMeteorAt: performance.now() };
      this.lastMeteorAt = performance.now();
    }
    if (!this.reduced && !this.ambientTimer) this.scheduleAmbientMeteor();
    if (!this.reduced && !this.bubbleTimer) this.scheduleBubble(randomBetween(0.6, 2.2));
  }

  start() {
    if (this.running || this.inactive || document.hidden) return;
    this.running = true;
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  scheduleAmbientMeteor(delay = meteorDelaySeconds()) {
    clearTimeout(this.ambientTimer);
    this.ambientTimer = 0;
    if (this.inactive || document.hidden || this.reduced) return;
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = 0;
      if (this.inactive || document.hidden || this.reduced) return;
      const quietFor = performance.now() - this.lastMeteorAt;
      if (quietFor < 6000 || this.meteors.length) {
        this.scheduleAmbientMeteor(randomBetween(7, 13));
        return;
      }
      this.spawnMeteor(0.22);
      this.scheduleAmbientMeteor();
    }, Math.max(1, delay) * 1000);
  }

  /** 底部随机升起的原版冷色星尘：小而干净，不叠光晕，也不响应音乐。 */
  scheduleBubble(delay = randomBetween(1.2, 3.8)) {
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = 0;
    if (this.inactive || document.hidden || this.reduced) return;
    this.bubbleTimer = setTimeout(() => {
      this.bubbleTimer = 0;
      if (this.inactive || document.hidden || this.reduced) return;
      this.spawnBubble();
      this.scheduleBubble();
    }, Math.max(0.2, delay) * 1000);
  }

  spawnBubble() {
    if (this.inactive || document.hidden || this.reduced) return false;
    if (this.bubbles.length >= MAX_BUBBLES) this.bubbles.shift();
    this.bubbles.push({
      x: randomBetween(0, this.w),
      y: this.h + randomBetween(0, 30),
      vy: -randomBetween(6, 18),
      radius: randomBetween(1.2, 2.6),
      sway: randomBetween(6, 20),
      phase: randomBetween(0, Math.PI * 2),
      color: AMBIENT_COLORS[Math.floor(Math.random() * AMBIENT_COLORS.length)],
      life: 0,
      maxLife: randomBetween(10, 18),
      alpha: randomBetween(0.14, 0.32),
    });
    this.start();
    return true;
  }

  /** 音乐节拍只推动蓄能器；弱拍不会逐个生成流星，强拍也有最短物理间隔。 */
  meteorFromBeat(strength) {
    const now = performance.now();
    this.beatGate = advanceBeatGate(this.beatGate, strength, now, {
      inactive: this.inactive || document.hidden || this.reduced,
    });
    if (!this.beatGate.spawn) return false;
    this.beatGate.threshold = randomBetween(0.94, 1.22);
    const spawned = this.spawnMeteor(strength);
    if (spawned && this.ambientTimer) {
      // 自然过程与节拍过程彼此独立，但避免恰好同帧重叠造成“爆发”错觉。
      this.scheduleAmbientMeteor(Math.max(8, meteorDelaySeconds()));
    }
    return spawned;
  }

  /** 单击反馈：短促星光与细环，不改变真实星图，也不生成额外随机星星。 */
  spark(x, y) {
    if (this.inactive || document.hidden) return false;
    const cx = clamp(x, 0, this.w);
    const cy = clamp(y, 0, this.h);
    const count = this.reduced ? 5 : (this.coarse ? 11 : 16);
    while (this.sparks.length + count > MAX_SPARKS) this.sparks.shift();
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = randomBetween(this.reduced ? 12 : 26, this.reduced ? 30 : 92);
      this.sparks.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: randomBetween(0.38, this.reduced ? 0.52 : 0.72),
        size: randomBetween(0.8, 1.9),
      });
    }
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x: cx, y: cy, life: 0, maxLife: this.reduced ? 0.34 : 0.52 });
    this.start();
    return true;
  }

  /** 三击流星雨：共享辐射点；所有尚未发生的定时器在切页时都会被取消。 */
  meteorShower(count = this.coarse ? 7 : 10, durationSeconds = 4.4) {
    if (this.inactive || document.hidden || this.reduced) return false;
    for (const timer of this.showerTimers) clearTimeout(timer);
    this.showerTimers.clear();
    const total = clamp(Math.round(count), 4, 14);
    const duration = clamp(durationSeconds, 2.5, 7);
    const offsets = Array.from(
      { length: total },
      () => randomBetween(0.04, duration) ** 0.96,
    ).sort((a, b) => a - b);
    for (let i = 1; i < offsets.length; i++) {
      offsets[i] = Math.max(offsets[i], offsets[i - 1] + 0.13);
    }
    for (const offset of offsets) {
      let timer = 0;
      timer = setTimeout(() => {
        this.showerTimers.delete(timer);
        if (!this.inactive && !document.hidden) this.spawnMeteor(randomBetween(0.48, 0.86));
      }, offset * 1000);
      this.showerTimers.add(timer);
    }
    return true;
  }

  spawnMeteor(strength = 0.35) {
    if (this.inactive || document.hidden || this.reduced) return false;
    if (this.meteors.length >= MAX_METEORS) this.meteors.shift();
    const meteor = createMeteorTrajectory(this.w, this.h, this.radiant, strength);
    meteor.life = 0;
    this.meteors.push(meteor);
    this.lastMeteorAt = performance.now();
    this.start();
    return true;
  }

  /** Git 原版鼠标短尾：仅桌面细指针启用，每移动约 22px 留下一颗冷色圆点。 */
  pushTrail(x, y) {
    if (this.inactive || document.hidden || this.reduced || this.coarse) return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 22) return false;
    if (this.trail.length >= MAX_TRAIL) return false;
    this.trail.push({
      x: clamp(x, 0, this.w),
      y: clamp(y, 0, this.h),
      life: 0,
      maxLife: randomBetween(0.4, 0.7),
      size: randomBetween(1.2, 2.4),
      color: AMBIENT_COLORS[Math.floor(Math.random() * AMBIENT_COLORS.length)],
    });
    this.start();
    return true;
  }

  loop(timestamp) {
    if (!this.running) return;
    const interactive = Boolean(
      this.meteors.length || this.sparks.length || this.rings.length || this.trail.length,
    );
    const targetFps = layerTargetFps(this.coarse, interactive);
    const frameInterval = 1000 / targetFps;
    if (this.lastTs && timestamp - this.lastTs < frameInterval - 1) {
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }

    const dt = this.lastTs ? Math.min((timestamp - this.lastTs) / 1000, 0.05) : 1 / 60;
    this.lastTs = timestamp;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    /* Git 原版稀疏星尘：紧致实心圆点、加色混合、无阴影与光晕。 */
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const bubble = this.bubbles[i];
      bubble.life += dt;
      if (bubble.life >= bubble.maxLife || bubble.y < -20) {
        this.bubbles.splice(i, 1);
        continue;
      }
      bubble.y += bubble.vy * dt;
      bubble.x += Math.sin(bubble.life * 0.7 + bubble.phase) * bubble.sway * dt;
      const alpha = bubble.alpha
        * clamp(bubble.life / 2, 0, 1)
        * clamp((bubble.maxLife - bubble.life) / 3, 0, 1);
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.fillStyle = bubble.color;
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, bubble.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.life += dt;
      if (ring.life >= ring.maxLife) {
        this.rings.splice(i, 1);
        continue;
      }
      const t = ring.life / ring.maxLife;
      const eased = 1 - (1 - t) ** 3;
      ctx.strokeStyle = `rgba(198,226,255,${(1 - t) * 0.42})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, 4 + eased * (this.reduced ? 15 : 27), 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      spark.life += dt;
      if (spark.life >= spark.maxLife) {
        this.sparks.splice(i, 1);
        continue;
      }
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.vx *= Math.exp(-3.2 * dt);
      spark.vy *= Math.exp(-3.2 * dt);
      const t = spark.life / spark.maxLife;
      const alpha = (1 - t) ** 1.7 * Math.min(1, t / 0.05);
      ctx.fillStyle = `rgba(210,234,255,${alpha * 0.72})`;
      ctx.beginPath();
      ctx.arc(spark.x, spark.y, spark.size * (1 - t * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const meteor = this.meteors[i];
      meteor.life += dt;
      meteor.x += meteor.vx * dt;
      meteor.y += meteor.vy * dt;
      if (meteor.life >= meteor.maxLife ||
          meteor.x < -meteor.len - 80 || meteor.x > w + meteor.len + 80 ||
          meteor.y > h + meteor.len + 80) {
        this.meteors.splice(i, 1);
        continue;
      }

      const t = meteor.life / meteor.maxLife;
      const rise = clamp(t / 0.1, 0, 1);
      const decay = (1 - clamp((t - 0.18) / 0.82, 0, 1)) ** 1.65;
      const alpha = clamp(rise * decay * meteor.brightness, 0, 1);
      const speed = Math.hypot(meteor.vx, meteor.vy) || 1;
      const ux = meteor.vx / speed;
      const uy = meteor.vy / speed;
      const tailX = meteor.x - ux * meteor.len;
      const tailY = meteor.y - uy * meteor.len;
      const nx = -uy;
      const ny = ux;
      const [r, g, b] = meteor.colors;

      const gradient = ctx.createLinearGradient(tailX, tailY, meteor.x, meteor.y);
      gradient.addColorStop(0, `rgba(${r},${g},${b},0)`);
      gradient.addColorStop(0.48, `rgba(${r},${g},${b},${0.3 * alpha})`);
      gradient.addColorStop(0.88, `rgba(218,235,255,${0.74 * alpha})`);
      gradient.addColorStop(1, `rgba(252,254,255,${0.98 * alpha})`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(meteor.x + nx * meteor.width, meteor.y + ny * meteor.width);
      ctx.lineTo(tailX, tailY);
      ctx.lineTo(meteor.x - nx * meteor.width, meteor.y - ny * meteor.width);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = `rgba(252,254,255,${alpha})`;
      ctx.beginPath();
      ctx.arc(meteor.x, meteor.y, meteor.width * 0.92, 0, Math.PI * 2);
      ctx.fill();
    }

    /* Git 原版鼠标轨迹：圆点在 0.4–0.7 秒内缩小并淡出，不叠阴影。 */
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const point = this.trail[i];
      point.life += dt;
      if (point.life >= point.maxLife) {
        this.trail.splice(i, 1);
        continue;
      }
      const t = point.life / point.maxLife;
      ctx.globalAlpha = 0.4 * (1 - t);
      ctx.fillStyle = point.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, point.size * (1 - t * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = 'source-over';
    if (this.meteors.length || this.sparks.length || this.rings.length ||
        this.bubbles.length || this.trail.length) {
      this.rafId = requestAnimationFrame(this.frame);
    } else {
      this.stop();
      ctx.clearRect(0, 0, w, h);
    }
  }
}
