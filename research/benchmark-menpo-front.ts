import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'
import type { LandmarkPoint, PhotoQuality, PoseValidation } from '../src/types'

type Point = { x: number; y: number }
type PointName = 'chin' | 'viewerLeftEyeCenter' | 'viewerRightEyeCenter' | 'viewerLeftMouthCorner' | 'viewerRightMouthCorner' | 'noseTip' | 'viewerLeftCheek' | 'viewerRightCheek'
type SampleRecord = {
  file: string
  partition: 'engineering' | 'holdout'
  bboxDiagonal: number
  interEyeDistance: number
  manual: Record<PointName, Point>
}
type NormalizedErrors = { bboxDiagonalPercent: Record<PointName, number>; interEyePercent: Record<PointName, number> }
type Case = SampleRecord & { quality: PhotoQuality; pose: PoseValidation; pointErrors: NormalizedErrors | null }

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/menpo-front-groundtruth'
const manifest = await fetch(`${stagingRoot}/sample-manifest.json`).then((response) => {
  if (!response.ok) throw new Error(`Menpo manifest unavailable: HTTP ${response.status}`)
  return response.json()
}) as {
  policyVersion: string
  source: Record<string, unknown>
  selection: string
  imageCount: number
  partitionCounts: Record<string, number>
  records: SampleRecord[]
}

const pointNames: PointName[] = [
  'chin', 'viewerLeftEyeCenter', 'viewerRightEyeCenter', 'viewerLeftMouthCorner',
  'viewerRightMouthCorner', 'noseTip', 'viewerLeftCheek', 'viewerRightCheek',
]

function quantiles(values: number[], digits = 3) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const at = (fraction: number) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(digits))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

function counts(values: string[]) {
  return Object.fromEntries(Object.entries(Object.groupBy(values, (value) => value)).map(([key, items]) => [key, items.length]))
}

function wilson95(successes: number, total: number) {
  if (total === 0) return null
  const z = 1.959963984540054
  const proportion = successes / total
  const denominator = 1 + z * z / total
  const center = (proportion + z * z / (2 * total)) / denominator
  const margin = z * Math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total)) / denominator
  return { low: Number((center - margin).toFixed(4)), high: Number((center + margin).toFixed(4)) }
}

function average(points: LandmarkPoint[]): Point {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
}

function predictedPoints(landmarks: LandmarkPoint[], width: number, height: number): Record<PointName, Point> {
  const irisA = average(landmarks.slice(468, 473))
  const irisB = average(landmarks.slice(473, 478))
  const [viewerLeftEyeCenter, viewerRightEyeCenter] = [irisA, irisB].sort((left, right) => left.x - right.x)
  const [viewerLeftMouthCorner, viewerRightMouthCorner] = [landmarks[61], landmarks[291]].sort((left, right) => left.x - right.x)
  const [viewerLeftCheek, viewerRightCheek] = [landmarks[234], landmarks[454]].sort((left, right) => left.x - right.x)
  const scale = (point: Point) => ({ x: point.x * width, y: point.y * height })
  return {
    chin: scale(landmarks[152]),
    viewerLeftEyeCenter: scale(viewerLeftEyeCenter),
    viewerRightEyeCenter: scale(viewerRightEyeCenter),
    viewerLeftMouthCorner: scale(viewerLeftMouthCorner),
    viewerRightMouthCorner: scale(viewerRightMouthCorner),
    noseTip: scale(landmarks[1]),
    viewerLeftCheek: scale(viewerLeftCheek),
    viewerRightCheek: scale(viewerRightCheek),
  }
}

function pointErrors(record: SampleRecord, pose: PoseValidation): NormalizedErrors | null {
  if (!pose.landmarks || !pose.landmarkImageWidth || !pose.landmarkImageHeight || pose.landmarks.length < 478) return null
  const predicted = predictedPoints(pose.landmarks, pose.landmarkImageWidth, pose.landmarkImageHeight)
  const distances = Object.fromEntries(pointNames.map((name) => {
    const truth = record.manual[name]
    return [name, Math.hypot(predicted[name].x - truth.x, predicted[name].y - truth.y)]
  })) as Record<PointName, number>
  return {
    bboxDiagonalPercent: Object.fromEntries(pointNames.map((name) => [name, 100 * distances[name] / record.bboxDiagonal])) as Record<PointName, number>,
    interEyePercent: Object.fromEntries(pointNames.map((name) => [name, 100 * distances[name] / record.interEyeDistance])) as Record<PointName, number>,
  }
}

