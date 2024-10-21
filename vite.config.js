import { defineConfig } from 'vite'
import react from'@vitejs/plugin-react'

export default defineConfig({
  base: '/LegitScriptEditor/',
  build: {
    outDir: 'dist/prod',
    assetsDir: 'assets',
    minify: 'terser',
    rollupOptions: {
    }
  },
  plugins: [react()],
});
