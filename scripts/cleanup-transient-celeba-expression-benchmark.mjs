import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'celeba-expression')
const v2 = process.argv.includes('--v2')
const resultPath = join(benchmarkDir, v2 ? 'celeba-expression-v2-result.json' : 'celeba-expression-result.json')

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe CelebA expression staging path')
await access(resultPath)
const result = JSON.parse(await readFile(resultPath, 'utf8'))
const expectedPolicy = v2 ? 'HEADUP-CELEBA-EXPRESSION-AUDIT-2.0' : 'HEADUP-CELEBA-EXPRESSION-AUDIT-1.0'
if (result.policyVersion !== expectedPolicy) throw new Error('Unexpected CelebA expression result policy')
await rm(stagingDir, { recursive: true, force: true })
result.retention = {
  imagesDeletedAfterRun: true,
  sourceImageIdsRetained: false,
  sourceUrlsRetained: false,
  sourceNamesRetained: false,
  individualPredictionsRetained: false,
  aggregateOnly: true,
}
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write('Removed transient CelebA expression images and manifest; retained aggregate-only result.\n')
