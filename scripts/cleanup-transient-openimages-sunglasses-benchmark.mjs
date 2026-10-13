import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'openimages-sunglasses')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'openimages-sunglasses-result.json')
const temporaryResultPath = `${resultPath}.cleanup.tmp`

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe Open Images sunglasses staging path')
await rm(stagingDir, { recursive: true, force: true })
try {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  if (result.policyVersion !== 'HEADUP-OPENIMAGES-SUNGLASSES-AUDIT-1.0') throw new Error('Unexpected Open Images sunglasses result policy')
  result.retention.imagesDeletedAfterRun = true
  await writeFile(temporaryResultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryResultPath, resultPath)
} catch (error) {
  await rm(temporaryResultPath, { force: true })
  if (error?.code !== 'ENOENT') throw error
}
process.stdout.write('Removed all transient Open Images sunglasses images and their manifest.\n')
