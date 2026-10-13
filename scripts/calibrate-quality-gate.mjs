import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const dbDir = join(projectDir, 'data', 'face-db-real-research')
const resultPath = join(dbDir, 'quality-calibration-result.json')
const records = (await readFile(join(dbDir, 'manifest.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const harness = await createProductionQualityHarness(projectDir)

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(3))
}

function distribution(values) {
  return {
    min: percentile(values, 0),
    p05: percentile(values, 0.05),
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
  }
}

function findSharpnessThreshold(clearCases, blurCases) {
  let best
  for (let threshold = 0; threshold <= 15; threshold += 0.025) {
    const clearAccepted = clearCases.filter((item) => item.sharpness >= threshold).length / clearCases.length
    const blurRejected = blurCases.filter((item) => item.sharpness < threshold).length / blurCases.length
    const balancedAccuracy = (clearAccepted + blurRejected) / 2
    const candidate = { threshold: Number(threshold.toFixed(3)), clearAccepted, blurRejected, balancedAccuracy }
    if (!best || candidate.balancedAccuracy > best.balancedAccuracy || (
      candidate.balancedAccuracy === best.balancedAccuracy && candidate.clearAccepted > best.clearAccepted
    )) best = candidate
  }
  return {
    threshold: best.threshold,
    clearAcceptanceRate: Number(best.clearAccepted.toFixed(4)),
    blurRejectionRate: Number(best.blurRejected.toFixed(4)),
    balancedAccuracy: Number(best.balancedAccuracy.toFixed(4)),
  }
}

const cases = []
for (const record of records) {
  const path = join(dbDir, record.relativePath)
  const original = await harness.inspect(path)
  cases.push({ partition: record.partition, variant: 'clear_original', ...original.raw })

  const moderateBlur = await sharp(path).blur(2).jpeg({ quality: 95 }).toBuffer()
  const moderate = await harness.inspect(moderateBlur)
  cases.push({ partition: record.partition, variant: 'blur_sigma_2', ...moderate.raw })

  const severeBlur = await sharp(path).blur(4).jpeg({ quality: 95 }).toBuffer()
  const severe = await harness.inspect(severeBlur)
  cases.push({ partition: record.partition, variant: 'blur_sigma_4', ...severe.raw })
}

const variants = Object.fromEntries(Object.entries(Object.groupBy(cases, (item) => item.variant)).map(([name, items]) => [name, {
  images: items.length,
  sharpness: distribution(items.map((item) => item.sharpness)),
  brightness: distribution(items.map((item) => item.brightness)),
  contrast: distribution(items.map((item) => item.contrast)),
}]))

const engineeringClear = cases.filter((item) => item.partition === 'engineering_qa' && item.variant === 'clear_original')
const engineeringBlur = cases.filter((item) => item.partition === 'engineering_qa' && item.variant === 'blur_sigma_4')
const recommended = findSharpnessThreshold(engineeringClear, engineeringBlur)
const holdoutClear = cases.filter((item) => item.partition === 'holdout' && item.variant === 'clear_original')
const holdoutModerate = cases.filter((item) => item.partition === 'holdout' && item.variant === 'blur_sigma_2')
const holdoutSevere = cases.filter((item) => item.partition === 'holdout' && item.variant === 'blur_sigma_4')
const threshold = recommended.threshold

const result = {
  calibratedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-REAL-RESEARCH-1.0',
  method: {
    selectionPartition: 'engineering_qa',
    validationPartition: 'holdout',
    positiveClass: 'clear_original',
    negativeClass: 'blur_sigma_4',
    moderateBlurIsReportedSeparately: true,
    originalsRetainedOnlyInExistingTemporaryResearchDatabase: true,
    degradedImagesRetained: false,
  },
  images: records.length,
  generatedCases: cases.length,
  variants,
  recommendedSharpnessThreshold: recommended,
  holdout: {
    clearAcceptanceRate: Number((holdoutClear.filter((item) => item.sharpness >= threshold).length / holdoutClear.length).toFixed(4)),
    moderateBlurRejectionRate: Number((holdoutModerate.filter((item) => item.sharpness < threshold).length / holdoutModerate.length).toFixed(4)),
    severeBlurRejectionRate: Number((holdoutSevere.filter((item) => item.sharpness < threshold).length / holdoutSevere.length).toFixed(4)),
  },
  historicalThreshold: 18,
  historicalThresholdClearFalseWarningRate: Number((cases.filter((item) => item.variant === 'clear_original' && item.sharpness < 18).length / records.length).toFixed(4)),
  productionThresholds: {
    severeBlurBlock: 3.35,
    reviewWarning: 4.3,
  },
  productionClearBlockRate: Number((cases.filter((item) => item.variant === 'clear_original' && item.sharpness < 3.35).length / records.length).toFixed(4)),
  productionClearReviewWarningRate: Number((cases.filter((item) => item.variant === 'clear_original' && item.sharpness < 4.3).length / records.length).toFixed(4)),
}

await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ...result, resultPath }, null, 2) + '\n')
