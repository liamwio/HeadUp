import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { detectFaces, type FaceDetection } from '../src/lib/faceDetector'
import type { LandmarkPoint } from '../src/types'

type ManifestRecord = {
  pseudonymousSubjectId: string
  relativePath: string
  view: 'left_profile' | 'right_profile'
}

type ProfileGeometry = {
  convexityAngleDegrees: number
  upperLipToNoseChinLineRatio: number
  lowerLipToNoseChinLineRatio: number
  noseProjectionRatio: number
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const databaseRoot = '/data/face-db-real-research'
const manifestResponse = await fetch(`${databaseRoot}/manifest.jsonl`)
if (!manifestResponse.ok) throw new Error(`Unable to load research manifest: ${manifestResponse.status}`)
const records = (await manifestResponse.text()).split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line) as ManifestRecord)
  .filter((record) => record.view === 'left_profile' || record.view === 'right_profile')

function quantiles(values: number[], digits = 4) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(digits))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Unable to load ${url}`))
    image.src = url
  })
}

function scaledCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.naturalWidth * scale)
  canvas.height = Math.round(image.naturalHeight * scale)
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

function cropFromDetection(image: HTMLImageElement, detection: FaceDetection, detectorInputWidth: number, detectorInputHeight: number): HTMLCanvasElement {
  const detectorScale = Math.min(detectorInputWidth / image.naturalWidth, detectorInputHeight / image.naturalHeight)
  const centerX = (detection.x + detection.width / 2) / detectorScale
  const centerY = (detection.y + detection.height / 2) / detectorScale
  const requestedSize = Math.max(detection.width, detection.height) / detectorScale * 1.65
  const size = Math.min(requestedSize, image.naturalWidth, image.naturalHeight)
  const left = Math.max(0, Math.min(image.naturalWidth - size, centerX - size / 2))
  const top = Math.max(0, Math.min(image.naturalHeight - size, centerY - size / 2))
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')!
  context.fillStyle = '#000'
  context.fillRect(0, 0, 512, 512)
  context.drawImage(image, left, top, size, size, 0, 0, 512, 512)
  return canvas
}

function distance(a: LandmarkPoint, b: LandmarkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointLineDistance(point: LandmarkPoint, start: LandmarkPoint, end: LandmarkPoint): number {
  const denominator = distance(start, end)
  if (denominator < 1e-6) return Number.NaN
  return Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / denominator
}

function angleAt(center: LandmarkPoint, first: LandmarkPoint, second: LandmarkPoint): number {
  const firstVector = { x: first.x - center.x, y: first.y - center.y }
  const secondVector = { x: second.x - center.x, y: second.y - center.y }
  const denominator = Math.hypot(firstVector.x, firstVector.y) * Math.hypot(secondVector.x, secondVector.y)
  if (denominator < 1e-6) return Number.NaN
  const cosine = Math.max(-1, Math.min(1, (firstVector.x * secondVector.x + firstVector.y * secondVector.y) / denominator))
  return Math.acos(cosine) * 180 / Math.PI
}

function profileGeometry(landmarks: LandmarkPoint[]): ProfileGeometry | null {
  if (landmarks.length < 169) return null
  const noseTip = landmarks[1]
  const subnasaleProxy = landmarks[2]
  const chin = landmarks[152]
  const upperLip = landmarks[0]
  const lowerLip = landmarks[17]
  const nasionProxy = landmarks[168]
  const noseChin = distance(noseTip, chin)
  if (noseChin < 1e-3) return null
  const geometry = {
    convexityAngleDegrees: angleAt(subnasaleProxy, nasionProxy, chin),
    upperLipToNoseChinLineRatio: pointLineDistance(upperLip, noseTip, chin) / noseChin,
    lowerLipToNoseChinLineRatio: pointLineDistance(lowerLip, noseTip, chin) / noseChin,
    noseProjectionRatio: distance(noseTip, subnasaleProxy) / noseChin,
  }
  return Object.values(geometry).every(Number.isFinite) ? geometry : null
}

const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
const landmarker = await FaceLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
  runningMode: 'IMAGE',
  numFaces: 1,
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  outputFacialTransformationMatrixes: false,
})

const byView = {
  left_profile: { images: 0, directDetected: 0, croppedDetected: 0, yuNetScores: [] as number[] },
  right_profile: { images: 0, directDetected: 0, croppedDetected: 0, yuNetScores: [] as number[] },
}
const paired = new Map<string, Partial<Record<'left_profile' | 'right_profile', ProfileGeometry>>>()

for (const [index, record] of records.entries()) {
  status.textContent = `处理 ${index + 1} / ${records.length}`
  const view = byView[record.view]
  view.images += 1
  const url = `${databaseRoot}/${record.relativePath.replaceAll('\\', '/')}`
  const [image, blob] = await Promise.all([loadImage(url), fetch(url).then((response) => response.blob())])
  const file = new File([blob], 'profile.jpg', { type: blob.type || 'image/jpeg' })
  const [directResult, faceSummary] = await Promise.all([
    Promise.resolve(landmarker.detect(scaledCanvas(image))),
    detectFaces(file),
  ])
  if (directResult.faceLandmarks[0]) view.directDetected += 1
  const detection = faceSummary.detections[0]
  if (!detection) continue
  view.yuNetScores.push(detection.score)
  const crop = cropFromDetection(image, detection, faceSummary.inputWidth, faceSummary.inputHeight)
  const croppedResult = landmarker.detect(crop)
  const landmarks = croppedResult.faceLandmarks[0]
  if (!landmarks) continue
  view.croppedDetected += 1
  const geometry = profileGeometry(landmarks)
  if (!geometry) continue
  const subject = paired.get(record.pseudonymousSubjectId) ?? {}
  subject[record.view] = geometry
  paired.set(record.pseudonymousSubjectId, subject)
}

const completePairs = [...paired.values()].filter((item): item is Record<'left_profile' | 'right_profile', ProfileGeometry> => Boolean(item.left_profile && item.right_profile))
const geometryNames = ['convexityAngleDegrees', 'upperLipToNoseChinLineRatio', 'lowerLipToNoseChinLineRatio', 'noseProjectionRatio'] as (keyof ProfileGeometry)[]
const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-PROFILE-LANDMARK-PROXY-1.0',
  source: 'Face Research Lab London Set, paired consented adult left/right 90-degree profiles',
  models: ['OpenCV YuNet 2026may', 'MediaPipe Face Landmarker float16 v1'],
  images: records.length,
  byView: Object.fromEntries(Object.entries(byView).map(([name, value]) => [name, {
    images: value.images,
    directDetected: value.directDetected,
    yuNetDetected: value.yuNetScores.length,
    croppedDetected: value.croppedDetected,
    yuNetScore: quantiles(value.yuNetScores),
  }])),
  pairedGeometryProxy: {
    subjectsWithBothSides: completePairs.length,
    warning: 'These are internal landmark-consistency proxies, not validated anatomical measurements and not exposed in the product.',
    absoluteLeftRightDifference: Object.fromEntries(geometryNames.map((name) => [name, quantiles(completePairs.map((pair) => Math.abs(pair.left_profile[name] - pair.right_profile[name])))])),
    relativeLeftRightDifferencePercent: Object.fromEntries(geometryNames.map((name) => [name, quantiles(completePairs.map((pair) => Math.abs(pair.left_profile[name] - pair.right_profile[name]) / Math.max(Math.abs(pair.left_profile[name]), 1e-6) * 100), 2)])),
  },
  retention: {
    imagesCopied: false,
    cropsWritten: false,
    individualMeasurementsRetained: false,
    identifiersRetained: false,
    aggregateOnly: true,
  },
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成'
landmarker.close()
