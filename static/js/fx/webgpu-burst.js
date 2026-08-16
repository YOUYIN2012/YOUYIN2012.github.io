/**
 * webgpu-burst.js — WebGPU 计算着色器粒子爆发（冷色）
 *
 * 粒子模拟（浮力/阻力/摆动/寿命）跑在 GPU compute 管线，
 * 渲染为 instanced quad + 片元 SDF 四角星/圆点，加色混合。
 * 初始化失败或超时即由上层回落 Canvas 2D。
 *
 * 粒子布局（stride 48B）：
 *   0 vec2f pos | 8 vec2f vel | 16 birth | 20 life | 24 size
 *   28 hue | 32 spin | 36 kind(0 星 1 点) | 40 alive | 44 pad
 */

import { rand } from '../utils.js';

const MAX_PARTICLES = 2048;
const STRIDE = 48;

const WGSL = /* wgsl */ `
struct Particle {
  pos:   vec2f,
  vel:   vec2f,
  birth: f32,
  life:  f32,
  size:  f32,
  hue:   f32,
  spin:  f32,
  kind:  f32,
  alive: f32,
  _pad:  f32,
};

struct SimParams {
  res: vec4f,      // xy = 画布像素；zw = 1/画布像素
  time: f32,
  dt: f32,
  gravity: f32,
  drag: f32,
};

@group(0) @binding(0) var<storage, read_write> particlesRW : array<Particle>;
@group(0) @binding(1) var<uniform> sim : SimParams;

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&particlesRW)) { return; }
  var p = particlesRW[i];
  if (p.alive < 0.5) { return; }

  let age = sim.time - p.birth;
  if (age >= p.life) {
    p.alive = 0.0;
    particlesRW[i] = p;
    return;
  }

  p.vel.y = p.vel.y + sim.gravity * sim.dt;
  p.vel = p.vel * exp(-sim.drag * sim.dt);
  p.pos = p.pos + p.vel * sim.dt;
  p.pos.x = p.pos.x + sin(age * 2.4 + p.spin * 6.28) * 10.0 * sim.dt;
  p.pos.y = p.pos.y - age * 4.0 * sim.dt;
  particlesRW[i] = p;
}

@group(0) @binding(2) var<storage, read> particlesRO : array<Particle>;
@group(0) @binding(3) var<uniform> simR : SimParams;

struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
  @location(3) kind: f32,
};

fn palette(hue: f32) -> vec3f {
  let ice    = vec3f(0.62, 0.85, 1.00);
  let indigo = vec3f(0.50, 0.62, 1.00);
  let cyan   = vec3f(0.56, 0.86, 0.96);
  if (hue <= 1.0) { return mix(ice, indigo, hue); }
  return mix(indigo, cyan, hue - 1.0);
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
  var out: VertexOut;
  let p = particlesRO[ii];

  var quad = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0,  1.0), vec2f(1.0, -1.0), vec2f(1.0,  1.0)
  );
  let local = quad[vi];

  let age = simR.time - p.birth;
  let t = clamp(age / max(p.life, 0.001), 0.0, 1.0);
  let alive = select(0.0, 1.0, p.alive > 0.5 && age >= 0.0);

  let popIn = mix(0.3, 1.0, smoothstep(0.0, 0.08, t));
  let popOut = 1.0 - smoothstep(0.55, 1.0, t) * 0.7;
  let size = p.size * popIn * popOut * alive;
  let spin = age * 1.2 * p.spin;

  let cs = cos(spin); let sn = sin(spin);
  let rot = mat2x2f(cs, sn, -sn, cs);
  let offset = rot * local * size;

  let world = (p.pos + offset) * simR.res.zw;
  out.pos = vec4f(world * 2.0 - 1.0, 0.0, 1.0);
  out.pos.y = -out.pos.y;
  out.local = local;
  out.color = palette(p.hue);
  out.alpha = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.5, 1.0, t)) * alive;
  out.kind = p.kind;
  return out;
}

@fragment
fn fsMain(in: VertexOut) -> @location(0) vec4f {
  var alpha = 0.0;
  var core = 0.0;
  if (in.kind < 0.5) {
    // 四角星光
    let d = max(abs(in.local.x), abs(in.local.y))
          + 0.35 * min(abs(in.local.x), abs(in.local.y)) - 0.9;
    alpha = smoothstep(0.18, -0.12, d) * in.alpha;
    core = smoothstep(0.4, -0.25, d);
  } else {
    // crisp 圆点
    let d = length(in.local);
    alpha = smoothstep(1.0, 0.55, d) * in.alpha;
    core = smoothstep(0.7, 0.0, d);
  }
  let col = in.color + vec3f(0.30) * core * core;
  return vec4f(col * alpha, alpha);
}
`;

export class WebGPUBurst {
  constructor(canvas) {
    this.canvas = canvas;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.simTime = 0;
    this.lastTs = 0;
    this.running = false;
    this.rafId = 0;
    this.cursor = 0;
    this.deadline = 0;   // 最后一批粒子消亡的精确时刻，决定何时休眠
    this.ok = false;
    this.frame = this.loop.bind(this);
    this.paramsData = new Float32Array(8);
  }

