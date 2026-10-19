import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'

type Split = 'engineering' | 'holdout'
type Manifest = {
  policyVersion: string
  model: Record<string, unknown>
  source: { bonaFide: string; attacks: string; attackSourceCommit: string; attackLicense: string }
  sampleFractions: number[]
  bonaFideRecords: Array<{ split: Split; assetUrl: string; spoofScore: number | null }>
  replayRecords: Array<{ split: Split; captureGroup: 'pc_display' | 'mobile_display'; assetUrl: string; bytes: number; sha256: string; spoofScores: Array<number | null> }>
}
type Evaluated = {
  kind: 'bona_fide' | 'attack'; split: Split; captureGroup?: 'pc_display' | 'mobile_display'; videoSlot?: number
  qualityPass: boolean; posePass: boolean; productionEligible: boolean; spoofScore: number | null
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/data/face-benchmark/.staging/silent-face-pad'

async function evaluateProduction(file: File) {
  const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
  const qualityPass = isPhotoQualityAcceptable(quality); const posePass = pose.status === 'pass'
  return { qualityPass, posePass, productionEligible: qualityPass && posePass }
}
function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true
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
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
  canvas.getContext('2d')!.drawImage(video, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(new File([blob], 'transient-frame.jpg', { type: 'image/jpeg' })) : reject(new Error('Frame encoding failed')),
    'image/jpeg', 0.92,
  ))
}
function quantile(values: number[], probability: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * probability
  const lower = Math.floor(position); const upper = Math.ceil(position)
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)).toFixed(6))
}
function distribution(values: number[]) {
  return { observations: values.length, min: quantile(values, 0), median: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) }
}
function chooseThreshold(items: Evaluated[]) {
  const live = items.filter((item) => item.kind === 'bona_fide' && item.productionEligible && item.spoofScore !== null)
  const attacks = items.filter((item) => item.kind === 'attack' && item.productionEligible && item.spoofScore !== null)
  const candidates = [...Array.from({ length: 201 }, (_value, index) => index / 200), 1.0001]
  const feasible = candidates.map((threshold) => ({
    threshold,
    liveFalseRejects: live.filter((item) => item.spoofScore! >= threshold).length,
    attacksCaught: attacks.filter((item) => item.spoofScore! >= threshold).length,
  })).filter((candidate) => candidate.liveFalseRejects <= 1)
  feasible.sort((left, right) => right.attacksCaught - left.attacksCaught || left.liveFalseRejects - right.liveFalseRejects || right.threshold - left.threshold)
  return { ...feasible[0], engineeringLiveEligible: live.length, engineeringAttackEligible: attacks.length }
}
function summarize(items: Evaluated[], threshold: number) {
  const scored = items.filter((item) => item.spoofScore !== null); const eligible = scored.filter((item) => item.productionEligible)
  const candidateSpoofAllScored = scored.filter((item) => item.spoofScore! >= threshold).length
  const candidateSpoofAmongProductionEligible = eligible.filter((item) => item.spoofScore! >= threshold).length
  return {
    attempted: items.length, qualityPassed: items.filter((item) => item.qualityPass).length,
    posePassed: items.filter((item) => item.posePass).length, productionEligible: items.filter((item) => item.productionEligible).length,
    padScored: scored.length, candidateSpoofAllScored, candidateSpoofAmongProductionEligible,
    finalAcceptedAfterProductionGateAndPad: eligible.length - candidateSpoofAmongProductionEligible,
    scoreDistributionAmongProductionEligible: distribution(eligible.map((item) => item.spoofScore!)),
  }
}

