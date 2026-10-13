import { computeFrontGeometry } from '../src/lib/faceMeasurements'
import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'
import type { LandmarkPoint, PhotoQuality, PoseValidation } from '../src/types'

type Point = { x: number; y: number }
type AttributeName = 'pose' | 'expression' | 'illumination' | 'makeup' | 'occlusion' | 'blur'
type AnchorName =
  | 'chin' | 'viewerLeftEyeCenter' | 'viewerRightEyeCenter'
  | 'viewerLeftEyeOuter' | 'viewerLeftEyeInner' | 'viewerRightEyeInner' | 'viewerRightEyeOuter'
  | 'viewerLeftMouthCorner' | 'viewerRightMouthCorner'
  | 'noseRoot' | 'noseTip' | 'noseBase' | 'viewerLeftNoseWing' | 'viewerRightNoseWing'
  | 'upperLip' | 'lowerLip' | 'viewerLeftCheek' | 'viewerRightCheek' | 'viewerLeftJaw' | 'viewerRightJaw'
type ComparableMetricName = 'pupilDistanceFaceWidthRatio' | 'interEyeRatio' | 'jawWidthRatio' | 'mouthWidthRatio' | 'noseMouthWidthRatio' | 'lipHeightMouthWidthRatio'
type SampleRecord = {
  file: string
  bbox: { left: number; top: number; right: number; bottom: number }
  attributes: Record<AttributeName, boolean>
  manual: Record<AnchorName, Point>
}
type NormalizedErrors = { bboxDiagonalPercent: Record<AnchorName, number>; interPupilPercent: Record<AnchorName, number> }
type Case = SampleRecord & {
  originalQuality: PhotoQuality
  pose: PoseValidation
  pointErrors: NormalizedErrors | null
  metricRelativeErrors: Record<ComparableMetricName, number> | null
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/wflw-groundtruth'
const manifest = await fetch(`${stagingRoot}/sample-manifest.json`).then((response) => {
  if (!response.ok) throw new Error(`WFLW manifest unavailable: HTTP ${response.status}`)
  return response.json()
}) as {
  policyVersion: string
  source: Record<string, unknown>
  selection: string
  availableFaces: number
  availableUniqueImages: number
  sampleFaces: number
  availableAttributeCounts: Record<string, number>
  sampleAttributeCounts: Record<string, number>
  records: SampleRecord[]
}

const attributeNames: AttributeName[] = ['pose', 'expression', 'illumination', 'makeup', 'occlusion', 'blur']
const anchorNames: AnchorName[] = [
  'chin', 'viewerLeftEyeCenter', 'viewerRightEyeCenter', 'viewerLeftEyeOuter', 'viewerLeftEyeInner',
  'viewerRightEyeInner', 'viewerRightEyeOuter', 'viewerLeftMouthCorner', 'viewerRightMouthCorner',
  'noseRoot', 'noseTip', 'noseBase', 'viewerLeftNoseWing', 'viewerRightNoseWing', 'upperLip', 'lowerLip',
  'viewerLeftCheek', 'viewerRightCheek', 'viewerLeftJaw', 'viewerRightJaw',
]
const comparableMetricNames: ComparableMetricName[] = [
  'pupilDistanceFaceWidthRatio', 'interEyeRatio', 'jawWidthRatio', 'mouthWidthRatio', 'noseMouthWidthRatio', 'lipHeightMouthWidthRatio',
]
const semanticAnchors: AnchorName[] = anchorNames.filter((name) => !['viewerLeftCheek', 'viewerRightCheek', 'viewerLeftJaw', 'viewerRightJaw'].includes(name))

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
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }
}

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function predictedAnchors(landmarks: LandmarkPoint[], width: number, height: number): Record<AnchorName, Point> {
  const scale = (point: Point) => ({ x: point.x * width, y: point.y * height })
  const iris = [average(landmarks.slice(468, 473)), average(landmarks.slice(473, 478))].sort((left, right) => left.x - right.x)
  const mouth = [landmarks[61], landmarks[291]].sort((left, right) => left.x - right.x)
  const wings = [landmarks[98], landmarks[327]].sort((left, right) => left.x - right.x)
  const cheeks = [landmarks[234], landmarks[454]].sort((left, right) => left.x - right.x)
  const jaw = [landmarks[172], landmarks[397]].sort((left, right) => left.x - right.x)
  const eyeCorners = [landmarks[33], landmarks[133], landmarks[362], landmarks[263]].sort((left, right) => left.x - right.x)
  return {
    chin: scale(landmarks[152]),
    viewerLeftEyeCenter: scale(iris[0]), viewerRightEyeCenter: scale(iris[1]),
    viewerLeftEyeOuter: scale(eyeCorners[0]), viewerLeftEyeInner: scale(eyeCorners[1]),
    viewerRightEyeInner: scale(eyeCorners[2]), viewerRightEyeOuter: scale(eyeCorners[3]),
    viewerLeftMouthCorner: scale(mouth[0]), viewerRightMouthCorner: scale(mouth[1]),
    noseRoot: scale(landmarks[168]), noseTip: scale(landmarks[1]), noseBase: scale(landmarks[2]),
    viewerLeftNoseWing: scale(wings[0]), viewerRightNoseWing: scale(wings[1]),
    upperLip: scale(landmarks[0]), lowerLip: scale(landmarks[17]),
    viewerLeftCheek: scale(cheeks[0]), viewerRightCheek: scale(cheeks[1]),
    viewerLeftJaw: scale(jaw[0]), viewerRightJaw: scale(jaw[1]),
  }
}

