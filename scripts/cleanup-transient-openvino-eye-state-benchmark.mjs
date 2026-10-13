import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'cew-eye-closure-highres')
const resultPath = join(benchmarkDir, 'openvino-eye-state-result.json')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe eye-state staging path')
await access(resultPath)
const result = JSON.parse(await readFile(resultPath, 'utf8'))
if (result.policyVersion !== 'HEADUP-OPENVINO-EYE-STATE-AUDIT-1.0') throw new Error('Unexpected eye-state result policy')
await rm(stagingDir, { recursive: true, force: true })
result.retention = {
  imagesDeletedAfterRun: true, archivesDeleted: true, transientModelDeleted: true,
  sourceImageIdsRetained: false, sourceUrlsRetained: false, sourceNamesRetained: false,
  individualPredictionsRetained: false, aggregateOnly: true,
}
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write('Removed transient CEW/LFW images and eye-state model; retained aggregate-only result.\n')
