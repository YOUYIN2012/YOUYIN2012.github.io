/**
 * 技术栈: ES6+, Web Audio API, Intersection Observer, CSS Grid/Flexbox
 */

// ===== 工具函数 =====
const random = (min, max) => Math.random() * (max - min) + min;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// ===== 性能监控 =====
class PerformanceMonitor {
    static measure(name, fn) {
        const start = performance.now();
        const result = fn();
        const end = performance.now();
        console.log(`${name} took ${end - start}ms`);
        return result;
    }
}

// ===== 音频管理器 =====
class AudioManager {
    constructor(audioElementId) {
        this.audio = document.getElementById(audioElementId);
        this.isPlaying = false;
        this.isLoaded = false;
        this.init();
    }

    init() {
        // 延迟加载音频以提高页面加载性能
        this.audio.addEventListener('loadeddata', () => {
            this.isLoaded = true;
        });

        // 处理音频播放错误
        this.audio.addEventListener('error', (e) => {
            console.warn('Audio loading failed:', e);
        });
    }

    async toggle() {
        try {
            if (!this.isLoaded) {
                await this.load();
            }

            if (this.isPlaying) {
                await this.pause();
            } else {
                await this.play();
            }
        } catch (error) {
            console.error('Audio toggle failed:', error);
        }
    }

    async load() {
        if (!this.isLoaded) {
            this.audio.load();
            await new Promise((resolve, reject) => {
                const onLoad = () => {
                    this.audio.removeEventListener('loadeddata', onLoad);
                    this.audio.removeEventListener('error', onError);
                    resolve();
                };
                const onError = (e) => {
                    this.audio.removeEventListener('loadeddata', onLoad);
                    this.audio.removeEventListener('error', onError);
                    reject(e);
                };
                this.audio.addEventListener('loadeddata', onLoad);
                this.audio.addEventListener('error', onError);
            });
            this.isLoaded = true;
        }
    }

    async play() {
        await this.audio.play();
        this.isPlaying = true;
        this.updateUI();
    }

    async pause() {
        this.audio.pause();
        this.isPlaying = false;
        this.updateUI();
    }

    updateUI() {
        const toggleBtn = document.getElementById('audioToggle');
        if (toggleBtn) {
            toggleBtn.classList.toggle('playing', this.isPlaying);
        }
    }
}

// ===== 背景装饰系统 =====
class BackgroundDecoration {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.stars = [];
        this.meteors = [];
        this.init();
    }

    init() {
        if (!this.container) return;

        // 创建星星
        for (let i = 0; i < 150; i++) {
            this.createStar();
        }

        // 创建流星
        for (let i = 0; i < 3; i++) {
            this.createMeteor();
        }

        // 开始闪烁动画
        this.startTwinkling();
        // 开始流星动画
        this.startMeteorShower();
    }

    createStar() {
        const star = document.createElement('div');
        star.className = 'star';
        star.style.cssText = `
            position: absolute;
            left: ${Math.random() * 100}%;
            top: ${Math.random() * 100}%;
            width: ${Math.random() * 3 + 1}px;
            height: ${Math.random() * 3 + 1}px;
            background: #ffffff;
            border-radius: 50%;
            pointer-events: none;
            box-shadow: 0 0 ${Math.random() * 10 + 5}px rgba(255, 255, 255, 0.8);
        `;

        this.stars.push(star);
        this.container.appendChild(star);
    }

    createMeteor() {
        const meteor = document.createElement('div');
        meteor.className = 'meteor';
        meteor.style.cssText = `
            position: absolute;
            left: ${Math.random() * 120 - 20}%;
            top: ${Math.random() * 50}%;
            width: 2px;
            height: 2px;
            background: linear-gradient(45deg, #ffffff, transparent);
            border-radius: 50%;
            pointer-events: none;
            opacity: 0;
        `;

        this.meteors.push(meteor);
        this.container.appendChild(meteor);
    }

    startTwinkling() {
        this.stars.forEach((star, index) => {
            // 为每个星星设置不同的闪烁动画
            star.style.animation = `twinkle ${Math.random() * 4 + 2}s ease-in-out infinite`;
            star.style.animationDelay = `${Math.random() * 5}s`;
        });
    }

    startMeteorShower() {
        this.meteors.forEach((meteor, index) => {
            setTimeout(() => {
                this.animateMeteor(meteor);
            }, index * 8000 + Math.random() * 5000); // 每8-13秒发射一颗流星
        });
    }

    animateMeteor(meteor) {
        // 重置流星位置
        meteor.style.left = `${Math.random() * 120 - 20}%`;
        meteor.style.top = `${Math.random() * 30}%`;
        meteor.style.opacity = '0';

        // 开始动画
        setTimeout(() => {
            meteor.style.transition = 'all 2s linear';
            meteor.style.opacity = '1';
            meteor.style.left = `${parseFloat(meteor.style.left) + 30}%`;
            meteor.style.top = `${parseFloat(meteor.style.top) + 40}%`;
            meteor.style.width = '200px';
            meteor.style.height = '1px';
            meteor.style.background = 'linear-gradient(45deg, rgba(255,255,255,0.8), transparent)';
            meteor.style.boxShadow = '0 0 20px rgba(255,255,255,0.6)';

            // 动画结束后重置
            setTimeout(() => {
                meteor.style.transition = 'none';
                meteor.style.width = '2px';
                meteor.style.height = '2px';
                meteor.style.boxShadow = 'none';
                meteor.style.opacity = '0';
            }, 2000);
        }, 100);

        // 循环动画
        setTimeout(() => {
            this.animateMeteor(meteor);
        }, 10000 + Math.random() * 5000);
    }
}

