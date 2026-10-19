import { inspectCapturePose } from '../src/lib/facePose'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'
import type { LandmarkPoint, PoseValidation } from '../src/types'

type Point = { x: number; y: number }
type Split = 'mappingEngineering' | 'mappingHoldout' | 'externalTest'
type RecordItem = {
  file: string
  split: Split
  bbox: { left: number; top: number; right: number; bottom: number }
  landmarkBox: { left: number; top: number; right: number; bottom: number }
  manual: Record<string, Point>
  contour: Point[]
}
type Predicted = {
  viewerLeftCheek: Point; viewerRightCheek: Point; viewerLeftJaw: Point; viewerRightJaw: Point
  viewerLeftEyeCenter: Point; viewerRightEyeCenter: Point; viewerLeftMouthCorner: Point; viewerRightMouthCorner: Point
}
type Case = RecordItem & { pose: PoseValidation; predicted: Predicted | null; transformedManual: Record<string, Point>; transformedContour: Point[]; landmarkDiagonal: number }

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/data/face-benchmark/.staging/wflw-groundtruth'
const manifest = await fetch(`${stagingRoot}/sample-manifest.json`).then((response) => {
  if (!response.ok) throw new Error(`WFLW contour manifest unavailable: HTTP ${response.status}`)
  return response.json()
}) as {
  policyVersion: string; source: Record<string, unknown>; selection: string; records: RecordItem[]
  counts: Record<Split, number>; imageLeakageAcrossEngineeringHoldout: boolean
  faceContourCandidates: number[]; jawContourCandidates: number[]
}

function quantiles(values: number[], digits = 3) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const at = (fraction: number) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(digits))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

function distance(left: Point, right: Point) { return Math.hypot(left.x - right.x, left.y - right.y) }
function average(points: LandmarkPoint[]): Point { return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length } }

function predictedFromPose(pose: PoseValidation): Predicted | null {
  if (!pose.landmarks || !pose.landmarkImageWidth || !pose.landmarkImageHeight || pose.landmarks.length < 478) return null
  const landmarks = pose.landmarks
  const scale = (point: Point) => ({ x: point.x * pose.landmarkImageWidth!, y: point.y * pose.landmarkImageHeight! })
  const cheeks = [landmarks[234], landmarks[454]].sort((left, right) => left.x - right.x)
  const jaw = [landmarks[172], landmarks[397]].sort((left, right) => left.x - right.x)
  const eyes = [average(landmarks.slice(468, 473)), average(landmarks.slice(473, 478))].sort((left, right) => left.x - right.x)
  const mouth = [landmarks[61], landmarks[291]].sort((left, right) => left.x - right.x)
  return {
    viewerLeftCheek: scale(cheeks[0]), viewerRightCheek: scale(cheeks[1]), viewerLeftJaw: scale(jaw[0]), viewerRightJaw: scale(jaw[1]),
    viewerLeftEyeCenter: scale(eyes[0]), viewerRightEyeCenter: scale(eyes[1]), viewerLeftMouthCorner: scale(mouth[0]), viewerRightMouthCorner: scale(mouth[1]),
  }
}

async function standardizedCrop(blob: Blob, record: RecordItem) {
  const bitmap = await createImageBitmap(blob)
  try {
    const side = Math.max(1, Math.max(record.bbox.right - record.bbox.left, record.bbox.bottom - record.bbox.top) * 1.6)
    const cropLeft = (record.bbox.left + record.bbox.right - side) / 2
    const cropTop = (record.bbox.top + record.bbox.bottom - side) / 2
    const outputSize = 1200; const scale = outputSize / side
    const canvas = document.createElement('canvas'); canvas.width = outputSize; canvas.height = outputSize
    const context = canvas.getContext('2d'); if (!context) throw new Error('Unable to create WFLW contour crop')
    context.fillStyle = '#808080'; context.fillRect(0, 0, outputSize, outputSize)
    context.drawImage(bitmap, -cropLeft * scale, -cropTop * scale, bitmap.width * scale, bitmap.height * scale)
    const cropBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Unable to encode WFLW contour crop')), 'image/jpeg', 0.95))
    const transform = (point: Point) => ({ x: (point.x - cropLeft) * scale, y: (point.y - cropTop) * scale })
    const landmarkDiagonal = Math.max(1, Math.hypot(record.landmarkBox.right - record.landmarkBox.left, record.landmarkBox.bottom - record.landmarkBox.top) * scale)
    return {
      file: new File([cropBlob], 'wflw-contour-transient.jpg', { type: 'image/jpeg' }),
      transformedManual: Object.fromEntries(Object.entries(record.manual).map(([name, point]) => [name, transform(point)])),
      transformedContour: record.contour.map(transform), landmarkDiagonal,
    }
  } finally { bitmap.close() }
}

function candidateError(item: Case, index: number, kind: 'face' | 'jaw') {
  if (!item.predicted) return Number.NaN
  const leftPredicted = kind === 'face' ? item.predicted.viewerLeftCheek : item.predicted.viewerLeftJaw
  const rightPredicted = kind === 'face' ? item.predicted.viewerRightCheek : item.predicted.viewerRightJaw
  return 50 * (distance(leftPredicted, item.transformedContour[index]) + distance(rightPredicted, item.transformedContour[32 - index])) / item.landmarkDiagonal
}

