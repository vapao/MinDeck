import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 端口分配见 ~/Workspace/mac-mini-tailscale-web-ports.md：前端 5180，后端 8004，Tailscale HTTPS 8450
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': 'http://127.0.0.1:8004',
      '/ws': { target: 'ws://127.0.0.1:8004', ws: true },
    },
  },
})
