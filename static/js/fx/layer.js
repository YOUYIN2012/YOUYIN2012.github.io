/**
 * layer.js — 交互层（Canvas 2D，单画布单循环）
 *
 * 职责：稀疏漂浮星尘、轻触星光爆发、流星雨、细指针光标拖尾。
 * 视觉原则：冷色、crisp、少而克制——不用 shadowBlur，不叠辉光。
 *
 * 性能：DPR 上限 2、页面隐藏即停、reduced-motion 仅保留
 * 极简一次淡出反馈、粒子规模按指针类型分级。
 */

import { clamp, rand, pick, prefersReducedMotion, isCoarsePointer, rafThrottle } from '../utils.js';

/* 冷色粒子调色板（冰蓝 / 靛 / 月白） */
const COOL = [
  ['#9fd8ff', '#e8f4ff'],
  ['#7fb0ff', '#b8d9ff'],
  ['#a8c8ff', '#8fd6f2'],
  ['#cfe6ff', '#9fb8ff'],
];

/* 四角星（unit 路径） */
const STAR = new Path2D();
STAR.moveTo(0, -1);
STAR.quadraticCurveTo(0.1, -0.1, 1, 0);
STAR.quadraticCurveTo(0.1, 0.1, 0, 1);
STAR.quadraticCurveTo(-0.1, 0.1, -1, 0);
STAR.quadraticCurveTo(-0.1, -0.1, 0, -1);
STAR.closePath();

