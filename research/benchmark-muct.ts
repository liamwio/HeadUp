import { computeFrontGeometry, type FrontGeometry } from '../src/lib/faceMeasurements'
import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'
import type { LandmarkPoint, PhotoQuality, PoseValidation } from '../src/types'

type Point = { x: number; y: number }
type SampleRecord = {
  file: string
  subjectToken: string
  camera: 'a' | 'b' | 'c' | 'd' | 'e'
  light: string
  baseLight: string
  manual: {
    chin: Point
    viewerLeftEyeCenter: Point
    viewerRightEyeCenter: Point
    viewerLeftMouthCorner: Point
    viewerRightMouthCorner: Point
    noseTip: Point
  }
}
type Case = SampleRecord & {
  quality: PhotoQuality
  pose: PoseValidation
  geometry: FrontGeometry | null
  pointErrors: Record<string, number> | null
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/data/face-benchmark/.staging/muct'
const manifest = await fetch(`${stagingRoot}/sample-manifest.json`).then((response) => {
  if (!response.ok) throw new Error(`MUCT manifest unavailable: HTTP ${response.status}`)
  return response.json()
}) as {
  policyVersion: string
  source: Record<string, unknown>
  selection: string
  subjectCount: number
  imageCount: number
  cameraCounts: Record<string, number>
  sourceArchives: Array<Record<string, unknown>>
  records: SampleRecord[]
}

function quantiles(values: number[], digits = 4) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const at = (fraction: number) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(digits))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

function counts(values: string[]) {
  return Object.fromEntries(Object.entries(Object.groupBy(values, (value) => value)).map(([key, items]) => [key, items.length]))
}

function wilson95(successes: number, total: number) {
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

function predictedPoints(landmarks: LandmarkPoint[], width: number, height: number) {
  const irisA = average(landmarks.slice(468, 473))
  const irisB = average(landmarks.slice(473, 478))
  const [viewerLeftEyeCenter, viewerRightEyeCenter] = [irisA, irisB].sort((left, right) => left.x - right.x)
  const [viewerLeftMouthCorner, viewerRightMouthCorner] = [landmarks[61], landmarks[291]].sort((left, right) => left.x - right.x)
  const scale = (point: Point) => ({ x: point.x * width, y: point.y * height })
  return {
    chin: scale(landmarks[152]),
    viewerLeftEyeCenter: scale(viewerLeftEyeCenter),
    viewerRightEyeCenter: scale(viewerRightEyeCenter),
    viewerLeftMouthCorner: scale(viewerLeftMouthCorner),
    viewerRightMouthCorner: scale(viewerRightMouthCorner),
    noseTip: scale(landmarks[1]),
  }
}

function manualPointErrors(record: SampleRecord, pose: PoseValidation) {
  if (!pose.landmarks || !pose.landmarkImageWidth || !pose.landmarkImageHeight || pose.landmarks.length < 478) return null
  const leftEye = record.manual.viewerLeftEyeCenter
  const rightEye = record.manual.viewerRightEyeCenter
  const interPupil = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y)
  if (interPupil < 1) return null
  const predicted = predictedPoints(pose.landmarks, pose.landmarkImageWidth, pose.landmarkImageHeight)
  return Object.fromEntries(Object.entries(record.manual).flatMap(([name, truth]) => {
    if (truth.x === 0 && truth.y === 0) return []
    const point = predicted[name as keyof typeof predicted]
    return [[name, 100 * Math.hypot(point.x - truth.x, point.y - truth.y) / interPupil]]
  }))
}