function selectMapping(engineering: Case[], candidates: number[], kind: 'face' | 'jaw') {
  const scores = candidates.map((index) => ({ index, error: quantiles(engineering.map((item) => candidateError(item, index, kind))) }))
  const selected = [...scores].sort((left, right) => (left.error?.median ?? Infinity) - (right.error?.median ?? Infinity) || (left.error?.p95 ?? Infinity) - (right.error?.p95 ?? Infinity))[0]
  const perCaseWinners = engineering.map((item) => [...candidates].sort((left, right) => candidateError(item, left, kind) - candidateError(item, right, kind))[0])
  const selectedWins = perCaseWinners.filter((index) => index === selected.index).length
  return { selectedIndex: selected.index, counterpartIndex: 32 - selected.index, selectedBy: 'lowest engineering median paired-point NME; P95 tie-break', candidateScores: scores, perImageWinnerShare: Number((selectedWins / engineering.length).toFixed(4)) }
}

function summarize(items: Case[], faceIndex: number, jawIndex: number) {
  const comparable = items.filter((item) => item.predicted)
  const pointErrors = { faceLeft: [] as number[], faceRight: [] as number[], jawLeft: [] as number[], jawRight: [] as number[] }
  const ratioErrors = { faceWidth: [] as number[], jawWidth: [] as number[], pupilDistanceFaceWidthRatio: [] as number[], jawWidthRatio: [] as number[], mouthWidthRatio: [] as number[] }
  for (const item of comparable) {
    const predicted = item.predicted!
    const faceLeft = item.transformedContour[faceIndex]; const faceRight = item.transformedContour[32 - faceIndex]
    const jawLeft = item.transformedContour[jawIndex]; const jawRight = item.transformedContour[32 - jawIndex]
    pointErrors.faceLeft.push(100 * distance(predicted.viewerLeftCheek, faceLeft) / item.landmarkDiagonal)
    pointErrors.faceRight.push(100 * distance(predicted.viewerRightCheek, faceRight) / item.landmarkDiagonal)
    pointErrors.jawLeft.push(100 * distance(predicted.viewerLeftJaw, jawLeft) / item.landmarkDiagonal)
    pointErrors.jawRight.push(100 * distance(predicted.viewerRightJaw, jawRight) / item.landmarkDiagonal)
    const truthFaceWidth = distance(faceLeft, faceRight); const truthJawWidth = distance(jawLeft, jawRight)
    const predictedFaceWidth = distance(predicted.viewerLeftCheek, predicted.viewerRightCheek); const predictedJawWidth = distance(predicted.viewerLeftJaw, predicted.viewerRightJaw)
    const truthPupil = distance(item.transformedManual.viewerLeftEyeCenter, item.transformedManual.viewerRightEyeCenter)
    const predictedPupil = distance(predicted.viewerLeftEyeCenter, predicted.viewerRightEyeCenter)
    const truthMouth = distance(item.transformedManual.viewerLeftMouthCorner, item.transformedManual.viewerRightMouthCorner)
    const predictedMouth = distance(predicted.viewerLeftMouthCorner, predicted.viewerRightMouthCorner)
    const relative = (actual: number, truth: number) => 100 * Math.abs(actual - truth) / Math.max(Math.abs(truth), 0.0001)
    ratioErrors.faceWidth.push(relative(predictedFaceWidth, truthFaceWidth)); ratioErrors.jawWidth.push(relative(predictedJawWidth, truthJawWidth))
    ratioErrors.pupilDistanceFaceWidthRatio.push(relative(predictedPupil / predictedFaceWidth, truthPupil / truthFaceWidth))
    ratioErrors.jawWidthRatio.push(relative(predictedJawWidth / predictedFaceWidth, truthJawWidth / truthFaceWidth))
    ratioErrors.mouthWidthRatio.push(relative(predictedMouth / predictedFaceWidth, truthMouth / truthFaceWidth))
  }
  return {
    faces: items.length, productionPosePassedComparableFaces: comparable.length,
    pointNmePercent: Object.fromEntries(Object.entries(pointErrors).map(([name, values]) => [name, quantiles(values)])),
    ratioAbsoluteRelativeErrorPercent: Object.fromEntries(Object.entries(ratioErrors).map(([name, values]) => [name, quantiles(values)])),
  }
}

