import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'oiv7-sunglasses-detector')
const resultPaths = [
  join(projectDir, 'data', 'face-benchmark', 'oiv7-sunglasses-detector-result.json'),
  join(projectDir, 'data', 'face-benchmark', 'oiv7s-sunglasses-detector-result.json'),
  join(projectDir, 'data', 'face-benchmark', 'oiv7-detectors-on-glasses-control-result.json'),
]

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe YOLO research staging path')
await rm(stagingDir, { recursive: true, force: true })
for (const resultPath of resultPaths) {
  const temporaryResultPath = `${resultPath}.cleanup.tmp`
  try {
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    if (!/^HEADUP-OIV7S?-SUNGLASSES-DETECTOR-AUDIT-1\.0$/.test(result.policyVersion)
      && result.policyVersion !== 'HEADUP-OIV7-SUNGLASSES-DETECTORS-GLASSES-CONTROL-1.0') throw new Error('Unexpected YOLO sunglasses result policy')
    if ('positiveImagesDeletedAfterRun' in result.retention) result.retention.positiveImagesDeletedAfterRun = true
    result.retention.modelDeletedAfterRun = true
    result.retention.runtimeDeletedAfterRun = true
    await writeFile(temporaryResultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryResultPath, resultPath)
  } catch (error) {
    await rm(temporaryResultPath, { force: true })
    if (error?.code !== 'ENOENT') throw error
  }
}
process.stdout.write('Removed transient YOLOv8n OIV7 model and Python runtime.\n')
