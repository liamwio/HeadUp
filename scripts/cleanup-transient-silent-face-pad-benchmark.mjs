import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const targets = [join(stagingRoot, 'silent-face-pad'), join(stagingRoot, 'physical-replay')]
for (const target of targets) {
  if (!resolve(target).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe Silent-Face cleanup path')
  await rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}
const resultPath = join(projectDir, 'data', 'face-benchmark', 'silent-face-pad-result.json')
try {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  if (result.policyVersion === 'HEADUP-SILENT-FACE-PAD-AUDIT-1.0') {
    result.retention.modelRuntimeVideosAndTemporaryScoresRequireCleanup = false
    result.retention.modelRuntimeVideosAndTemporaryScoresDeletedAfterRun = true
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
} catch (error) { if (error?.code !== 'ENOENT') throw error }
process.stdout.write('Removed Silent-Face source, models, Python runtime, physical replay videos and temporary individual scores.\n')