function summarize(items: Case[]) {
  const posePasses = items.filter((item) => item.pose.status === 'pass').length
  const qualityPasses = items.filter((item) => isPhotoQualityAcceptable(item.quality)).length
  return {
    images: items.length,
    mediaPipeFaceDetected: items.filter((item) => item.pose.detectedFaces > 0).length,
    poseGatePassed: posePasses,
    poseGatePassRate: Number((posePasses / items.length).toFixed(4)),
    poseGateWilson95: wilson95(posePasses, items.length),
    qualityGatePassed: qualityPasses,
    qualityGatePassRate: Number((qualityPasses / items.length).toFixed(4)),
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

function grouped(cases: Case[], key: (item: Case) => string) {
  return Object.fromEntries(Object.entries(Object.groupBy(cases, key)).map(([name, items]) => [name, summarize(items)]))
}

function counterfactualFrontPass(item: Case, centerThreshold: number, yawThreshold = 20) {
  return item.pose.detectedFaces === 1
    && (item.pose.faceDetectorScore ?? 0) >= 0.9
    && (item.pose.faceAreaRatio ?? 0) >= 0.09
    && (item.pose.faceCenterDistance ?? Number.POSITIVE_INFINITY) <= centerThreshold
    && Math.abs(item.pose.roll ?? Number.POSITIVE_INFINITY) <= 12
    && Math.abs(item.pose.yaw ?? Number.POSITIVE_INFINITY) <= yawThreshold
}

function subjectPartition(item: Case) {
  const index = Number(item.subjectToken.slice('subject-'.length))
  return index <= 80 ? 'engineering' : 'holdout'
}

function jointCenterYawSweep(cases: Case[]) {
  const baseLighting = cases.filter((item) => item.light === item.baseLight)
  return [0.12, 0.15, 0.18, 0.2].flatMap((centerThreshold) => [10, 12, 15, 18, 20].map((yawThreshold) => ({
    centerThreshold,
    yawThreshold,
    partitions: Object.fromEntries(['engineering', 'holdout'].map((partition) => {
      const partitionCases = baseLighting.filter((item) => subjectPartition(item) === partition)
      return [partition, {
        subjects: new Set(partitionCases.map((item) => item.subjectToken)).size,
        byCamera: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((camera) => {
          const cameraCases = partitionCases.filter((item) => item.camera === camera)
          return [camera, { accepted: cameraCases.filter((item) => counterfactualFrontPass(item, centerThreshold, yawThreshold)).length, total: cameraCases.length }]
        })),
      }]
    })),
  })))
}

function centerThresholdSweep(cases: Case[]) {
  const baseLighting = cases.filter((item) => item.light === item.baseLight)
  return [0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25].map((threshold) => ({
    threshold,
    frontCameraAllLightingAccepted: cases.filter((item) => item.camera === 'a' && counterfactualFrontPass(item, threshold)).length,
    frontCameraAllLightingTotal: cases.filter((item) => item.camera === 'a').length,
    pairedBaseLightingAcceptedByCamera: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((camera) => {
      const cameraCases = baseLighting.filter((item) => item.camera === camera)
      return [camera, { accepted: cameraCases.filter((item) => counterfactualFrontPass(item, threshold)).length, total: cameraCases.length }]
    })),
  }))
}

function summarizePointErrors(cases: Case[]) {
  const available = cases.filter((item) => item.pointErrors)
  const names = ['chin', 'viewerLeftEyeCenter', 'viewerRightEyeCenter', 'viewerLeftMouthCorner', 'viewerRightMouthCorner', 'noseTip']
  return {
    acceptedImagesWithComparableLandmarks: available.length,
    conditionalOnProductionPosePass: true,
    unit: 'percent of manually annotated inter-pupil distance',
    byPoint: Object.fromEntries(names.map((name) => [name, quantiles(available.flatMap((item) => item.pointErrors?.[name] ?? []), 2)])),
  }
}

const geometryKeys: Array<keyof FrontGeometry> = [
  'mirrorResidual', 'visibleFaceLengthWidthRatio', 'pupilDistanceFaceWidthRatio', 'interEyeRatio', 'eyeCanthalTiltDegrees',
  'jawWidthRatio', 'mouthWidthRatio', 'midfaceHeightRatio', 'lowerFaceHeightRatio', 'midLowerFaceHeightRatio',
  'noseMouthWidthRatio', 'noseLengthFaceHeightRatio', 'lipHeightMouthWidthRatio',
]

