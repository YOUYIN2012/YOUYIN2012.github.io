/**
 * beat-worklet.js — AudioWorklet 节拍检测
 *
 * 三频段（低/中/高）一阶 IIR 包络 → 谱通量 → 自适应阈值起振检测。
 * 检出节拍经 port.postMessage({ beat }) 上抛，主线程据此触发流星与极光脉冲。
 * classic script：AudioWorklet 模块不能用 import。
 *
 * 注意：本文件由 engine.js 以 new URL('./beat-worklet.js', import.meta.url) 加载，
 * 并列入 sw.js CORE_ASSETS（离线播放也需要它）。
 */

class BeatDetector extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor() {
    super();
    // 一阶低通的截止系数：y += a * (x - y)，a = 1 - exp(-2π·fc/fs)
    this.aLow = 1 - Math.exp((-2 * Math.PI * 130) / sampleRate);
    this.aMid = 1 - Math.exp((-2 * Math.PI * 2200) / sampleRate);
    this.lpLow = 0;
    this.lpMid = 0;
    this.prevE = [0, 0, 0];
    this.fluxMean = 0;
    this.fluxDev = 0;
    this.lastBeatTime = -1;
    this.minInterval = 0.28;   // 秒：最短节拍间隔，防连发
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    const n = ch.length;

    let lpLow = this.lpLow, lpMid = this.lpMid;
    let eLow = 0, eMid = 0, eHigh = 0;
    for (let i = 0; i < n; i++) {
      const x = ch[i];
      lpLow += this.aLow * (x - lpLow);
      lpMid += this.aMid * (x - lpMid);
      const low = lpLow;
      const mid = lpMid - lpLow;
      const high = x - lpMid;
      eLow += low * low;
      eMid += mid * mid;
      eHigh += high * high;
    }
    this.lpLow = lpLow;
    this.lpMid = lpMid;

    const e = [eLow / n, eMid / n, eHigh / n];
    let flux = 0;
    for (let b = 0; b < 3; b++) {
      const d = e[b] - this.prevE[b];
      if (d > 0) flux += d;
      this.prevE[b] = e[b];
    }

    // 自适应阈值：通量均值 + 1.6×平均偏差
    this.fluxMean += 0.03 * (flux - this.fluxMean);
    this.fluxDev += 0.03 * (Math.abs(flux - this.fluxMean) - this.fluxDev);
    const threshold = this.fluxMean + 1.6 * this.fluxDev + 1e-6;

    if (flux > threshold && currentTime - this.lastBeatTime > this.minInterval) {
      this.lastBeatTime = currentTime;
      const strength = Math.min(1, (flux - threshold) / (this.fluxMean + this.fluxDev + 1e-6));
      this.port.postMessage({ beat: strength });
    }

    // 直通：保持音频链路不变
    for (let c = 0; c < output.length; c++) {
      const outCh = output[c];
      const inCh = input[Math.min(c, input.length - 1)];
      for (let i = 0; i < outCh.length; i++) outCh[i] = inCh[i];
    }
    return true;
  }
}

registerProcessor('beat-detector', BeatDetector);
