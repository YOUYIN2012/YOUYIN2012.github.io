# Forever 💖

一个简约的爱情表达网页，使用现代Web技术构建。

## ✨ 特性

- **极简设计** - 仅包含少量视觉元素，无文字干扰
- **现代技术栈** - ES6+ JavaScript, CSS Grid/Flexbox, Web Audio API
- **响应式设计** - 完美适配桌面、平板和手机
- **性能优化** - 懒加载、内存管理、动画优化
- **无障碍支持** - ARIA标签、键盘导航、高对比度模式
- **优雅降级** - 在旧浏览器中仍能正常工作

## 🎨 视觉元素

- 中心跳动心形 - 使用CSS渐变和动画
- 装饰点阵 - 闪烁动画效果
- 背景装饰 - 动态浮动元素
- 音频控制 - SVG图标按钮

## 🛠 技术栈

### 前端框架
- **HTML5** - 语义化结构
- **CSS3** - 自定义属性、Flexbox、Grid、动画
- **ES6+ JavaScript** - 模块化、类、异步函数

### 性能优化
- **Intersection Observer** - 懒加载和视口检测
- **RequestAnimationFrame** - 流畅动画
- **Web Audio API** - 音频管理
- **Service Worker** - 离线缓存 (可选)

### 响应式设计
- **移动优先** - 从小屏幕开始设计
- **断点系统** - 480px, 768px, 1024px
- **触摸优化** - 触摸事件和手势支持

## 📱 浏览器支持

- Chrome 70+
- Firefox 65+
- Safari 12+
- Edge 79+

## 🚀 快速开始

1. 克隆项目
```bash
git clone <repository-url>
cd forever
```

2. 启动本地服务器
```bash
python -m http.server 8000
```

3. 在浏览器中打开 `http://localhost:8000`

## 📁 项目结构

```
forever/
├── index.html          # 主页面
├── static/
│   ├── css/
│   │   └── style.css   # 样式文件
│   ├── js/
│   │   └── main.js     # 主脚本
│   └── music/
│       └── 苏打绿再遇见_audio_only.mp3  # 背景音乐
└── README.md           # 项目说明
```

## 🎵 音频控制

点击右下角的音频按钮来控制背景音乐播放/暂停。

## 🎯 交互功能

- **心形点击** - 双击触发涟漪效果
- **触摸支持** - 在移动设备上支持触摸交互
- **音频控制** - 优雅的播放/暂停切换

## 🔧 自定义配置

### 颜色主题
在 `static/css/style.css` 中修改CSS自定义属性：

```css
:root {
    --primary-color: #ff6b9d;    /* 主色调 */
    --secondary-color: #ffd89b;  /* 辅助色 */
    --background-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
```

### 音频文件
替换 `static/music/` 目录下的音频文件。

## 📊 性能指标

- **首次内容绘制 (FCP)**: < 1.5s
- **最大内容绘制 (LCP)**: < 2.5s
- **首次输入延迟 (FID)**: < 100ms
- **累积布局偏移 (CLS)**: < 0.1

## 🌟 最佳实践

- 使用现代CSS特性 (Grid, Flexbox, Custom Properties)
- 实现性能监控和错误处理
- 支持无障碍访问
- 优雅降级到基础功能
- 移动优先的响应式设计

## 📄 许可证

MIT License

---

*"Love is not about how many days, but how much you love each day."*
