# 爱意随风起

原生 Web 单页星空体验：WebGL2 天空、Canvas2D 交互粒子、按需 WebGPU 增强、Web Audio 可视化与 PWA 应用壳。

## 本地运行

```bash
python3 -m http.server 4175
```

打开 `http://127.0.0.1:4175/`。调试参数：

- `?debug=1`：在标题中显示渲染状态。
- `?demo=storm`：自动触发流星雨。
- `?webgpu=0`：强制使用 Canvas2D 爆发粒子。
- `?webgl=0`：验证无 WebGL 降级页面。

## 质量检查

项目不依赖运行时框架，也不需要安装第三方包：

```bash
npm test
```

检查包括 JavaScript 语法、JSON、模块与资源引用、Service Worker 预缓存清单、CSP 哈希和核心数值逻辑。

## 交互

- 轻触星空：星光爆发。
- 三击星空：流星雨。
- 音乐球单击：播放或暂停；双击：下一首；长按：上一首。
- 键盘聚焦“触发流星雨”按钮后按 Enter 或空格可触发流星雨。

> 修改应用壳资源时同步提升 `sw.js` 中的 `VERSION`。新版本会在旧页面全部关闭后整体接管，避免 HTML 与模块跨版本混用。
