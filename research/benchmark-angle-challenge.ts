import { detectFaces } from '../src/lib/faceDetector'
import { estimateWideHeadPose } from '../src/lib/wideHeadPose'
import { runActiveChallenge, type ActiveChallengeFrame, type ActiveChallengeState } from '../src/lib/activeChallenge'
import { ANGLE_CHALLENGE_CONFIG, allAngleChallengeSpecs, runAngleChallenge, type AngleChallengeDepth, type AngleChallengeSpec } from '../src/lib/angleChallenge'

type Manifest = {
  policyVersion: string
  source: { id: string; name: string; doi: string; license: string }
  records: Array<{ subjectId: string; angles: Record<string, string> }>
  verifiedArchives: Array<{ name: string; bytes: number; md5: string; sha256: string }>
  expectedImages: number
}

const statusElement = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const manifestUrl = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/angle-challenge/manifest.json'
const currentOrders: ActiveChallengeState['order'][] = ['positive_first', 'negative_first']
const depthAngle: Record<AngleChallengeDepth, number> = { shallow: 30, medium: 45, deep: 60 }

function asFsUrl(path: string) { return `/@fs/${path.replaceAll('\\', '/')}` }

async function analyze(path: string, name: string): Promise<ActiveChallengeFrame> {
  const response = await fetch(asFsUrl(path))
  if (!response.ok) throw new Error(`Image load failed (${response.status}): ${name}`)
  const file = new File([await response.blob()], name, { type: 'image/jpeg' })
  const [pose, summary] = await Promise.all([estimateWideHeadPose(file), detectFaces(file)])
  const eligible = summary.detections.filter((detection) => detection.score >= 0.6).sort((left, right) => right.score - left.score)
  const best = eligible[0]
  return {
    timestampMs: 0, yaw: pose.yaw, roll: pose.roll, faceCount: eligible.length,
    faceScore: best?.score ?? 0, faceAreaRatio: best?.areaRatio ?? 0, faceCenterDistance: best?.centerDistance ?? 1,
  }
}

function labelsBetween(from: number, to: number) {
  if (from === to) return []
  const step = Math.sign(to - from) * 15
  const labels: number[] = []
  for (let value = from + step; step > 0 ? value <= to : value >= to; value += step) labels.push(value)
  return labels
}

function framesForTargets(views: Record<string, ActiveChallengeFrame>, targets: number[], smooth: boolean) {
  const labels: number[] = [targets[0], targets[0]]
  let current = targets[0]
  for (const target of targets.slice(1)) {
    if (smooth) labels.push(...labelsBetween(current, target))
    else labels.push(target)
    labels.push(target)
    current = target
  }
  return labels.map((label, index) => ({ ...views[String(label)], timestampMs: index * 300 }))
}

function currentTargets(order: ActiveChallengeState['order']) {
  return order === 'positive_first' ? [0, 60, 0, -60, 0] : [0, -60, 0, 60, 0]
}

function angleTargets(spec: AngleChallengeSpec) {
  const sign = spec.firstDirection === 'positive' ? 1 : -1
  return [0, sign * depthAngle[spec.firstDepth], 0, -sign * depthAngle[spec.secondDepth], 0]
}

function increment(map: Record<string, number>, key: string | null) {
  const normalized = key ?? 'incomplete_before_sequence_end'
  map[normalized] = (map[normalized] ?? 0) + 1
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number) => sorted[Math.round((sorted.length - 1) * fraction)]
  return { minimum: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), maximum: at(1) }
}

