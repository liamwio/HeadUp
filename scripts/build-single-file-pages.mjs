import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from '../tools/vendor/vite-plugin-singlefile/dist/esm/index.js'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { singleFilePages as pages } from './single-file-pages-manifest.mjs'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(projectDir, 'single-file-pages')
const workDir = join(projectDir, '.tmp', 'single-file-build')
const themeCss = await readFile(join(projectDir, 'scripts', 'single-file-theme.css'), 'utf8')

const familyNames = {
  'research/pages/research-progress.html': 'RESEARCH EVIDENCE DASHBOARD',
  'research/pages/front-profile-visual-regression.html': 'VISUAL REGRESSION GALLERY',
  'research/pages/wikimedia-profile-regression.html': 'PROFILE VALIDATION',
  'research/pages/wikimedia-profile-manual-review.html': 'MANUAL PROFILE REVIEW',
}

async function listFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(fullPath))
    else result.push(fullPath)
  }
  return result
}

function decorateResearchPage(html, page) {
  const family = familyNames[page] || (page.includes('annotation') || page.includes('assisted') || page.includes('rating') ? 'RESEARCH ANNOTATION WORKBENCH' : 'LOCAL RESEARCH TOOL')
  const productBar = `<header class="headup-product-bar"><div class="headup-product-bar__brand"><span class="headup-product-bar__mark" aria-hidden="true">H</span><span>HeadUp</span><span class="headup-product-bar__family">${family}</span></div><a class="headup-product-bar__home" href="/index.html">返回主应用</a></header>`
  let result = html.replace(/<html([^>]*)>/i, (_match, attrs) => `<html${attrs} class="headup-unified-root">`)
  result = result.replace(/<body([^>]*)>/i, (_match, attrs) => `<body${attrs} class="headup-unified-page">${productBar}`)
  result = result.replace('</head>', `<style data-headup-unified-theme>${themeCss}</style></head>`)
  return result
}

await rm(workDir, { recursive: true, force: true })
await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

for (const page of pages) {
  const pageWorkDir = join(workDir, page.replace(/\.html$/, ''))
  await build({
    configFile: false,
    root: projectDir,
    publicDir: false,
    base: './',
    logLevel: 'warn',
    resolve: {
      alias: {
        'virtual:pwa-register': join(projectDir, 'scripts', 'pwa-register-stub.js'),
      },
    },
    plugins: [
      react(),
      viteSingleFile({ useRecommendedBuildConfig: false, removeViteModuleLoader: true }),
    ],
    build: {
      outDir: pageWorkDir,
      emptyOutDir: true,
      copyPublicDir: false,
      cssCodeSplit: false,
      assetsDir: 'assets',
      chunkSizeWarningLimit: 100000,
      rollupOptions: {
        input: join(projectDir, page),
        output: { codeSplitting: false },
      },
    },
  })

  const builtFiles = await listFiles(pageWorkDir)
  const builtHtml = builtFiles.find((file) => file.toLowerCase().endsWith('.html'))
  if (!builtHtml) throw new Error(`No HTML output found for ${page}`)

  let html = await readFile(builtHtml, 'utf8')
  if (page !== 'index.html') html = decorateResearchPage(html, page)
  await mkdir(dirname(join(outputDir, page)), { recursive: true })
  await writeFile(join(outputDir, page), html, 'utf8')

  for (const asset of builtFiles.filter((file) => !file.toLowerCase().endsWith('.html'))) {
    const destination = join(outputDir, relative(pageWorkDir, asset))
    await mkdir(dirname(destination), { recursive: true })
    await cp(asset, destination, { force: true })
    // Inlined ESM resolves `new URL(wasm, import.meta.url)` against the HTML URL.
    // Keep one root-level copy so ONNX Runtime can load it from every page shell.
    if (asset.toLowerCase().endsWith('.wasm')) {
      await cp(asset, join(dirname(join(outputDir, page)), basename(asset)), { force: true })
    }
  }
  const kb = Math.round((await stat(join(outputDir, page))).size / 1024)
  console.log(`built ${page} (${kb.toLocaleString()} KiB)`)
}

for (const directory of ['assets', 'mediapipe', 'models']) {
  await cp(join(projectDir, 'public', directory), join(outputDir, directory), { recursive: true, force: true })
}
await cp(join(projectDir, 'public', 'favicon.svg'), join(outputDir, 'favicon.svg'), { force: true })
await rm(workDir, { recursive: true, force: true })

console.log(`\n${pages.length} single-file page shells written to ${outputDir}`)
