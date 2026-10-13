import * as ort from 'onnxruntime-web/wasm'
import { detectFaces, type FaceDetection } from '../src/lib/faceDetector'
import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'

type Split = 'engineering' | 'holdout'
type Manifest = {
  policyVersion: string
  model: {
    name: string; sourcePage: string; originalRepository: string; sourceCommit: string; relativePath: string
    bytes: number; sha256: string; sha384: string; license: string; input: string
    mean: number[]; scale: number[]; officialOutput: string; officialCelebASpoofAcer: number
  }
  source: { bonaFide: string; attacks: string; attackSourceCommit: string; attackLicense: string }
  sampleFractions: number[]
  bonaFideRecords: Array<{ split: Split; assetUrl: string }>
  replayRecords: Array<{ split: Split; captureGroup: 'pc_display' | 'mobile_display'; assetUrl: string; bytes: number; sha256: string }>
}
type Evaluated = {
  kind: 'bona_fide' | 'attack'
  split: Split
  captureGroup?: 'pc_display' | 'mobile_display'
  videoSlot?: number
  qualityPass: boolean
  posePass: boolean
  productionEligible: boolean
  padScore: number | null
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/anti-spoof-mn3'
const YuNetMaxInputEdge = 320

function softmaxPair(values: number[]) {
  if (values.length !== 2) throw new Error(`Expected two PAD outputs, got ${values.length}`)
  const looksLikeProbabilities = values.every((value) => value >= 0 && value <= 1)
    && Math.abs(values[0] + values[1] - 1) < 0.01
  if (looksLikeProbabilities) return values
  const maximum = Math.max(...values)
  const exponentials = values.map((value) => Math.exp(value - maximum))
  const denominator = exponentials[0] + exponentials[1]
  return exponentials.map((value) => value / denominator)
}

function bestDetection(detections: FaceDetection[]) {
  return [...detections].sort((left, right) => right.score - left.score)[0]
}

async function padTensor(file: File) {
  const [summary, bitmap] = await Promise.all([detectFaces(file), createImageBitmap(file)])
  try {
    const detection = bestDetection(summary.detections)
    if (!detection) return null
    const scaleToDetector = YuNetMaxInputEdge / Math.max(bitmap.width, bitmap.height)
    const detectorContentWidth = Math.max(1, Math.round(bitmap.width * scaleToDetector))
    const detectorContentHeight = Math.max(1, Math.round(bitmap.height * scaleToDetector))
    const scaleX = bitmap.width / detectorContentWidth
    const scaleY = bitmap.height / detectorContentHeight
    const sourceX = Math.max(0, detection.x * scaleX)
    const sourceY = Math.max(0, detection.y * scaleY)
    const sourceWidth = Math.min(bitmap.width - sourceX, detection.width * scaleX)
    const sourceHeight = Math.min(bitmap.height - sourceY, detection.height * scaleY)
    if (sourceWidth < 2 || sourceHeight < 2) return null
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Unable to create PAD preprocessing context')
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, 128, 128)
    const pixels = context.getImageData(0, 0, 128, 128).data
    const channelSize = 128 * 128
    const input = new Float32Array(channelSize * 3)
    const mean = [151.2405, 119.5950, 107.8395]
    const divisor = [63.0105, 56.4570, 55.0035]
    for (let pixel = 0; pixel < channelSize; pixel++) {
      const rgba = pixel * 4
      input[pixel] = (pixels[rgba] - mean[0]) / divisor[0]
      input[channelSize + pixel] = (pixels[rgba + 1] - mean[1]) / divisor[1]
      input[channelSize * 2 + pixel] = (pixels[rgba + 2] - mean[2]) / divisor[2]
    }
    return new ort.Tensor('float32', input, [1, 3, 128, 128])
  } finally {
    bitmap.close()
  }
}

async function padScore(session: ort.InferenceSession, file: File) {
  const tensor = await padTensor(file)
  if (!tensor) return null
  const outputs = await session.run({ [session.inputNames[0]]: tensor })
  const values = Array.from(outputs[session.outputNames[0]].data as ArrayLike<number>)
  return softmaxPair(values)[1]
}

