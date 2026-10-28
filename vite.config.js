import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // NO_HMR=1：给截图/导出用的第二个预览服务，别的进程改文件时不会把无头浏览器整页刷新
  server: { fs: { allow: ['.'] }, hmr: process.env.NO_HMR ? false : undefined },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
});
