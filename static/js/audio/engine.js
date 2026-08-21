/**
 * engine.js — Web Audio 音频引擎
 *
 * <audio> → MediaElementSource → GainNode（切歌快速淡入）
 *        → AnalyserNode → AudioWorklet 节拍检测 → destination
 *
 * 播放时 tick() 采样并计算 RMS 能量（驱动极光/月晕/频谱环），节拍瞬态叠加。
 * 附加：OPFS 离线音频仓库（跨 SW 版本存活）、暂停时生成式环境音床（synth.js）、
 * Media Session 锁屏控制 + 静态封面、播放时 Wake Lock、自动连播、错误回调兜底。
 */

import { AmbientSynth } from './synth.js';
import { TrackStore } from './track-store.js';

const musicUrl = (name) => new URL(`../../music/${name}`, import.meta.url).href;
const BEAT_WORKLET_URL = new URL('./beat-worklet.js', import.meta.url).href;

/** 从曲目 src 提取 OPFS 存储用的文件名。 */
const trackFilename = (src) => decodeURIComponent(new URL(src, location.href).pathname.split('/').pop());

const TRACKS = [
  { title: 'Possible Dreams', artist: 'Eugenio Mininni', src: musicUrl('Possible Dreams-Eugenio Mininni.mp3') },
  // 新增曲目：把 mp3 放入 static/music/ 后在此追加
  // { title: '…', artist: '…', src: musicUrl('文件名.mp3') },
];

const ARTWORK = [{
  src: new URL('../../images/icon-512.png', import.meta.url).href,
  sizes: '512x512',
  type: 'image/png',
}];