// ===== 时间背景管理器 =====
class TimeBasedBackground {
    constructor() {
        this.updateInterval = null;
        this.init();
    }

    init() {
        this.updateBackground();
        // 每分钟更新一次背景
        this.updateInterval = setInterval(() => {
            this.updateBackground();
        }, 60000);

        // 页面可见性变化时更新
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.updateBackground();
            }
        });
    }

    updateBackground() {
        const now = new Date();
        const hour = now.getHours();
        const timeOfDay = this.getTimeOfDay(hour);

        const gradient = this.getGradientForTime(timeOfDay, hour);
        document.body.style.background = gradient;
    }

    getTimeOfDay(hour) {
        if (hour >= 5 && hour < 12) return 'morning';
        if (hour >= 12 && hour < 17) return 'afternoon';
        if (hour >= 17 && hour < 21) return 'evening';
        return 'night';
    }

    getGradientForTime(timeOfDay, hour) {
        switch (timeOfDay) {
            case 'morning':
                // 早晨：浅蓝色星空
                return `linear-gradient(180deg,
                    #1e3c72 0%,
                    #2a5298 25%,
                    #3a7bd5 50%,
                    #00d2d3 75%,
                    #54a0ff 100%)`;

            case 'afternoon':
                // 下午：深蓝色星空
                return `linear-gradient(180deg,
                    #0c0c0c 0%,
                    #1a1a2e 25%,
                    #16213e 50%,
                    #0f3460 75%,
                    #1a1a2e 100%)`;

            case 'evening':
                // 傍晚：紫色星空
                return `linear-gradient(180deg,
                    #2c1810 0%,
                    #4a0e4e 25%,
                    #642b73 50%,
                    #8b5cf6 75%,
                    #4c1d95 100%)`;

            case 'night':
                // 夜晚：深紫色星空
                return `linear-gradient(180deg,
                    #0f0f23 0%,
                    #1a1a2e 25%,
                    #16213e 50%,
                    #0f3460 75%,
                    #000000 100%)`;

            default:
                return `linear-gradient(180deg, #0c0c0c 0%, #1a1a2e 25%, #16213e 50%, #0f3460 75%, #1a1a2e 100%)`;
        }
    }

    destroy() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
    }
}

// ===== 响应式管理器 =====
class ResponsiveManager {
    constructor() {
        this.breakpoints = {
            mobile: 480,
            tablet: 768,
            desktop: 1024
        };
        this.currentBreakpoint = this.getCurrentBreakpoint();
        this.init();
    }

    init() {
        window.addEventListener('resize', () => {
            const newBreakpoint = this.getCurrentBreakpoint();
            if (newBreakpoint !== this.currentBreakpoint) {
                this.currentBreakpoint = newBreakpoint;
                this.handleBreakpointChange(newBreakpoint);
            }
        });
    }

    getCurrentBreakpoint() {
        const width = window.innerWidth;
        if (width <= this.breakpoints.mobile) return 'mobile';
        if (width <= this.breakpoints.tablet) return 'tablet';
        return 'desktop';
    }

    handleBreakpointChange(breakpoint) {
        console.log(`Breakpoint changed to: ${breakpoint}`);
        // 可以在这里添加断点变化时的处理逻辑
    }
}

// ===== 主应用类 =====
class LoveApp {
    constructor() {
        this.audioManager = null;
        this.backgroundDecoration = null;
        this.timeBasedBackground = null;
        this.responsiveManager = null;
        this.init();
    }

    init() {
        PerformanceMonitor.measure('App Initialization', () => {
            this.setupAudio();
            this.setupDecorations();
            this.setupInteractions();
            this.setupResponsive();
            this.setupPerformanceOptimizations();
        });
    }

    setupAudio() {
        this.audioManager = new AudioManager('bgMusic');

        const audioToggle = document.getElementById('audioToggle');
        if (audioToggle) {
            audioToggle.addEventListener('click', () => {
                this.audioManager.toggle();
            });
        }
    }

    setupDecorations() {
        this.backgroundDecoration = new BackgroundDecoration('backgroundDecoration');
        this.timeBasedBackground = new TimeBasedBackground();
    }

    setupInteractions() {
        // 交互功能已移除，保持简洁设计
    }

    setupResponsive() {
        this.responsiveManager = new ResponsiveManager();
    }

    setupPerformanceOptimizations() {
        // 页面可见性API - 当页面不可见时暂停动画
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // 页面不可见时可以暂停一些动画
                console.log('Page hidden - can pause animations');
            } else {
                // 页面重新可见
                console.log('Page visible - resume animations');
            }
        });

        // 内存管理 - 清理事件监听器
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }

    cleanup() {
        // 清理资源
        if (this.audioManager) {
            this.audioManager.pause();
        }
    }
}

// ===== 应用启动 =====
document.addEventListener('DOMContentLoaded', () => {
    // 检查浏览器支持
    if (!('IntersectionObserver' in window) ||
        !('requestAnimationFrame' in window)) {
        console.warn('Some modern features may not be supported in this browser');
    }

    // 启动应用
    new LoveApp();
});

// ===== CSS 动画支持 =====
const style = document.createElement('style');
style.textContent = `
    @keyframes ripple {
        0% {
            transform: scale(0);
            opacity: 1;
        }
        100% {
            transform: scale(4);
            opacity: 0;
        }
    }

    .bg-element {
        will-change: transform;
        
    }
`;
document.head.appendChild(style);

