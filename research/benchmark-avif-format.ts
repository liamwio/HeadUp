import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'

type RecordEntry = { group: string; variant: 'jpeg95' | 'avif90'; mimeType: string; relativePath: string }
type Evaluated = Awaited<ReturnType<typeof inspectCaptureFile>>
const root = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/avif-format'
const status = document.querySelector<HTMLElement>('#status')!; const resultElement = document.querySelector<HTMLElement>('#result')!
const round = (value: number, digits = 5) => Number(value.toFixed(digits))
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return values.length ? { min: round(Math.min(...values)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } : { min: 999, median: 999, p95: 999, max: 999 } }
function landmarkRms(left: NonNullable<Evaluated['pose']['landmarks']>, right: NonNullable<Evaluated['pose']['landmarks']>) { return Math.sqrt(left.reduce((sum, point, index) => sum + (point.x - right[index].x) ** 2 + (point.y - right[index].y) ** 2, 0) / left.length) }
async function evaluate(record: RecordEntry) { const blob = await fetch(`${root}/${record.relativePath}`).then((response) => response.blob()); const file = new File([blob], `${record.group}.${record.variant === 'avif90' ? 'avif' : 'jpg'}`, { type: record.mimeType }); const started = performance.now(); const analysis = await inspectCaptureFile('front', file); return { analysis, durationMs: performance.now() - started } }

async function main() {
  const manifest = await fetch(`${root}/manifest.json`).then((response) => response.json()) as { policyVersion: string; source: unknown; protocol: unknown; records: RecordEntry[] }
  if (manifest.policyVersion !== 'HEADUP-AVIF-PREPARE-1.0' || manifest.records.length !== 40) throw new Error('Unexpected AVIF manifest')
  const groups = [...new Set(manifest.records.map((record) => record.group))]; const comparisons = []
  for (const [index, group] of groups.entries()) {
    status.textContent = `处理AVIF真人 ${index + 1} / ${groups.length}`
    const jpeg = manifest.records.find((record) => record.group === group && record.variant === 'jpeg95')!
    const avif = manifest.records.find((record) => record.group === group && record.variant === 'avif90')!
    const first = index % 2 === 0 ? jpeg : avif; const second = index % 2 === 0 ? avif : jpeg
    const firstResult = await evaluate(first); const secondResult = await evaluate(second)
    const baseline = first.variant === 'jpeg95' ? firstResult : secondResult; const measured = first.variant === 'avif90' ? firstResult : secondResult
    comparisons.push({
      warm: index > 0,
      dimensionsMatch: measured.analysis.width === baseline.analysis.width && measured.analysis.height === baseline.analysis.height,
      qualityAcceptanceMatches: isPhotoQualityAcceptable(measured.analysis.quality) === isPhotoQualityAcceptable(baseline.analysis.quality),
      qualityScoreDelta: Math.abs(measured.analysis.quality.score - baseline.analysis.quality.score),
      poseStatusMatches: measured.analysis.pose.status === baseline.analysis.pose.status,
      yawDelta: Math.abs(measured.analysis.pose.yaw - baseline.analysis.pose.yaw), pitchDelta: Math.abs(measured.analysis.pose.pitch - baseline.analysis.pose.pitch), rollDelta: Math.abs(measured.analysis.pose.roll - baseline.analysis.pose.roll),
      landmarkRms: measured.analysis.pose.landmarks?.length === 478 && baseline.analysis.pose.landmarks?.length === 478 ? landmarkRms(baseline.analysis.pose.landmarks, measured.analysis.pose.landmarks) : null,
      jpegDurationMs: baseline.durationMs, avifDurationMs: measured.durationMs,
    })
  }
  const landmarks = comparisons.flatMap((item) => item.landmarkRms === null ? [] : [item.landmarkRms]); const warm = comparisons.filter((item) => item.warm)
  const gates = {
    evaluated20RealFacePairs: comparisons.length === 20,
    everyAvifPreservesDimensions: comparisons.every((item) => item.dimensionsMatch),
    everyAvifPreservesQualityAcceptance: comparisons.every((item) => item.qualityAcceptanceMatches),
    qualityScoreDeltaP95AtMost3: percentile(comparisons.map((item) => item.qualityScoreDelta), .95) <= 3,
    everyAvifPreservesPoseStatus: comparisons.every((item) => item.poseStatusMatches),
    poseAxisDeltaP95AtMost2Degrees: percentile(comparisons.map((item) => Math.max(item.yawDelta, item.pitchDelta, item.rollDelta)), .95) <= 2,
    atLeast18ComparableLandmarkPairs: landmarks.length >= 18,
    landmarkRmsP95AtMost1Percent: percentile(landmarks, .95) <= .01,
    warmAvifAnalysisP95AtMost5Seconds: percentile(warm.map((item) => item.avifDurationMs), .95) <= 5_000,
  }
  const critical = { dimensions: gates.everyAvifPreservesDimensions, acceptance: gates.everyAvifPreservesQualityAcceptance, pose: gates.everyAvifPreservesPoseStatus && gates.poseAxisDeltaP95AtMost2Degrees, landmarks: gates.atLeast18ComparableLandmarkPairs && gates.landmarkRmsP95AtMost1Percent, latency: gates.warmAvifAnalysisP95AtMost5Seconds }
  const passesCritical = Object.values(critical).every(Boolean); const passesAll = Object.values(gates).every(Boolean)
  const result = { testedAt: new Date().toISOString(), policyVersion: 'HEADUP-AVIF-FORMAT-1.0', source: manifest.source, protocol: manifest.protocol,
    evaluation: { comparisons: comparisons.length, comparableLandmarkPairs: landmarks.length, dimensionsMatch: comparisons.filter((item) => item.dimensionsMatch).length, qualityAcceptanceMatches: comparisons.filter((item) => item.qualityAcceptanceMatches).length, poseStatusMatches: comparisons.filter((item) => item.poseStatusMatches).length, qualityScoreDelta: distribution(comparisons.map((item) => item.qualityScoreDelta)), yawDeltaDegrees: distribution(comparisons.map((item) => item.yawDelta)), pitchDeltaDegrees: distribution(comparisons.map((item) => item.pitchDelta)), rollDeltaDegrees: distribution(comparisons.map((item) => item.rollDelta)), landmarkRms: distribution(landmarks), jpegWarmAnalysisMs: distribution(warm.map((item) => item.jpegDurationMs)), avifWarmAnalysisMs: distribution(warm.map((item) => item.avifDurationMs)) },
    predeclaredGates: gates, criticalGates: critical, passesCriticalAvifContract: passesCritical, passesAllAvifGates: passesAll, productionDecision: passesAll ? 'enable_avif_upload' : passesCritical ? 'enable_avif_but_do_not_compare_quality_scores_across_formats' : 'keep_avif_disabled',
    limitations: ['Chromium AVIF decoding does not prove Safari/iOS/Android parity.', 'Sharp AVIF90 does not cover every phone encoder or HDR AVIF.', 'Studio front images do not cover all capture conditions.', 'HEIC/HEIF remains unsupported and is rejected with an actionable conversion message.'],
    retention: { imagesDeletedAfterRun: false, sourceArchiveDeletedAfterPrepare: true, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true } }
  resultElement.textContent = JSON.stringify(result, null, 2); status.textContent = '完成'
}
main().catch((error) => { resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error); resultElement.textContent = resultElement.dataset.error; status.textContent = '失败' })
