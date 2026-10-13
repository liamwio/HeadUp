import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const targets = [join(stagingRoot, 'anti-spoof-mn3'), join(stagingRoot, 'physical-replay')]
for (const target of targets) {
  if (!resolve(target).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe anti-spoof cleanup path')
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}
const resultPath = join(projectDir, 'data', 'face-benchmark', 'anti-spoof-mn3-result.json')
try {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  if (result.policyVersion === 'HEADUP-ANTI-SPOOF-MN3-AUDIT-1.0') {
    result.retention.modelAndVideosRequireCleanup = false
    result.retention.modelAndVideosDeletedAfterRun = true
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
process.stdout.write('Removed transient anti-spoof model, physical replay videos and manifests.\n')