async function main() {
  const manifest = await fetch(manifestUrl).then(async (response) => {
    if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
    return response.json() as Promise<Manifest>
  })
  if (manifest.policyVersion !== 'HEADUP-ANGLE-CHALLENGE-INPUT-1.0') throw new Error('Unexpected input manifest')
  const specs = allAngleChallengeSpecs()
  const current = { smoothTrials: 0, smoothPassed: 0, abruptTrials: 0, abruptPassed: 0, smoothFailures: {} as Record<string, number>, abruptFailures: {} as Record<string, number> }
  const candidate = { smoothTrials: 0, smoothPassed: 0, abruptTrials: 0, abruptPassed: 0, smoothFailures: {} as Record<string, number>, abruptFailures: {} as Record<string, number> }
  const predictedYawByLabel: Record<string, number[]> = Object.fromEntries(Array.from({ length: 13 }, (_value, index) => [String(-90 + index * 15), []]))
  const perSpec: Record<string, { trials: number; smoothPassed: number; abruptPassed: number }> = {}
  let images = 0
  for (const [subjectIndex, record] of manifest.records.entries()) {
    const views: Record<string, ActiveChallengeFrame> = {}
    for (const [viewIndex, [label, path]] of Object.entries(record.angles).entries()) {
      statusElement.textContent = `真实多角度人像 ${subjectIndex + 1} / ${manifest.records.length}，视角 ${viewIndex + 1} / 13`
      const frame = await analyze(path, `${record.subjectId}-${label}.jpg`)
      views[label] = frame
      predictedYawByLabel[label].push(frame.yaw)
      images += 1
    }
    for (const order of currentOrders) {
      const targets = currentTargets(order)
      for (const smooth of [true, false]) {
        const state = runActiveChallenge(order, framesForTargets(views, targets, smooth))
        const prefix = smooth ? 'smooth' : 'abrupt'
        current[`${prefix}Trials`] += 1
        if (state.status === 'passed') current[`${prefix}Passed`] += 1
        else increment(current[`${prefix}Failures`], state.failureReason)
      }
    }
    for (const spec of specs) {
      const key = `${spec.firstDirection}:${spec.firstDepth}:${spec.secondDepth}`
      perSpec[key] ??= { trials: 0, smoothPassed: 0, abruptPassed: 0 }
      perSpec[key].trials += 1
      const targets = angleTargets(spec)
      for (const smooth of [true, false]) {
        const state = runAngleChallenge(spec, framesForTargets(views, targets, smooth))
        const prefix = smooth ? 'smooth' : 'abrupt'
        candidate[`${prefix}Trials`] += 1
        if (state.status === 'passed') {
          candidate[`${prefix}Passed`] += 1
          perSpec[key][`${prefix}Passed`] += 1
        } else increment(candidate[`${prefix}Failures`], state.failureReason)
      }
    }
  }
  if (images !== manifest.expectedImages) throw new Error(`Expected ${manifest.expectedImages} images, evaluated ${images}`)
  const rate = (passed: number, trials: number) => Number((passed / trials).toFixed(4))
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-ANGLE-CHALLENGE-AUDIT-1.0',
    source: manifest.source,
    selection: { subjects: manifest.records.length, realPortraits: images, horizontalLabels: Object.keys(predictedYawByLabel).map(Number), archivesVerified: manifest.verifiedArchives.length, archiveChecksumsVerified: true },
    modelObservedYawByLabel: Object.fromEntries(Object.entries(predictedYawByLabel).map(([label, values]) => [label, distribution(values)])),
    currentTwoOrderChallengeAdaptiveInjection: {
      ...current,
      smoothAttackFalseAcceptRate: rate(current.smoothPassed, current.smoothTrials),
      abruptAttackFalseAcceptRate: rate(current.abruptPassed, current.abruptTrials),
      interpretation: 'Every trial is an ordered injection made from separate real portrait files. A pass is an attack false accept, not bona-fide evidence.',
    },
    higherEntropyAngleCandidate: {
      specs: specs.length, targetLabels: depthAngle, config: ANGLE_CHALLENGE_CONFIG, ...candidate,
      smoothAttackFalseAcceptRate: rate(candidate.smoothPassed, candidate.smoothTrials),
      abruptAttackFalseAcceptRate: rate(candidate.abruptPassed, candidate.abruptTrials), perSpec,
      interpretation: 'The candidate adds three non-overlapping yaw depths and a maximum frame-to-frame yaw jump. Ordered smooth portrait injection remains an attack even when it resembles a plausible motion path.',
    },
    limitations: [
      'Pointing04 contains instructed still poses, not continuous live smartphone capture.',
      'The source is 15 subjects at 384x288 and contains pose-label/model noise; it cannot estimate real-user completion rate.',
      'Frame injection can always present intermediate images, so continuity and extra challenge entropy are defense-in-depth rather than certified PAD.',
    ],
    retention: { imagesDeletedAfterRun: false, archivesDeletedDuringPreparation: true, identifiersRetained: false, perImagePredictionsRetained: false, aggregateOnly: true },
    decision: 'candidate_not_integrated_without_fresh_live_video_and_injection_resistance',
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  statusElement.textContent = '完成；保存聚合结果后立即清理全部临时真人图像'
}

void main().catch((error) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  resultElement.dataset.error = message
  statusElement.textContent = `失败：${message}`
})
