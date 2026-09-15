import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 3100,
    proxy: {
      '/api': 'http://127.0.0.1:8091',
    },
  },
  build: {
    sourcemap: true,
  },
});
