import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = process.argv[2] ? resolve(process.argv[2]) : null

if (!inputPath) {
  throw new Error('Usage: node scripts/import-index-redesign.mjs <redesigned-single-file.html>')
}

const html = await readFile(inputPath, 'utf8')
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1])

if (styles.length < 2 || !styles[1].includes('--ink:#4b1f28')) {
  throw new Error('The supplied HTML does not contain the expected HeadUp burgundy redesign layer.')
}

const dataImages = [...html.matchAll(/data:image\/([^;]+);base64,([A-Za-z0-9+/=]+)/g)]
if (dataImages.length === 0) {
  throw new Error('The supplied redesign does not contain its required portrait asset.')
}

const [firstImage] = dataImages
const extension = firstImage[1] === 'jpeg' ? 'jpg' : firstImage[1]
const assetName = `headup-front-profile-hero.${extension}`
const assetPath = resolve(projectDir, 'public', 'assets', assetName)
await mkdir(dirname(assetPath), { recursive: true })
await writeFile(assetPath, Buffer.from(firstImage[2], 'base64'))

const redesignCss = styles.slice(1).join('\n\n')
  .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, `/assets/${assetName}`)
  .replace(/^\s+/, '')

const banner = `/*\n * HeadUp main-app redesign imported from ${basename(inputPath)}.\n * Source logic remains in App.tsx; this file contains the selected visual layer only.\n */\n\n`
await writeFile(resolve(projectDir, 'src', 'redesign.css'), banner + redesignCss, 'utf8')

console.log(`Imported ${styles.length - 1} redesign style layers.`)
console.log(`CSS: src/redesign.css (${Math.round(redesignCss.length / 1024)} KiB)`)
console.log(`Asset: public/assets/${assetName} (${Math.round(Buffer.from(firstImage[2], 'base64').length / 1024)} KiB)`)