async function run() {
  const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
    return response.json() as Promise<Manifest>
  })
  if (manifest.policyVersion !== 'HEADUP-SILENT-FACE-PREPARE-1.0') throw new Error('Unexpected prepare policy')
  const evaluated: Evaluated[] = []
  for (const [index, record] of manifest.bonaFideRecords.entries()) {
    status.textContent = `处理授权真人正面对照 ${index + 1} / ${manifest.bonaFideRecords.length}`
    const blob = await fetch(record.assetUrl).then((response) => {
      if (!response.ok) throw new Error(`Bona-fide image load failed: ${response.status}`); return response.blob()
    })
    evaluated.push({ kind: 'bona_fide', split: record.split, spoofScore: record.spoofScore, ...await evaluateProduction(new File([blob], 'authorized-front.jpg', { type: blob.type || 'image/jpeg' })) })
  }
  for (const [videoSlot, record] of manifest.replayRecords.entries()) {
    const video = await loadVideo(record.assetUrl)
    for (const [frameIndex, fraction] of manifest.sampleFractions.entries()) {
      status.textContent = `处理真实屏幕翻拍 ${videoSlot + 1} / ${manifest.replayRecords.length}，帧 ${frameIndex + 1} / ${manifest.sampleFractions.length}`
      await seek(video, Math.min(video.duration - 0.05, Math.max(0, video.duration * fraction)))
      evaluated.push({ kind: 'attack', split: record.split, captureGroup: record.captureGroup, videoSlot, spoofScore: record.spoofScores[frameIndex], ...await evaluateProduction(await frameToFile(video)) })
    }
    video.removeAttribute('src'); video.load()
  }
  const engineering = evaluated.filter((item) => item.split === 'engineering')
  const thresholdSelection = chooseThreshold(engineering); const threshold = thresholdSelection.threshold
  const bonaEngineering = evaluated.filter((item) => item.kind === 'bona_fide' && item.split === 'engineering')
  const bonaHoldout = evaluated.filter((item) => item.kind === 'bona_fide' && item.split === 'holdout')
  const attackEngineering = evaluated.filter((item) => item.kind === 'attack' && item.split === 'engineering')
  const attackHoldout = evaluated.filter((item) => item.kind === 'attack' && item.split === 'holdout')
  const groups = ['pc_display', 'mobile_display'] as const
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-SILENT-FACE-PAD-AUDIT-1.0', model: manifest.model,
    method: {
      pipeline: 'Official RetinaFace detector, official 2.7x MiniFASNetV2 and 4.0x MiniFASNetV1SE crops, ensemble mean real probability',
      score: 'spoofScore = 1 - mean(class 1 real probability)',
      thresholdSelection: { split: 'engineering only: 85 bona-fide identities and three replay videos', gridStep: 0.005, constraint: 'at most one production-eligible engineering bona-fide false reject', objective: 'maximize caught production-eligible engineering replay frames; then minimize false rejects; then prefer higher threshold', ...thresholdSelection },
      threshold, sampleFractions: manifest.sampleFractions,
    },
    sources: manifest.source,
    selection: {
      bonaFideIdentities: manifest.bonaFideRecords.length, engineeringBonaFideIdentities: bonaEngineering.length, holdoutBonaFideIdentities: bonaHoldout.length,
      replayVideos: manifest.replayRecords.length, engineeringReplayVideos: manifest.replayRecords.filter((item) => item.split === 'engineering').length,
      holdoutReplayVideos: manifest.replayRecords.filter((item) => item.split === 'holdout').length, framesPerVideo: manifest.sampleFractions.length,
      verifiedReplayBytes: manifest.replayRecords.reduce((sum, item) => sum + item.bytes, 0),
    },
    evaluation: {
      bonaFideEngineering: summarize(bonaEngineering, threshold), bonaFideHoldout: summarize(bonaHoldout, threshold),
      attackEngineering: summarize(attackEngineering, threshold), attackHoldout: summarize(attackHoldout, threshold),
      attackByCaptureGroup: Object.fromEntries(groups.map((group) => [group, {
        engineering: summarize(attackEngineering.filter((item) => item.captureGroup === group), threshold),
        holdout: summarize(attackHoldout.filter((item) => item.captureGroup === group), threshold),
      }])),
      attackPerVideoAggregate: Object.fromEntries(manifest.replayRecords.map((_record, videoSlot) => [
        `video_${String(videoSlot + 1).padStart(2, '0')}`,
        summarize(evaluated.filter((item) => item.kind === 'attack' && item.videoSlot === videoSlot), threshold),
      ])),
    },
    interpretation: 'Bona-fide candidate spoof flags are false rejects. Attack final acceptances are false accepts. Frames within a video are correlated.',
    scope: 'Static RGB research candidate. London controls are studio photographs rather than fresh phone-camera bona-fide sessions. Attack coverage is six screen replay videos only; no print, 3D mask, injection, depth/IR or active challenge.',
    productionDecision: 'Research-only until fresh phone bona-fide and broader instrument-isolated attack tests meet pre-registered thresholds.',
    retention: { sourceImagesCopied: false, framesWritten: false, individualPredictionsRetained: false, modelRuntimeVideosAndTemporaryScoresRequireCleanup: true, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2); status.textContent = '完成；请固化聚合结果并立即清理模型、运行时、视频和临时分数'
}
void run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error); resultElement.dataset.error = message; status.textContent = `失败：${message}`
})
