import { defineConfig } from 'vite';

export default defineConfig({
  envDir: false,
  build: { outDir: 'dist/client' },
  server: { host: '127.0.0.1' },
});
