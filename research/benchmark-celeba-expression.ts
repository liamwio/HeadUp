import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

type Labels = { smiling: boolean; mouthSlightlyOpen: boolean; narrowEyes: boolean }
type Coverage = { masculinePresentationProxy: boolean; youngAppearanceProxy: boolean; eyeglasses: boolean; heavyMakeup: boolean }
type RecordEntry = {
  sampleId: string
  subjectId: string
  split: 'engineering' | 'holdout'
  relativePath: string
  labels: Labels
  coverage: Coverage
}
type NeutralEntry = { sampleId: string; split: 'neutral_engineering' | 'neutral_holdout'; assetUrl: string; labels: Labels }
type Manifest = {
  source: string
  publisher: string
  sourcePage: string
  originalSourcePage: string
  sourceCommit: string
  licenseBoundary: string
  selection: Record<string, unknown>
  records: RecordEntry[]
  authorizedNeutralRecords: NeutralEntry[]
}
type Signals = {
  smileBilateral: number
  jawOpen: number
  eyeClosureBilateral: number
  eyeSquintBilateral: number
}
type Evaluated = {
  subjectId: string
  source: 'celeba' | 'authorized_neutral'
  split: string
  labels: Labels
  coverage?: Coverage
  detected: boolean
  signals?: Signals
}
type Thresholds = { smileBilateral: number; jawOpen: number }

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/celeba-expression'
const auditVariant = new URLSearchParams(window.location.search).get('policy') === 'v2' ? 'v2' : 'v1'

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
  return { minimum: round(sorted[0]), p25: round(at(0.25)), median: round(at(0.5)), p75: round(at(0.75)), p95: round(at(0.95)), maximum: round(sorted.at(-1)!) }
}

function toScoreMap(categories: { categoryName: string; score: number }[]) {
  return Object.fromEntries(categories.map((category) => [category.categoryName, category.score]))
}

function signalFrom(scores: Record<string, number>): Signals {
  return {
    smileBilateral: Math.min(scores.mouthSmileLeft ?? 0, scores.mouthSmileRight ?? 0),
    jawOpen: scores.jawOpen ?? 0,
    eyeClosureBilateral: Math.min(scores.eyeBlinkLeft ?? 0, scores.eyeBlinkRight ?? 0),
    eyeSquintBilateral: Math.min(scores.eyeSquintLeft ?? 0, scores.eyeSquintRight ?? 0),
  }
}

function rejected(item: Evaluated, thresholds: Thresholds) {
  return Boolean(item.signals && (item.signals.smileBilateral >= thresholds.smileBilateral || item.signals.jawOpen >= thresholds.jawOpen))
}

function metric(items: Evaluated[], thresholds: Thresholds) {
  const detected = items.filter((item) => item.detected)
  const neutral = detected.filter((item) => !item.labels.smiling && !item.labels.mouthSlightlyOpen)
  const smiling = detected.filter((item) => item.labels.smiling)
  const mouthOpen = detected.filter((item) => item.labels.mouthSlightlyOpen)
  const expressionPositive = detected.filter((item) => item.labels.smiling || item.labels.mouthSlightlyOpen)
  const falseRejects = neutral.filter((item) => rejected(item, thresholds)).length
  const smilingRejected = smiling.filter((item) => rejected(item, thresholds)).length
  const mouthOpenRejected = mouthOpen.filter((item) => rejected(item, thresholds)).length
  const expressionRejected = expressionPositive.filter((item) => rejected(item, thresholds)).length
  return {
    images: items.length,
    detected: detected.length,
    detectionRate: rate(detected.length, items.length),
    neutral: neutral.length,
    neutralFalseRejects: falseRejects,
    neutralFalseRejectRate: rate(falseRejects, neutral.length),
    smiling: smiling.length,
    smilingRejected,
    smilingRecallProxy: rate(smilingRejected, smiling.length),
    mouthSlightlyOpen: mouthOpen.length,
    mouthSlightlyOpenRejected: mouthOpenRejected,
    mouthOpenRecallProxy: rate(mouthOpenRejected, mouthOpen.length),
    expressionPositive: expressionPositive.length,
    expressionPositiveRejected: expressionRejected,
    expressionRecallProxy: rate(expressionRejected, expressionPositive.length),
  }
}

