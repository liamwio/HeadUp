import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'openimages-glasses')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'openimages-glasses-control-result.json')
const temporaryResultPath = `${resultPath}.cleanup.tmp`
const detectorResultPath = join(projectDir, 'data', 'face-benchmark', 'oiv7-detectors-on-glasses-control-result.json')

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe Open Images glasses staging path')
await rm(stagingDir, { recursive: true, force: true })
try {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  if (result.policyVersion !== 'HEADUP-OPENIMAGES-GLASSES-CONTROL-AUDIT-1.0') throw new Error('Unexpected ordinary-glasses result policy')
  result.retention.imagesDeletedAfterRun = true
  await writeFile(temporaryResultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryResultPath, resultPath)
} catch (error) {
  await rm(temporaryResultPath, { force: true })
  if (error?.code !== 'ENOENT') throw error
}
try {
  const detectorResult = JSON.parse(await readFile(detectorResultPath, 'utf8'))
  if (detectorResult.policyVersion !== 'HEADUP-OIV7-SUNGLASSES-DETECTORS-GLASSES-CONTROL-1.0') throw new Error('Unexpected detector glasses-control result policy')
  for (const model of Object.values(detectorResult.models)) {
    const controls = model.bySizeBand.close.controls + model.bySizeBand.standard.controls
    const falsePositives = model.bySizeBand.close.sunglassesFalsePositiveProxy + model.bySizeBand.standard.sunglassesFalsePositiveProxy
    model.productScaleProxy = {
      controls,
      sunglassesFalsePositiveProxy: falsePositives,
      falsePositiveProxyRate: Number((falsePositives / controls).toFixed(4)),
      definition: 'close + standard face-size bands; excludes context-small faces that the production gate rejects',
    }
  }
  detectorResult.retention.controlImagesDeletedAfterRun = true
  const temporaryDetectorResultPath = `${detectorResultPath}.cleanup.tmp`
  await writeFile(temporaryDetectorResultPath, `${JSON.stringify(detectorResult, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryDetectorResultPath, detectorResultPath)
} catch (error) {
  await rm(`${detectorResultPath}.cleanup.tmp`, { force: true })
  if (error?.code !== 'ENOENT') throw error
}
process.stdout.write('Removed transient Open Images ordinary-glasses controls and manifest.\n')
