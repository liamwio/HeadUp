import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'

type RecordEntry = { sampleId: string; group: string; variant: string; relativePath: string }
type Evaluated = Awaited<ReturnType<typeof inspectCaptureFile>>
type Rendered = { analysis: Evaluated; pixels: Uint8ClampedArray }
const root = '/data/face-benchmark/.staging/icc-color-encoding'
const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const baselineVariant = 'srgb_baseline_444'
const variants = ['untagged_srgb_444', 'p3_tagged_444', 'srgb_progressive_420', 'p3_progressive_420'] as const
const round = (value: number, digits = 5) => Number(value.toFixed(digits))
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return values.length ? { min: round(Math.min(...values)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } : { min: 999, median: 999, p95: 999, max: 999 } }
function landmarkRms(left: NonNullable<Evaluated['pose']['landmarks']>, right: NonNullable<Evaluated['pose']['landmarks']>) { return Math.sqrt(left.reduce((sum, point, index) => sum + (point.x - right[index].x) ** 2 + (point.y - right[index].y) ** 2, 0) / left.length) }
function pixelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  let absolute = 0; let squared = 0; let max = 0; let channels = 0
  for (let index = 0; index < left.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(left[index + channel] - right[index + channel]) / 255
      absolute += delta; squared += delta * delta; max = Math.max(max, delta); channels++
    }
  }
  return { meanAbsolute: absolute / channels, rms: Math.sqrt(squared / channels), max }
}
async function evaluate(record: RecordEntry): Promise<Rendered> {
  const blob = await fetch(`${root}/${record.relativePath}`).then((response) => response.blob())
  const file = new File([blob], `${record.sampleId}.jpg`, { type: 'image/jpeg' })
  const analysis = await inspectCaptureFile('front', file)
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 120
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return { analysis, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data }
  } finally { bitmap.close() }
}

