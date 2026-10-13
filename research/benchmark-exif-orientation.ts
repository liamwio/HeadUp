import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'

type RecordEntry = { sampleId: string; group: string; orientation: 1 | 3 | 6 | 8; relativePath: string; expectedDisplayWidth: number; expectedDisplayHeight: number }
type Evaluated = RecordEntry & { displayWidth: number; displayHeight: number; quality: Awaited<ReturnType<typeof inspectCaptureFile>>['quality']; pose: Awaited<ReturnType<typeof inspectCaptureFile>>['pose']; bitmapDecodeCalls: number }
const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/exif-orientation'

function round(value: number, digits = 4) { return Number(value.toFixed(digits)) }
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return { min: round(Math.min(...values)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } }
function landmarkRms(left: NonNullable<Evaluated['pose']['landmarks']>, right: NonNullable<Evaluated['pose']['landmarks']>) {
  return Math.sqrt(left.reduce((sum, point, index) => sum + (point.x - right[index].x) ** 2 + (point.y - right[index].y) ** 2, 0) / left.length)
}

async function main() {
  const manifest = await fetch(`${stagingRoot}/manifest.json`).then((response) => response.json()) as { policyVersion: string; source: unknown; selection: unknown; protocol: unknown; records: RecordEntry[] }
  if (manifest.policyVersion !== 'HEADUP-EXIF-ORIENTATION-PREPARE-1.0' || manifest.records.length !== 80) throw new Error('Unexpected EXIF manifest')
  const evaluated: Evaluated[] = []
  const originalCreateImageBitmap = globalThis.createImageBitmap.bind(globalThis)
  let totalBitmapDecodeCalls = 0
  globalThis.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
    totalBitmapDecodeCalls++
    return originalCreateImageBitmap(...args)
  }) as typeof createImageBitmap
  for (const [index, record] of manifest.records.entries()) {
    status.textContent = `处理EXIF方向 ${index + 1} / ${manifest.records.length}`
    const blob = await fetch(`${stagingRoot}/${record.relativePath}`).then((response) => response.blob())
    const file = new File([blob], `${record.sampleId}.jpg`, { type: 'image/jpeg' })
    const before = totalBitmapDecodeCalls
    const inspected = await inspectCaptureFile('front', file)
    evaluated.push({ ...record, displayWidth: inspected.width, displayHeight: inspected.height, quality: inspected.quality, pose: inspected.pose, bitmapDecodeCalls: totalBitmapDecodeCalls - before })
  }
  const groups = Object.groupBy(evaluated, (item) => item.group)
  const comparisons = []
  for (const [group, values] of Object.entries(groups)) {
    if (!values || values.length !== 4) throw new Error(`Incomplete EXIF group: ${group}`)
    const baseline = values.find((item) => item.orientation === 1)!
    for (const item of values.filter((value) => value.orientation !== 1)) {
      comparisons.push({
        orientation: item.orientation,
        dimensionsCorrect: item.displayWidth === item.expectedDisplayWidth && item.displayHeight === item.expectedDisplayHeight,
        qualityScoreDelta: Math.abs(item.quality.score - baseline.quality.score),
        qualityAcceptanceMatches: isPhotoQualityAcceptable(item.quality) === isPhotoQualityAcceptable(baseline.quality),
        poseStatusMatches: item.pose.status === baseline.pose.status,
        yawDelta: Math.abs((item.pose.yaw ?? 999) - (baseline.pose.yaw ?? -999)),
        pitchDelta: Math.abs((item.pose.pitch ?? 999) - (baseline.pose.pitch ?? -999)),
        rollDelta: Math.abs((item.pose.roll ?? 999) - (baseline.pose.roll ?? -999)),
        landmarkRms: baseline.pose.landmarks?.length === 478 && item.pose.landmarks?.length === 478 ? landmarkRms(baseline.pose.landmarks, item.pose.landmarks) : null,
      })
    }
  }
  const landmarkValues = comparisons.flatMap((item) => item.landmarkRms === null ? [] : [item.landmarkRms])
  const gates = {
    evaluated20GroupsAnd80Images: Object.keys(groups).length === 20 && evaluated.length === 80,
    everyInputDecodedExactlyOnce: totalBitmapDecodeCalls === 80 && evaluated.every((item) => item.bitmapDecodeCalls === 1),
    everyVariantDecodedToExpectedDisplayDimensions: comparisons.every((item) => item.dimensionsCorrect),
    everyQualityAcceptanceMatchesBaseline: comparisons.every((item) => item.qualityAcceptanceMatches),
    qualityScoreDeltaP95AtMost3Points: percentile(comparisons.map((item) => item.qualityScoreDelta), .95) <= 3,
    everyPoseStatusMatchesBaseline: comparisons.every((item) => item.poseStatusMatches),
    eachPoseAxisDeltaP95AtMost3Degrees: ['yawDelta', 'pitchDelta', 'rollDelta'].every((key) => percentile(comparisons.map((item) => item[key as keyof typeof item] as number), .95) <= 3),
    atLeast54ComparableLandmarkVariants: landmarkValues.length >= 54,
    landmarkRmsP95AtMost1Percent: landmarkValues.length > 0 && percentile(landmarkValues, .95) <= 0.01,
  }
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-EXIF-ORIENTATION-AUDIT-1.0',
    source: manifest.source,
    selection: manifest.selection,
    protocol: manifest.protocol,
    evaluation: {
      images: evaluated.length,
      bitmapDecodeCalls: totalBitmapDecodeCalls,
      groups: Object.keys(groups).length,
      comparisons: comparisons.length,
      correctDimensions: comparisons.filter((item) => item.dimensionsCorrect).length,
      qualityAcceptanceMatches: comparisons.filter((item) => item.qualityAcceptanceMatches).length,
      poseStatusMatches: comparisons.filter((item) => item.poseStatusMatches).length,
      comparableLandmarks: landmarkValues.length,
      qualityScoreDelta: distribution(comparisons.map((item) => item.qualityScoreDelta)),
      yawDeltaDegrees: distribution(comparisons.map((item) => item.yawDelta)),
      pitchDeltaDegrees: distribution(comparisons.map((item) => item.pitchDelta)),
      rollDeltaDegrees: distribution(comparisons.map((item) => item.rollDelta)),
      landmarkRms: landmarkValues.length ? distribution(landmarkValues) : null,
      byOrientation: Object.fromEntries([3, 6, 8].map((orientation) => [String(orientation), {
        comparisons: comparisons.filter((item) => item.orientation === orientation).length,
        dimensionsCorrect: comparisons.filter((item) => item.orientation === orientation && item.dimensionsCorrect).length,
        qualityScoreDelta: distribution(comparisons.filter((item) => item.orientation === orientation).map((item) => item.qualityScoreDelta)),
      }])),
    },
    predeclaredGates: gates,
    passesExifOrientationContract: Object.values(gates).every(Boolean),
    productionDecision: Object.values(gates).every(Boolean) ? 'retain_browser_orientation_decode' : 'explicit_orientation_normalization_required',
    retention: { imagesDeletedAfterRun: false, sourceNamesRetained: false, individualPredictionsRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  status.textContent = '完成'
}

main().catch((error) => { resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error); resultElement.textContent = resultElement.dataset.error; status.textContent = '失败' })
