/**
 * utils.js — 通用工具与环境探测
 */

export const $ = (sel, root = document) => root.querySelector(sel);

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (min = 0, max = 1) => Math.random() * (max - min) + min;
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 当前是否偏好减少动效（实时读取） */
export const prefersReducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 是否触屏为主 */
export const isCoarsePointer = () =>
  matchMedia('(pointer: coarse)').matches;

/** 轻量触觉反馈（支持的设备上） */
export function haptic(pattern = 10) {
  try { navigator.vibrate?.(pattern); } catch { /* 不支持则忽略 */ }
}

/** 单帧节流的高频事件辅助 */
export function rafThrottle(fn) {
  let frame = 0;
  let latestArgs = null;
  let latestThis = null;
  const throttled = function (...args) {
    latestArgs = args;
    latestThis = this;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const callArgs = latestArgs;
      const callThis = latestThis;
      latestArgs = latestThis = null;
      fn.apply(callThis, callArgs);
    });
  };
  throttled.cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    latestArgs = latestThis = null;
  };
  return throttled;
}

/** 颜色数组 RGB 线性插值 */
export const mixRGB = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * FPS 看门狗：持续采样帧耗时，超阈值时触发降级回调。
 * 用于多端自适应画质。
 */
export class FpsGuard {
  constructor({ sampleFrames = 70, badMs = 34, onDegrade, coolDownMs = 15000, maxLevel = 3 } = {}) {
    Object.assign(this, { sampleFrames, badMs, onDegrade, coolDownMs, maxLevel });
    this.frames = 0;
    this.bad = 0;
    this.total = 0;
    this.lastTs = 0;
    this.lastDegradeAt = 0;
    this.level = 0; // 0 满画质，随后按 maxLevel 逐级降档
  }
  tick(ts) {
    if (!this.lastTs) { this.lastTs = ts; return; }
    const dt = ts - this.lastTs;
    this.lastTs = ts;
    // 调试器暂停、标签页恢复等长间隔不属于渲染性能问题。
    if (dt > 250) { this.resetSample(); return; }
    this.total += dt;
    if (dt > this.badMs) this.bad++;
    if (++this.frames >= this.sampleFrames) {
      const avg = this.total / this.frames;
      const badRatio = this.bad / this.frames;
      if (this.level < this.maxLevel &&
          (avg > this.badMs || badRatio > 0.25) &&
          Date.now() - this.lastDegradeAt > this.coolDownMs) {
        this.level++;
        this.lastDegradeAt = Date.now();
        this.onDegrade?.(this.level);
      }
      this.resetSample();
    }
  }

  resetSample() {
    this.frames = this.bad = this.total = 0;
  }

  reset() {
    this.resetSample();
    this.lastTs = 0;
  }
}
