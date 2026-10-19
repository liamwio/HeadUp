import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { relative } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const researchInputs = () => ['tests/pages','research/pages'].flatMap(directory => readdirSync(new URL('./'+directory, import.meta.url)).filter(name => name.endsWith('.html')).map(name => fileURLToPath(new URL('./'+directory+'/'+name, import.meta.url))))

export default defineConfig(({mode}) => ({
  resolve: mode === 'research' ? {alias: {'virtual:pwa-register': fileURLToPath(new URL('./scripts/pwa-register-stub.js', import.meta.url))}} : undefined,
  server: { proxy: { '/api': 'http://127.0.0.1:5191', '/qa-family-api': {target:'http://127.0.0.1:5196',rewrite:path=>path.replace(/^\/qa-family-api/,'/api/family')} } },
  preview: { proxy: { '/api': 'http://127.0.0.1:5191' } },
  plugins: [
    react(),
    {
      name: 'headup-research-product-theme',
      transformIndexHtml: {
        order: 'post',
        handler(html, context) {
          const pages = ['research/pages/research-progress.html','research/pages/research-active-challenge.html','research/pages/research-local-occlusion.html','research/pages/research-local-retake.html','research/pages/research-menton-annotation.html','research/pages/research-profile-region-annotation.html','research/pages/research-profile-assisted-review.html','research/pages/research-profile-neck-aesthetic-rating.html','research/pages/front-profile-visual-regression.html','research/pages/research-profile-geometry-crosscheck.html','research/pages/wikimedia-profile-regression.html','research/pages/wikimedia-profile-manual-review.html','research/pages/research-fei-yaw-threshold.html']
          if (!pages.includes(relative(root,context.filename).replaceAll('\\','/'))) return html
          const theme = readFileSync(fileURLToPath(new URL('./scripts/single-file-theme.css', import.meta.url)), 'utf8')
          const bar = '<header class="headup-product-bar"><div class="headup-product-bar__brand"><span class="headup-product-bar__mark" aria-hidden="true">H</span><span>HeadUp</span><span class="headup-product-bar__family">研究工作台</span></div><a class="headup-product-bar__home" href="/">返回主应用</a></header>'
          return html.replace(/<html([^>]*)>/i, '<html$1 class="headup-unified-root">').replace(/<body([^>]*)>/i, `<body$1 class="headup-unified-page">${bar}`).replace('</head>', `<style data-headup-unified-theme>${theme}</style></head>`)
        },
      },
    },
    ...(mode === 'research' ? [] : [VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        globIgnores: ['**/mediapipe/**', '**/onnxruntime/**', '**/models/**'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/mediapipe/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'headup-mediapipe-v1',
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/models/') || url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'headup-local-models-v2',
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      manifest: {
        name: 'HeadUp 颅面外观分析',
        short_name: 'HeadUp',
        description: '隐私优先的颅面外观结构测量与趋势记录工具',
        theme_color: '#7c2330',
        background_color: '#fff8f5',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      }
    })])
  ],
  build: {
    outDir: mode === 'research' ? 'dist-research' : 'dist',
    rollupOptions: {input: mode === 'research' ? [fileURLToPath(new URL('./index.html', import.meta.url)),...researchInputs()] : fileURLToPath(new URL('./index.html', import.meta.url))},
  },
  test: {
    environment: 'node'
  }
}))