export class AudioEngine {
  constructor(audioEl) {
    this.tracks = TRACKS;
    this.index = -1;
    this.playing = false;
    this.ready = false;
    this.onState = null;
    this.onError = null;
    this.energy = 0;        // 0..1 RMS，每帧更新
    this.wakeLock = null;
    this.transitionId = 0;
    this.sessionTrack = -1;
    this._ctxWarned = false;
    this.onBeat = null;       // 节拍回调（AudioWorklet 检出，strength 0..1）
    this.beatBoost = 0;       // 节拍瞬态能量，tick 时叠加进总能量
    this.synth = null;
    this.store = new TrackStore();
    this._warmLocalCopies();

    this.audio = audioEl;
    this.freq = new Uint8Array(512);
    this.wave = new Uint8Array(1024);

    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('error', () => this._reportError(this.audio.error));
    this.audio.addEventListener('playing', () => this._persistCurrent());
    this.audio.addEventListener('play', () => {
      this.playing = true;
      this._emit();
      this._syncSession();
      this._requestWakeLock();
      this.synth?.off();
    });
    this.audio.addEventListener('pause', () => {
      this.playing = false;
      // 环境音床走独立输出；暂停即清空视觉瞬态，避免残留节拍继续驱动天空。
      this.beatBoost = 0;
      this.freq.fill(0);
      this.synth?.on();
      this._emit();
      this._syncSession();
      this._releaseWakeLock();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.playing) this._requestWakeLock();
    });
    addEventListener('pagehide', () => this._releaseWakeLock());
    this._initSession();
  }

  /** 必须在用户手势中调用 */
  ensureContext() {
    if (this.ready) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'playback' });
      this.src = this.ctx.createMediaElementSource(this.audio);
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.82;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.wave = new Uint8Array(this.analyser.fftSize);
      this.src.connect(this.gain);
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      // 环境音直接输出，不进入音乐 analyser / AudioWorklet，听觉与视觉状态彼此隔离。
      this.synth = new AmbientSynth(this.ctx, this.ctx.destination);
      // 节拍检测模块异步就位；就绪前保持直连，避免任何可闻中断。
      this.ctx.audioWorklet.addModule(BEAT_WORKLET_URL).then(() => {
        const node = new AudioWorkletNode(this.ctx, 'beat-detector', { outputChannelCount: [2] });
        node.port.onmessage = (e) => {
          if (typeof e.data?.beat !== 'number') return;
          if (!this.playing) return;
          this.beatBoost = Math.max(this.beatBoost, 0.35 + 0.65 * e.data.beat);
          this.onBeat?.(e.data.beat);
        };
        this.analyser.disconnect();
        this.analyser.connect(node);
        node.connect(this.ctx.destination);
      }).catch((err) => {
        console.warn('[audio] beat worklet 不可用，保持直连', err);
      });
      this.ready = true;
    } catch (err) {
      console.warn('[audio] Web Audio 不可用，降级为普通播放', err);
    }
    return this.ready;
  }

  get track() { return this.index >= 0 ? this.tracks[this.index] : null; }

  async toggle() {
    if (this.index < 0) return this.playAt(0);
    if (this.playing) return this.pause();
    return this.resume();
  }

  async resume() {
    if (this.index < 0) return this.playAt(0);
    this.ensureContext();
    // 先同步发起 play() 占住用户手势窗口，再异步恢复 AudioContext。
    const playing = this.audio.play().catch((error) => {
      if (error?.name !== 'AbortError') this._reportError(error);
      return false;
    });
    await this._resumeCtx();
    await playing;
  }

  pause() {
    this.audio.pause();
    if (this.audio.paused) this._releaseWakeLock();
  }

  /** 单音源硬切换 + 快速淡入；play() 始终同步发起以留在用户手势栈内 */
  async playAt(i) {
    if (i < 0 || i >= this.tracks.length) return;
    const transitionId = ++this.transitionId;
    const changing = this.index !== i;
    const wasPlaying = this.playing;
    this.index = i;
    this.ensureContext();

    const startSource = () => {
      // 设置音源与调用 play() 必须发生在任何 await 之前，否则部分移动浏览器会以
      // 「非用户手势」为由拦截播放。OPFS 本地副本已在构造期预解析，此处同步可取。
      this.audio.src = this.tracks[i]._localUrl ?? this.tracks[i].src;
      return this.audio.play().then(
        () => transitionId === this.transitionId,
        (error) => {
          if (transitionId === this.transitionId && error?.name !== 'AbortError') {
            this._reportError(error);
          }
          return false;
        },
      );
    };

    if (this.ready && changing && wasPlaying) {
      // 硬切换 + 快速淡入：先淡出再换曲会让 play() 落在 await 之后，
      // 脱离用户手势窗口（严格的移动端策略会拒绝播放），可靠性优先于无缝度。
      const g = this.gain.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(0, this.ctx.currentTime);
      const started = startSource();   // 同步发起
      await this._resumeCtx();
      if (!await started) {
        // 播放失败必须还回音量，否则环境音床与后续播放全部静音
        g.cancelScheduledValues(this.ctx.currentTime);
        g.setValueAtTime(1, this.ctx.currentTime);
        return;
      }
      await this._fadeGain(0, 1, 220);
    } else {
      if (this.gain) this.gain.gain.value = 1;
      const started = startSource();   // 同步发起
      await this._resumeCtx();
      if (!await started) return;
    }
  }

  /** 恢复 AudioContext；创建成功但始终无法进入 running 时告警一次（元素输出已被接管，会静音）。 */
  async _resumeCtx() {
    if (!this.ready || !this.ctx) return;
    await this.ctx.resume().catch(() => {});
    if (this.ctx.state !== 'running' && !this._ctxWarned) {
      this._ctxWarned = true;
      console.warn('[audio] AudioContext 无法进入 running 状态，声音可能被静音');
    }
  }

  next() { return this.playAt(this.index < 0 ? 0 : (this.index + 1) % this.tracks.length); }
  prev() { return this.playAt(this.index < 0 ? this.tracks.length - 1 : (this.index - 1 + this.tracks.length) % this.tracks.length); }

  _fadeGain(from, to, ms) {
    if (!this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const g = this.gain.gain;
      const t0 = this.ctx.currentTime;
      g.cancelScheduledValues(t0);
      g.setValueAtTime(from, t0);
      g.linearRampToValueAtTime(to, t0 + ms / 1000);
      setTimeout(resolve, ms + 30);
    });
  }

  /** 环境音床是否在响（暂停/兜底期间为 true，但不进入音乐可视化链） */
  get synthActive() { return this.synth?.active ?? false; }

  /** 每帧调用一次：仅在音乐播放时采样并计算能量（节拍瞬态叠加）。 */
  tick(dt = 1 / 60) {
    if (!this.ready || !this.playing) {
      this.energy *= Math.exp(-5 * dt);
      this.beatBoost *= Math.exp(-6 * dt);
      if (this.energy < 0.002) {
        this.energy = 0;
        this.freq.fill(0);
      }
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);
    let sum = 0;
    const step = Math.max(1, Math.floor(this.wave.length / 256));
    let n = 0;
    for (let i = 0; i < this.wave.length; i += step) {
      const v = (this.wave[i] - 128) / 128;
      sum += v * v;
      n++;
    }
    const rms = Math.sqrt(sum / n);
    this.energy = Math.min(1, rms * 2.4 + this.beatBoost);
    this.beatBoost *= Math.exp(-6 * dt);
  }

  /** 预解析 OPFS 本地副本的 blob URL：playAt 必须同步取 src，不能等异步查询。 */
  _warmLocalCopies() {
    this.store.init().then((ok) => {
      if (!ok) return;
      for (const track of this.tracks) {
        this.store.url(trackFilename(track.src))
          .then((url) => { if (url) track._localUrl = url; })
          .catch(() => {});
      }
    }).catch(() => {});
  }

  /** 首次成功播放后把整曲存入 OPFS：离线可听，且跨 SW 版本升级存活。 */
  async _persistCurrent() {
    const track = this.track;
    if (!track || track._stored || track._localUrl || !this.store.ok) return;
    track._stored = true;
    try {
      const res = await fetch(track.src);
      if (!res.ok) { track._stored = false; return; }
      const bytes = await res.arrayBuffer();
      await this.store.put(trackFilename(track.src), bytes);
    } catch {
      track._stored = false;
    }
  }

  /* ---------- Media Session ---------- */

  _initSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => this.resume());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('nexttrack', () => this.next());
    } catch { /* 部分动作不支持 */ }
  }

  _syncSession() {
    if (!('mediaSession' in navigator) || !this.track) return;
    try {
      const t = this.track;
      if (this.sessionTrack !== this.index && typeof MediaMetadata === 'function') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: t.title,
          artist: t.artist,
          album: '爱意随风起',
          artwork: ARTWORK,
        });
        this.sessionTrack = this.index;
      }
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    } catch {
      // Media Session 是增强功能，平台实现不完整时不影响基础播放。
    }
  }

  /* ---------- Wake Lock ---------- */

  async _requestWakeLock() {
    // 'screen' 是有意选择：频谱驱动的星河可视化随音乐呼吸，播放期间保持亮屏。
    if (!('wakeLock' in navigator) || this.wakeLock || document.hidden || !this.playing) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
    } catch { /* 被拒绝或不可用 */ }
  }

  _releaseWakeLock() {
    try { this.wakeLock?.release(); } catch { /* 忽略 */ }
    this.wakeLock = null;
  }

  _reportError(error) {
    this.playing = false;
    // 离线且无本地副本时的兜底：先让环境音床进入 active，再通知可视化启动采样。
    this.synth?.on();
    this._emit();
    this._syncSession();
    this._releaseWakeLock();
    this.onError?.(error);
  }

  _emit() {
    this.onState?.({ index: this.index, playing: this.playing, track: this.track });
  }
}
