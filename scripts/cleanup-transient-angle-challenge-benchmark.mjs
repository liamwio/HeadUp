import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'angle-challenge')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'angle-challenge-result.json')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe angle-challenge cleanup path')
await rm(stagingDir, { recursive: true, force: true })
try {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  if (result.policyVersion === 'HEADUP-ANGLE-CHALLENGE-AUDIT-1.0' && result.retention) {
    result.retention.imagesDeletedAfterRun = true
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
process.stdout.write('Removed all transient Pointing04 portraits, archive metadata and subject mappings for the angle-challenge audit.\n')