function isJointGatePassed(item: Case) {
  return item.pose.status === 'pass' && isPhotoQualityAcceptable(item.quality)
}

function summarize(items: Case[]) {
  const posePasses = items.filter((item) => item.pose.status === 'pass').length
  const qualityPasses = items.filter((item) => isPhotoQualityAcceptable(item.quality)).length
  const jointPasses = items.filter(isJointGatePassed).length
  return {
    images: items.length,
    mediaPipeFaceDetected: items.filter((item) => item.pose.detectedFaces > 0).length,
    productionPoseGatePassed: posePasses,
    productionPoseGatePassRate: Number((posePasses / items.length).toFixed(4)),
    productionPoseGateWilson95: wilson95(posePasses, items.length),
    qualityGatePassed: qualityPasses,
    qualityGatePassRate: Number((qualityPasses / items.length).toFixed(4)),
    jointPoseAndQualityGatePassed: jointPasses,
    jointGatePassRate: Number((jointPasses / items.length).toFixed(4)),
    jointGateWilson95: wilson95(jointPasses, items.length),
    qualityScore: quantiles(items.map((item) => item.quality.score), 2),
    yuNetFaceScore: quantiles(items.map((item) => item.pose.faceDetectorScore ?? Number.NaN), 4),
    faceAreaRatio: quantiles(items.map((item) => item.pose.faceAreaRatio ?? Number.NaN), 4),
    faceCenterDistance: quantiles(items.map((item) => item.pose.faceCenterDistance ?? Number.NaN), 4),
    yaw: quantiles(items.map((item) => item.pose.yaw ?? Number.NaN), 2),
    pitch: quantiles(items.map((item) => item.pose.pitch ?? Number.NaN), 2),
    roll: quantiles(items.map((item) => item.pose.roll ?? Number.NaN), 2),
    poseFlags: counts(items.flatMap((item) => item.pose.flags.length ? item.pose.flags : ['none'])),
    qualityFlags: counts(items.flatMap((item) => item.quality.flags.length ? item.quality.flags : ['none'])),
  }
}

function summarizePointErrors(items: Case[]) {
  const available = items.filter((item) => item.pointErrors)
  const jointGate = available.filter(isJointGatePassed)
  const group = (cases: Case[], unit: keyof NormalizedErrors) => Object.fromEntries(pointNames.map((name) => {
    const values = cases.flatMap((item) => item.pointErrors ? [item.pointErrors[unit][name]] : [])
    return [name, { distribution: quantiles(values), above8Percent: values.filter((value) => value > 8).length, above12Percent: values.filter((value) => value > 12).length }]
  }))
  return {
    productionPosePassedComparableImages: available.length,
    jointPoseAndQualityPassedComparableImages: jointGate.length,
    note: 'Production intentionally exposes landmarks only after its complete pose and front-occlusion gate; rejected wild images are coverage failures, not silently excluded accuracy successes.',
    productionPosePassed: {
      bboxDiagonalPercent: group(available, 'bboxDiagonalPercent'),
      interEyePercent: group(available, 'interEyePercent'),
    },
    jointPoseAndQualityPassed: {
      bboxDiagonalPercent: group(jointGate, 'bboxDiagonalPercent'),
      interEyePercent: group(jointGate, 'interEyePercent'),
    },
  }
}

