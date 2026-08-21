/**
 * track-store.js — OPFS 离线音频仓库
 *
 * Cache API 的 MEDIA_CACHE 随 SW 版本更迭被整体清空；OPFS 持久、跨版本存活，
 * 让「离线可听」不因升级而失效。Storage Buckets 可用时申请独立持久桶，
 * 否则回落默认 OPFS 根目录。所有操作失败均静默降级——离线仓库是增强，不是依赖。
 */

const BUCKET_NAME = 'love-sky-music';
const DIR_NAME = 'music';

export class TrackStore {
  constructor() {
    this.dir = null;
    this.ok = false;
    this.urlCache = new Map();     // name → blob URL（复用，避免泄漏）
    this.pendingPut = new Set();   // 正在写入的曲目，防并发重复下载
  }

  async init() {
    if (this.ok || this.failed) return this.ok;
    try {
      // Storage Buckets（较新）：为音频申请独立持久桶；API 形态有差异时回落默认 OPFS。
      try {
        const buckets = navigator.storage?.buckets;
        if (buckets?.create) await buckets.create(BUCKET_NAME, { type: 'persistent' });
      } catch { /* 桶已存在或不支持 */ }
      const root = await navigator.storage.getDirectory();
      this.dir = await root.getDirectoryHandle(DIR_NAME, { create: true });
      this.ok = true;
      // 申请持久化存储，降低被自动清理的概率
      navigator.storage?.persist?.()?.catch(() => {});
    } catch {
      this.failed = true;
    }
    return this.ok;
  }

  async has(name) {
    if (!this.ok) return false;
    try {
      await this.dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async put(name, bytes) {
    if (!this.ok || this.pendingPut.has(name)) return false;
    this.pendingPut.add(name);
    try {
      const fh = await this.dir.getFileHandle(name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(bytes);
      await writable.close();
      return true;
    } catch {
      return false;
    } finally {
      this.pendingPut.delete(name);
    }
  }

  /** 曲目的本地 blob URL；不存在返回 null。结果缓存复用。 */
  async url(name) {
    if (!this.ok) return null;
    if (this.urlCache.has(name)) return this.urlCache.get(name);
    try {
      const fh = await this.dir.getFileHandle(name);
      const file = await fh.getFile();
      if (!file.size) return null;
      const url = URL.createObjectURL(file);
      this.urlCache.set(name, url);
      return url;
    } catch {
      return null;
    }
  }
}
