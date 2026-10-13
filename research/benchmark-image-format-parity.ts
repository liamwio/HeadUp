import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'

type RecordEntry = { sampleId: string; orientation: number; relativePath: string }
type Evaluated = Awaited<ReturnType<typeof inspectCaptureFile>>
const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const root = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/exif-orientation'
function round(value: number, digits = 4) { return Number(value.toFixed(digits)) }
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return { min: round(Math.min(...values)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } }
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) { return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(`${type} encoding unavailable`)), type, quality)) }
function landmarkRms(left: NonNullable<Evaluated['pose']['landmarks']>, right: NonNullable<Evaluated['pose']['landmarks']>) { return Math.sqrt(left.reduce((sum, point, index) => sum + (point.x - right[index].x) ** 2 + (point.y - right[index].y) ** 2, 0) / left.length) }

async function main() {
  const manifest = await fetch(`${root}/manifest.json`).then((response) => response.json()) as { policyVersion: string; source: unknown; records: RecordEntry[] }
  const records = manifest.records.filter((record) => record.orientation === 1)
  if (manifest.policyVersion !== 'HEADUP-EXIF-ORIENTATION-PREPARE-1.0' || records.length !== 20) throw new Error('Unexpected format parity source')
  const variants = ['png_lossless', 'webp_quality_90', 'jpeg_quality_70'] as const
  const comparisons = []
  for (const [index, record] of records.entries()) {
    status.textContent = `处理格式 ${index + 1} / ${records.length}`
    const sourceBlob = await fetch(`${root}/${record.relativePath}`).then((response) => response.blob())
    const baselineFile = new File([sourceBlob], `${record.sampleId}.jpg`, { type: 'image/jpeg' })
    const bitmap = await createImageBitmap(sourceBlob)
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close()
    const [baseline, png, webp, jpeg70] = await Promise.all([
      inspectCaptureFile('front', baselineFile),
      canvasBlob(canvas, 'image/png').then((blob) => inspectCaptureFile('front', new File([blob], `${record.sampleId}.png`, { type: 'image/png' }))),
      canvasBlob(canvas, 'image/webp', .9).then((blob) => inspectCaptureFile('front', new File([blob], `${record.sampleId}.webp`, { type: 'image/webp' }))),
      canvasBlob(canvas, 'image/jpeg', .7).then((blob) => inspectCaptureFile('front', new File([blob], `${record.sampleId}-q70.jpg`, { type: 'image/jpeg' }))),
    ])
    const values: Record<typeof variants[number], Evaluated> = { png_lossless: png, webp_quality_90: webp, jpeg_quality_70: jpeg70 }
    for (const variant of variants) {
      const measured = values[variant]
      comparisons.push({
        variant,
        dimensionsMatch: measured.width === baseline.width && measured.height === baseline.height,
        qualityAcceptanceMatches: isPhotoQualityAcceptable(measured.quality) === isPhotoQualityAcceptable(baseline.quality),
        qualityScoreDelta: Math.abs(measured.quality.score - baseline.quality.score),
        poseStatusMatches: measured.pose.status === baseline.pose.status,
        yawDelta: Math.abs((measured.pose.yaw ?? 999) - (baseline.pose.yaw ?? -999)),
        pitchDelta: Math.abs((measured.pose.pitch ?? 999) - (baseline.pose.pitch ?? -999)),
        rollDelta: Math.abs((measured.pose.roll ?? 999) - (baseline.pose.roll ?? -999)),
        landmarkRms: measured.pose.landmarks?.length === 478 && baseline.pose.landmarks?.length === 478 ? landmarkRms(baseline.pose.landmarks, measured.pose.landmarks) : null,
      })
    }
  }
  const landmarkValues = comparisons.flatMap((item) => item.landmarkRms === null ? [] : [item.landmarkRms])
  const byVariant = Object.fromEntries(variants.map((variant) => {
    const items = comparisons.filter((item) => item.variant === variant)
    return [variant, { comparisons: items.length, dimensionsMatch: items.filter((item) => item.dimensionsMatch).length, qualityAcceptanceMatches: items.filter((item) => item.qualityAcceptanceMatches).length, poseStatusMatches: items.filter((item) => item.poseStatusMatches).length, qualityScoreDelta: distribution(items.map((item) => item.qualityScoreDelta)), yawDeltaDegrees: distribution(items.map((item) => item.yawDelta)), pitchDeltaDegrees: distribution(items.map((item) => item.pitchDelta)), rollDeltaDegrees: distribution(items.map((item) => item.rollDelta)), landmarkRms: distribution(items.flatMap((item) => item.landmarkRms === null ? [] : [item.landmarkRms])) }]
  }))
  const gates = {
    evaluated20GroupsAnd60Comparisons: comparisons.length === 60,
    everyFormatPreservesDimensions: comparisons.every((item) => item.dimensionsMatch),
    everyFormatPreservesQualityAcceptance: comparisons.every((item) => item.qualityAcceptanceMatches),
    eachFormatQualityScoreDeltaP95AtMost3: variants.every((variant) => byVariant[variant].qualityScoreDelta.p95 <= 3),
    everyFormatPreservesPoseStatus: comparisons.every((item) => item.poseStatusMatches),
    eachFormatPoseAxisDeltaP95AtMost2Degrees: variants.every((variant) => Math.max(byVariant[variant].yawDeltaDegrees.p95, byVariant[variant].pitchDeltaDegrees.p95, byVariant[variant].rollDeltaDegrees.p95) <= 2),
    atLeast54ComparableLandmarkVariants: landmarkValues.length >= 54,
    landmarkRmsP95AtMost1Percent: percentile(landmarkValues, .95) <= .01,
  }
  const criticalGates = { dimensions: gates.everyFormatPreservesDimensions, acceptance: gates.everyFormatPreservesQualityAcceptance, pose: gates.everyFormatPreservesPoseStatus && gates.eachFormatPoseAxisDeltaP95AtMost2Degrees, landmarks: gates.atLeast54ComparableLandmarkVariants && gates.landmarkRmsP95AtMost1Percent }
  const passesCritical = Object.values(criticalGates).every(Boolean)
  const passesAll = Object.values(gates).every(Boolean)
  const result = { testedAt: new Date().toISOString(), policyVersion: 'HEADUP-IMAGE-FORMAT-PARITY-1.0', source: manifest.source, protocol: { groups: 20, baseline: 'JPEG95 orientation1', variants }, evaluation: { comparisons: comparisons.length, comparableLandmarks: landmarkValues.length, byVariant, overallLandmarkRms: distribution(landmarkValues) }, predeclaredGates: gates, criticalGates, passesCriticalFormatContract: passesCritical, passesAllFormatParityGates: passesAll, qualityScoreCrossFormatComparableWithin3Points: gates.eachFormatQualityScoreDeltaP95AtMost3, productionDecision: passesAll ? 'retain_jpeg_png_webp_support' : passesCritical ? 'retain_format_support_but_do_not_compare_quality_scores_across_encodings' : 'restrict_or_normalize_divergent_format', limitations: ['Canvas-generated formats do not cover every encoder or color profile.', 'Chromium results do not prove Safari/iOS/Android parity.', 'The comparison uses studio front images, not all capture conditions.', 'A failed score-parity gate means data-quality scores should not be compared longitudinally across different encodings.'], retention: { imagesDeletedAfterRun: false, generatedVariantsWritten: false, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true } }
  resultElement.textContent = JSON.stringify(result, null, 2); status.textContent = '完成'
}
main().catch((error) => { resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error); resultElement.textContent = resultElement.dataset.error; status.textContent = '失败' })
