import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'fairface')
const resultPaths = ['exposure-fairface-result.json', 'lowlight-fairface-result.json'].map((name) => join(projectDir, 'data', 'face-benchmark', name))
if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe FairFace staging path')
await rm(stagingDir, { recursive: true, force: true })
for (const resultPath of resultPaths) {
  try {
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    result.retention.imagesDeletedAfterRun = true
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
process.stdout.write('Removed transient FairFace images and manifest.\n')
