import * as ort from 'onnxruntime-web/wasm'
import { detectFaces, type FaceDetection } from '../src/lib/faceDetector'

type Split = 'engineering' | 'holdout'
type Kind = 'bona_fide' | 'print_attack'
type ManifestRecord = { split: Split; kind: Kind; subjectGroup: string; glasses: string; position: string; session: string; path: string }
type Evaluated = Omit<ManifestRecord, 'path' | 'subjectGroup'> & { width: number; height: number; padScore: number | null }
type Manifest = {
  policyVersion: string
  source: Record<string, unknown>
  model: { name: string; sourceCommit: string; bytes: number; sha256: string; sha384: string; license: string }
  population: Record<string, unknown>
  selection: Record<string, { available: number; selected: number }>
  records: ManifestRecord[]
}

const statusElement = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
window.addEventListener('error', (event) => { resultElement.dataset.error = event.error instanceof Error ? event.error.stack ?? event.error.message : event.message })
window.addEventListener('unhandledrejection', (event) => { resultElement.dataset.error = event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason) })
const stagingRoot = '/data/face-benchmark/.staging/nuaa-print-attack'
const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
  if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
  return response.json() as Promise<Manifest>
})
if (manifest.policyVersion !== 'HEADUP-NUAA-PRINT-PREPARE-1.0') throw new Error('Unexpected NUAA manifest')

function asFsUrl(path: string) { return `/@fs/${path.replaceAll('\\', '/')}` }
function softmaxPair(values: number[]) {
  if (values.length !== 2) throw new Error(`Expected two PAD outputs, got ${values.length}`)
  if (values.every((value) => value >= 0 && value <= 1) && Math.abs(values[0] + values[1] - 1) < 0.01) return values
  const maximum = Math.max(...values); const exponents = values.map((value) => Math.exp(value - maximum)); const sum = exponents[0] + exponents[1]
  return exponents.map((value) => value / sum)
}
function bestDetection(detections: FaceDetection[]) { return [...detections].sort((left, right) => right.score - left.score)[0] }

async function padTensor(file: File) {
  const [summary, bitmap] = await Promise.all([detectFaces(file), createImageBitmap(file)])
  try {
    const detection = bestDetection(summary.detections)
    if (!detection) return { tensor: null, width: bitmap.width, height: bitmap.height }
    const detectorScale = 320 / Math.max(bitmap.width, bitmap.height)
    const detectorWidth = Math.max(1, Math.round(bitmap.width * detectorScale)); const detectorHeight = Math.max(1, Math.round(bitmap.height * detectorScale))
    const scaleX = bitmap.width / detectorWidth; const scaleY = bitmap.height / detectorHeight
    const sourceX = Math.max(0, detection.x * scaleX); const sourceY = Math.max(0, detection.y * scaleY)
    const sourceWidth = Math.min(bitmap.width - sourceX, detection.width * scaleX); const sourceHeight = Math.min(bitmap.height - sourceY, detection.height * scaleY)
    if (sourceWidth < 2 || sourceHeight < 2) return { tensor: null, width: bitmap.width, height: bitmap.height }
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('Unable to create PAD context')
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, 128, 128)
    const pixels = context.getImageData(0, 0, 128, 128).data; const size = 128 * 128; const input = new Float32Array(size * 3)
    const mean = [151.2405, 119.5950, 107.8395]; const divisor = [63.0105, 56.4570, 55.0035]
    for (let pixel = 0; pixel < size; pixel += 1) { const rgba = pixel * 4; input[pixel] = (pixels[rgba] - mean[0]) / divisor[0]; input[size + pixel] = (pixels[rgba + 1] - mean[1]) / divisor[1]; input[size * 2 + pixel] = (pixels[rgba + 2] - mean[2]) / divisor[2] }
    return { tensor: new ort.Tensor('float32', input, [1, 3, 128, 128]), width: bitmap.width, height: bitmap.height }
  } finally { bitmap.close() }
}

function percentile(values: number[], fraction: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.round((sorted.length - 1) * fraction)] }
function distribution(values: number[]) { return values.length ? { minimum: percentile(values, 0), p05: percentile(values, 0.05), median: percentile(values, 0.5), p95: percentile(values, 0.95), maximum: percentile(values, 1) } : null }
function groupBy<T>(items: T[], key: (item: T) => string) { return Object.groupBy(items, key) as Record<string, T[]> }

function metrics(items: Evaluated[], threshold: number) {
  const bonaFide = items.filter((item) => item.kind === 'bona_fide'); const attacks = items.filter((item) => item.kind === 'print_attack')
  const falseRejects = bonaFide.filter((item) => item.padScore === null || item.padScore >= threshold).length
  const attacksCaught = attacks.filter((item) => item.padScore === null || item.padScore >= threshold).length
  const ratio = (numerator: number, denominator: number) => denominator ? Number((numerator / denominator).toFixed(4)) : null
  return {
    threshold, bonaFide: bonaFide.length, bonaFideScored: bonaFide.filter((item) => item.padScore !== null).length, falseRejects,
    falseRejectRate: ratio(falseRejects, bonaFide.length), printAttacks: attacks.length,
    printAttacksScored: attacks.filter((item) => item.padScore !== null).length, attacksCaught,
    attackDetectionRate: ratio(attacksCaught, attacks.length), attackFalseAccepts: attacks.length - attacksCaught,
    attackFalseAcceptRate: ratio(attacks.length - attacksCaught, attacks.length),
  }
}

