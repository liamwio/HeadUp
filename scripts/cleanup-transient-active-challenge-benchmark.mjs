import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const targets = [join(stagingRoot, 'active-challenge'), join(stagingRoot, 'physical-replay')]
const resultPath = join(projectDir, 'data', 'face-benchmark', 'active-challenge-replay-result.json')
for (const target of targets) {
  if (!resolve(target).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe active-challenge cleanup path')
  await rm(target, { recursive: true, force: true })
}
try {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  if (result.policyVersion === 'HEADUP-ACTIVE-CHALLENGE-AUDIT-1.0' && result.retention) {
    result.retention.replayVideosDeletedAfterRun = true
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
process.stdout.write('Removed active-challenge manifest and all transient physical replay videos. Authorized London source images were not changed.\n')