function geometryDrift(cases: Case[], mode: 'cameraHeight' | 'lighting') {
  const differences: Record<string, number[]> = Object.fromEntries(geometryKeys.map((key) => [key, []]))
  let pairs = 0
  const bySubject = Object.groupBy(cases, (item) => item.subjectToken)
  for (const subjectCases of Object.values(bySubject)) {
    const baseline = subjectCases.find((item) => item.camera === 'a' && item.light === item.baseLight && item.geometry)
    if (!baseline?.geometry) continue
    const comparisons = mode === 'cameraHeight'
      ? subjectCases.filter((item) => ['d', 'e'].includes(item.camera) && item.light === item.baseLight && item.geometry)
      : subjectCases.filter((item) => item.camera === 'a' && item.light !== item.baseLight && item.geometry)
    for (const item of comparisons) {
      if (!item.geometry) continue
      pairs += 1
      for (const key of geometryKeys) {
        const base = baseline.geometry[key]
        const value = item.geometry[key]
        differences[key].push(key === 'mirrorResidual'
          ? Math.abs(value - base) * 100
          : key === 'eyeCanthalTiltDegrees'
            ? Math.abs(value - base)
            : Math.abs(value - base) / Math.max(Math.abs(base), 0.0001) * 100)
      }
    }
  }
  return {
    comparablePairs: pairs,
    baseline: 'same subject, camera a, selected base lighting',
    comparison: mode === 'cameraHeight' ? 'same lighting, cameras d/e' : 'same camera a, other lighting sets',
    units: { mirrorResidual: 'absolute percentage points', eyeCanthalTiltDegrees: 'absolute degrees', otherMetrics: 'absolute relative percent' },
    byMetric: Object.fromEntries(geometryKeys.map((key) => [key, quantiles(differences[key], 2)])),
  }
}

function geometryDriftWithPitchGate(cases: Case[], threshold: number) {
  const differences: Record<string, number[]> = Object.fromEntries(geometryKeys.map((key) => [key, []]))
  let pairs = 0
  for (const subjectCases of Object.values(Object.groupBy(cases, (item) => item.subjectToken))) {
    const baseline = subjectCases.find((item) => item.camera === 'a' && item.light === item.baseLight && item.geometry
      && item.pose.status === 'pass' && Math.abs(item.pose.pitch ?? Number.POSITIVE_INFINITY) <= threshold)
    if (!baseline?.geometry) continue
    const comparisons = subjectCases.filter((item) => ['d', 'e'].includes(item.camera) && item.light === item.baseLight && item.geometry
      && item.pose.status === 'pass' && Math.abs(item.pose.pitch ?? Number.POSITIVE_INFINITY) <= threshold)
    for (const item of comparisons) {
      if (!item.geometry) continue
      pairs += 1
      for (const key of geometryKeys) {
        const base = baseline.geometry[key]
        const value = item.geometry[key]
        differences[key].push(key === 'mirrorResidual'
          ? Math.abs(value - base) * 100
          : key === 'eyeCanthalTiltDegrees'
            ? Math.abs(value - base)
            : Math.abs(value - base) / Math.max(Math.abs(base), 0.0001) * 100)
      }
    }
  }
  return {
    comparablePairs: pairs,
    conditionalGate: `current production front gate plus |pitch| <= ${threshold} degrees on both baseline and camera-height comparison`,
    units: { mirrorResidual: 'absolute percentage points', eyeCanthalTiltDegrees: 'absolute degrees', otherMetrics: 'absolute relative percent' },
    byMetric: Object.fromEntries(geometryKeys.map((key) => [key, quantiles(differences[key], 2)])),
  }
}

function pitchGateCalibration(cases: Case[]) {
  const thresholds = [3, 5, 7, 8, 9, 10, 12, 15]
  return thresholds.map((threshold) => ({
    threshold,
    byPartition: Object.fromEntries(['engineering', 'holdout', 'all'].map((partition) => {
      const partitionCases = partition === 'all' ? cases : cases.filter((item) => subjectPartition(item) === partition)
      const baseLighting = partitionCases.filter((item) => item.light === item.baseLight)
      return [partition, {
        subjects: new Set(partitionCases.map((item) => item.subjectToken)).size,
        byCamera: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((camera) => {
          const cameraCases = baseLighting.filter((item) => item.camera === camera)
          const productionAccepted = cameraCases.filter((item) => item.pose.status === 'pass')
          return [camera, {
            images: cameraCases.length,
            productionAccepted: productionAccepted.length,
            acceptedWithPitchGate: productionAccepted.filter((item) => Math.abs(item.pose.pitch ?? Number.POSITIVE_INFINITY) <= threshold).length,
          }]
        })),
        acceptedCameraHeightGeometryDrift: geometryDriftWithPitchGate(partitionCases, threshold),
      }]
    })),
  }))
}

const cases: Case[] = []
for (const [index, record] of manifest.records.entries()) {
  status.textContent = `处理 ${index + 1} / ${manifest.records.length}`
  const blob = await fetch(`${stagingRoot}/sample/${record.file}`).then((response) => {
    if (!response.ok) throw new Error(`MUCT sample unavailable: HTTP ${response.status}`)
    return response.blob()
  })
  const file = new File([blob], 'muct-transient.jpg', { type: blob.type || 'image/jpeg' })
  const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
  const geometry = pose.landmarks ? computeFrontGeometry(pose.landmarks, pose.landmarkImageWidth, pose.landmarkImageHeight) : null
  cases.push({ ...record, quality, pose, geometry, pointErrors: manualPointErrors(record, pose) })
}

