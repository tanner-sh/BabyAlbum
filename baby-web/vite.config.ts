import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发时把 API 请求转给本地的 baby-server
    proxy: { '/api': 'http://localhost:3000' },
  },
});
