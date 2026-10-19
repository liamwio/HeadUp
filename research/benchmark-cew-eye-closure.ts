import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

type Entry = {
  subjectId: string
  split: 'engineering' | 'holdout'
  relativePath: string
  label: { bothEyesClosed: boolean }
}
type AuthorizedEntry = {
  subjectId: string
  split: 'authorized_engineering' | 'authorized_holdout'
  assetUrl: string
  label: { bothEyesClosed: false }
}
type Manifest = {
  source: string
  publisher: string
  sourcePage: string
  archive: unknown
  licenseBoundary: string
  selection: Record<string, unknown>
  records: Entry[]
  authorizedOpenRecords: AuthorizedEntry[]
}
type Signals = {
  eyeClosureBilateral: number
  eyeClosureMaximum: number
  eyeSquintBilateral: number
}
type Evaluated = {
  subjectId: string
  source: 'cew' | 'authorized_open'
  split: string
  bothEyesClosed: boolean
  detected: boolean
  signals?: Signals
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const highResolution = location.pathname.includes('highres')
const stagingRoot = highResolution
  ? '/data/face-benchmark/.staging/cew-eye-closure-highres'
  : '/data/face-benchmark/.staging/cew-eye-closure'

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits))
}

function rate(numerator: number, denominator: number) {
  return denominator ? round(numerator / denominator) : null
}

function quantiles(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
  return {
    minimum: round(sorted[0]), p25: round(at(0.25)), median: round(at(0.5)),
    p75: round(at(0.75)), p95: round(at(0.95)), maximum: round(sorted.at(-1)!),
  }
}

function signals(categories: { categoryName: string; score: number }[]): Signals {
  const scores = Object.fromEntries(categories.map((category) => [category.categoryName, category.score]))
  const leftBlink = scores.eyeBlinkLeft ?? 0
  const rightBlink = scores.eyeBlinkRight ?? 0
  return {
    eyeClosureBilateral: Math.min(leftBlink, rightBlink),
    eyeClosureMaximum: Math.max(leftBlink, rightBlink),
    eyeSquintBilateral: Math.min(scores.eyeSquintLeft ?? 0, scores.eyeSquintRight ?? 0),
  }
}

function metric(items: Evaluated[], threshold: number) {
  const detected = items.filter((item) => item.detected)
  const closed = items.filter((item) => item.bothEyesClosed)
  const open = items.filter((item) => !item.bothEyesClosed)
  const closedDetected = closed.filter((item) => item.detected)
  const openDetected = open.filter((item) => item.detected)
  const closedSignalRejected = closedDetected.filter((item) => item.signals!.eyeClosureBilateral >= threshold).length
  const openSignalFalseRejected = openDetected.filter((item) => item.signals!.eyeClosureBilateral >= threshold).length
  return {
    images: items.length,
    detected: detected.length,
    detectionRate: rate(detected.length, items.length),
    closed: closed.length,
    closedDetected: closedDetected.length,
    closedDetectionRate: rate(closedDetected.length, closed.length),
    closedSignalRejected,
    closedSignalRecallAmongDetected: rate(closedSignalRejected, closedDetected.length),
    closedBlockedIncludingFaceDetectionFailure: closed.length - closedDetected.length + closedSignalRejected,
    closedBlockRateIncludingFaceDetectionFailure: rate(closed.length - closedDetected.length + closedSignalRejected, closed.length),
    open: open.length,
    openDetected: openDetected.length,
    openDetectionRate: rate(openDetected.length, open.length),
    openSignalFalseRejected,
    openSignalFalseRejectRateAmongDetected: rate(openSignalFalseRejected, openDetected.length),
  }
}

function chooseThreshold(engineering: Evaluated[]) {
  const candidates = Array.from({ length: 181 }, (_, index) => round(0.05 + index * 0.005, 3))
    .map((threshold) => ({ threshold, metric: metric(engineering, threshold) }))
    .filter((candidate) => (candidate.metric.openSignalFalseRejectRateAmongDetected ?? 1) <= 0.01)
    .sort((left, right) =>
      (right.metric.closedSignalRecallAmongDetected ?? 0) - (left.metric.closedSignalRecallAmongDetected ?? 0)
      || (left.metric.openSignalFalseRejectRateAmongDetected ?? 1) - (right.metric.openSignalFalseRejectRateAmongDetected ?? 1)
      || right.threshold - left.threshold)
  if (!candidates.length) throw new Error('No CEW eye-closure threshold satisfies the engineering open-eye false-reject constraint')
  return candidates[0]
}

function distribution(items: Evaluated[], key: keyof Signals) {
  return quantiles(items.flatMap((item) => item.signals ? [item.signals[key]] : []))
}