const baseLightCases = cases.filter((item) => item.light === item.baseLight)
const result = {
  testedAt: new Date().toISOString(),
  policyVersion: manifest.policyVersion,
  analysisPolicyVersion: 'HEADUP-MUCT-FRONT-GEOMETRY-3.0',
  source: manifest.source,
  selection: manifest.selection,
  subjects: manifest.subjectCount,
  images: cases.length,
  sourceArchives: manifest.sourceArchives,
  productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  overall: summarize(cases),
  byCameraOnPairedBaseLighting: grouped(baseLightCases, (item) => item.camera),
  productionGateBySubjectPartitionAndCamera: Object.fromEntries(Object.entries(Object.groupBy(baseLightCases, subjectPartition)).map(([partition, items]) => [partition, grouped(items, (item) => item.camera)])),
  byLightingOnFrontCamera: grouped(cases.filter((item) => item.camera === 'a'), (item) => item.light),
  centerThresholdCounterfactual: {
    warning: 'Research-only pre-occlusion counterfactual using the other current score/area/yaw/roll rules; this does not change production thresholds.',
    sweep: centerThresholdSweep(cases),
    engineeringHoldoutJointSweep: jointCenterYawSweep(cases),
  },
  manualLandmarkErrorOverall: summarizePointErrors(cases),
  manualLandmarkErrorByCamera: Object.fromEntries(Object.entries(Object.groupBy(cases, (item) => item.camera)).map(([camera, items]) => [camera, summarizePointErrors(items)])),
  sameSubjectGeometrySensitivity: {
    cameraHeight: geometryDrift(cases, 'cameraHeight'),
    lighting: geometryDrift(cases, 'lighting'),
  },
  pitchGateCalibration: {
    candidateThresholdsDegrees: [3, 5, 7, 8, 9, 10, 12, 15],
    selectionPartition: 'engineering subjects 1-80 only; holdout subjects 81-120 must not select the threshold',
    note: 'Camera d/e are height-sensitivity probes, not categorical invalid-photo ground truth. A threshold must preserve nominal camera-a usability while reducing accepted d/e drift.',
    sweep: pitchGateCalibration(cases),
  },
  geometryMetricDefinitions: {
    mirrorResidual: 'median of 12 paired-point reflection residuals around a fitted face axis, normalized by iris-center distance',
    visibleFaceLengthWidthRatio: 'forehead landmark 10 to chin 152 divided by visible cheek width 234 to 454',
    pupilDistanceFaceWidthRatio: 'mean iris-center distance divided by visible cheek width',
    interEyeRatio: 'inner canthal distance divided by mean eye width',
    eyeCanthalTiltDegrees: 'mean bilateral canthal-line angle relative to the fitted face horizontal axis',
    jawWidthRatio: 'visible jaw landmarks 172 to 397 divided by visible cheek width',
    mouthWidthRatio: 'mouth corners 61 to 291 divided by visible cheek width',
    midfaceHeightRatio: 'landmarks 168 to 2 divided by visible face height',
    lowerFaceHeightRatio: 'landmarks 2 to 152 divided by visible face height',
    midLowerFaceHeightRatio: 'compatibility metric: landmarks 168 to 2 divided by landmarks 2 to 152',
    noseMouthWidthRatio: 'nasal alar proxy 98 to 327 divided by mouth width',
    noseLengthFaceHeightRatio: 'nasal root proxy 168 to tip proxy 1 divided by visible face height',
    lipHeightMouthWidthRatio: 'outer lip height 0 to 17 divided by mouth width',
  },
  interpretation: {
    cameraA: 'nominal front',
    camerasBC: 'increasing oblique views that the front gate should reject',
    camerasDE: 'higher/lower camera positions; sensitivity probes, not identical-view repeats',
    quality: 'MUCT is 640x480 and should fail the current minimum-resolution hard gate; pose and landmark results are reported separately',
    landmarkError: 'Only production-pose-passed images expose landmarks; reported NME is conditional accuracy and must be read with coverage',
  },
  retention: {
    imagesRetainedAfterCleanup: false,
    individualPredictionsRetained: false,
    originalIdentifiersRetained: false,
    aggregateOnly: true,
  },
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成'
