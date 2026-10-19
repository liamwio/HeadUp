import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { computeFrontGeometry, type FrontGeometry } from '../src/lib/faceMeasurements'

declare global {
  interface Window {
    __HEADUP_FRONT_REPEATABILITY__?: unknown
  }
}

type Variant = {
  name: string
  makeSource: (image: HTMLImageElement) => Promise<HTMLImageElement | HTMLCanvasElement | ImageBitmap>
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const databaseRoot = '/data/face-db-real-research'
const manifestResponse = await fetch(`${databaseRoot}/manifest.jsonl`)
if (!manifestResponse.ok) throw new Error(`Unable to load research manifest: ${manifestResponse.status}`)
const imageUrls = (await manifestResponse.text()).split(/\r?\n/).filter(Boolean)
  .map((line) => JSON.parse(line) as { relativePath: string; view: string })
  .filter((record) => record.view === 'front')
  .map((record) => `${databaseRoot}/${record.relativePath.replaceAll('\\', '/')}`)
const metricNames = Object.keys({
  mirrorResidual: 0,
  visibleFaceLengthWidthRatio: 0,
  pupilDistanceFaceWidthRatio: 0,
  interEyeRatio: 0,
  eyeCanthalTiltDegrees: 0,
  visibleForeheadWidthRatio: 0,
  jawWidthRatio: 0,
  mouthWidthRatio: 0,
  midfaceHeightRatio: 0,
  browPeakMidfaceHeightRatio:0,
  lowerFaceHeightRatio: 0,
  midLowerFaceHeightRatio: 0,
  noseMouthWidthRatio: 0,
  noseLengthFaceHeightRatio: 0,
  lipHeightMouthWidthRatio: 0,
}) as (keyof FrontGeometry)[]

function canvasFrom(image: HTMLImageElement, draw: (context: CanvasRenderingContext2D, width: number, height: number) => void): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight))
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: false })!
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  draw(context, canvas.width, canvas.height)
  return canvas
}

function standardCanvas(image: HTMLImageElement): HTMLCanvasElement {
  return canvasFrom(image, (context, width, height) => context.drawImage(image, 0, 0, width, height))
}

async function jpegSource(image: HTMLImageElement): Promise<ImageBitmap> {
  const canvas = standardCanvas(image)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('JPEG encoding failed')), 'image/jpeg', 0.75))
  return createImageBitmap(blob)
}

const variants: Variant[] = [
  { name: 'jpeg_quality_75', makeSource: jpegSource },
  { name: 'brightness_85_percent', makeSource: async (image) => canvasFrom(image, (context, width, height) => { context.filter = 'brightness(85%)'; context.drawImage(image, 0, 0, width, height) }) },
  { name: 'brightness_115_percent', makeSource: async (image) => canvasFrom(image, (context, width, height) => { context.filter = 'brightness(115%)'; context.drawImage(image, 0, 0, width, height) }) },
  { name: 'rotate_minus_2_degrees', makeSource: async (image) => canvasFrom(image, (context, width, height) => { context.translate(width / 2, height / 2); context.rotate(-2 * Math.PI / 180); context.drawImage(image, -width / 2, -height / 2, width, height) }) },
  { name: 'rotate_plus_2_degrees', makeSource: async (image) => canvasFrom(image, (context, width, height) => { context.translate(width / 2, height / 2); context.rotate(2 * Math.PI / 180); context.drawImage(image, -width / 2, -height / 2, width, height) }) },
  { name: 'shift_right_3_percent', makeSource: async (image) => canvasFrom(image, (context, width, height) => context.drawImage(image, width * 0.03, 0, width, height)) },
  { name: 'shift_down_3_percent', makeSource: async (image) => canvasFrom(image, (context, width, height) => context.drawImage(image, 0, height * 0.03, width, height)) },
  { name: 'center_zoom_5_percent', makeSource: async (image) => canvasFrom(image, (context, width, height) => context.drawImage(image, -width * 0.025, -height * 0.025, width * 1.05, height * 1.05)) },
]

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Unable to load ${url}`))
    image.src = url
  })
}

function quantiles(values: number[], digits = 4) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(digits))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
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

const baselineGeometry: FrontGeometry[] = []
const variantRecords = Object.fromEntries(variants.map((variant) => [variant.name, [] as { baseline: FrontGeometry; measured: FrontGeometry }[]]))
const detectionFailures = Object.fromEntries(['baseline', ...variants.map((variant) => variant.name)].map((name) => [name, 0]))

for (const [imageIndex, url] of imageUrls.entries()) {
  status.textContent = `处理 ${imageIndex + 1} / ${imageUrls.length}`
  const image = await loadImage(url)
  const baselineSource = standardCanvas(image)
  const baselineResult = landmarker.detect(baselineSource)
  const baselineLandmarks = baselineResult.faceLandmarks[0]
  const baseline = baselineLandmarks ? computeFrontGeometry(baselineLandmarks, baselineSource.width, baselineSource.height) : null
  if (!baseline) {
    detectionFailures.baseline += 1
    continue
  }
  baselineGeometry.push(baseline)

  for (const variant of variants) {
    const source = await variant.makeSource(image)
    try {
      const detected = landmarker.detect(source)
      const landmarks = detected.faceLandmarks[0]
      const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width
      const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height
      const measured = landmarks ? computeFrontGeometry(landmarks, width, height) : null
      if (measured) variantRecords[variant.name].push({ baseline, measured })
      else detectionFailures[variant.name] += 1
    } finally {
      if (source instanceof ImageBitmap) source.close()
    }
  }
}

const baseline = Object.fromEntries(metricNames.map((metric) => [metric, quantiles(baselineGeometry.map((item) => item[metric]))]))
const perturbations = Object.fromEntries(variants.map((variant) => {
  const records = variantRecords[variant.name]
  return [variant.name, {
    detected: records.length,
    failed: detectionFailures[variant.name],
    metrics: Object.fromEntries(metricNames.map((metric) => {
      const absolute = records.map((item) => Math.abs(item.measured[metric] - item.baseline[metric]))
      const relativePercent = records.map((item) => Math.abs(item.measured[metric] - item.baseline[metric]) / Math.max(Math.abs(item.baseline[metric]), 1e-6) * 100)
      return [metric, {
        absoluteDifference: quantiles(absolute, 6),
        relativeDifferencePercent: quantiles(relativePercent, 3),
      }]
    })),
  }]
}))

const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-FRONT-REPEATABILITY-3.0',
  source: 'Face Research Lab London Set, 102 consented adult front images; local transient transformations only',
  model: 'MediaPipe Face Landmarker float16 v1, 478 landmarks',
  subjectsAttempted: imageUrls.length,
  baselineDetected: baselineGeometry.length,
  baselineFailed: detectionFailures.baseline,
  aspectCorrection: 'x multiplied by imageWidth/imageHeight before Euclidean image-plane distances',
  symmetryUpdate: 'fitted face axis; median of 12 paired-point reflected distances normalized by iris-center distance',
  browPeakMidfaceCandidate:'distance(midpoint(105,334),2) divided by visible face height 10–152; research-only, not production FRONT-RATIO-06',
  perturbationsAppliedInMemory: variants.map((variant) => variant.name),
  baseline,
  perturbations,
  retention: {
    transformedImagesWritten: false,
    individualMeasurementsRetained: false,
    identifiersRetained: false,
    aggregateOnly: true,
  },
}

window.__HEADUP_FRONT_REPEATABILITY__ = result
status.textContent = '完成'
resultElement.textContent = JSON.stringify(result, null, 2)
landmarker.close()
