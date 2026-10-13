import { detectFaces } from '../src/lib/faceDetector'
import { estimateWideHeadPose } from '../src/lib/wideHeadPose'
import { ACTIVE_CHALLENGE_CONFIG, runActiveChallenge, type ActiveChallengeFrame, type ActiveChallengeState } from '../src/lib/activeChallenge'

type TargetPaths = Record<'center' | 'positive_yaw' | 'negative_yaw', string>
type Manifest = {
  policyVersion: string
  bonaFideSource: string
  bonaFideLicense: string
  bonaFideRecords: Array<{ subjectId: string; paths: TargetPaths }>
  replaySource: string
  replaySourceCommit: string
  replayLicense: string
  replayAttackType: string
  replayRecords: Array<{ id: string; captureGroup: string; path: string; bytes: number; sha256: string }>
  samplingIntervalMs: number
}

const statusElement = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const manifestPath = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/active-challenge/manifest.json'
const orders: ActiveChallengeState['order'][] = ['positive_first', 'negative_first']

function asFsUrl(path: string) { return `/@fs/${path.replaceAll('\\', '/')}` }

async function urlToFile(path: string, name: string) {
  const response = await fetch(asFsUrl(path))
  if (!response.ok) throw new Error(`Image load failed (${response.status}): ${name}`)
  return new File([await response.blob()], name, { type: 'image/jpeg' })
}

async function analyzeFile(file: File, timestampMs: number): Promise<ActiveChallengeFrame> {
  const [pose, summary] = await Promise.all([estimateWideHeadPose(file), detectFaces(file)])
  const eligible = summary.detections.filter((detection) => detection.score >= 0.6).sort((left, right) => right.score - left.score)
  const best = eligible[0]
  return {
    timestampMs, yaw: pose.yaw, roll: pose.roll, faceCount: eligible.length,
    faceScore: best?.score ?? 0, faceAreaRatio: best?.areaRatio ?? 0, faceCenterDistance: best?.centerDistance ?? 1,
  }
}

function repeatFrame(frame: ActiveChallengeFrame, timestampMs: number): ActiveChallengeFrame {
  return { ...frame, timestampMs }
}

function sequenceForOrder(views: Record<keyof TargetPaths, ActiveChallengeFrame>, order: ActiveChallengeState['order']) {
  const sideA = order === 'positive_first' ? views.positive_yaw : views.negative_yaw
  const sideB = order === 'positive_first' ? views.negative_yaw : views.positive_yaw
  const viewSequence = [views.center, sideA, views.center, sideB, views.center]
  return viewSequence.flatMap((frame, index) => [repeatFrame(frame, index * 600), repeatFrame(frame, index * 600 + 300)])
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))]
}

function summarizeYaw(frames: ActiveChallengeFrame[]) {
  const yaw = frames.map((frame) => frame.yaw)
  return { minimum: percentile(yaw, 0), p05: percentile(yaw, 0.05), median: percentile(yaw, 0.5), p95: percentile(yaw, 0.95), maximum: percentile(yaw, 1) }
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'; video.muted = true; video.playsInline = true
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error(`Unable to decode video: ${video.error?.message ?? url}`))
    video.src = url; video.load()
  })
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`Seek timed out at ${time.toFixed(2)}s`)), 15_000)
    video.onseeked = () => { window.clearTimeout(timeout); resolve() }
    video.onerror = () => { window.clearTimeout(timeout); reject(new Error(video.error?.message ?? 'Video seek failed')) }
    video.currentTime = time
  })
}

function frameToFile(video: HTMLVideoElement, name: string): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth; canvas.height = video.videoHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to create video frame context')
  context.drawImage(video, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(new File([blob], name, { type: 'image/jpeg' })) : reject(new Error('Frame encoding failed')),
    'image/jpeg', 0.9,
  ))
}

function replayTrials(frames: ActiveChallengeFrame[]) {
  const trials: Array<{ order: ActiveChallengeState['order']; passed: boolean; failureReason: string | null }> = []
  for (let startIndex = 0; startIndex < frames.length; startIndex += 3) {
    const windowStart = frames[startIndex].timestampMs
    const trialFrames = frames.slice(startIndex).filter((frame) => frame.timestampMs - windowStart <= ACTIVE_CHALLENGE_CONFIG.overallTimeoutMs)
    for (const order of orders) {
      const state = runActiveChallenge(order, trialFrames)
      trials.push({ order, passed: state.status === 'passed', failureReason: state.failureReason })
    }
  }
  return trials
}

function countBy(values: Array<string | null>) {
  const result: Record<string, number> = {}
  for (const value of values) result[value ?? 'incomplete_before_video_end'] = (result[value ?? 'incomplete_before_video_end'] ?? 0) + 1
  return result
}

