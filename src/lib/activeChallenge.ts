export type ChallengeTarget = 'center' | 'positive_yaw' | 'negative_yaw'

export type ActiveChallengeFrame = {
  timestampMs: number
  yaw: number
  roll: number
  faceCount: number
  faceScore: number
  faceAreaRatio: number
  faceCenterDistance: number
}

export type ActiveChallengeConfig = {
  stableFrames: number
  stableDurationMs: number
  maximumFrameGapMs: number
  stepTimeoutMs: number
  overallTimeoutMs: number
  centerMaximumAbsoluteYaw: number
  sideMinimumAbsoluteYaw: number
  maximumAbsoluteRoll: number
  centerMinimumFaceScore: number
  sideMinimumFaceScore: number
  centerMinimumAreaRatio: number
  sideMinimumAreaRatio: number
  centerMaximumDistance: number
  sideMaximumDistance: number
}

export const ACTIVE_CHALLENGE_CONFIG: ActiveChallengeConfig = {
  stableFrames: 2,
  stableDurationMs: 250,
  maximumFrameGapMs: 1500,
  stepTimeoutMs: 4500,
  overallTimeoutMs: 20000,
  centerMaximumAbsoluteYaw: 12,
  sideMinimumAbsoluteYaw: 35,
  maximumAbsoluteRoll: 18,
  centerMinimumFaceScore: 0.9,
  sideMinimumFaceScore: 0.85,
  centerMinimumAreaRatio: 0.09,
  sideMinimumAreaRatio: 0.07,
  centerMaximumDistance: 0.18,
  sideMaximumDistance: 0.25,
}

export type ActiveChallengeState = {
  order: 'positive_first' | 'negative_first'
  targets: ChallengeTarget[]
  status: 'running' | 'passed' | 'failed'
  stepIndex: number
  startedAtMs: number | null
  stepStartedAtMs: number | null
  lastFrameAtMs: number | null
  stableCount: number
  stableStartedAtMs: number | null
  acceptedAtMs: Array<number | null>
  failureReason: string | null
}

export function challengeTargets(order: ActiveChallengeState['order']): ChallengeTarget[] {
  const sides: ChallengeTarget[] = order === 'positive_first'
    ? ['positive_yaw', 'negative_yaw']
    : ['negative_yaw', 'positive_yaw']
  return ['center', sides[0], 'center', sides[1], 'center']
}

export function createActiveChallenge(order: ActiveChallengeState['order']): ActiveChallengeState {
  const targets = challengeTargets(order)
  return {
    order, targets, status: 'running', stepIndex: 0, startedAtMs: null, stepStartedAtMs: null,
    lastFrameAtMs: null, stableCount: 0, stableStartedAtMs: null,
    acceptedAtMs: targets.map(() => null), failureReason: null,
  }
}

function failed(state: ActiveChallengeState, reason: string): ActiveChallengeState {
  return { ...state, status: 'failed', failureReason: reason }
}

export function activeChallengeFrameIsStructurallyValid(frame: ActiveChallengeFrame) {
  const numericValues = [
    frame.timestampMs, frame.yaw, frame.roll, frame.faceCount,
    frame.faceScore, frame.faceAreaRatio, frame.faceCenterDistance,
  ]
  return numericValues.every(Number.isFinite)
    && frame.timestampMs >= 0
    && Number.isInteger(frame.faceCount)
    && frame.faceCount >= 0
    && frame.faceScore >= 0 && frame.faceScore <= 1
    && frame.faceAreaRatio >= 0 && frame.faceAreaRatio <= 1
    && frame.faceCenterDistance >= 0 && frame.faceCenterDistance <= Math.SQRT1_2
    && Math.abs(frame.yaw) <= 180
    && Math.abs(frame.roll) <= 180
}

function frameMatchesTarget(frame: ActiveChallengeFrame, target: ChallengeTarget, config: ActiveChallengeConfig) {
  if (frame.faceCount !== 1 || Math.abs(frame.roll) > config.maximumAbsoluteRoll) return false
  const center = target === 'center'
  if (frame.faceScore < (center ? config.centerMinimumFaceScore : config.sideMinimumFaceScore)) return false
  if (frame.faceAreaRatio < (center ? config.centerMinimumAreaRatio : config.sideMinimumAreaRatio)) return false
  if (frame.faceCenterDistance > (center ? config.centerMaximumDistance : config.sideMaximumDistance)) return false
  if (target === 'center') return Math.abs(frame.yaw) <= config.centerMaximumAbsoluteYaw
  if (target === 'positive_yaw') return frame.yaw >= config.sideMinimumAbsoluteYaw
  return frame.yaw <= -config.sideMinimumAbsoluteYaw
}

export function advanceActiveChallenge(
  state: ActiveChallengeState,
  frame: ActiveChallengeFrame,
  config: ActiveChallengeConfig = ACTIVE_CHALLENGE_CONFIG,
): ActiveChallengeState {
  if (state.status !== 'running') return state
  if (!activeChallengeFrameIsStructurallyValid(frame)) return failed(state, 'invalid_frame')
  if (state.lastFrameAtMs !== null) {
    if (frame.timestampMs <= state.lastFrameAtMs) return failed(state, 'non_monotonic_frame_time')
    if (frame.timestampMs - state.lastFrameAtMs > config.maximumFrameGapMs) return failed(state, 'frame_gap_too_large')
  }
  const startedAtMs = state.startedAtMs ?? frame.timestampMs
  const stepStartedAtMs = state.stepStartedAtMs ?? frame.timestampMs
  if (frame.timestampMs - startedAtMs > config.overallTimeoutMs) return failed({ ...state, startedAtMs }, 'overall_timeout')
  if (frame.timestampMs - stepStartedAtMs > config.stepTimeoutMs) return failed({ ...state, startedAtMs, stepStartedAtMs }, 'step_timeout')

  const target = state.targets[state.stepIndex]
  const matches = frameMatchesTarget(frame, target, config)
  const stableCount = matches ? state.stableCount + 1 : 0
  const stableStartedAtMs = matches ? (state.stableStartedAtMs ?? frame.timestampMs) : null
  const stableDuration = stableStartedAtMs === null ? 0 : frame.timestampMs - stableStartedAtMs
  const base = { ...state, startedAtMs, stepStartedAtMs, lastFrameAtMs: frame.timestampMs, stableCount, stableStartedAtMs }
  if (!matches || stableCount < config.stableFrames || stableDuration < config.stableDurationMs) return base

  const acceptedAtMs = [...state.acceptedAtMs]
  acceptedAtMs[state.stepIndex] = frame.timestampMs
  const nextStep = state.stepIndex + 1
  if (nextStep >= state.targets.length) {
    return { ...base, status: 'passed', stepIndex: nextStep, acceptedAtMs, stableCount: 0, stableStartedAtMs: null }
  }
  return {
    ...base, stepIndex: nextStep, stepStartedAtMs: frame.timestampMs,
    stableCount: 0, stableStartedAtMs: null, acceptedAtMs,
  }
}

export function runActiveChallenge(
  order: ActiveChallengeState['order'],
  frames: ActiveChallengeFrame[],
  config: ActiveChallengeConfig = ACTIVE_CHALLENGE_CONFIG,
) {
  return frames.reduce((state, frame) => advanceActiveChallenge(state, frame, config), createActiveChallenge(order))
}
