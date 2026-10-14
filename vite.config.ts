import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: Number(env.WEB_PORT ?? 4173),
      strictPort: true,
      proxy: {
        '/auth': { target: `http://127.0.0.1:${env.API_PORT ?? 4174}`, changeOrigin: false },
        '/health': { target: `http://127.0.0.1:${env.API_PORT ?? 4174}`, changeOrigin: false },
      },
    },
    build: { outDir: 'dist/web', emptyOutDir: true },
  };
});