async function main() {
  const manifest = await fetch(`${root}/manifest.json`).then((response) => response.json()) as { policyVersion: string; source: unknown; protocol: unknown; encodingAudit: Record<string, { files: number; iccAttached: boolean; iccSha256: (string | null)[]; progressive: boolean; chromaSubsampling: string[] }>; records: RecordEntry[] }
  if (manifest.policyVersion !== 'HEADUP-ICC-COLOR-PREPARE-1.0' || manifest.records.length !== 100) throw new Error('Unexpected ICC manifest')
  const comparisons = []
  const groups = [...new Set(manifest.records.map((record) => record.group))]
  for (const [groupIndex, group] of groups.entries()) {
    status.textContent = `处理色彩编码 ${groupIndex + 1} / ${groups.length}`
    const entries = manifest.records.filter((record) => record.group === group)
    const evaluated = new Map<string, Rendered>()
    for (const record of entries) evaluated.set(record.variant, await evaluate(record))
    const baseline = evaluated.get(baselineVariant)!
    for (const variant of variants) {
      const measured = evaluated.get(variant)!
      const appearance = pixelDifference(baseline.pixels, measured.pixels)
      comparisons.push({
        variant,
        dimensionsMatch: measured.analysis.width === baseline.analysis.width && measured.analysis.height === baseline.analysis.height,
        qualityAcceptanceMatches: isPhotoQualityAcceptable(measured.analysis.quality) === isPhotoQualityAcceptable(baseline.analysis.quality),
        qualityScoreDelta: Math.abs(measured.analysis.quality.score - baseline.analysis.quality.score),
        poseStatusMatches: measured.analysis.pose.status === baseline.analysis.pose.status,
        yawDelta: Math.abs(measured.analysis.pose.yaw - baseline.analysis.pose.yaw),
        pitchDelta: Math.abs(measured.analysis.pose.pitch - baseline.analysis.pose.pitch),
        rollDelta: Math.abs(measured.analysis.pose.roll - baseline.analysis.pose.roll),
        landmarkRms: measured.analysis.pose.landmarks?.length === 478 && baseline.analysis.pose.landmarks?.length === 478 ? landmarkRms(baseline.analysis.pose.landmarks, measured.analysis.pose.landmarks) : null,
        renderedRgbMeanAbsolute: appearance.meanAbsolute,
        renderedRgbRms: appearance.rms,
        renderedRgbMax: appearance.max,
      })
    }
  }
  const byVariant = Object.fromEntries(variants.map((variant) => {
    const items = comparisons.filter((item) => item.variant === variant)
    return [variant, {
      comparisons: items.length,
      dimensionsMatch: items.filter((item) => item.dimensionsMatch).length,
      qualityAcceptanceMatches: items.filter((item) => item.qualityAcceptanceMatches).length,
      poseStatusMatches: items.filter((item) => item.poseStatusMatches).length,
      qualityScoreDelta: distribution(items.map((item) => item.qualityScoreDelta)),
      yawDeltaDegrees: distribution(items.map((item) => item.yawDelta)),
      pitchDeltaDegrees: distribution(items.map((item) => item.pitchDelta)),
      rollDeltaDegrees: distribution(items.map((item) => item.rollDelta)),
      landmarkRms: distribution(items.flatMap((item) => item.landmarkRms === null ? [] : [item.landmarkRms])),
      renderedRgbMeanAbsolute: distribution(items.map((item) => item.renderedRgbMeanAbsolute)),
      renderedRgbRms: distribution(items.map((item) => item.renderedRgbRms)),
      renderedRgbMax: distribution(items.map((item) => item.renderedRgbMax)),
    }]
  }))
  const landmarkValues = comparisons.flatMap((item) => item.landmarkRms === null ? [] : [item.landmarkRms])
  const srgbHash = manifest.encodingAudit.srgb_baseline_444.iccSha256[0]
  const p3Hash = manifest.encodingAudit.p3_tagged_444.iccSha256[0]
  const encodingMetadataContract = Boolean(srgbHash && p3Hash && srgbHash !== p3Hash) &&
    manifest.encodingAudit.untagged_srgb_444.iccAttached === false &&
    manifest.encodingAudit.srgb_progressive_420.progressive && manifest.encodingAudit.p3_progressive_420.progressive &&
    manifest.encodingAudit.srgb_progressive_420.chromaSubsampling[0] === '4:2:0' && manifest.encodingAudit.p3_progressive_420.chromaSubsampling[0] === '4:2:0'
  const gates = {
    evaluated20GroupsAnd80Comparisons: comparisons.length === 80,
    encodingMetadataMatchesFiveFrozenVariants: encodingMetadataContract,
    everyVariantPreservesDimensions: comparisons.every((item) => item.dimensionsMatch),
    everyVariantPreservesQualityAcceptance: comparisons.every((item) => item.qualityAcceptanceMatches),
    eachVariantQualityScoreDeltaP95AtMost3: variants.every((variant) => byVariant[variant].qualityScoreDelta.p95 <= 3),
    everyVariantPreservesPoseStatus: comparisons.every((item) => item.poseStatusMatches),
    eachVariantPoseAxisDeltaP95AtMost2Degrees: variants.every((variant) => Math.max(byVariant[variant].yawDeltaDegrees.p95, byVariant[variant].pitchDeltaDegrees.p95, byVariant[variant].rollDeltaDegrees.p95) <= 2),
    atLeast72ComparableLandmarkVariants: landmarkValues.length >= 72,
    landmarkRmsP95AtMost1Percent: percentile(landmarkValues, .95) <= .01,
    eachVariantRenderedRgbRmsP95AtMost3Percent: variants.every((variant) => byVariant[variant].renderedRgbRms.p95 <= .03),
  }
  const criticalGates = {
    metadata: gates.encodingMetadataMatchesFiveFrozenVariants,
    dimensions: gates.everyVariantPreservesDimensions,
    acceptance: gates.everyVariantPreservesQualityAcceptance,
    pose: gates.everyVariantPreservesPoseStatus && gates.eachVariantPoseAxisDeltaP95AtMost2Degrees,
    landmarks: gates.atLeast72ComparableLandmarkVariants && gates.landmarkRmsP95AtMost1Percent,
    renderedAppearance: gates.eachVariantRenderedRgbRmsP95AtMost3Percent,
  }
  const passesCritical = Object.values(criticalGates).every(Boolean)
  const passesAll = Object.values(gates).every(Boolean)
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-ICC-COLOR-ENCODING-1.0', source: manifest.source, protocol: manifest.protocol,
    encodingAudit: manifest.encodingAudit,
    evaluation: { comparisons: comparisons.length, comparableLandmarks: landmarkValues.length, byVariant, overallLandmarkRms: distribution(landmarkValues), overallRenderedRgbRms: distribution(comparisons.map((item) => item.renderedRgbRms)) },
    predeclaredGates: gates, criticalGates, passesCriticalIccColorContract: passesCritical, passesAllIccColorGates: passesAll,
    productionDecision: passesAll ? 'retain_icc_and_progressive_jpeg_support' : passesCritical ? 'retain_support_but_do_not_compare_quality_scores_across_encodings' : 'restrict_or_normalize_divergent_color_encoding',
    limitations: ['Chromium color management does not prove Safari/iOS/Android parity.', 'Sharp-generated profiles do not cover every camera manufacturer ICC profile or HDR image.', 'Rendered RGB parity is measured after browser color management on an SDR canvas.', 'Studio front images do not cover all lighting and skin appearance conditions.'],
    retention: { imagesDeletedAfterRun: false, sourceArchiveDeletedAfterPrepare: true, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2); status.textContent = '完成'
}
main().catch((error) => { resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error); resultElement.textContent = resultElement.dataset.error; status.textContent = '失败' })
