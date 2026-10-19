import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { computeFrontGeometry, type FrontGeometry } from '../src/lib/faceMeasurements'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { correctMirroredFrontFile } from '../src/lib/mirrorCorrection'

type RecordEntry = { sampleId: string; relativePath: string }
type Metric = Exclude<keyof FrontGeometry, 'midLowerFaceHeightRatio'>
const metrics: Metric[] = ['mirrorResidual', 'visibleFaceLengthWidthRatio', 'pupilDistanceFaceWidthRatio', 'interEyeRatio', 'eyeCanthalTiltDegrees', 'jawWidthRatio', 'mouthWidthRatio', 'midfaceHeightRatio', 'lowerFaceHeightRatio', 'noseMouthWidthRatio', 'noseLengthFaceHeightRatio', 'lipHeightMouthWidthRatio']
const stableMetrics = new Set<Metric>(['pupilDistanceFaceWidthRatio', 'jawWidthRatio'])
const root = '/data/face-benchmark/.staging/front-mirror'
const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const round = (value: number, digits = 6) => Number(value.toFixed(digits))
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return values.length ? { min: round(Math.min(...values)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } : { min: 999, median: 999, p95: 999, max: 999 } }
function canvasBlob(canvas: HTMLCanvasElement) { return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png')) }
function metricDifference(metric: Metric, baseline: FrontGeometry, mirrored: FrontGeometry) {
  if (metric === 'mirrorResidual' || metric === 'eyeCanthalTiltDegrees') return Math.abs(mirrored[metric] - baseline[metric])
  return Math.abs(mirrored[metric] - baseline[metric]) / Math.max(Math.abs(baseline[metric]), 0.0001)
}

async function main() {
  const manifest = await fetch(`${root}/manifest.json`).then((response) => response.json()) as { policyVersion: string; source: unknown; protocol: unknown; records: RecordEntry[] }
  if (manifest.policyVersion !== 'HEADUP-FRONT-MIRROR-PREPARE-1.0' || manifest.records.length !== 102) throw new Error('Unexpected mirror manifest')
  const comparisons = []
  for (const [index, record] of manifest.records.entries()) {
    status.textContent = `处理镜像真人 ${index + 1} / ${manifest.records.length}`
    const sourceBlob = await fetch(`${root}/${record.relativePath}`).then((response) => response.blob())
    const bitmap = await createImageBitmap(sourceBlob)
    const normalCanvas = document.createElement('canvas'); normalCanvas.width = bitmap.width; normalCanvas.height = bitmap.height
    normalCanvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    const mirrorCanvas = document.createElement('canvas'); mirrorCanvas.width = bitmap.width; mirrorCanvas.height = bitmap.height
    const mirrorContext = mirrorCanvas.getContext('2d')!; mirrorContext.translate(bitmap.width, 0); mirrorContext.scale(-1, 1); mirrorContext.drawImage(bitmap, 0, 0); bitmap.close()
    const [normalBlob, mirrorBlob] = await Promise.all([canvasBlob(normalCanvas), canvasBlob(mirrorCanvas)])
    const baseline = await inspectCaptureFile('front', new File([normalBlob], `${record.sampleId}-normal.png`, { type: 'image/png' }))
    const mirrorFile = new File([mirrorBlob], `${record.sampleId}-mirror.png`, { type: 'image/png' })
    const mirrored = await inspectCaptureFile('front', mirrorFile)
    const correctedFile = await correctMirroredFrontFile(mirrorFile)
    const corrected = await inspectCaptureFile('front', correctedFile)
    const baselineGeometry = baseline.pose.landmarks ? computeFrontGeometry(baseline.pose.landmarks, baseline.width, baseline.height) : null
    const mirroredGeometry = mirrored.pose.landmarks ? computeFrontGeometry(mirrored.pose.landmarks, mirrored.width, mirrored.height) : null
    const correctedGeometry = corrected.pose.landmarks ? computeFrontGeometry(corrected.pose.landmarks, corrected.width, corrected.height) : null
    comparisons.push({
      qualityAcceptanceMatches: isPhotoQualityAcceptable(baseline.quality) === isPhotoQualityAcceptable(mirrored.quality),
      qualityScoreDelta: Math.abs(baseline.quality.score - mirrored.quality.score),
      mediapipeDetectionMatches: (baseline.pose.detectedFaces === 1) === (mirrored.pose.detectedFaces === 1),
      yunetTrustedMatches: ((baseline.pose.faceDetectorScore ?? 0) >= .9) === ((mirrored.pose.faceDetectorScore ?? 0) >= .9),
      poseStatusMatches: baseline.pose.status === mirrored.pose.status,
      yawMirrorResidual: Math.abs(baseline.pose.yaw + mirrored.pose.yaw),
      pitchMirrorResidual: Math.abs(baseline.pose.pitch - mirrored.pose.pitch),
      rollMirrorResidual: Math.abs(baseline.pose.roll + mirrored.pose.roll),
      geometryComparable: Boolean(baselineGeometry && mirroredGeometry),
      metricDifferences: baselineGeometry && mirroredGeometry ? Object.fromEntries(metrics.map((metric) => [metric, metricDifference(metric, baselineGeometry, mirroredGeometry)])) : null,
      correctedQualityAcceptanceMatches: isPhotoQualityAcceptable(baseline.quality) === isPhotoQualityAcceptable(corrected.quality),
      correctedQualityScoreDelta: Math.abs(baseline.quality.score - corrected.quality.score),
      correctedMediaPipeDetectionMatches: (baseline.pose.detectedFaces === 1) === (corrected.pose.detectedFaces === 1),
      correctedYuNetTrustedMatches: ((baseline.pose.faceDetectorScore ?? 0) >= .9) === ((corrected.pose.faceDetectorScore ?? 0) >= .9),
      correctedPoseStatusMatches: baseline.pose.status === corrected.pose.status,
      correctedYawResidual: Math.abs(baseline.pose.yaw - corrected.pose.yaw),
      correctedPitchResidual: Math.abs(baseline.pose.pitch - corrected.pose.pitch),
      correctedRollResidual: Math.abs(baseline.pose.roll - corrected.pose.roll),
      correctedGeometryComparable: Boolean(baselineGeometry && correctedGeometry),
      correctedMetricDifferences: baselineGeometry && correctedGeometry ? Object.fromEntries(metrics.map((metric) => [metric, metricDifference(metric, baselineGeometry, correctedGeometry)])) : null,
    })
  }
  function metricSummary(key: 'metricDifferences' | 'correctedMetricDifferences') { return Object.fromEntries(metrics.map((metric) => {
    const values = comparisons.flatMap((item) => item[key] ? [item[key][metric]] : [])
    const mode = metric === 'mirrorResidual' ? 'absolute_ratio' : metric === 'eyeCanthalTiltDegrees' ? 'absolute_degrees' : 'absolute_relative_fraction'
    const threshold = metric === 'mirrorResidual' ? .02 : metric === 'eyeCanthalTiltDegrees' ? 1 : stableMetrics.has(metric) ? .03 : .05
    return [metric, { comparable: values.length, mode, threshold, difference: distribution(values), passesP95: percentile(values, .95) <= threshold }]
  })) }
  const byMetric = metricSummary('metricDifferences')
  const correctedByMetric = metricSummary('correctedMetricDifferences')
  const discoveryGates = {
    evaluatedAll102MirroredPairs: comparisons.length === 102,
    everyPairPreservesQualityAcceptance: comparisons.every((item) => item.qualityAcceptanceMatches),
    everyPairPreservesMediaPipeAndYuNetDetection: comparisons.every((item) => item.mediapipeDetectionMatches && item.yunetTrustedMatches),
    everyPairPreservesPoseStatus: comparisons.every((item) => item.poseStatusMatches),
    mirrorPoseAxisResidualP95Within2Degrees: percentile(comparisons.map((item) => Math.max(item.yawMirrorResidual, item.pitchMirrorResidual, item.rollMirrorResidual)), .95) <= 2,
    atLeast95ComparableGeometryPairs: comparisons.filter((item) => item.geometryComparable).length >= 95,
    all12ProductMetricsPassMirrorP95: Object.values(byMetric).every((item) => item.passesP95),
  }
  const correctionGates = {
    evaluatedAll102CorrectedPairs: comparisons.length === 102,
    everyCorrectedPairPreservesQualityAcceptance: comparisons.every((item) => item.correctedQualityAcceptanceMatches),
    everyCorrectedPairPreservesMediaPipeAndYuNetDetection: comparisons.every((item) => item.correctedMediaPipeDetectionMatches && item.correctedYuNetTrustedMatches),
    everyCorrectedPairPreservesPoseStatus: comparisons.every((item) => item.correctedPoseStatusMatches),
    correctedPoseAxisResidualP95WithinHalfDegree: percentile(comparisons.map((item) => Math.max(item.correctedYawResidual, item.correctedPitchResidual, item.correctedRollResidual)), .95) <= .5,
    atLeast95CorrectedComparableGeometryPairs: comparisons.filter((item) => item.correctedGeometryComparable).length >= 95,
    all12CorrectedProductMetricsPassP95: Object.values(correctedByMetric).every((item) => item.passesP95),
  }
  const passesRaw = Object.values(discoveryGates).every(Boolean)
  const passesCorrection = Object.values(correctionGates).every(Boolean)
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-FRONT-MIRROR-1.0', source: manifest.source, protocol: manifest.protocol,
    evaluation: {
      comparisons: comparisons.length,
      qualityAcceptanceMatches: comparisons.filter((item) => item.qualityAcceptanceMatches).length,
      detectionMatches: comparisons.filter((item) => item.mediapipeDetectionMatches && item.yunetTrustedMatches).length,
      poseStatusMatches: comparisons.filter((item) => item.poseStatusMatches).length,
      comparableGeometryPairs: comparisons.filter((item) => item.geometryComparable).length,
      qualityScoreDelta: distribution(comparisons.map((item) => item.qualityScoreDelta)),
      yawMirrorResidualDegrees: distribution(comparisons.map((item) => item.yawMirrorResidual)),
      pitchMirrorResidualDegrees: distribution(comparisons.map((item) => item.pitchMirrorResidual)),
      rollMirrorResidualDegrees: distribution(comparisons.map((item) => item.rollMirrorResidual)),
      byMetric,
      corrected: {
        qualityAcceptanceMatches: comparisons.filter((item) => item.correctedQualityAcceptanceMatches).length,
        detectionMatches: comparisons.filter((item) => item.correctedMediaPipeDetectionMatches && item.correctedYuNetTrustedMatches).length,
        poseStatusMatches: comparisons.filter((item) => item.correctedPoseStatusMatches).length,
        comparableGeometryPairs: comparisons.filter((item) => item.correctedGeometryComparable).length,
        qualityScoreDelta: distribution(comparisons.map((item) => item.correctedQualityScoreDelta)),
        yawResidualDegrees: distribution(comparisons.map((item) => item.correctedYawResidual)),
        pitchResidualDegrees: distribution(comparisons.map((item) => item.correctedPitchResidual)),
        rollResidualDegrees: distribution(comparisons.map((item) => item.correctedRollResidual)),
        byMetric: correctedByMetric,
      },
    },
    predeclaredDiscoveryGates: discoveryGates,
    predeclaredCorrectionGates: correctionGates,
    passesRawFrontMirrorContract: passesRaw,
    passesExplicitMirrorCorrectionContract: passesCorrection,
    productionDecision: passesRaw ? 'front_measurements_accept_mirrored_uploads_without_unmirror' : passesCorrection ? 'offer_explicit_front_mirror_correction' : 'reject_mirrored_front_uploads',
    limitations: ['Only neutral studio front images are tested.', 'The result does not apply to right-profile capture, whose direction semantics reverse under mirroring.', 'Canvas-generated horizontal flips do not prove device metadata or preview mirroring behavior.', 'Mirror invariance does not establish measurement accuracy or cross-session repeatability.'],
    retention: { imagesDeletedAfterRun: false, mirroredImagesWritten: false, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2); status.textContent = '完成'
}
main().catch((error) => { resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error); resultElement.textContent = resultElement.dataset.error; status.textContent = '失败' })
