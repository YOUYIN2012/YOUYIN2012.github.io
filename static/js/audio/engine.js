/**
 * engine.js — Web Audio 音频引擎
 *
 * <audio> → MediaElementSource → GainNode（切歌交叉淡出）
 *        → AnalyserNode（频谱/波形）→ destination
 *
 * 每帧 tick() 采样一次并计算 RMS 能量（驱动极光/月晕/频谱环）。
 * 附加：Media Session 锁屏控制 + 静态封面、播放时 Wake Lock、
 * 自动连播、错误回调兜底。无任何文字 UI 依赖。
 */

const musicUrl = (name) => new URL(`../../music/${name}`, import.meta.url).href;

const TRACKS = [
  // { title: 'Thinking Out Loud', artist: 'Ed Sheeran', src: musicUrl('Ed Sheeran-Thinking Out Loud.mp3') },
  // { title: '晴天', artist: '周杰伦', src: musicUrl('周杰伦 - 晴天.mp3') },
  // { title: '少一点天分', artist: '孙盛希', src: musicUrl('孙盛希 - 少一点天分.mp3') },
  { title: 'Possible Dreams', artist: 'Eugenio Mininni', src: musicUrl('Possible Dreams-Eugenio Mininni.mp3') },
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

    this.audio = audioEl;
    this.freq = new Uint8Array(512);
    this.wave = new Uint8Array(1024);

    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('error', () => this._reportError(this.audio.error));
    this.audio.addEventListener('play', () => {
      this.playing = true;
      this._emit();
      this._syncSession();
      this._requestWakeLock();
    });
    this.audio.addEventListener('pause', () => {
      this.playing = false;
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
    await this.ctx?.resume().catch(() => {});
    try {
      await this.audio.play();
    } catch (error) {
      if (error?.name !== 'AbortError') this._reportError(error);
    }
  }

  pause() {
    this.audio.pause();
    if (this.audio.paused) this._releaseWakeLock();
  }

  /** 单音源淡出 → 切换 → 淡入，避免切歌爆音 */
  async playAt(i) {
    if (i < 0 || i >= this.tracks.length) return;
    const transitionId = ++this.transitionId;
    const changing = this.index !== i;
    this.index = i;
    this.ensureContext();
    await this.ctx?.resume().catch(() => {});

    const start = async () => {
      if (transitionId !== this.transitionId) return false;
      this.audio.src = this.tracks[i].src;
      try {
        await this.audio.play();
      } catch (error) {
        if (transitionId === this.transitionId && error?.name !== 'AbortError') {
          this._reportError(error);
        }
        return false;
      }
      return transitionId === this.transitionId;
    };

    if (this.ready && changing && this.playing) {
      await this._fadeGain(1, 0, 250);
      if (transitionId !== this.transitionId || !await start()) return;
      await this._fadeGain(0, 1, 450);
    } else {
      if (this.gain) this.gain.gain.value = 1;
      if (!await start()) return;
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

  /** 每帧调用一次：采样并计算能量 */
  tick(dt = 1 / 60) {
    if (!this.ready || !this.playing) {
      this.energy *= Math.exp(-5 * dt);
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
    this.energy = Math.min(1, rms * 2.4);
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
    this._emit();
    this._syncSession();
    this._releaseWakeLock();
    this.onError?.(error);
  }

  _emit() {
    this.onState?.({ index: this.index, playing: this.playing, track: this.track });
  }
}