export class Layer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.coarse = isCoarsePointer();
    this.reduced = prefersReducedMotion();
    this.running = false;
    this.rafId = 0;
    this.ambientMax = this.reduced ? 0 : (this.coarse ? 9 : 16);
    this.frameInterval = 1000 / (this.coarse ? 30 : 60);
    this.ambient = [];
    this.bursts = [];
    this.rings = [];
    this.meteors = [];
    this.trail = [];
    this.meteorQueue = 0;
    this.meteorWindow = 0;
    this.meteorDuration = 0;
    this.meteorElapsed = 0;
    this.meteorSchedule = [];
    this.lastTs = 0;
    this.w = 0; this.h = 0;
    this.frame = this.loop.bind(this);
    this.handleResize = rafThrottle(() => this.resize());
    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

    this.resize();
    addEventListener('resize', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      document.hidden ? this.stop() : this.start();
    });
    this.motionQuery.addEventListener?.('change', (event) => {
      this.reduced = event.matches;
      this.ambientMax = this.reduced ? 0 : (this.coarse ? 9 : 16);
      if (this.reduced) this.ambient.length = 0;
      this.start();
    });
    this.start();
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth || innerWidth;
    this.h = this.canvas.clientHeight || innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  start() {
    if (this.running || document.hidden) return;
    this.running = true;
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }
  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /* ---------- 公开 API ---------- */

  /** 轻触星光爆发（页面坐标）——星尘与天空小星同规格（1–4px） */
  burst(x, y, { count, power = 1 } = {}) {
    const n = this.reduced ? 8 : Math.min(count ?? (this.coarse ? 26 : 38), 96);
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(36, 210) * power;
      this.bursts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 42,
        size: Math.random() < 0.45 ? rand(2.0, this.coarse ? 3.6 : 4.2) : rand(1.0, this.coarse ? 2.0 : 2.4),
        rot: rand(0, Math.PI * 2),
        vr: rand(-2.4, 2.4),
        life: 0,
        maxLife: rand(0.55, 1.15),
        colors: pick(COOL),
        star: Math.random() < 0.45,
      });
    }
    this.ring(x, y);
    this.start();
  }

  /** 纤细扩散光环：即时触觉级的视觉反馈（crisp 描线，无辉光） */
  ring(x, y) {
    if (this.rings.length > 24) return;
    this.rings.push({ x, y, life: 0, maxLife: 0.55 });
    this.start();
  }

  /** 流星雨（细而 crisp 的长划） */
  meteorShower(count, duration = 4) {
    if (this.reduced) return;
    const base = this.coarse ? 9 : 14;
    const total = count ?? Math.round(rand(base * 0.8, base * 1.3));
    const actualDuration = count === undefined ? duration * rand(0.88, 1.14) : duration;

    // 2–4 个随机密集区混合少量散点，既不均匀排队，也不会漏发。
    const clusterCount = Math.floor(rand(2, 5));
    const clusters = Array.from({ length: clusterCount }, () => rand(0.12, 0.88) * actualDuration);
    this.meteorSchedule = Array.from({ length: total }, () => {
      const time = Math.random() < 0.72
        ? pick(clusters) + rand(-0.38, 0.38)
        : rand(0.04, actualDuration);
      return clamp(time, 0.04, actualDuration);
    }).sort((a, b) => a - b);

    this.meteorQueue = total;
    this.meteorWindow = actualDuration;
    this.meteorDuration = actualDuration;
    this.meteorElapsed = 0;
    this.start();
  }

  /** 生成一颗方向受约束、外观随机的流星。Canvas y 向下，因此 vx/vy 始终为正。 */
  spawnMeteor() {
    const fromTop = Math.random() < 0.72;
    const angle = rand(22, 50) * Math.PI / 180;
    const speed = rand(420, 780) * (this.coarse ? 0.9 : 1);
    const colors = pick([
      [166, 205, 255],
      [188, 218, 255],
      [154, 215, 246],
      [202, 222, 255],
    ]);

    this.meteors.push({
      x: fromTop ? rand(-0.12, 0.72) * this.w : rand(-150, -20),
      y: fromTop ? rand(-90, -8) : rand(-0.04, 0.42) * this.h,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: rand(0.78, 1.42),
      len: speed * rand(0.16, 0.31),
      width: rand(0.9, 2.25),
      headScale: rand(0.92, 1.12),
      brightness: rand(0.72, 1.0),
      shimmer: rand(8, 18),
      phase: rand(0, Math.PI * 2),
      colors,
    });
  }

  /** 光标拖尾（细指针设备，按距离节流） */
  pushTrail(x, y) {
    if (this.reduced || this.coarse) return;
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 22) return;
    if (this.trail.length > 40) return;
    this.trail.push({ x, y, life: 0, maxLife: rand(0.4, 0.7), size: rand(1.2, 2.4), colors: pick(COOL) });
    this.start();
  }

  /* ---------- 主循环 ---------- */

  loop(ts) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    if (this.lastTs && ts - this.lastTs < this.frameInterval - 1) return;
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.05) : 0.016;
    this.lastTs = ts;

    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    /* 稀疏星尘（小而干净） */
    while (this.ambient.length < this.ambientMax) {
      this.ambient.push({
        x: rand(0, w), y: h + rand(0, 30),
        vy: -rand(6, 18), sway: rand(6, 20), phase: rand(0, Math.PI * 2),
        size: rand(1.2, 2.6), life: 0, maxLife: rand(10, 18),
        colors: pick(COOL),
        alpha: rand(0.14, 0.32),
      });
    }
    for (let i = this.ambient.length - 1; i >= 0; i--) {
      const m = this.ambient[i];
      m.life += dt;
      m.y += m.vy * dt;
      m.x += Math.sin(m.life * 0.7 + m.phase) * m.sway * dt;
      if (m.life > m.maxLife || m.y < -20) { this.ambient.splice(i, 1); continue; }
      const a = m.alpha * clamp(m.life / 2, 0, 1) * clamp((m.maxLife - m.life) / 3, 0, 1);
      this.dot(m.x, m.y, m.size, m.colors[0], a);
    }

    /* 扩散光环 */
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      if (r.life > r.maxLife) { this.rings.splice(i, 1); continue; }
      const t = r.life / r.maxLife;
      const ease = 1 - (1 - t) ** 3;
      ctx.strokeStyle = `rgba(200,228,255,${(1 - t) * 0.55})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 5 + ease * 32, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* 爆发粒子：紧致圆点 + 四角星 */
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const p = this.bursts[i];
      p.life += dt;
      if (p.life > p.maxLife) { this.bursts.splice(i, 1); continue; }
      const drag = Math.exp(-2.6 * dt);
      p.vx *= drag;
      p.vy = p.vy * drag - 40 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const t = p.life / p.maxLife;
      const a = Math.min(1, t / 0.06) * (1 - t * t);
      if (p.star) this.star4(p.x, p.y, p.size * (1 - t * 0.4), p.colors, a, p.rot);
      else this.dot(p.x, p.y, p.size * (1 - t * 0.5), p.colors[0], a);
    }

    /* 流星 */
    if (this.meteorQueue > 0 && this.meteorWindow > 0) {
      this.meteorElapsed += dt;
      this.meteorWindow = Math.max(0, this.meteorDuration - this.meteorElapsed);
      while (this.meteorSchedule.length && this.meteorSchedule[0] <= this.meteorElapsed) {
        this.meteorSchedule.shift();
        this.meteorQueue--;
        this.spawnMeteor();
      }
    } else if (this.meteorQueue <= 0 || this.meteorWindow <= 0) {
      this.meteorQueue = 0;
      this.meteorWindow = 0;
      this.meteorSchedule.length = 0;
    }
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.life += dt;
      if (m.life > m.maxLife) { this.meteors.splice(i, 1); continue; }
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const t = m.life / m.maxLife;
      const fade = Math.min(1, t / 0.12) * (1 - ((t - 0.12) / 0.88) ** 2);
      const shimmer = 0.88 + 0.12 * Math.sin(m.life * m.shimmer + m.phase);
      const a = clamp(fade * m.brightness * shimmer, 0, 1);
      const mag = Math.hypot(m.vx, m.vy) || 1;
      const ux = m.vx / mag, uy = m.vy / mag;
      const tx = m.x - ux * m.len, ty = m.y - uy * m.len;
      const nx = -uy, ny = ux;            // 法向
      const hw = m.width;                 // 头部半宽，向尾收拢成锥形
      const [r, g, b] = m.colors;
      // 锥形拖尾：三角带 + 尾暗头亮渐变
      const grad = ctx.createLinearGradient(tx, ty, m.x, m.y);
      grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},${0.36 * a})`);
      grad.addColorStop(0.85, `rgba(${Math.min(255, r + 38)},${Math.min(255, g + 24)},255,${0.74 * a})`);
      grad.addColorStop(1, `rgba(250,253,255,${0.96 * a})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(m.x + nx * hw, m.y + ny * hw);
      ctx.lineTo(tx, ty);
      ctx.lineTo(m.x - nx * hw, m.y - ny * hw);
      ctx.closePath();
      ctx.fill();
      // 头部亮点
      ctx.fillStyle = `rgba(250,253,255,${a})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.width * m.headScale, 0, Math.PI * 2);
      ctx.fill();
    }

    /* 拖尾 */
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const p = this.trail[i];
      p.life += dt;
      if (p.life > p.maxLife) { this.trail.splice(i, 1); continue; }
      const t = p.life / p.maxLife;
      this.dot(p.x, p.y, p.size * (1 - t * 0.6), p.colors[0], 0.4 * (1 - t));
    }

    ctx.globalCompositeOperation = 'source-over';

    // reduced-motion 没有常驻星尘，反馈结束后完全休眠。
    if (this.ambientMax === 0 && !this.bursts.length && !this.rings.length &&
        !this.meteors.length && !this.trail.length && this.meteorQueue <= 0) {
      this.stop();
    }
  }

  /* 纯净圆点（无阴影，边缘由 alpha 控制） */
  dot(x, y, r, color, alpha) {
    if (alpha <= 0.01) return;
    const { ctx } = this;
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* 四角星光（两层颜色， crisp 描线感） */
  star4(x, y, size, [c1, c2], alpha, rot = 0) {
    if (alpha <= 0.01) return;
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(size, size);
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.fillStyle = c1;
    ctx.fill(STAR);
    ctx.scale(0.45, 0.45);
    ctx.fillStyle = c2;
    ctx.fill(STAR);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
