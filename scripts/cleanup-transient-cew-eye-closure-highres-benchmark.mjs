import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'cew-eye-closure-highres')
const resultPath = join(benchmarkDir, 'cew-eye-closure-highres-result.json')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe high-resolution CEW staging path')
await access(resultPath)
const result = JSON.parse(await readFile(resultPath, 'utf8'))
if (result.policyVersion !== 'HEADUP-CEW-EYE-CLOSURE-HIGHRES-AUDIT-1.0') throw new Error('Unexpected high-resolution CEW result policy')
await rm(stagingDir, { recursive: true, force: true })
result.retention = {
  imagesDeletedAfterRun: true, archivesDeleted: true,
  sourceImageIdsRetained: false, sourceUrlsRetained: false, sourceNamesRetained: false,
  individualPredictionsRetained: false, aggregateOnly: true,
}
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write('Removed transient high-resolution CEW/LFW images and manifest; retained aggregate-only result.\n')