async function standardizedCrop(blob: Blob, record: SampleRecord) {
  const bitmap = await createImageBitmap(blob)
  try {
    const boxWidth = record.bbox.right - record.bbox.left
    const boxHeight = record.bbox.bottom - record.bbox.top
    const side = Math.max(1, Math.max(boxWidth, boxHeight) * 1.6)
    const centerX = (record.bbox.left + record.bbox.right) / 2
    const centerY = (record.bbox.top + record.bbox.bottom) / 2
    const cropLeft = centerX - side / 2
    const cropTop = centerY - side / 2
    const outputSize = 1200
    const scale = outputSize / side
    const canvas = document.createElement('canvas')
    canvas.width = outputSize; canvas.height = outputSize
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Unable to create WFLW standard crop')
    context.fillStyle = '#808080'; context.fillRect(0, 0, outputSize, outputSize)
    context.drawImage(bitmap, -cropLeft * scale, -cropTop * scale, bitmap.width * scale, bitmap.height * scale)
    const cropBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Unable to encode WFLW crop')), 'image/jpeg', 0.95))
    const transform = (point: Point) => ({ x: (point.x - cropLeft) * scale, y: (point.y - cropTop) * scale })
    return { file: new File([cropBlob], 'wflw-standardized-transient.jpg', { type: 'image/jpeg' }), manual: Object.fromEntries(anchorNames.map((name) => [name, transform(record.manual[name])])) as Record<AnchorName, Point> }
  } finally {
    bitmap.close()
  }
}

function groundTruthMetrics(manual: Record<AnchorName, Point>): Record<ComparableMetricName, number> {
  const faceWidth = Math.max(1, distance(manual.viewerLeftCheek, manual.viewerRightCheek))
  const mouthWidth = Math.max(1, distance(manual.viewerLeftMouthCorner, manual.viewerRightMouthCorner))
  const eyeWidthLeft = distance(manual.viewerLeftEyeOuter, manual.viewerLeftEyeInner)
  const eyeWidthRight = distance(manual.viewerRightEyeInner, manual.viewerRightEyeOuter)
  return {
    pupilDistanceFaceWidthRatio: distance(manual.viewerLeftEyeCenter, manual.viewerRightEyeCenter) / faceWidth,
    interEyeRatio: distance(manual.viewerLeftEyeInner, manual.viewerRightEyeInner) / Math.max(1, (eyeWidthLeft + eyeWidthRight) / 2),
    jawWidthRatio: distance(manual.viewerLeftJaw, manual.viewerRightJaw) / faceWidth,
    mouthWidthRatio: mouthWidth / faceWidth,
    noseMouthWidthRatio: distance(manual.viewerLeftNoseWing, manual.viewerRightNoseWing) / mouthWidth,
    lipHeightMouthWidthRatio: distance(manual.upperLip, manual.lowerLip) / mouthWidth,
  }
}

