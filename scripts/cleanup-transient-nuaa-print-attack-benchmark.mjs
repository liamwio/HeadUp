import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'nuaa-print-attack')
const probeZipPath = join(stagingRoot, 'nuaa-probe.zip')
const probeMetaPath = join(stagingRoot, 'nuaa-probe-meta')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'nuaa-print-attack-result.json')
for (const target of [stagingDir, probeZipPath, probeMetaPath]) {
  if (!resolve(target).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe NUAA cleanup path')
  await rm(target, { recursive: true, force: true })
}
try {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  if (result.policyVersion === 'HEADUP-NUAA-PRINT-AUDIT-1.0' && result.retention) {
    result.retention.sourceImagesDeletedAfterRun = true
    result.retention.modelDeletedAfterRun = true
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
process.stdout.write('Removed NUAA archive, all selected real/print portraits, source mappings, and transient anti-spoof model.\n')
