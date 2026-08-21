/**
 * synth.js — 生成式环境音（无音频资产的音景）
 *
 * 风：循环白噪声 → LFO 调制低通；pad：Am add9 失谐正弦堆；
 * 空间：程序生成脉冲响应的卷积混响；点缀：偶发五声音阶高音闪烁。
 * 全部实时合成、零下载，并走独立输出，不参与音乐频谱、节拍流星或极光脉冲。
 *
 * 触发：暂停时淡入、播放时淡出、离线播放失败自动兜底。
 */

/* 冷色五声音阶（A 羽调式），闪烁音符从中取 */
const SHIMMER_NOTES = [880, 987.77, 1174.66, 1318.51, 1567.98];
/* Am add9：A2 / E3 / B3 / C4 —— 小九和弦的「冷」来自大二度叠置 */
const PAD_CHORD = [110, 164.81, 246.94, 261.63];

export class AmbientSynth {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;   // 独立音频输出，不接入音乐 analyser
    this.out = null;
    this.active = false;
    this.building = false;
    this.shimmerTimer = 0;
  }

  /** 惰性建图：首次启用才消耗节点资源。 */
  _build() {
    if (this.out || this.building) return;
    const ctx = this.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.destination);

    /* 生成式混响 IR：立体声噪声 × 指数衰减（3s），无任何下载 */
    const irLength = Math.floor(ctx.sampleRate * 3);
    const ir = ctx.createBuffer(2, irLength, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      for (let i = 0; i < irLength; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / irLength) ** 2.6;
      }
    }
    const reverb = ctx.createConvolver();
    reverb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    reverb.connect(wet);
    wet.connect(this.out);

    /* 风：白噪声 → 双低通（LFO 调制截止频率） */
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < noiseData.length; i++) {
      // 布朗噪声比白噪声更接近风的低频体感
      brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      noiseData[i] = brown * 3.5;
    }
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuf;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 340;
    windFilter.Q.value = 0.6;
    const windLfo = ctx.createOscillator();
    windLfo.frequency.value = 0.05;
    const windLfoGain = ctx.createGain();
    windLfoGain.gain.value = 170;
    windLfo.connect(windLfoGain);
    windLfoGain.connect(windFilter.frequency);
    const windGain = ctx.createGain();
    windGain.gain.value = 0.55;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.out);
    windGain.connect(reverb);
    wind.start();
    windLfo.start();

    /* pad：每音两枚 ±4 音分失谐正弦，慢速互调 */
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 900;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.16;
    padFilter.connect(padGain);
    padGain.connect(this.out);
    padGain.connect(reverb);
    for (const freq of PAD_CHORD) {
      for (const cents of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.detune.value = cents;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.03 + Math.random() * 0.05;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 3;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.detune);
        osc.connect(padFilter);
        osc.start();
        lfo.start();
      }
    }

    /* 偶发高音闪烁：随机间隔 7–18s，慢起慢落，只进混响 */
    const ping = () => {
      if (!this.active) return;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = SHIMMER_NOTES[Math.floor(Math.random() * SHIMMER_NOTES.length)];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.04, t0 + 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 5);
      osc.connect(g);
      g.connect(reverb);
      osc.start(t0);
      osc.stop(t0 + 5.2);
      this.shimmerTimer = setTimeout(ping, 7000 + Math.random() * 11000);
    };
    this._ping = ping;
  }

  /** 淡入环境床。ctx 需已在用户手势中恢复。 */
  on() {
    if (!this.ctx || this.active) return;
    try {
      this._build();
      this.active = true;
      const t = this.ctx.currentTime;
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setValueAtTime(this.out.gain.value, t);
      this.out.gain.linearRampToValueAtTime(0.14, t + 3);
      clearTimeout(this.shimmerTimer);
      this.shimmerTimer = setTimeout(this._ping, 4000 + Math.random() * 6000);
    } catch { /* 建图失败则保持静默 */ }
  }

  off() {
    if (!this.out || !this.active) return;
    this.active = false;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + 2);
    clearTimeout(this.shimmerTimer);
  }
}
