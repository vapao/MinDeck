import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

// 端口：前端 5180，后端 8004，Tailscale HTTPS 8450
// 代理跟随 MINDECK_PORT，否则改了后端端口的本地开发会静默连到生产 Hub
const hub = `127.0.0.1:${process.env.MINDECK_PORT ?? 8004}`
const release = JSON.parse(readFileSync(new URL('../../scripts/release-config.json', import.meta.url), 'utf8'))
const repository = process.env.MINDECK_REPOSITORY ?? release.repository
export default defineConfig({
  define: {
    'import.meta.env.VITE_HELPER_INSTALL_URL': JSON.stringify(/^[\w.-]+\/[\w.-]+$/.test(repository)
      ? `https://github.com/${repository}/releases/latest/download/install-helper.sh` : ''),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'MinDeck',
        short_name: 'MinDeck',
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