function macroMetric(items: Evaluated[], thresholds: Thresholds) {
  const groups = Object.groupBy(items, (item) => item.subjectId)
  const subjectMetrics = Object.values(groups).flatMap((group) => group ? [metric(group, thresholds)] : [])
  const average = (key: 'neutralFalseRejectRate' | 'smilingRecallProxy' | 'mouthOpenRecallProxy' | 'expressionRecallProxy') => {
    const values = subjectMetrics.flatMap((subject) => subject[key] === null ? [] : [subject[key]])
    return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
  }
  return {
    subjects: subjectMetrics.length,
    subjectsWithNeutralControls: subjectMetrics.filter((subject) => subject.neutral > 0).length,
    subjectsWithSmilingImages: subjectMetrics.filter((subject) => subject.smiling > 0).length,
    subjectsWithMouthOpenImages: subjectMetrics.filter((subject) => subject.mouthSlightlyOpen > 0).length,
    neutralFalseRejectRateMacro: average('neutralFalseRejectRate'),
    smilingRecallProxyMacro: average('smilingRecallProxy'),
    mouthOpenRecallProxyMacro: average('mouthOpenRecallProxy'),
    expressionRecallProxyMacro: average('expressionRecallProxy'),
  }
}

function chooseThresholds(engineering: Evaluated[]) {
  const candidates: { thresholds: Thresholds; metric: ReturnType<typeof metric>; objective: number }[] = []
  const grid = Array.from({ length: 31 }, (_, index) => round(0.15 + index * 0.025, 3))
  for (const smileBilateral of grid) {
    for (const jawOpen of grid) {
      const thresholds = { smileBilateral, jawOpen }
      const result = metric(engineering, thresholds)
      const falseRejectRate = result.neutralFalseRejectRate ?? 1
      if (falseRejectRate > 0.02) continue
      const objective = ((result.smilingRecallProxy ?? 0) + (result.mouthOpenRecallProxy ?? 0)) / 2
      candidates.push({ thresholds, metric: result, objective })
    }
  }
  candidates.sort((left, right) =>
    right.objective - left.objective
    || (left.metric.neutralFalseRejectRate ?? 1) - (right.metric.neutralFalseRejectRate ?? 1)
    || right.thresholds.smileBilateral - left.thresholds.smileBilateral
    || right.thresholds.jawOpen - left.thresholds.jawOpen)
  if (!candidates.length) throw new Error('No expression threshold candidate met the engineering neutral false-reject constraint')
  return candidates[0]
}

function chooseThresholdsV2(engineering: Evaluated[], authorizedNeutralEngineering: Evaluated[]) {
  const neutralPool = [...engineering, ...authorizedNeutralEngineering]
  const candidates: { thresholds: Thresholds; metric: ReturnType<typeof metric>; neutralMetric: ReturnType<typeof metric>; objective: number }[] = []
  const smileGrid = Array.from({ length: 31 }, (_, index) => round(0.2 + index * 0.025, 3))
  const jawGrid = Array.from({ length: 30 }, (_, index) => round(0.01 + index * 0.01, 3))
  for (const smileBilateral of smileGrid) {
    for (const jawOpen of jawGrid) {
      const thresholds = { smileBilateral, jawOpen }
      const result = metric(engineering, thresholds)
      const neutral = metric(neutralPool, thresholds)
      if ((neutral.neutralFalseRejectRate ?? 1) > 0.01) continue
      const smileRecall = result.smilingRecallProxy ?? 0
      const mouthRecall = result.mouthOpenRecallProxy ?? 0
      const objective = Math.min(smileRecall, mouthRecall) * 0.7 + ((smileRecall + mouthRecall) / 2) * 0.3
      candidates.push({ thresholds, metric: result, neutralMetric: neutral, objective })
    }
  }
  candidates.sort((left, right) => right.objective - left.objective
    || (left.neutralMetric.neutralFalseRejectRate ?? 1) - (right.neutralMetric.neutralFalseRejectRate ?? 1)
    || right.thresholds.smileBilateral - left.thresholds.smileBilateral
    || right.thresholds.jawOpen - left.thresholds.jawOpen)
  if (!candidates.length) throw new Error('No V2 expression threshold met the combined engineering neutral <=1% constraint')
  return candidates[0]
}

function distribution(items: Evaluated[], signal: keyof Signals) {
  return quantiles(items.flatMap((item) => item.signals ? [item.signals[signal]] : []))
}

