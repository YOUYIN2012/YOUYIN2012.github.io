import js from '@eslint/js';
import globals from 'globals';

export default [
  // 忽略目录（flat config 默认忽略 node_modules，这里显式声明意图）
  { ignores: ['node_modules/', 'coverage/', 'dist/'] },

  js.configs.recommended,
  {
    // 浏览器端 ESM 模块
    files: ['static/js/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
  },
  {
    // classic Service Worker：caches/clients 等全局由 serviceworker 集合提供
    files: ['sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  {
    // AudioWorklet 处理器：sampleRate/currentTime/registerProcessor 等由宿主注入
    files: ['static/js/audio/beat-worklet.js'],
    languageOptions: {
      globals: { ...globals.audioWorklet },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
