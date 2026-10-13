import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'cew-eye-closure')
const resultPath = join(benchmarkDir, 'cew-eye-closure-result.json')

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe CEW staging path')
await access(resultPath)
const result = JSON.parse(await readFile(resultPath, 'utf8'))
if (result.policyVersion !== 'HEADUP-CEW-EYE-CLOSURE-AUDIT-1.0') throw new Error('Unexpected CEW result policy')
await rm(stagingDir, { recursive: true, force: true })
result.retention = {
  imagesDeletedAfterRun: true,
  archiveDeleted: true,
  sourceImageIdsRetained: false,
  sourceUrlsRetained: false,
  sourceNamesRetained: false,
  individualPredictionsRetained: false,
  aggregateOnly: true,
}
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write('Removed transient CEW images and manifest; retained aggregate-only result.\n')