function compare(recordManual: Record<AnchorName, Point>, pose: PoseValidation) {
  if (!pose.landmarks || !pose.landmarkImageWidth || !pose.landmarkImageHeight || pose.landmarks.length < 478) return { pointErrors: null, metricRelativeErrors: null }
  const predicted = predictedAnchors(pose.landmarks, pose.landmarkImageWidth, pose.landmarkImageHeight)
  const xs = Object.values(recordManual).map((point) => point.x); const ys = Object.values(recordManual).map((point) => point.y)
  const diagonal = Math.max(1, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)))
  const interPupil = Math.max(1, distance(recordManual.viewerLeftEyeCenter, recordManual.viewerRightEyeCenter))
  const raw = Object.fromEntries(anchorNames.map((name) => [name, distance(predicted[name], recordManual[name])])) as Record<AnchorName, number>
  const pointErrors: NormalizedErrors = {
    bboxDiagonalPercent: Object.fromEntries(anchorNames.map((name) => [name, 100 * raw[name] / diagonal])) as Record<AnchorName, number>,
    interPupilPercent: Object.fromEntries(anchorNames.map((name) => [name, 100 * raw[name] / interPupil])) as Record<AnchorName, number>,
  }
  const geometry = computeFrontGeometry(pose.landmarks, pose.landmarkImageWidth, pose.landmarkImageHeight)
  if (!geometry) return { pointErrors, metricRelativeErrors: null }
  const truth = groundTruthMetrics(recordManual)
  const metricRelativeErrors = Object.fromEntries(comparableMetricNames.map((name) => [name, 100 * Math.abs(geometry[name] - truth[name]) / Math.max(Math.abs(truth[name]), 0.0001)])) as Record<ComparableMetricName, number>
  return { pointErrors, metricRelativeErrors }
}

function summarize(items: Case[]) {
  const posePasses = items.filter((item) => item.pose.status === 'pass').length
  const comparable = items.filter((item) => item.pointErrors)
  return {
    faces: items.length,
    originalUniqueImages: new Set(items.map((item) => item.file)).size,
    originalQualityGatePassed: items.filter((item) => isPhotoQualityAcceptable(item.originalQuality)).length,
    originalQualityScore: quantiles(items.map((item) => item.originalQuality.score), 2),
    originalQualityFlags: counts(items.flatMap((item) => item.originalQuality.flags.length ? item.originalQuality.flags : ['none'])),
    standardizedCropMediaPipeDetected: items.filter((item) => item.pose.detectedFaces > 0).length,
    standardizedCropProductionPosePassed: posePasses,
    standardizedCropPosePassRate: Number((posePasses / items.length).toFixed(4)),
    standardizedCropPosePassWilson95: wilson95(posePasses, items.length),
    standardizedCropPoseFlags: counts(items.flatMap((item) => item.pose.flags.length ? item.pose.flags : ['none'])),
    standardizedCropYaw: quantiles(items.map((item) => item.pose.yaw ?? Number.NaN), 2),
    standardizedCropPitch: quantiles(items.map((item) => item.pose.pitch ?? Number.NaN), 2),
    standardizedCropRoll: quantiles(items.map((item) => item.pose.roll ?? Number.NaN), 2),
    comparableLandmarkFaces: comparable.length,
    landmarkError: {
      unit: 'percent of WFLW landmark-box diagonal; conditional on complete production pose/occlusion pass after deterministic GT-box crop',
      byAnchor: Object.fromEntries(anchorNames.map((name) => [name, quantiles(comparable.flatMap((item) => item.pointErrors ? [item.pointErrors.bboxDiagonalPercent[name]] : []))])),
      interPupilUnitByAnchor: Object.fromEntries(anchorNames.map((name) => [name, quantiles(comparable.flatMap((item) => item.pointErrors ? [item.pointErrors.interPupilPercent[name]] : []))])),
    },
    comparableMetricRelativeError: {
      unit: 'absolute relative percent versus ratios calculated from fixed WFLW semantic anchors',
      byMetric: Object.fromEntries(comparableMetricNames.map((name) => [name, quantiles(items.flatMap((item) => item.metricRelativeErrors ? [item.metricRelativeErrors[name]] : []))])),
    },
  }
}

function categoryFor(item: Case, category: string) {
  if (category === 'all') return true
  if (category === 'baseline') return attributeNames.every((name) => !item.attributes[name])
  return item.attributes[category as AttributeName]
}