async function evaluateFile(session: ort.InferenceSession, file: File) {
  const [quality, pose, score] = await Promise.all([
    inspectImage(file),
    inspectCapturePose('front', file),
    padScore(session, file),
  ])
  const qualityPass = isPhotoQualityAcceptable(quality)
  const posePass = pose.status === 'pass'
  return { qualityPass, posePass, productionEligible: qualityPass && posePass, padScore: score }
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'; video.muted = true; video.playsInline = true
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error(`Unable to decode replay video: ${video.error?.message ?? 'unknown error'}`))
    video.src = url; video.load()
  })
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`Video seek timed out at ${time.toFixed(2)}s`)), 15000)
    video.onseeked = () => { window.clearTimeout(timeout); resolve() }
    video.onerror = () => { window.clearTimeout(timeout); reject(new Error(video.error?.message ?? 'Video seek failed')) }
    video.currentTime = time
  })
}

function frameToFile(video: HTMLVideoElement): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth; canvas.height = video.videoHeight
  canvas.getContext('2d')!.drawImage(video, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(new File([blob], 'transient-frame.jpg', { type: 'image/jpeg' })) : reject(new Error('Frame encoding failed')),
    'image/jpeg', 0.92,
  ))
}

function quantile(values: number[], probability: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position); const upper = Math.ceil(position)
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)).toFixed(6))
}

function distribution(values: number[]) {
  return { observations: values.length, min: quantile(values, 0), median: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) }
}

function chooseThreshold(items: Evaluated[]) {
  const live = items.filter((item) => item.kind === 'bona_fide' && item.productionEligible && item.padScore !== null)
  const attacks = items.filter((item) => item.kind === 'attack' && item.productionEligible && item.padScore !== null)
  const candidates = [...Array.from({ length: 201 }, (_value, index) => index / 200), 1.0001]
  const feasible = candidates.map((threshold) => ({
    threshold,
    liveFalseRejects: live.filter((item) => item.padScore! >= threshold).length,
    attacksCaught: attacks.filter((item) => item.padScore! >= threshold).length,
  })).filter((candidate) => candidate.liveFalseRejects <= 1)
  feasible.sort((left, right) => right.attacksCaught - left.attacksCaught
    || left.liveFalseRejects - right.liveFalseRejects
    || right.threshold - left.threshold)
  return { ...feasible[0], engineeringLiveEligible: live.length, engineeringAttackEligible: attacks.length }
}

function summarize(items: Evaluated[], threshold: number) {
  const scored = items.filter((item) => item.padScore !== null)
  const eligible = scored.filter((item) => item.productionEligible)
  const candidateSpoofAllScored = scored.filter((item) => item.padScore! >= threshold).length
  const candidateSpoofAmongProductionEligible = eligible.filter((item) => item.padScore! >= threshold).length
  return {
    attempted: items.length,
    qualityPassed: items.filter((item) => item.qualityPass).length,
    posePassed: items.filter((item) => item.posePass).length,
    productionEligible: items.filter((item) => item.productionEligible).length,
    padScored: scored.length,
    candidateSpoofAllScored,
    candidateSpoofAmongProductionEligible,
    finalAcceptedAfterProductionGateAndPad: eligible.length - candidateSpoofAmongProductionEligible,
    scoreDistributionAmongProductionEligible: distribution(eligible.map((item) => item.padScore!)),
  }
}

