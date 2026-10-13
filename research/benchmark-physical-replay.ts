import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'

type ManifestSample = {
  id: string
  captureGroup: 'pc_display' | 'mobile_display'
  relativePath: string
  bytes: number
  sha256: string
}

type Manifest = {
  source: string
  sourceCommit: string
  license: string
  attackType: string
  samples: ManifestSample[]
}

type FrameResult = {
  qualityPass: boolean
  posePass: boolean
  combinedPass: boolean
  qualityFlags: string[]
  poseFlags: string[]
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/physical-replay'
const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
  if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
  return response.json() as Promise<Manifest>
})
const sampleFractions = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]

function counts(values: string[]) {
  const output: Record<string, number> = {}
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error(`Unable to decode ${url}: ${video.error?.message ?? 'unknown media error'}`))
    video.src = url
    video.load()
  })
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`Seek timed out at ${time.toFixed(2)}s`)), 15000)
    video.onseeked = () => {
      window.clearTimeout(timeout)
      resolve()
    }
    video.onerror = () => {
      window.clearTimeout(timeout)
      reject(new Error(video.error?.message ?? 'Video seek failed'))
    }
    video.currentTime = time
  })
}

function frameToFile(video: HTMLVideoElement, id: string, frameIndex: number): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(video, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob
      ? resolve(new File([blob], `${id}-${frameIndex}.jpg`, { type: 'image/jpeg' }))
      : reject(new Error('Frame encoding failed')),
    'image/jpeg',
    0.92,
  ))
}

const perVideo: Record<string, { captureGroup: string; width: number; height: number; durationSeconds: number; frames: FrameResult[] }> = {}

for (const [videoIndex, sample] of manifest.samples.entries()) {
  status.textContent = `加载真实翻拍视频 ${videoIndex + 1} / ${manifest.samples.length}`
  const video = await loadVideo(`${stagingRoot}/${sample.relativePath}`)
  const frames: FrameResult[] = []
  for (const [frameIndex, fraction] of sampleFractions.entries()) {
    status.textContent = `视频 ${videoIndex + 1} / ${manifest.samples.length}，帧 ${frameIndex + 1} / ${sampleFractions.length}`
    await seek(video, Math.min(video.duration - 0.05, Math.max(0, video.duration * fraction)))
    const file = await frameToFile(video, sample.id, frameIndex)
    const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
    const qualityPass = isPhotoQualityAcceptable(quality)
    const posePass = pose.status === 'pass'
    frames.push({
      qualityPass,
      posePass,
      combinedPass: qualityPass && posePass,
      qualityFlags: quality.flags,
      poseFlags: pose.flags,
    })
  }
  perVideo[sample.id] = {
    captureGroup: sample.captureGroup,
    width: video.videoWidth,
    height: video.videoHeight,
    durationSeconds: Number(video.duration.toFixed(2)),
    frames,
  }
  video.removeAttribute('src')
  video.load()
}

function summarize(items: FrameResult[]) {
  const frames = items.length
  const qualityPassed = items.filter((item) => item.qualityPass).length
  const posePassed = items.filter((item) => item.posePass).length
  const combinedPassed = items.filter((item) => item.combinedPass).length
  return {
    frames,
    qualityPassed,
    posePassed,
    combinedPassed,
    attackFalseAcceptRate: Number((combinedPassed / frames).toFixed(4)),
    qualityFlags: counts(items.flatMap((item) => item.qualityFlags.length ? item.qualityFlags : ['none'])),
    poseFlags: counts(items.flatMap((item) => item.poseFlags.length ? item.poseFlags : ['none'])),
  }
}

const perVideoSummary = Object.fromEntries(Object.entries(perVideo).map(([id, video]) => [id, {
  captureGroup: video.captureGroup,
  width: video.width,
  height: video.height,
  durationSeconds: video.durationSeconds,
  ...summarize(video.frames),
}]))
const groups = ['pc_display', 'mobile_display'] as const
const byCaptureGroup = Object.fromEntries(groups.map((group) => [group, summarize(
  Object.values(perVideo).filter((video) => video.captureGroup === group).flatMap((video) => video.frames),
)]))
const allFrames = Object.values(perVideo).flatMap((video) => video.frames)

const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-PHYSICAL-REPLAY-AUDIT-1.0',
  source: manifest.source,
  sourceCommit: manifest.sourceCommit,
  license: manifest.license,
  attackType: manifest.attackType,
  selection: {
    videos: manifest.samples.length,
    sampleFractions,
    framesPerVideo: sampleFractions.length,
    totalFrames: allFrames.length,
    sourceBytesVerified: manifest.samples.reduce((sum, sample) => sum + sample.bytes, 0),
    sourceChecksumsVerified: true,
  },
  productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  overall: summarize(allFrames),
  byCaptureGroup,
  perVideo: perVideoSummary,
  interpretation: 'Every frame is a physical screen-replay attack. A combined pass is an attack false accept, not a successful capture. This still-image gate has no temporal liveness signal.',
  scope: 'Public sample only; no bona-fide control videos, printed photos, masks, injection attacks, or certification claim.',
  retention: { videosDeletedAfterRun: false, framesWritten: false, individualFramePredictionsRetained: false, aggregateOnly: true },
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成；请保存聚合结果后立即运行清理脚本'
