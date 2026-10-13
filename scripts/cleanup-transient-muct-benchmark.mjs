import { rm, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'muct')
const inspectionDir = join(stagingRoot, 'muct-inspect')
if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe MUCT staging path')
if (!resolve(inspectionDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe MUCT inspection path')
await rm(stagingDir, { recursive: true, force: true })
await rm(inspectionDir, { recursive: true, force: true })
const pdfTempDir = join(projectDir, 'tmp', 'pdfs')
for (const filename of [
  'muct-landmarked-face-database.pdf', 'muct.txt', 'muct-page1.png', 'muct-page1-hi.png', 'muct-page2.png',
]) {
  await rm(join(pdfTempDir, filename), { force: true })
}
try { await rmdir(pdfTempDir) } catch { /* preserve unrelated PDF intermediates */ }
process.stdout.write('Removed transient MUCT images and manifest.\n')
