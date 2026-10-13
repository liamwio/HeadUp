import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins:[react(),{name:'headup-android-entry',transformIndexHtml:{order:'pre',handler:html=>html.replace('/src/main.tsx','/src/android/main.tsx')},resolveId:id=>id==='virtual:pwa-register'?'\0android-apk-updates':undefined,load:id=>id==='\0android-apk-updates'?'export const registerSW=()=>async()=>{}':undefined}],
  build:{outDir:'dist-android',emptyOutDir:true},
})