function selectThreshold(engineering: Evaluated[]) {
  const candidates = [...new Set([...engineering.map((item) => item.padScore).filter((value): value is number => value !== null), 1])].sort((a, b) => a - b)
  const eligible = candidates.map((threshold) => metrics(engineering, threshold)).filter((item) => item.falseRejectRate !== null && item.falseRejectRate <= 0.01)
  return eligible.sort((left, right) => (right.attackDetectionRate ?? -1) - (left.attackDetectionRate ?? -1) || (left.falseRejectRate ?? 1) - (right.falseRejectRate ?? 1) || left.threshold - right.threshold)[0] ?? null
}

const modelResponse = await fetch(`${stagingRoot}/model/anti-spoof-mn3.onnx`)
if (!modelResponse.ok) throw new Error(`Model load failed: ${modelResponse.status}`)
const session = await ort.InferenceSession.create(await modelResponse.arrayBuffer(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
const evaluated: Evaluated[] = []
for (const [index, record] of manifest.records.entries()) {
  statusElement.textContent = `NUAA 真人/打印照片 ${index + 1} / ${manifest.records.length}`
  const response = await fetch(asFsUrl(record.path)); if (!response.ok) throw new Error(`Image load failed: ${response.status}`)
  const file = new File([await response.blob()], `memory-${index}.jpg`, { type: 'image/jpeg' })
  const { tensor, width, height } = await padTensor(file)
  let padScore: number | null = null
  if (tensor) { const outputs = await session.run({ [session.inputNames[0]]: tensor }); padScore = softmaxPair(Array.from(outputs[session.outputNames[0]].data as ArrayLike<number>))[1] }
  evaluated.push({ split: record.split, kind: record.kind, glasses: record.glasses, position: record.position, session: record.session, width, height, padScore })
}

const engineering = evaluated.filter((item) => item.split === 'engineering'); const holdout = evaluated.filter((item) => item.split === 'holdout')
const selected = selectThreshold(engineering)
const priorThreshold = 0.78
const summarizeGroup = (items: Evaluated[]) => ({ images: items.length, scored: items.filter((item) => item.padScore !== null).length, score: distribution(items.flatMap((item) => item.padScore === null ? [] : [Number(item.padScore.toFixed(6))])), width: distribution(items.map((item) => item.width)), height: distribution(items.map((item) => item.height)) })
const bySplitKind = Object.fromEntries(Object.entries(groupBy(evaluated, (item) => `${item.split}_${item.kind}`)).map(([key, items]) => [key, summarizeGroup(items)]))
const byHoldoutCondition = Object.fromEntries(Object.entries(groupBy(holdout, (item) => `${item.kind}_glasses${item.glasses}_position${item.position}`)).map(([key, items]) => [key, { ...summarizeGroup(items), priorThreshold: metrics(items, priorThreshold), selectedThreshold: selected ? metrics(items, selected.threshold) : null }]))
const result = {
  testedAt: new Date().toISOString(), policyVersion: 'HEADUP-NUAA-PRINT-AUDIT-1.0', source: manifest.source, model: manifest.model,
  population: manifest.population, selection: manifest.selection,
  preprocessing: 'Exact HeadUp candidate pipeline: YuNet highest-score box, exact box crop, 128x128 RGB, official mean/divisor, spoof class probability.',
  evaluatedImages: evaluated.length, bySplitKind,
  priorFrozenThreshold: { origin: 'London engineering + physical screen replay engineering videos', engineering: metrics(engineering, priorThreshold), holdout: metrics(holdout, priorThreshold) },
  sourceSpecificThreshold: selected ? { selectionRule: 'maximize engineering print detection with total bona-fide false reject rate <=1%, null score rejects', engineering: selected, holdout: metrics(holdout, selected.threshold) } : { selectionRule: 'No threshold met the engineering live false-reject constraint', engineering: null, holdout: null },
  byHoldoutCondition,
  limitations: [
    'Official train/test partition is primarily by sessions 1/2 versus session 3; identities overlap and adjacent video frames are correlated.',
    'Detected-face crops are low resolution and do not follow the HeadUp smartphone capture protocol, so bona-fide acceptance is PAD stress evidence only.',
    'The archive transport SHA-256 is a HeadUp-observed fingerprint, not a checksum published by NUAA.',
  ],
  retention: { sourceArchiveDeletedDuringPreparation: true, sourceImagesDeletedAfterRun: false, modelDeletedAfterRun: false, sourcePathsRetained: false, perImagePredictionsRetained: false, aggregateOnly: true },
  decision: 'anti_spoof_mn3_remains_rejected_regardless_of_this_additional_domain_result',
}
resultElement.textContent = JSON.stringify(result, null, 2)
statusElement.textContent = '完成；保存聚合结果后立即清理 NUAA 真人/打印图与临时模型'
