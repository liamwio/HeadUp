import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { computeFrontGeometry, type FrontGeometry } from '../src/lib/faceMeasurements'

type RecordEntry = { sampleId: string; orientation: number; relativePath: string }
type Metric = Exclude<keyof FrontGeometry, 'midLowerFaceHeightRatio'>
const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const root = '/data/face-benchmark/.staging/exif-orientation'
const metrics: Metric[] = ['mirrorResidual', 'visibleFaceLengthWidthRatio', 'pupilDistanceFaceWidthRatio', 'interEyeRatio', 'eyeCanthalTiltDegrees', 'jawWidthRatio', 'mouthWidthRatio', 'midfaceHeightRatio', 'lowerFaceHeightRatio', 'noseMouthWidthRatio', 'noseLengthFaceHeightRatio', 'lipHeightMouthWidthRatio']
const stable = new Set<Metric>(['pupilDistanceFaceWidthRatio', 'jawWidthRatio'])
function round(value: number, digits = 6) { return Number(value.toFixed(digits)) }
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return { min: round(Math.min(...values)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } }
function baseCanvas(image: ImageBitmap, maximum = 768) { const scale = Math.min(1, maximum / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas }
function padded(source: HTMLCanvasElement, axis: 'horizontal' | 'vertical', color: string) { const canvas = document.createElement('canvas'); canvas.width = axis === 'horizontal' ? Math.round(source.width * 1.2) : source.width; canvas.height = axis === 'vertical' ? Math.round(source.height * 1.2) : source.height; const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(source, (canvas.width - source.width) / 2, (canvas.height - source.height) / 2); return canvas }
function resized(source: HTMLCanvasElement) { const scale = 512 / Math.max(source.width, source.height); const canvas = document.createElement('canvas'); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale); canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height); return canvas }
async function jpeg50(source: HTMLCanvasElement) { const blob = await new Promise<Blob>((resolve, reject) => source.toBlob((value) => value ? resolve(value) : reject(new Error('JPEG50 encode failed')), 'image/jpeg', .5)); return createImageBitmap(blob) }
function dimensions(source: HTMLCanvasElement | ImageBitmap) { return { width: source.width, height: source.height } }

async function main() {
  const manifest = await fetch(`${root}/manifest.json`).then((response) => response.json()) as { policyVersion: string; records: RecordEntry[]; source: unknown }
  const records = manifest.records.filter((record) => record.orientation === 1)
  if (manifest.policyVersion !== 'HEADUP-EXIF-ORIENTATION-PREPARE-1.0' || records.length !== 20) throw new Error('Unexpected canvas perturbation source')
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
  const landmarker = await FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 1, minFaceDetectionConfidence: .5, minFacePresenceConfidence: .5 })
  const variantNames = ['pillarbox_white_10', 'pillarbox_black_10', 'letterbox_white_10', 'letterbox_black_10', 'resize_max_512', 'jpeg_quality_50'] as const
  const comparisons = Object.fromEntries(variantNames.map((name) => [name, [] as { baseline: FrontGeometry; measured: FrontGeometry }[]]))
  const failures = Object.fromEntries(['baseline', ...variantNames].map((name) => [name, 0]))
  try {
    for (const [index, record] of records.entries()) {
      status.textContent = `处理画布扰动 ${index + 1} / ${records.length}`
      const blob = await fetch(`${root}/${record.relativePath}`).then((response) => response.blob())
      const bitmap = await createImageBitmap(blob)
      const base = baseCanvas(bitmap); bitmap.close()
      const baselineLandmarks = landmarker.detect(base).faceLandmarks[0]
      const baseline = baselineLandmarks ? computeFrontGeometry(baselineLandmarks, base.width, base.height) : null
      if (!baseline) { failures.baseline++; continue }
      const variants: Record<typeof variantNames[number], HTMLCanvasElement | ImageBitmap> = {
        pillarbox_white_10: padded(base, 'horizontal', '#fff'),
        pillarbox_black_10: padded(base, 'horizontal', '#000'),
        letterbox_white_10: padded(base, 'vertical', '#fff'),
        letterbox_black_10: padded(base, 'vertical', '#000'),
        resize_max_512: resized(base),
        jpeg_quality_50: await jpeg50(base),
      }
      for (const name of variantNames) {
        const source = variants[name]
        const landmarks = landmarker.detect(source).faceLandmarks[0]
        const size = dimensions(source)
        const measured = landmarks ? computeFrontGeometry(landmarks, size.width, size.height) : null
        if (measured) comparisons[name].push({ baseline, measured }); else failures[name]++
        if (source instanceof ImageBitmap) source.close()
      }
    }
  } finally { landmarker.close() }
  const byVariant = Object.fromEntries(variantNames.map((name) => [name, {
    detected: comparisons[name].length,
    failed: failures[name],
    metrics: Object.fromEntries(metrics.map((metric) => {
      const absolute = comparisons[name].map((item) => Math.abs(item.measured[metric] - item.baseline[metric]))
      const relative = comparisons[name].map((item) => Math.abs(item.measured[metric] - item.baseline[metric]) / Math.max(Math.abs(item.baseline[metric]), 1e-6))
      return [metric, { absoluteDifference: distribution(absolute), relativeDifference: distribution(relative) }]
    })),
  }]))
  const perMetricGates = Object.fromEntries(metrics.map((metric) => [metric, {
    eachVariantHasAtLeast19Detections: variantNames.every((name) => byVariant[name].detected >= 19),
    p95WithinThreshold: variantNames.every((name) => metric === 'mirrorResidual'
      ? byVariant[name].metrics[metric].absoluteDifference.p95 <= .03
      : metric === 'eyeCanthalTiltDegrees'
        ? byVariant[name].metrics[metric].absoluteDifference.p95 <= 1
        : byVariant[name].metrics[metric].relativeDifference.p95 <= (stable.has(metric) ? .03 : .08)),
  }]))
  const gates = {
    baselineDetectedAtLeast19Of20: failures.baseline <= 1,
    everyVariantDetectedAtLeast19Of20: variantNames.every((name) => byVariant[name].detected >= 19),
    everyProductMetricPassesItsP95Threshold: Object.values(perMetricGates).every((gate) => Object.values(gate).every(Boolean)),
  }
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-FRONT-CANVAS-PERTURBATION-1.0', source: manifest.source,
    protocol: { images: 20, variants: variantNames, productMetrics: metrics, thresholds: { stableRatioP95: .03, otherRatioP95: .08, eyeTiltAbsoluteDegreesP95: 1, mirrorResidualAbsoluteP95: .03 } },
    baselineDetected: 20 - failures.baseline, perturbations: byVariant, perMetricGates, predeclaredGates: gates,
    passesCanvasPerturbationContract: Object.values(gates).every(Boolean),
    productionDecision: Object.values(gates).every(Boolean) ? 'retain_image_plane_normalization' : 'coordinate_or_crop_normalization_fix_required',
    limitations: ['In-memory transforms of studio images are not real phone retakes.', 'Padding colors are black/white only.', 'The audit isolates MediaPipe geometry and does not re-run quality/pose gates.'],
    retention: { imagesDeletedAfterRun: false, transformedImagesWritten: false, individualMeasurementsRetained: false, identifiersRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2); status.textContent = '完成'
}
main().catch((error) => { resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error); resultElement.textContent = resultElement.dataset.error; status.textContent = '失败' })
