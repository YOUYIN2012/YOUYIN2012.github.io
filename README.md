# 爱意随风起



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
