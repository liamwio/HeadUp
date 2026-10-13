import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { singleFilePages as pages } from './single-file-pages-manifest.mjs'

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputDir = join(projectDir, 'single-file-pages')
let failures = 0

for (const page of pages) {
  const path = join(outputDir, page)
  const html = await readFile(path, 'utf8')
  const externalScripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>/gi)]
  const externalStyles = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)]
  const hasInlineStyle = /<style\b[^>]*>[\s\S]*?<\/style>/i.test(html)
  const hasInlineScript = /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]+?<\/script>/i.test(html)
  const needsScript = page !== 'research-progress.html'
  const valid = externalScripts.length === 0 && externalStyles.length === 0 && hasInlineStyle && (!needsScript || hasInlineScript)
  if (!valid) failures += 1
  const size = (await stat(path)).size
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 12)
  console.log(`${valid ? 'PASS' : 'FAIL'} ${page.padEnd(48)} ${(size / 1024).toFixed(1).padStart(9)} KiB  sha256:${hash}`)
}

if (failures) {
  console.error(`\n${failures} page(s) failed the single-file shell gate.`)
  process.exitCode = 1
} else {
  console.log(`\nPASS: ${pages.length}/${pages.length} pages contain inline UI code with no external JS/CSS references.`)
}