async function main() {
  const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
    return response.json() as Promise<Manifest>
  })
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'IMAGE', numFaces: 1,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
  })
  const inputs = [
    ...manifest.records.map((record) => ({
      subjectId: record.subjectId, source: 'cew' as const, split: record.split,
      bothEyesClosed: record.label.bothEyesClosed,
      assetUrl: `${stagingRoot}/${record.relativePath}`,
    })),
    ...manifest.authorizedOpenRecords.map((record) => ({
      subjectId: record.subjectId, source: 'authorized_open' as const, split: record.split,
      bothEyesClosed: false, assetUrl: record.assetUrl,
    })),
  ]
  const evaluated: Evaluated[] = []
  try {
    for (const [index, input] of inputs.entries()) {
      status.textContent = `处理真实闭眼/睁眼图 ${index + 1} / ${inputs.length}`
      const blob = await fetch(input.assetUrl).then(async (response) => {
        if (!response.ok) throw new Error(`Image load failed: ${response.status}`)
        return response.blob()
      })
      const bitmap = await createImageBitmap(blob)
      try {
        const categories = landmarker.detect(bitmap).faceBlendshapes[0]?.categories
        evaluated.push({
          subjectId: input.subjectId, source: input.source, split: input.split,
          bothEyesClosed: input.bothEyesClosed, detected: Boolean(categories?.length),
          ...(categories?.length ? { signals: signals(categories) } : {}),
        })
      } finally {
        bitmap.close()
      }
    }
  } finally {
    landmarker.close()
  }

  const cewEngineering = evaluated.filter((item) => item.source === 'cew' && item.split === 'engineering')
  const cewHoldout = evaluated.filter((item) => item.source === 'cew' && item.split === 'holdout')
  const authorizedEngineering = evaluated.filter((item) => item.source === 'authorized_open' && item.split === 'authorized_engineering')
  const authorizedHoldout = evaluated.filter((item) => item.source === 'authorized_open' && item.split === 'authorized_holdout')
  const chosen = chooseThreshold([...cewEngineering, ...authorizedEngineering])
  const threshold = chosen.threshold
  const closed = evaluated.filter((item) => item.source === 'cew' && item.bothEyesClosed)
  const open = evaluated.filter((item) => item.source === 'cew' && !item.bothEyesClosed)
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: highResolution ? 'HEADUP-CEW-EYE-CLOSURE-HIGHRES-AUDIT-1.0' : 'HEADUP-CEW-EYE-CLOSURE-AUDIT-1.0',
    source: manifest.source,
    publisher: manifest.publisher,
    sourcePage: manifest.sourcePage,
    archive: manifest.archive,
    licenseBoundary: manifest.licenseBoundary,
    selection: manifest.selection,
    method: {
      model: 'MediaPipe Face Landmarker float16 v1, 52 blendshapes',
      signal: 'min(eyeBlinkLeft, eyeBlinkRight)',
      thresholdSelection: 'Grid selected on 600 unique-subject CEW engineering faces plus 85 authorized open-eye engineering controls; maximize closed-eye recall among detected faces subject to <=1% open-eye false rejects among detected controls.',
      threshold,
      engineeringSelectionMetric: chosen.metric,
    },
    evaluation: {
      cewEngineering: metric(cewEngineering, threshold),
      cewHoldout: metric(cewHoldout, threshold),
      authorizedOpenEngineering: metric(authorizedEngineering, threshold),
      authorizedOpenHoldout: metric(authorizedHoldout, threshold),
    },
    signalDistributions: {
      cewClosed: {
        bilateralEyeClosure: distribution(closed, 'eyeClosureBilateral'),
        maximumEyeClosure: distribution(closed, 'eyeClosureMaximum'),
        bilateralEyeSquint: distribution(closed, 'eyeSquintBilateral'),
      },
      cewOpen: {
        bilateralEyeClosure: distribution(open, 'eyeClosureBilateral'),
        maximumEyeClosure: distribution(open, 'eyeClosureMaximum'),
        bilateralEyeSquint: distribution(open, 'eyeSquintBilateral'),
      },
    },
    decision: {
      productionEyeClosureGateEligible: false,
      productionIntegrated: false,
      rationale: highResolution
        ? 'Pending result review. This removes the 100x100 source-resolution limitation but retains cross-source and non-standard-capture limitations; production integration still requires reviewing identity-isolated recall and false rejects.'
        : 'Pending result review. CEW supplies real closed/open labels and identity separation, but its 100x100 warped faces are upscaled only for signal probing and cannot establish standard-phone-capture production error rates.',
    },
    limitations: highResolution ? [
      'Closed and open classes come from different original sources in the official CEW construction, so class-correlated source differences remain possible.',
      'CEW images are one image per subject rather than same-subject open/closed action pairs.',
      'Closed eyes are not identical to the product wording squint; this benchmark can validate obvious bilateral eye closure only.',
      'These are unconstrained face crops, not standard HeadUp phone captures with the product framing and quality protocol.',
      'CEW/LFW images are research-only and cannot enter the commercial product, training assets, or redistribution.',
    ] : [
      'CEW warped faces are 100x100 and deterministically upscaled to 512x512 only to probe Face Landmarker; upscaling adds no information and production quality would reject the originals.',
      'CEW images are one image per subject rather than same-subject open/closed action pairs.',
      'Closed eyes are not identical to the product wording squint; this benchmark can validate obvious bilateral eye closure only.',
      'CEW is research-only and cannot enter the commercial product, training assets, or redistribution.',
    ],
    retention: {
      imagesDeletedAfterRun: false, archiveDeleted: true,
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
