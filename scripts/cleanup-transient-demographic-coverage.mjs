import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'demographic-coverage')
const resultPaths = ['demographic-coverage-result.json', 'exposure-external-result.json', 'exposure-highlight-calibration-result.json'].map((name) => join(benchmarkDir, name))
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}${sep}`)) throw new Error('Unsafe demographic cleanup path')
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
process.stdout.write('Removed transient FFHQ-Aging images, labels, metadata, and manifest.\n')
