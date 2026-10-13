import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:5191', '/qa-family-api': {target:'http://127.0.0.1:5196',rewrite:path=>path.replace(/^\/qa-family-api/,'/api/family')} } },
  preview: { proxy: { '/api': 'http://127.0.0.1:5191' } },
  plugins: [
    react(),
    {
      name: 'headup-research-product-theme',
      transformIndexHtml: {
        order: 'post',
        handler(html, context) {
          const pages = ['research-progress.html','research-active-challenge.html','research-local-occlusion.html','research-local-retake.html','research-menton-annotation.html','research-profile-region-annotation.html','research-profile-assisted-review.html','research-profile-neck-aesthetic-rating.html','front-profile-visual-regression.html','research-profile-geometry-crosscheck.html','wikimedia-profile-regression.html','wikimedia-profile-manual-review.html','research-fei-yaw-threshold.html']
          if (!pages.includes(basename(context.filename))) return html
          const theme = readFileSync(fileURLToPath(new URL('./scripts/single-file-theme.css', import.meta.url)), 'utf8')
          const bar = '<header class="headup-product-bar"><div class="headup-product-bar__brand"><span class="headup-product-bar__mark" aria-hidden="true">H</span><span>HeadUp</span><span class="headup-product-bar__family">研究工作台</span></div><a class="headup-product-bar__home" href="/">返回主应用</a></header>'
          return html.replace(/<html([^>]*)>/i, '<html$1 class="headup-unified-root">').replace(/<body([^>]*)>/i, `<body$1 class="headup-unified-page">${bar}`).replace('</head>', `<style data-headup-unified-theme>${theme}</style></head>`)
        },
      },
    },
    VitePWA({
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
    })
  ],
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        familyShareQa: fileURLToPath(new URL('./family-share-qa.html', import.meta.url)),
        familyStorageQa: fileURLToPath(new URL('./family-storage-qa.html', import.meta.url)),
        familyCameraQa: fileURLToPath(new URL('./family-camera-qa.html', import.meta.url)),
        familyAiQa: fileURLToPath(new URL('./family-ai-qa.html', import.meta.url)),
        familyVolumeQa: fileURLToPath(new URL('./family-volume-qa.html', import.meta.url)),
        familyAccountQa: fileURLToPath(new URL('./family-account-qa.html', import.meta.url)),
        familySyncQa: fileURLToPath(new URL('./family-sync-qa.html', import.meta.url)),
        familyCompareQa: fileURLToPath(new URL('./family-compare-qa.html', import.meta.url)),
        familyAuditQa: fileURLToPath(new URL('./family-audit-qa.html', import.meta.url)),
        familyBaselineQa: fileURLToPath(new URL('./family-baseline-qa.html', import.meta.url)),
        familyPlanQa: fileURLToPath(new URL('./family-plan-qa.html', import.meta.url)),
        familyHandoffQa: fileURLToPath(new URL('./family-handoff-qa.html', import.meta.url)),
        familyHandoffResponsiveQa: fileURLToPath(new URL('./family-handoff-responsive-qa.html', import.meta.url)),
        familyResponsiveQa: fileURLToPath(new URL('./family-responsive-qa.html', import.meta.url)),
        researchProgress: fileURLToPath(new URL('./research-progress.html', import.meta.url)),
        activeChallengeStudy: fileURLToPath(new URL('./research-active-challenge.html', import.meta.url)),
        localOcclusionStudy: fileURLToPath(new URL('./research-local-occlusion.html', import.meta.url)),
        localRetakeStudy: fileURLToPath(new URL('./research-local-retake.html', import.meta.url)),
        mentonAnnotationStudy: fileURLToPath(new URL('./research-menton-annotation.html', import.meta.url)),
        profileRegionAnnotationStudy: fileURLToPath(new URL('./research-profile-region-annotation.html', import.meta.url)),
        profileRegionAssistedReview: fileURLToPath(new URL('./research-profile-assisted-review.html', import.meta.url)),
        profileNeckAestheticRating: fileURLToPath(new URL('./research-profile-neck-aesthetic-rating.html', import.meta.url)),
        frontProfileVisualRegression: fileURLToPath(new URL('./front-profile-visual-regression.html', import.meta.url)),
        profileGeometryCrosscheck: fileURLToPath(new URL('./research-profile-geometry-crosscheck.html', import.meta.url)),
        wikimediaProfileRegression: fileURLToPath(new URL('./wikimedia-profile-regression.html', import.meta.url)),
        wikimediaProfileManualReview: fileURLToPath(new URL('./wikimedia-profile-manual-review.html', import.meta.url)),
        feiYawThreshold: fileURLToPath(new URL('./research-fei-yaw-threshold.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'node'
  }
})
