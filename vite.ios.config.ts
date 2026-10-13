import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins:[react(),{name:'headup-ios-entry',transformIndexHtml:{order:'pre',handler:html=>html.replace('/src/main.tsx','/src/ios/main.tsx')},resolveId:id=>id==='virtual:pwa-register'?'\0ios-native-updates':undefined,load:id=>id==='\0ios-native-updates'?'export const registerSW=()=>async()=>{}':undefined}],
  build:{outDir:'dist-ios',emptyOutDir:true},
})