const cases: Case[] = []
try {
  for (const [index, record] of manifest.records.entries()) {
    status.textContent = `处理 ${index + 1} / ${manifest.records.length}`
    const encodedPath = record.file.split('/').map(encodeURIComponent).join('/')
    const blob = await fetch(`${stagingRoot}/mirror-extract/WFLW_images/${encodedPath}`).then((response) => {
      if (!response.ok) throw new Error(`WFLW contour image unavailable: HTTP ${response.status}`)
      return response.blob()
    })
    const crop = await standardizedCrop(blob, record)
    const pose = await inspectCapturePose('front', crop.file)
    cases.push({ ...record, pose, predicted: predictedFromPose(pose), transformedManual: crop.transformedManual, transformedContour: crop.transformedContour, landmarkDiagonal: crop.landmarkDiagonal })
  }

  const engineering = cases.filter((item) => item.split === 'mappingEngineering' && item.predicted)
  const faceMapping = selectMapping(engineering, manifest.faceContourCandidates, 'face')
  const jawMapping = selectMapping(engineering, manifest.jawContourCandidates, 'jaw')
  const bySplit = Object.fromEntries((Object.keys(manifest.counts) as Split[]).map((split) => [split, summarize(cases.filter((item) => item.split === split), faceMapping.selectedIndex, jawMapping.selectedIndex)]))
  const legacyExternal = summarize(cases.filter((item) => item.split === 'externalTest'), 4, 8)
  const holdout = bySplit.mappingHoldout
  const faceP95 = Math.max(holdout.pointNmePercent.faceLeft?.p95 ?? Infinity, holdout.pointNmePercent.faceRight?.p95 ?? Infinity)
  const jawP95 = Math.max(holdout.pointNmePercent.jawLeft?.p95 ?? Infinity, holdout.pointNmePercent.jawRight?.p95 ?? Infinity)
  const ratioChecks = {
    pupilDistanceFaceWidthRatio: { p95ThresholdPercent: 12, actualP95: holdout.ratioAbsoluteRelativeErrorPercent.pupilDistanceFaceWidthRatio?.p95, passed: (holdout.ratioAbsoluteRelativeErrorPercent.pupilDistanceFaceWidthRatio?.p95 ?? Infinity) <= 12 },
    jawWidthRatio: { p95ThresholdPercent: 12, actualP95: holdout.ratioAbsoluteRelativeErrorPercent.jawWidthRatio?.p95, passed: (holdout.ratioAbsoluteRelativeErrorPercent.jawWidthRatio?.p95 ?? Infinity) <= 12 },
    mouthWidthRatio: { p95ThresholdPercent: 20, actualP95: holdout.ratioAbsoluteRelativeErrorPercent.mouthWidthRatio?.p95, passed: (holdout.ratioAbsoluteRelativeErrorPercent.mouthWidthRatio?.p95 ?? Infinity) <= 20 },
  }
  const result = {
    testedAt: new Date().toISOString(), analysisPolicyVersion: 'HEADUP-WFLW-CONTOUR-CALIBRATION-1.0', policyVersion: manifest.policyVersion,
    source: manifest.source, selection: manifest.selection, faces: cases.length, counts: manifest.counts,
    isolation: { imageLeakageAcrossEngineeringHoldout: manifest.imageLeakageAcrossEngineeringHoldout, mappingSelectedOnlyOn: 'mappingEngineering', formalValidation: 'mappingHoldout', externalTestRole: 'secondary reanalysis; WFLW test aggregate was observed in the preceding v1 audit' },
    productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
    selectedMapping: { faceWidth: faceMapping, jawWidth: jawMapping },
    bySplit,
    legacyExternalTestMapping: { mapping: { face: [4, 28], jaw: [8, 24] }, result: legacyExternal },
    predeclaredCriteria: { minimumEngineeringComparable: 100, minimumHoldoutComparable: 70, holdoutFaceAndJawPointP95Percent: 8, holdoutRatioP95Percent: { pupilDistanceFaceWidthRatio: 12, jawWidthRatio: 12, mouthWidthRatio: 20 }, note: 'Ratio thresholds were declared after the v1 external-test audit but before this path-disjoint official-train holdout was run.' },
    evaluation: {
      engineeringComparableSufficient: engineering.length >= 100,
      holdoutComparableSufficient: holdout.productionPosePassedComparableFaces >= 70,
      facePointP95: faceP95, facePointP95Passed: faceP95 <= 8,
      jawPointP95: jawP95, jawPointP95Passed: jawP95 <= 8,
      ratioChecks,
      formalHoldoutVerdict: engineering.length >= 100 && holdout.productionPosePassedComparableFaces >= 70 && faceP95 <= 8 && jawP95 <= 8 && Object.values(ratioChecks).every((value) => value.passed) ? 'all_predeclared_holdout_gates_passed' : 'one_or_more_predeclared_holdout_gates_failed_or_insufficient',
    },
    limitations: ['WFLW train split has no identity labels; path-level isolation prevents the same scene file crossing engineering/holdout but cannot prove person-level isolation.', 'GT-box standardized crops are best-case alignment evidence, not phone capture usability.', 'Contour index mapping is annotation-protocol alignment, not anatomical truth.'],
    retention: { imagesRetainedAfterCleanup: false, annotationsRetainedAfterCleanup: false, individualPredictionsRetained: false, originalIdentifiersRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2); status.textContent = '完成'
} catch (error) {
  resultElement.dataset.error = error instanceof Error ? error.stack || error.message : String(error); status.textContent = '失败'; throw error
}