const cases: Case[] = []
try {
  for (const [index, record] of manifest.records.entries()) {
    status.textContent = `处理 ${index + 1} / ${manifest.records.length}`
    const encodedPath = record.file.split('/').map(encodeURIComponent).join('/')
    const blob = await fetch(`${stagingRoot}/extract/${encodedPath}`).then((response) => {
      if (!response.ok) throw new Error(`Menpo sample unavailable: HTTP ${response.status}`)
      return response.blob()
    })
    const file = new File([blob], 'menpo-transient.jpg', { type: blob.type || 'image/jpeg' })
    const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
    cases.push({ ...record, quality, pose, pointErrors: pointErrors(record, pose) })
  }

  const byPartition = Object.fromEntries((['engineering', 'holdout'] as const).map((partition) => {
    const partitionCases = cases.filter((item) => item.partition === partition)
    return [partition, { captureGate: summarize(partitionCases), landmarkError: summarizePointErrors(partitionCases) }]
  }))
  const holdoutAudit = byPartition.holdout.landmarkError
  const posePassedDiagonal = holdoutAudit.productionPosePassed.bboxDiagonalPercent
  const coreNames: PointName[] = ['viewerLeftEyeCenter', 'viewerRightEyeCenter', 'viewerLeftMouthCorner', 'viewerRightMouthCorner', 'noseTip']
  const diagnosticChecks = Object.fromEntries(coreNames.map((name) => {
    const distribution = posePassedDiagonal[name].distribution
    return [name, {
      medianThresholdPercent: 3,
      p95ThresholdPercent: 8,
      medianThresholdPassed: Boolean(distribution && distribution.median <= 3),
      p95ThresholdPassed: Boolean(distribution && distribution.p95 <= 8),
    }]
  }))
  diagnosticChecks.chin = {
    medianThresholdPercent: 5,
    p95ThresholdPercent: 12,
    medianThresholdPassed: Boolean(posePassedDiagonal.chin.distribution && posePassedDiagonal.chin.distribution.median <= 5),
    p95ThresholdPassed: Boolean(posePassedDiagonal.chin.distribution && posePassedDiagonal.chin.distribution.p95 <= 12),
  }
  const result = {
    testedAt: new Date().toISOString(),
    analysisPolicyVersion: 'HEADUP-MENPO-FRONT-GROUNDTRUTH-1.0',
    policyVersion: manifest.policyVersion,
    source: manifest.source,
    selection: manifest.selection,
    images: cases.length,
    partitions: manifest.partitionCounts,
    productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
    overall: { captureGate: summarize(cases), landmarkError: summarizePointErrors(cases) },
    byPartition,
    fixedGroundTruthMapping: {
      chin: 'Menpo/iBUG 68-point index 8 versus MediaPipe 152',
      eyeCenters: 'means of Menpo 36..41 and 42..47 versus MediaPipe iris means 468..472 and 473..477, sorted by image x',
      mouthCorners: 'Menpo 48 and 54 versus MediaPipe 61 and 291, sorted by image x',
      noseTip: 'Menpo 30 versus MediaPipe 1',
      visibleCheeks: 'Menpo jaw-contour 2 and 14 versus MediaPipe 234 and 454; diagnostic only because the annotation semantics are not identical',
      coordinateConvention: 'Menpo PTS coordinates converted from 1-based to 0-based pixels before comparison',
    },
    predeclaredInterpretation: {
      stressCoverage: 'A predeclared hash-stratified 1,200-image sample from all 6,655 semi-frontal in-the-wild annotations measures failure boundaries; the images are not claimed to follow the HeadUp phone capture protocol.',
      targetProxy: 'The joint production pose-and-quality passed subset is the closer proxy, but remains internet imagery rather than same-person mobile retakes.',
      anchorAuditThresholds: {
        coreAnchors: 'On holdout joint-gate images, each eye center, mouth corner and nose tip: median <= 3% and P95 <= 8% of GT face-box diagonal.',
        chin: 'On holdout joint-gate images: median <= 5% and P95 <= 12% of GT face-box diagonal.',
        minimumComparableHoldoutImages: 100,
        visibleCheeks: 'Reported diagnostically and excluded from pass/fail because Menpo jaw points 2/14 and MediaPipe cheek points are semantically non-identical.',
      },
    },
    evaluation: {
      formalTargetProxyVerdict: holdoutAudit.jointPoseAndQualityPassedComparableImages >= 100 ? 'eligible_for_threshold_evaluation' : 'insufficient_comparable_holdout_images',
      holdoutJointGateComparableImages: holdoutAudit.jointPoseAndQualityPassedComparableImages,
      requiredHoldoutJointGateComparableImages: 100,
      diagnosticOnlyOnProductionPosePassedHoldout: {
        comparableImages: holdoutAudit.productionPosePassedComparableImages,
        warning: 'This larger subset omits the production pixel-quality requirement and is diagnostic, not the predeclared target-proxy verdict.',
        checks: diagnosticChecks,
      },
    },
    limitations: [
      'Menpo semi-frontal images deliberately include uncontrolled pose, expression, occlusion, illumination and crop.',
      'The dataset has no HeadUp front/left/right same-session triplets and cannot validate retake repeatability.',
      'No demographic labels are used or retained; coverage is photographic-condition coverage, not a demographic fairness claim.',
      'The benchmark does not optimize for glasses because the product protocol requires capture without glasses.',
    ],
    retention: { imagesRetainedAfterCleanup: false, annotationsRetainedAfterCleanup: false, individualPredictionsRetained: false, originalIdentifiersRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  status.textContent = '完成'
} catch (error) {
  resultElement.dataset.error = error instanceof Error ? error.stack || error.message : String(error)
  status.textContent = '失败'
  throw error
}