async function main() {
  const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
    return response.json() as Promise<Manifest>
  })
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  })
  const inputs = [
    ...manifest.records.map((record) => ({
      subjectId: record.subjectId,
      source: 'celeba' as const,
      split: record.split,
      labels: record.labels,
      coverage: record.coverage,
      assetUrl: `${stagingRoot}/${record.relativePath}`,
    })),
    ...manifest.authorizedNeutralRecords.map((record) => ({
      subjectId: record.sampleId,
      source: 'authorized_neutral' as const,
      split: record.split,
      labels: record.labels,
      assetUrl: record.assetUrl,
    })),
  ]
  const evaluated: Evaluated[] = []
  try {
    for (const [index, input] of inputs.entries()) {
      status.textContent = `处理真实表情图 ${index + 1} / ${inputs.length}`
      const blob = await fetch(input.assetUrl).then(async (response) => {
        if (!response.ok) throw new Error(`Image load failed: ${response.status}`)
        return response.blob()
      })
      const bitmap = await createImageBitmap(blob)
      try {
        const detection = landmarker.detect(bitmap)
        const categories = detection.faceBlendshapes[0]?.categories
        evaluated.push({
          subjectId: input.subjectId,
          source: input.source,
          split: input.split,
          labels: input.labels,
          ...('coverage' in input ? { coverage: input.coverage } : {}),
          detected: Boolean(categories?.length),
          ...(categories?.length ? { signals: signalFrom(toScoreMap(categories)) } : {}),
        })
      } finally {
        bitmap.close()
      }
    }
  } finally {
    landmarker.close()
  }

  const celebaEngineering = evaluated.filter((item) => item.source === 'celeba' && item.split === 'engineering')
  const celebaHoldout = evaluated.filter((item) => item.source === 'celeba' && item.split === 'holdout')
  const neutralEngineering = evaluated.filter((item) => item.source === 'authorized_neutral' && item.split === 'neutral_engineering')
  const neutralHoldout = evaluated.filter((item) => item.source === 'authorized_neutral' && item.split === 'neutral_holdout')
  const chosen = auditVariant === 'v2'
    ? chooseThresholdsV2(celebaEngineering, neutralEngineering)
    : chooseThresholds(celebaEngineering)
  const thresholds = chosen.thresholds
  const celeba = evaluated.filter((item) => item.source === 'celeba')
  const coverageKeys: (keyof Coverage)[] = ['masculinePresentationProxy', 'youngAppearanceProxy', 'eyeglasses', 'heavyMakeup']
  const byCoverage = Object.fromEntries(coverageKeys.map((key) => [key, {
    false: metric(celebaHoldout.filter((item) => item.coverage?.[key] === false), thresholds),
    true: metric(celebaHoldout.filter((item) => item.coverage?.[key] === true), thresholds),
  }]))
  const narrowControls = celeba.filter((item) => item.labels.narrowEyes)
  const nonNarrowControls = celeba.filter((item) => !item.labels.narrowEyes)
  const holdoutMacro = macroMetric(celebaHoldout, thresholds)
  const holdoutMetric = metric(celebaHoldout, thresholds)
  const authorizedHoldoutMetric = metric(neutralHoldout, thresholds)
  const masculineCoverage = celebaHoldout.filter((item) => item.coverage?.masculinePresentationProxy === true).length
  const v2Gates = {
    combinedEngineeringNeutralHasAtLeast120Images: metric([...celebaEngineering, ...neutralEngineering], thresholds).neutral >= 120,
    combinedEngineeringNeutralFalseRejectRateAtMost1Percent: (metric([...celebaEngineering, ...neutralEngineering], thresholds).neutralFalseRejectRate ?? 1) <= 0.01,
    holdoutCelebaNeutralFalseRejectRateAtMost2Percent: (holdoutMetric.neutralFalseRejectRate ?? 1) <= 0.02,
    authorizedNeutralHoldoutHasZeroFalseRejects: authorizedHoldoutMetric.neutral >= 15 && authorizedHoldoutMetric.neutralFalseRejects === 0,
    holdoutSmilingSubjectMacroRecallAtLeast80Percent: (holdoutMacro.smilingRecallProxyMacro ?? 0) >= 0.8,
    holdoutMouthOpenSubjectMacroRecallAtLeast80Percent: (holdoutMacro.mouthOpenRecallProxyMacro ?? 0) >= 0.8,
    holdoutAnyExpressionSubjectMacroRecallAtLeast75Percent: (holdoutMacro.expressionRecallProxyMacro ?? 0) >= 0.75,
    masculinePresentationProxyHoldoutHasAtLeast20Images: masculineCoverage >= 20,
  }
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: auditVariant === 'v2' ? 'HEADUP-CELEBA-EXPRESSION-AUDIT-2.0' : 'HEADUP-CELEBA-EXPRESSION-AUDIT-1.0',
    source: manifest.source,
    publisher: manifest.publisher,
    sourcePage: manifest.sourcePage,
    originalSourcePage: manifest.originalSourcePage,
    sourceCommit: manifest.sourceCommit,
    licenseBoundary: manifest.licenseBoundary,
    selection: manifest.selection,
    method: {
      model: 'MediaPipe Face Landmarker float16 v1, 52 blendshapes',
      signals: {
        smileBilateral: 'min(mouthSmileLeft, mouthSmileRight)',
        jawOpen: 'jawOpen',
        eyeClosureBilateral: 'min(eyeBlinkLeft, eyeBlinkRight)',
        eyeSquintBilateral: 'min(eyeSquintLeft, eyeSquintRight)',
      },
      thresholdSelection: auditVariant === 'v2'
        ? 'Expanded smile 0.20–0.95 and jaw 0.01–0.30 grids; maximize a balance-first recall objective on CelebA engineering identities subject to <=1% false rejects across CelebA plus 85 authorized engineering neutral controls.'
        : 'Grid selected on CelebA engineering identities only; maximize mean Smiling/Mouth_Slightly_Open recall proxy subject to <=2% neutral false rejects.',
      thresholds,
      engineeringSelectionMetric: chosen.metric,
      ...(auditVariant === 'v2' && 'neutralMetric' in chosen ? { combinedEngineeringNeutralSelectionMetric: chosen.neutralMetric } : {}),
    },
    evaluation: {
      celebaEngineering: metric(celebaEngineering, thresholds),
      celebaHoldout: holdoutMetric,
      celebaHoldoutSubjectMacro: holdoutMacro,
      authorizedNeutralEngineering: metric(neutralEngineering, thresholds),
      authorizedNeutralHoldout: authorizedHoldoutMetric,
      byHoldoutCoverage: byCoverage,
    },
    signalDistributions: {
      neutralCeleba: {
        smileBilateral: distribution(celeba.filter((item) => !item.labels.smiling && !item.labels.mouthSlightlyOpen), 'smileBilateral'),
        jawOpen: distribution(celeba.filter((item) => !item.labels.smiling && !item.labels.mouthSlightlyOpen), 'jawOpen'),
      },
      smilingCeleba: { smileBilateral: distribution(celeba.filter((item) => item.labels.smiling), 'smileBilateral') },
      mouthSlightlyOpenCeleba: { jawOpen: distribution(celeba.filter((item) => item.labels.mouthSlightlyOpen), 'jawOpen') },
      narrowEyesAsSafetyControl: {
        caveat: 'CelebA Narrow_Eyes is an appearance attribute, not a squint action label; it is used only to check anatomical false-reject risk.',
        narrowEyeClosure: distribution(narrowControls, 'eyeClosureBilateral'),
        narrowEyeSquint: distribution(narrowControls, 'eyeSquintBilateral'),
        nonNarrowEyeClosure: distribution(nonNarrowControls, 'eyeClosureBilateral'),
        nonNarrowEyeSquint: distribution(nonNarrowControls, 'eyeSquintBilateral'),
      },
    },
    decision: {
      productionSmileAndMouthGateEligible: auditVariant === 'v2' && Object.values(v2Gates).every(Boolean),
      productionIntegrated: false,
      ...(auditVariant === 'v2' ? { predeclaredV2Gates: v2Gates, passesAllV2Gates: Object.values(v2Gates).every(Boolean) } : {}),
      rationale: auditVariant === 'v2'
        ? 'V2 expands the previously omitted low jawOpen threshold range but still requires every predeclared identity-isolated recall, neutral false-reject and coverage gate. Passing would cover smile/mouth only; closed-eye/squint remains separately blocked.'
        : 'This benchmark supplies a threshold candidate and independent holdout evidence. Production integration requires reviewing holdout false rejects/recall and a separate real closed-eye/squint action dataset; Narrow_Eyes must not be treated as squint ground truth.',
    },
    limitations: [
      'CelebA attributes are weak binary annotations and do not encode expression intensity; Mouth_Slightly_Open is broader than the product requirement for obvious mouth opening.',
      'The 512x512 assets are aligned crops derived from real photographs, not standard HeadUp phone captures with full head framing.',
      'CelebA is non-commercial research only; images and per-image outputs cannot enter the commercial product or training assets.',
      'No eye-closure or squint-action ground truth is present, so no production eye-expression threshold is selected.',
    ],
    retention: {
      imagesDeletedAfterRun: false,
      sourceImageIdsRetained: false,
      sourceUrlsRetained: false,
      sourceNamesRetained: false,
      individualPredictionsRetained: false,
      aggregateOnly: true,
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
