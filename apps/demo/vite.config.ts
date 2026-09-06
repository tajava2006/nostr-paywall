import { defineConfig } from 'vite';

// nsite(NIP-5A) 배포용 — 경로를 상대로 두고 산출물을 한 디렉토리에 모은다.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', assetsDir: 'assets', target: 'es2022' },
});
