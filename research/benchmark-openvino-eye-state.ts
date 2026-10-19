import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import * as ort from 'onnxruntime-web/wasm'

type Entry = { subjectId: string; split: 'engineering' | 'holdout'; relativePath: string; label: { bothEyesClosed: boolean } }
type AuthorizedEntry = { subjectId: string; split: 'authorized_engineering' | 'authorized_holdout'; assetUrl: string; label: { bothEyesClosed: false } }
type Manifest = {
  source: string; publisher: string; sourcePage: string; licenseBoundary: string
  selection: Record<string, unknown>; records: Entry[]; authorizedOpenRecords: AuthorizedEntry[]
  eyeStateModel: {
    name: string; sourcePage: string; sourceCommit: string; relativePath: string; bytes: number
    sha256: string; sha384: string; license: string; input: string; officialOutput: string; officialMrlAccuracy: number
  }
}
type Scores = { dedicatedClassZero: number; dedicatedClassOne: number; mediaPipeBilateralBlink: number }
type Evaluated = {
  source: 'cew' | 'authorized_open'; split: string; bothEyesClosed: boolean
  faceDetected: boolean; scores?: Scores
}
type Landmark = { x: number; y: number }

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/data/face-benchmark/.staging/cew-eye-closure-highres'

function round(value: number, digits = 4) { return Number(value.toFixed(digits)) }
function rate(numerator: number, denominator: number) { return denominator ? round(numerator / denominator) : null }
function quantiles(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
  return { minimum: round(sorted[0]), p25: round(at(0.25)), median: round(at(0.5)), p75: round(at(0.75)), p95: round(at(0.95)), maximum: round(sorted.at(-1)!) }
}

function metric(items: Evaluated[], signal: keyof Scores, threshold: number) {
  const detected = items.filter((item) => item.faceDetected && item.scores)
  const closed = items.filter((item) => item.bothEyesClosed)
  const open = items.filter((item) => !item.bothEyesClosed)
  const closedDetected = detected.filter((item) => item.bothEyesClosed)
  const openDetected = detected.filter((item) => !item.bothEyesClosed)
  const closedRejected = closedDetected.filter((item) => item.scores![signal] >= threshold).length
  const openFalseRejected = openDetected.filter((item) => item.scores![signal] >= threshold).length
  return {
    images: items.length, faceDetected: detected.length, faceDetectionRate: rate(detected.length, items.length),
    closed: closed.length, closedDetected: closedDetected.length,
    closedRecallAmongDetected: rate(closedRejected, closedDetected.length), closedRejected,
    closedBlockRateIncludingFaceDetectionFailure: rate(closed.length - closedDetected.length + closedRejected, closed.length),
    open: open.length, openDetected: openDetected.length,
    openFalseRejectRateAmongDetected: rate(openFalseRejected, openDetected.length), openFalseRejected,
  }
}

function chooseThreshold(items: Evaluated[], signal: keyof Scores) {
  const candidates = Array.from({ length: 100 }, (_, index) => round(0.01 + index * 0.01, 2))
    .map((threshold) => ({ threshold, metric: metric(items, signal, threshold) }))
    .filter((candidate) => (candidate.metric.openFalseRejectRateAmongDetected ?? 1) <= 0.01)
    .sort((left, right) =>
      (right.metric.closedRecallAmongDetected ?? 0) - (left.metric.closedRecallAmongDetected ?? 0)
      || (left.metric.openFalseRejectRateAmongDetected ?? 1) - (right.metric.openFalseRejectRateAmongDetected ?? 1)
      || right.threshold - left.threshold)
  return candidates[0] ?? {
    threshold: 1.0001,
    metric: metric(items, signal, 1.0001),
    noFeasibleThresholdAtOrBelowOne: true,
  }
}

function eyeTensor(bitmap: ImageBitmap, landmarks: Landmark[], cornerA: number, cornerB: number) {
  const first = landmarks[cornerA]
  const second = landmarks[cornerB]
  const centerX = ((first.x + second.x) / 2) * bitmap.width
  const centerY = ((first.y + second.y) / 2) * bitmap.height
  const eyeWidth = Math.hypot((first.x - second.x) * bitmap.width, (first.y - second.y) * bitmap.height)
  const side = Math.max(8, eyeWidth * 1.65)
  const canvas = new OffscreenCanvas(32, 32)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = 'black'
  context.fillRect(0, 0, 32, 32)
  context.drawImage(bitmap, centerX - side / 2, centerY - side / 2, side, side, 0, 0, 32, 32)
  const pixels = context.getImageData(0, 0, 32, 32).data
  const input = new Float32Array(3 * 32 * 32)
  for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
    input[pixel] = (pixels[pixel * 4 + 2] - 127) / 255
    input[32 * 32 + pixel] = (pixels[pixel * 4 + 1] - 127) / 255
    input[2 * 32 * 32 + pixel] = (pixels[pixel * 4] - 127) / 255
  }
  return new ort.Tensor('float32', input, [1, 3, 32, 32])
}