async function run() {
  const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
    return response.json() as Promise<Manifest>
  })
  if (manifest.policyVersion !== 'HEADUP-ANTI-SPOOF-MN3-PREPARE-1.0') throw new Error('Unexpected prepare policy')
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(`${stagingRoot}/${manifest.model.relativePath}`, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  })
  const evaluated: Evaluated[] = []

  for (const [index, record] of manifest.bonaFideRecords.entries()) {
    status.textContent = `处理授权真人正面对照 ${index + 1} / ${manifest.bonaFideRecords.length}`
    const blob = await fetch(record.assetUrl).then((response) => {
      if (!response.ok) throw new Error(`Bona-fide image load failed: ${response.status}`)
      return response.blob()
    })
    evaluated.push({ kind: 'bona_fide', split: record.split, ...await evaluateFile(session, new File([blob], 'authorized-front.jpg', { type: blob.type || 'image/jpeg' })) })
  }

  for (const [videoSlot, record] of manifest.replayRecords.entries()) {
    const video = await loadVideo(record.assetUrl)
    for (const [frameIndex, fraction] of manifest.sampleFractions.entries()) {
      status.textContent = `处理真实屏幕翻拍 ${videoSlot + 1} / ${manifest.replayRecords.length}，帧 ${frameIndex + 1} / ${manifest.sampleFractions.length}`
      await seek(video, Math.min(video.duration - 0.05, Math.max(0, video.duration * fraction)))
      evaluated.push({
        kind: 'attack', split: record.split, captureGroup: record.captureGroup, videoSlot,
        ...await evaluateFile(session, await frameToFile(video)),
      })
    }
    video.removeAttribute('src'); video.load()
  }

  const engineering = evaluated.filter((item) => item.split === 'engineering')
  const thresholdSelection = chooseThreshold(engineering)
  const threshold = thresholdSelection.threshold
  const bonaEngineering = evaluated.filter((item) => item.kind === 'bona_fide' && item.split === 'engineering')
  const bonaHoldout = evaluated.filter((item) => item.kind === 'bona_fide' && item.split === 'holdout')
  const attackEngineering = evaluated.filter((item) => item.kind === 'attack' && item.split === 'engineering')
  const attackHoldout = evaluated.filter((item) => item.kind === 'attack' && item.split === 'holdout')
  const attackGroups = ['pc_display', 'mobile_display'] as const
  const byCaptureGroup = Object.fromEntries(attackGroups.map((group) => [group, {
    engineering: summarize(attackEngineering.filter((item) => item.captureGroup === group), threshold),
    holdout: summarize(attackHoldout.filter((item) => item.captureGroup === group), threshold),
  }]))
  const perVideo = Object.fromEntries(manifest.replayRecords.map((_record, videoSlot) => [
    `video_${String(videoSlot + 1).padStart(2, '0')}`,
    summarize(evaluated.filter((item) => item.kind === 'attack' && item.videoSlot === videoSlot), threshold),
  ]))

  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-ANTI-SPOOF-MN3-AUDIT-1.0',
    model: manifest.model,
    method: {
      faceCrop: 'Exact highest-score YuNet face bounding box, matching the original webcam demo crop behavior',
      outputMapping: 'Official class 0 real, class 1 spoof; softmax only when output is not already a probability pair',
      thresholdSelection: {
        split: 'engineering only: 85 bona-fide identities and three replay videos',
        gridStep: 0.005,
        constraint: 'at most one production-eligible engineering bona-fide false reject',
        objective: 'maximize caught production-eligible engineering replay frames; then minimize false rejects; then prefer higher threshold',
        ...thresholdSelection,
      },
      threshold,
      sampleFractions: manifest.sampleFractions,
    },
    sources: manifest.source,
    selection: {
      bonaFideIdentities: manifest.bonaFideRecords.length,
      engineeringBonaFideIdentities: bonaEngineering.length,
      holdoutBonaFideIdentities: bonaHoldout.length,
      replayVideos: manifest.replayRecords.length,
      engineeringReplayVideos: manifest.replayRecords.filter((item) => item.split === 'engineering').length,
      holdoutReplayVideos: manifest.replayRecords.filter((item) => item.split === 'holdout').length,
      framesPerVideo: manifest.sampleFractions.length,
      verifiedReplayBytes: manifest.replayRecords.reduce((sum, item) => sum + item.bytes, 0),
    },
    evaluation: {
      bonaFideEngineering: summarize(bonaEngineering, threshold),
      bonaFideHoldout: summarize(bonaHoldout, threshold),
      attackEngineering: summarize(attackEngineering, threshold),
      attackHoldout: summarize(attackHoldout, threshold),
      attackByCaptureGroup: byCaptureGroup,
      attackPerVideoAggregate: perVideo,
    },
    interpretation: 'A bona-fide candidate spoof flag is a false reject. An attack final acceptance after production gate and PAD is an attack false accept. Frames from the same video are correlated and are not independent attacks.',
    scope: 'Static RGB candidate audit only. London controls are authorized studio photographs, not fresh sensor-captured bona-fide phone sessions. The six replay videos do not cover print, 3D mask, camera injection or challenge-response attacks. No certification claim.',
    productionDecision: 'Candidate remains research-only until fresh phone bona-fide A/B captures and broader attack instruments meet pre-registered subject- and device-isolated thresholds.',
    retention: {
      sourceImagesCopied: false,
      framesWritten: false,
      individualPredictionsRetained: false,
      modelAndVideosRequireCleanup: true,
      aggregateOnly: true,
    },
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  status.textContent = '完成；请固化聚合结果并立即清理模型与视频'
}

void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  resultElement.dataset.error = message
  status.textContent = `失败：${message}`
})
