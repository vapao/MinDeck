import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// 端口：前端 5180，后端 8004，Tailscale HTTPS 8450
// 代理跟随 AGENTDECK_PORT，否则改了后端端口的本地开发会静默连到生产 Hub
const hub = `127.0.0.1:${process.env.AGENTDECK_PORT ?? 8004}`
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'AgentDeck',
        short_name: 'AgentDeck',
        description: 'Multi-device console for Claude / Codex',
        lang: 'zh-CN',
        display: 'standalone',
        display_override: ['window-controls-overlay'],
        background_color: '#111214',
        theme_color: '#141518',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // 只预缓存静态壳；API / WS / 附件永远回源，会话数据以 Hub 的事件流为准
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  server: {
    port: 5180,
    strictPort: true,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': `http://${hub}`,
      '/ws': { target: `ws://${hub}`, ws: true },
    },
  },
})