  async init() {
    try {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter({ powerPreference: 'low-power' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
      ]);
      if (!adapter) return false;
      this.device = await Promise.race([
        adapter.requestDevice(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      this.device.lost.then(() => { this.stop(); this.ok = false; });

      this.ctx = this.canvas.getContext('webgpu');
      if (!this.ctx) return false;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'premultiplied',
      });

      this.particleBuf = this.device.createBuffer({
        size: MAX_PARTICLES * STRIDE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.paramsBuf = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const module = this.device.createShaderModule({ code: WGSL });

      const computeLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      const renderLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        ],
      });

      this.computePipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
        compute: { module, entryPoint: 'simulate' },
      });
      this.renderPipeline = this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [renderLayout] }),
        vertex: { module, entryPoint: 'vsMain' },
        fragment: {
          module, entryPoint: 'fsMain',
          targets: [{
            format: this.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one' },
              alpha: { srcFactor: 'one', dstFactor: 'one' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      });

      this.computeGroup = this.device.createBindGroup({
        layout: computeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.particleBuf } },
          { binding: 1, resource: { buffer: this.paramsBuf } },
        ],
      });
      this.renderGroup = this.device.createBindGroup({
        layout: renderLayout,
        entries: [
          { binding: 2, resource: { buffer: this.particleBuf } },
          { binding: 3, resource: { buffer: this.paramsBuf } },
        ],
      });

      this.resize();
      addEventListener('resize', () => this.resize(), { passive: true });
      document.addEventListener('visibilitychange', () => {
        document.hidden ? this.stop() : (this.simTime < this.deadline && this.start());
      });
      this.ok = true;
      return true;
    } catch (err) {
      console.warn('[webgpu] init failed:', err);
      return false;
    }
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** 与 Layer.burst 对齐（入参 CSS 像素，内部换算为设备像素；星尘 1–4px 规格） */
  burst(x, y, { count = 36, power = 1 } = {}) {
    if (!this.ok) return false;
    const n = Math.min(count, MAX_PARTICLES);
    const batch = new ArrayBuffer(n * STRIDE);
    const f32 = new Float32Array(batch);
    const px = x * this.dpr, py = y * this.dpr;
    for (let i = 0; i < n; i++) {
      const o = i * 12;
      const a = rand(0, Math.PI * 2);
      const sp = rand(40, 240) * power * this.dpr;
      f32[o]      = px;
      f32[o + 1]  = py;
      f32[o + 2]  = Math.cos(a) * sp;
      f32[o + 3]  = Math.sin(a) * sp - 50 * this.dpr;
      f32[o + 4]  = this.simTime;
      const life = rand(0.6, 1.3);
      f32[o + 5]  = life;
      f32[o + 6]  = rand(1.4, 4.2) * this.dpr;   // 设备像素：与天空小星同规格
      f32[o + 7]  = rand(0, 2);
      f32[o + 8]  = rand(-1.2, 1.2);
      f32[o + 9]  = Math.random() < 0.4 ? 0 : 1;
      f32[o + 10] = 1;
      // 精确记录最后一批粒子消亡时刻，保证动画完整播放到消失
      this.deadline = Math.max(this.deadline, this.simTime + life);
    }
    let index = this.cursor;
    if (index + n > MAX_PARTICLES) index = 0;
    this.cursor = (index + n) % MAX_PARTICLES;
    this.device.queue.writeBuffer(this.particleBuf, index * STRIDE, batch);
    this.start();
    return true;
  }

  start() {
    if (this.running || !this.ok || document.hidden) return;
    this.running = true;
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }
  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  loop(ts) {
    if (!this.running || !this.ok || !this.device) return;
    this.rafId = requestAnimationFrame(this.frame);

    const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.05) : 0.016;
    this.lastTs = ts;
    this.simTime += dt;

    // 空闲判定：所有粒子都已度过寿命才休眠（补 0.2s 余量收尾淡出）
    if (this.simTime > this.deadline + 0.2) { this.stop(); return; }

    const params = this.paramsData;
    params[0] = this.canvas.width;
    params[1] = this.canvas.height;
    params[2] = 1 / this.canvas.width;
    params[3] = 1 / this.canvas.height;
    params[4] = this.simTime;
    params[5] = dt;
    params[6] = -70;
    params[7] = 2.2;
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);

    const encoder = this.device.createCommandEncoder();

    const compute = encoder.beginComputePass();
    compute.setPipeline(this.computePipeline);
    compute.setBindGroup(0, this.computeGroup);
    compute.dispatchWorkgroups(Math.ceil(MAX_PARTICLES / 64));
    compute.end();

    const render = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    render.setPipeline(this.renderPipeline);
    render.setBindGroup(0, this.renderGroup);
    render.draw(6, MAX_PARTICLES);
    render.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
