# 爱意随风起

一片用代码写就的静谧星河。

单屏、无文字、冷色调。技术与克制并存：画面只有夜空、月亮、稀疏的星与一个音乐球，复杂度全部藏在渲染管线里。

## 体验

- **着色器天空**：WebGL2 片元着色器实时渲染——FBM 极光带、单层像素级 crisp 星野、抗锯齿月亮、低频流星，按本地时间自动切换四套冷色调色板
- **交互**：轻触屏幕有星光回应（WebGPU 计算着色器粒子，自动回落 Canvas 2D）；三连击空旷处降下一场流星雨
- **音乐球**：轻触播放/暂停 · 双击下一首 · 长按上一首；环形频谱可视化随节拍呼吸，音频能量同时驱动极光与月晕；支持锁屏/通知栏媒体控制与屏幕常亮
- **视差**：桌面指针 / 移动端陀螺仪轻微视差

## 技术

零依赖、零构建，直接静态分发。

| 层 | 技术 |
| --- | --- |
| 天空 | WebGL2 · GLSL（FBM / SDF / 域扭曲） |
| 粒子 | WebGPU Compute（WGSL 存储缓冲 + instanced quad + 片元 SDF）→ Canvas 2D 回退 |
| 音频 | Web Audio（AnalyserNode / GainNode 交叉淡出）· Media Session · Wake Lock |
| 平台 | Pointer Events · DeviceOrientation · Vibration · PWA / Service Worker 离线 |
| 性能 | FPS 看门狗分级画质（先降 octave，再降分辨率）· 空闲音频采样休眠 · 移动交互层 30fps · 页面隐藏全停 · `prefers-reduced-motion` 4fps 低频补帧 · DPR 上限 2 |

## 结构

```
index.html          单屏入口
favicon.svg / manifest.webmanifest / sw.js
static/css/main.css 唯一样式（@layer 分层）
static/js/
  main.js           总编排
  utils.js          工具 + FPS 看门狗
  fx/sky.js         WebGL2 天空
  fx/layer.js       Canvas 2D 交互层（星尘/爆发/光环/流星）
  fx/webgpu-burst.js WebGPU 粒子
  audio/engine.js   音频引擎
  ui/viz.js         音乐球可视化
static/music/       曲目
```

---

*愿时光温柔，愿你被爱。*