async function main() {
  const manifest = await fetch(manifestPath).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
    return response.json() as Promise<Manifest>
  })
  if (manifest.policyVersion !== 'HEADUP-ACTIVE-CHALLENGE-INPUT-1.0') throw new Error('Unexpected input manifest version')

  let bonaFidePassed = 0
  const bonaFideFailures: Record<string, number> = {}
  for (const [index, record] of manifest.bonaFideRecords.entries()) {
    statusElement.textContent = `真人三视角 ${index + 1} / ${manifest.bonaFideRecords.length}`
    const entries = await Promise.all((Object.entries(record.paths) as Array<[keyof TargetPaths, string]>).map(async ([target, path]) => {
      const file = await urlToFile(path, `${record.subjectId}-${target}.jpg`)
      return [target, await analyzeFile(file, 0)] as const
    }))
    const views = Object.fromEntries(entries) as Record<keyof TargetPaths, ActiveChallengeFrame>
    for (const order of orders) {
      const trial = runActiveChallenge(order, sequenceForOrder(views, order))
      if (trial.status === 'passed') bonaFidePassed += 1
      else {
        const reason = trial.status === 'running'
          ? `unmet_${trial.targets[trial.stepIndex] ?? 'unknown_target'}`
          : trial.failureReason ?? 'failed_without_reason'
        bonaFideFailures[reason] = (bonaFideFailures[reason] ?? 0) + 1
      }
    }
  }

  const perVideo: Record<string, unknown> = {}
  let totalReplayFrames = 0
  let totalTrials = 0
  let passedTrials = 0
  for (const [videoIndex, record] of manifest.replayRecords.entries()) {
    statusElement.textContent = `真实屏幕回放 ${videoIndex + 1} / ${manifest.replayRecords.length}：加载视频`
    const video = await loadVideo(asFsUrl(record.path))
    const frames: ActiveChallengeFrame[] = []
    const finalTime = Math.max(0, video.duration - 0.15)
    for (let time = 0.15, frameIndex = 0; time <= finalTime; time += manifest.samplingIntervalMs / 1000, frameIndex += 1) {
      statusElement.textContent = `真实屏幕回放 ${videoIndex + 1} / ${manifest.replayRecords.length}：帧 ${frameIndex + 1}`
      await seek(video, time)
      const file = await frameToFile(video, `${record.id}-${frameIndex}.jpg`)
      frames.push(await analyzeFile(file, Math.round(time * 1000)))
    }
    const trials = replayTrials(frames)
    const passed = trials.filter((trial) => trial.passed).length
    totalReplayFrames += frames.length; totalTrials += trials.length; passedTrials += passed
    perVideo[record.id] = {
      captureGroup: record.captureGroup,
      width: video.videoWidth, height: video.videoHeight, durationSeconds: Number(video.duration.toFixed(2)),
      sampledFrames: frames.length, yawDegrees: summarizeYaw(frames), trials: trials.length, passedTrials: passed,
      attackFalseAcceptRate: Number((passed / trials.length).toFixed(4)), anyTrialPassed: passed > 0,
      failureReasons: countBy(trials.filter((trial) => !trial.passed).map((trial) => trial.failureReason)),
    }
    video.removeAttribute('src'); video.load()
  }

  const bonaFideTrials = manifest.bonaFideRecords.length * orders.length
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-ACTIVE-CHALLENGE-AUDIT-1.0',
    method: {
      challenge: 'center -> randomized first side -> center -> opposite side -> center',
      orders, config: ACTIVE_CHALLENGE_CONFIG,
      stability: 'two matching observations spanning at least 250 ms per step',
      replaySamplingIntervalMs: manifest.samplingIntervalMs,
      replayTrialStartIntervalMs: manifest.samplingIntervalMs * 3,
    },
    bonaFidePoseSequenceProxy: {
      source: manifest.bonaFideSource, license: manifest.bonaFideLicense,
      subjects: manifest.bonaFideRecords.length, trials: bonaFideTrials, passedTrials: bonaFidePassed,
      passRate: Number((bonaFidePassed / bonaFideTrials).toFixed(4)), failureReasons: bonaFideFailures,
      limitation: 'Controlled still views are repeated only to test direction, framing, thresholds, and sequence logic; this is not a live motion or user-completion estimate.',
    },
    physicalReplayAttack: {
      source: manifest.replaySource, sourceCommit: manifest.replaySourceCommit, license: manifest.replayLicense,
      attackType: manifest.replayAttackType, videos: manifest.replayRecords.length, sampledFrames: totalReplayFrames,
      trials: totalTrials, passedTrials, attackFalseAcceptRate: Number((passedTrials / totalTrials).toFixed(4)), perVideo,
      interpretation: 'Every passing trial is an attack false accept. Trials start every 900 ms and test both random orders against the remaining consecutive sampled frames.',
      limitation: 'These are ordinary screen-replay clips, not recordings prepared to follow the displayed random challenge. Results do not cover challenge-aware replay, injection, 3D masks, depth/IR, or certified PAD testing.',
    },
    retention: { sourceLondonImagesChanged: false, replayVideosDeletedAfterRun: false, extractedFramesWritten: false, perFramePredictionsRetained: false, aggregateOnly: true },
    decision: 'research_only_not_production_pad',
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  statusElement.textContent = '完成；保存聚合结果后立即删除暂存回放视频'
}

void main().catch((error) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  resultElement.dataset.error = message
  statusElement.textContent = `失败：${message}`
})