async function classProbabilities(session: ort.InferenceSession, tensor: ort.Tensor): Promise<[number, number]> {
  const output = await session.run({ [session.inputNames[0]]: tensor })
  const values = Array.from(output[session.outputNames[0]].data as Float32Array)
  if (values.length !== 2) throw new Error(`Unexpected eye-state output length: ${values.length}`)
  const sum = values[0] + values[1]
  if (values.every((value) => value >= 0 && value <= 1) && Math.abs(sum - 1) < 0.02) return [values[0], values[1]]
  const maximum = Math.max(...values)
  const exponentials = values.map((value) => Math.exp(value - maximum))
  const denominator = exponentials[0] + exponentials[1]
  return [exponentials[0] / denominator, exponentials[1] / denominator]
}

async function main() {
  const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
    return response.json() as Promise<Manifest>
  })
  const [fileset, modelBytes] = await Promise.all([
    FilesetResolver.forVisionTasks('/mediapipe/wasm'),
    fetch(`${stagingRoot}/${manifest.eyeStateModel.relativePath}`).then((response) => response.arrayBuffer()),
  ])
  const [landmarker, eyeSession] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE', numFaces: 1, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
    }),
    ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] }),
  ])
  const inputs = [
    ...manifest.records.map((record) => ({ source: 'cew' as const, split: record.split, bothEyesClosed: record.label.bothEyesClosed, assetUrl: `${stagingRoot}/${record.relativePath}` })),
    ...manifest.authorizedOpenRecords.map((record) => ({ source: 'authorized_open' as const, split: record.split, bothEyesClosed: false, assetUrl: record.assetUrl })),
  ]
  const evaluated: Evaluated[] = []
  try {
    for (const [index, input] of inputs.entries()) {
      status.textContent = `处理专用眼睛状态模型 ${index + 1} / ${inputs.length}`
      const blob = await fetch(input.assetUrl).then((response) => response.blob())
      const bitmap = await createImageBitmap(blob)
      try {
        const detection = landmarker.detect(bitmap)
        const landmarks = detection.faceLandmarks[0] as Landmark[] | undefined
        const categories = detection.faceBlendshapes[0]?.categories
        if (!landmarks || !categories?.length) {
          evaluated.push({ source: input.source, split: input.split, bothEyesClosed: input.bothEyesClosed, faceDetected: false })
          continue
        }
        const scoreMap = Object.fromEntries(categories.map((category) => [category.categoryName, category.score]))
        const [rightClasses, leftClasses] = await Promise.all([
          classProbabilities(eyeSession, eyeTensor(bitmap, landmarks, 33, 133)),
          classProbabilities(eyeSession, eyeTensor(bitmap, landmarks, 362, 263)),
        ])
        evaluated.push({
          source: input.source, split: input.split, bothEyesClosed: input.bothEyesClosed, faceDetected: true,
          scores: {
            dedicatedClassZero: Math.min(rightClasses[0], leftClasses[0]),
            dedicatedClassOne: Math.min(rightClasses[1], leftClasses[1]),
            mediaPipeBilateralBlink: Math.min(scoreMap.eyeBlinkLeft ?? 0, scoreMap.eyeBlinkRight ?? 0),
          },
        })
      } finally { bitmap.close() }
    }
    status.textContent = '推理完成，汇总工程集与身份隔离留出集'
  } finally {
    // Both libraries own WASM runtimes. Closing one while the other remains
    // active can stall after thousands of runs, so the disposable benchmark
    // browser owns teardown after the aggregate is serialized.
    void landmarker
    void eyeSession
  }

  const engineering = evaluated.filter((item) => item.split === 'engineering' || item.split === 'authorized_engineering')
  const holdout = evaluated.filter((item) => item.source === 'cew' && item.split === 'holdout')
  const authorizedHoldout = evaluated.filter((item) => item.source === 'authorized_open' && item.split === 'authorized_holdout')
  const dedicatedCandidates = [
    { signal: 'dedicatedClassZero' as const, ...chooseThreshold(engineering, 'dedicatedClassZero') },
    { signal: 'dedicatedClassOne' as const, ...chooseThreshold(engineering, 'dedicatedClassOne') },
  ].sort((left, right) =>
    (right.metric.closedRecallAmongDetected ?? 0) - (left.metric.closedRecallAmongDetected ?? 0)
    || (left.metric.openFalseRejectRateAmongDetected ?? 1) - (right.metric.openFalseRejectRateAmongDetected ?? 1))
  const dedicated = dedicatedCandidates[0]
  const baseline = chooseThreshold(engineering, 'mediaPipeBilateralBlink')
  const signalDistribution = (items: Evaluated[], signal: keyof Scores) => quantiles(items.flatMap((item) => item.scores ? [item.scores[signal]] : []))
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-OPENVINO-EYE-STATE-AUDIT-1.0',
    source: manifest.source, publisher: manifest.publisher, sourcePage: manifest.sourcePage,
    licenseBoundary: manifest.licenseBoundary, selection: manifest.selection,
    model: manifest.eyeStateModel,
    method: {
      eyeCrop: 'MediaPipe eye corners 33/133 and 362/263; axis-aligned square side 1.65x corner distance; 32x32 BGR',
      preprocessing: '(BGR - 127) / 255 according to Open Model Zoo Model Optimizer arguments',
      bilateralRule: 'min(left closed probability, right closed probability)',
      thresholdSelection: 'Select on CEW + authorized engineering controls only; maximize detected closed-eye recall subject to <=1% detected open-eye false rejects.',
      outputMappingSelection: 'Evaluate class index 0 and 1 on engineering controls only; choose the class direction with higher feasible closed-eye recall.',
      selectedClosedClassSignal: dedicated.signal,
      thresholds: { dedicatedEyeState: dedicated.threshold, mediaPipeBilateralBlink: baseline.threshold },
    },
    evaluation: {
      dedicatedEngineering: dedicated.metric,
      dedicatedHoldout: metric(holdout, dedicated.signal, dedicated.threshold),
      dedicatedAuthorizedOpenHoldout: metric(authorizedHoldout, dedicated.signal, dedicated.threshold),
      mediaPipeEngineering: baseline.metric,
      mediaPipeHoldout: metric(holdout, 'mediaPipeBilateralBlink', baseline.threshold),
      mediaPipeAuthorizedOpenHoldout: metric(authorizedHoldout, 'mediaPipeBilateralBlink', baseline.threshold),
    },
    signalDistributions: {
      dedicatedClassZeroClosed: signalDistribution(evaluated.filter((item) => item.source === 'cew' && item.bothEyesClosed), 'dedicatedClassZero'),
      dedicatedClassZeroOpen: signalDistribution(evaluated.filter((item) => item.source === 'cew' && !item.bothEyesClosed), 'dedicatedClassZero'),
      dedicatedClassOneClosed: signalDistribution(evaluated.filter((item) => item.source === 'cew' && item.bothEyesClosed), 'dedicatedClassOne'),
      dedicatedClassOneOpen: signalDistribution(evaluated.filter((item) => item.source === 'cew' && !item.bothEyesClosed), 'dedicatedClassOne'),
      mediaPipeClosed: signalDistribution(evaluated.filter((item) => item.source === 'cew' && item.bothEyesClosed), 'mediaPipeBilateralBlink'),
      mediaPipeOpen: signalDistribution(evaluated.filter((item) => item.source === 'cew' && !item.bothEyesClosed), 'mediaPipeBilateralBlink'),
    },
    decision: {
      productionEyeStateModelEligible: false, productionIntegrated: false,
      rationale: 'Pending independent holdout review; do not integrate solely from the official MRL accuracy.',
    },
    limitations: [
      'CEW closed/open classes come from different source domains and are not same-subject action pairs.',
      'The model was trained on MRL infrared eye crops from only 37 subjects; CEW transfer performance is the relevant evidence here.',
      'Eye crops are derived from MediaPipe landmarks and fail when the full face is not detected.',
      'CEW/LFW images are not standard HeadUp phone captures.',
    ],
    retention: {
      imagesDeletedAfterRun: false, archivesDeleted: true, transientModelDeleted: false,
      sourceImageIdsRetained: false, sourceUrlsRetained: false, sourceNamesRetained: false,
      individualPredictionsRetained: false, aggregateOnly: true,
    },
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  status.textContent = '完成；请保存聚合结果后立即运行清理脚本'
}

main().catch((error) => {
  resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error)
  resultElement.textContent = resultElement.dataset.error
  status.textContent = '失败'
})
