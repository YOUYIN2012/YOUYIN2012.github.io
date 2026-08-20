/**
 * viz.js — 音乐球迷你可视化
 *
 * 外环分段弧 = 当前曲目列表（当前曲目弧更亮更长）；
 * 休眠时缓慢旋转，播放时弧线变为频谱短刺随节拍呼吸。
 * 只读取 engine.tick() 已缓存的采样数据，自身不做 analyser 调用。
 */

export class FabViz {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.phase = 0;
    this.lastTs = 0;
    this.running = false;
    this.rafId = 0;
    this.timerId = 0;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    this.frame = this.loop.bind(this);
    this.bins = this.buildBins();

    this.resize();
    addEventListener('resize', () => this.resize(), { passive: true });
    document.addEventListener('visibilitychange', () => {
      document.hidden ? this.stop() : this.start();
    });
    this.motionQuery.addEventListener?.('change', (event) => {
      this.reduced = event.matches;
      this.poke();
    });
    this.start();
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * this.dpr));
    const height = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  start() {
    if (this.running || document.hidden) return;
    this.running = true;
    this.lastTs = 0;
    this.schedule(true);
  }
  schedule(immediate = false) {
    if (!this.running) return;
    const delay = immediate ? 0 : (this.reduced ? 250 : (this.engine.playing ? 0 : 80));
    if (delay) {
      this.timerId = setTimeout(() => {
        this.timerId = 0;
        this.rafId = requestAnimationFrame(this.frame);
      }, delay);
    } else {
      this.rafId = requestAnimationFrame(this.frame);
    }
  }
  poke() {
    if (!this.running) { this.start(); return; }
    if (this.timerId) clearTimeout(this.timerId);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.timerId = this.rafId = 0;
    this.schedule(true);
  }
  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timerId) clearTimeout(this.timerId);
    this.rafId = this.timerId = 0;
  }

  buildBins() {
    const count = 28;
    const length = this.engine.freq.length;
    this.binSourceLength = length;
    return Array.from({ length: count }, (_, i) => {
      const lo = Math.floor((i / count) ** 1.6 * length * 0.6);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) / count) ** 1.6 * length * 0.6));
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      return { lo, hi, cos: Math.cos(angle), sin: Math.sin(angle) };
    });
  }

  loop(ts) {
    if (!this.running) return;
    this.rafId = 0;
    this.schedule();
    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.1) : 0.016;
    this.lastTs = ts;
    if (!this.reduced) this.phase += dt;

    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - this.dpr * 2.5;
    const playing = this.engine.playing;
    const e = this.engine.energy;

    /* 四段曲目弧（间隙 10°） */
    const tracks = this.engine.tracks.length;
    const gap = 0.16;
    const seg = (Math.PI * 2 - gap * tracks) / tracks;
    for (let i = 0; i < tracks; i++) {
      const active = i === this.engine.index;
      const a0 = -Math.PI / 2 + i * (seg + gap) + this.phase * (playing ? 0.35 : 0.12);
      const len = seg * (active ? 1 : 0.62);
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a0 + len);
      ctx.strokeStyle = active
        ? `rgba(159,216,255,${0.75 + e * 0.25})`
        : 'rgba(190,205,235,0.28)';
      ctx.lineWidth = this.dpr * (active ? 1.8 : 1.2);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    /* 播放时：频谱短刺叠加在弧外侧 */
    if (playing) {
      if (this.binSourceLength !== this.engine.freq.length) this.bins = this.buildBins();
      for (const bin of this.bins) {
        let v = 0;
        for (let j = bin.lo; j < bin.hi; j++) v = Math.max(v, this.engine.freq[j]);
        v = (v / 255) ** 1.4;
        const len = 1.5 * this.dpr + v * 9 * this.dpr;
        ctx.strokeStyle = `rgba(220,240,255,${0.35 + v * 0.55})`;
        ctx.lineWidth = this.dpr;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx + bin.cos * (R + 2.5 * this.dpr), cy + bin.sin * (R + 2.5 * this.dpr));
        ctx.lineTo(cx + bin.cos * (R + 2.5 * this.dpr + len), cy + bin.sin * (R + 2.5 * this.dpr + len));
        ctx.stroke();
      }
    }
  }
}