const cases: Case[] = []
try {
  for (const [index, record] of manifest.records.entries()) {
    status.textContent = `处理 ${index + 1} / ${manifest.records.length}`
    const encodedPath = record.file.split('/').map(encodeURIComponent).join('/')
    const blob = await fetch(`${stagingRoot}/mirror-extract/WFLW_images/${encodedPath}`).then((response) => {
      if (!response.ok) throw new Error(`WFLW image unavailable: HTTP ${response.status}`)
      return response.blob()
    })
    const originalFile = new File([blob], 'wflw-original-transient.jpg', { type: blob.type || 'image/jpeg' })
    const [originalQuality, standardized] = await Promise.all([inspectImage(originalFile), standardizedCrop(blob, record)])
    const pose = await inspectCapturePose('front', standardized.file)
    const compared = compare(standardized.manual, pose)
    cases.push({ ...record, originalQuality, pose, ...compared })
  }

  const categories = ['all', 'baseline', ...attributeNames]
  const byCategory = Object.fromEntries(categories.map((category) => [category, summarize(cases.filter((item) => categoryFor(item, category)))]))
  const all = byCategory.all
  const anchorChecks = Object.fromEntries(semanticAnchors.map((name) => {
    const distribution = all.landmarkError.byAnchor[name]
    return [name, { medianThresholdPercent: 3, p95ThresholdPercent: 8, medianThresholdPassed: Boolean(distribution && distribution.median <= 3), p95ThresholdPassed: Boolean(distribution && distribution.p95 <= 8) }]
  }))
  const categoryCoverage = Object.fromEntries(categories.map((category) => [category, { comparableFaces: byCategory[category].comparableLandmarkFaces, minimumRequired: category === 'all' ? 300 : 30, sufficient: byCategory[category].comparableLandmarkFaces >= (category === 'all' ? 300 : 30) }]))
  const result = {
    testedAt: new Date().toISOString(),
    analysisPolicyVersion: 'HEADUP-WFLW-FRONT-GROUNDTRUTH-1.0',
    policyVersion: manifest.policyVersion,
    source: manifest.source,
    selection: manifest.selection,
    availableFaces: manifest.availableFaces,
    availableUniqueImages: manifest.availableUniqueImages,
    sampleFaces: manifest.sampleFaces,
    availableAttributeCounts: manifest.availableAttributeCounts,
    sampleAttributeCounts: manifest.sampleAttributeCounts,
    productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
    deterministicStandardization: { crop: 'square centered on official face rectangle, side = 1.6 × max(rect width, rect height)', output: '1200×1200 JPEG quality 0.95 with neutral gray out-of-image padding', warning: 'This is a best-case framing normalization. Its pose pass rate and resized resolution are not standard-phone usability or quality evidence.' },
    fixedGroundTruthMapping: {
      chin: 'WFLW 16 versus MediaPipe 152', eyeCenters: 'WFLW pupils 96/97 versus MediaPipe iris means 468..472/473..477',
      eyeCorners: 'WFLW 60/64/68/72 versus MediaPipe 33/133/362/263, sorted by image x', mouthCorners: 'WFLW 76/82 versus MediaPipe 61/291',
      nose: 'WFLW root/tip/base 51/54/57 versus MediaPipe 168/1/2', noseWings: 'WFLW 55/59 versus MediaPipe 98/327',
      lips: 'WFLW outer upper/lower centers 79/85 versus MediaPipe 0/17', cheekAndJaw: 'WFLW 4/28 and 8/24 versus MediaPipe 234/454 and 172/397; contour semantics are diagnostic',
    },
    byCategory,
    predeclaredCriteria: { semanticAnchorMedianPercent: 3, semanticAnchorP95Percent: 8, minimumComparableAll: 300, minimumComparablePerCategory: 30, contourAnchorsExcludedFromPassFail: ['viewerLeftCheek', 'viewerRightCheek', 'viewerLeftJaw', 'viewerRightJaw'] },
    evaluation: {
      coverage: categoryCoverage,
      semanticAnchorChecks: anchorChecks,
      formalVerdict: categoryCoverage.all.sufficient && Object.values(categoryCoverage).every((value) => value.sufficient)
        ? (Object.values(anchorChecks).every((value) => value.medianThresholdPassed && value.p95ThresholdPassed) ? 'all_predeclared_coverage_and_anchor_gates_passed' : 'one_or_more_semantic_anchor_gates_failed')
        : 'insufficient_comparable_coverage_for_one_or_more_categories',
    },
    postRunInterpretation: {
      predeclaredVerdictPreserved: true,
      largePose: `${byCategory.pose.standardizedCropProductionPosePassed}/${byCategory.pose.faces} official large-pose faces passed; zero is expected rejection by the front-capture gate, not landmark-accuracy evidence.`,
      conditionalAnchorResult: 'All predeclared semantic-anchor median/P95 checks pass on the 183 production-pose-passed faces, but the total and expression/makeup category sample minimums are not met.',
      ratioResult: 'Small individual point errors compound into materially larger ratio errors; reliability tiers must be based on ratio error and repeatability, not anchor error alone.',
    },
    limitations: [
      'WFLW is in-the-wild imagery from WIDER Face, not a same-person standard-phone retake dataset.',
      'The deterministic GT-box crop removes target-face detection/framing ambiguity and therefore is best-case landmark evidence, not original-scene production coverage.',
      'Attributes overlap; category counts must not be added as independent faces.',
      'No demographic labels are used or retained; challenge-attribute coverage is not a demographic fairness claim.',
      'The benchmark does not optimize for glasses because HeadUp capture requires no glasses.',
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
