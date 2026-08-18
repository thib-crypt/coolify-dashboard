import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.join(root, 'shared'),
    },
  },
  server: {
    port: 5180,
    open: false,
    proxy: {
      '/app': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
