import { activeChallengeFrameIsStructurallyValid, type ActiveChallengeFrame } from './activeChallenge'

export type AngleChallengeDepth = 'shallow' | 'medium' | 'deep'
export type AngleChallengeDirection = 'positive' | 'negative'

export type AngleChallengeSpec = {
  firstDirection: AngleChallengeDirection
  firstDepth: AngleChallengeDepth
  secondDepth: AngleChallengeDepth
}

export type AngleChallengeTarget =
  | { kind: 'center' }
  | { kind: 'yaw'; direction: AngleChallengeDirection; depth: AngleChallengeDepth }

export type AngleChallengeConfig = {
  stableFrames: number
  stableDurationMs: number
  maximumFrameGapMs: number
  maximumYawDeltaPerFrame: number
  stepTimeoutMs: number
  overallTimeoutMs: number
  centerMaximumAbsoluteYaw: number
  maximumAbsoluteRoll: number
  centerMinimumFaceScore: number
  sideMinimumFaceScore: number
  centerMinimumAreaRatio: number
  sideMinimumAreaRatio: number
  centerMaximumDistance: number
  sideMaximumDistance: number
  yawRanges: Record<AngleChallengeDepth, readonly [minimum: number, maximum: number]>
}

export const ANGLE_CHALLENGE_CONFIG: AngleChallengeConfig = {
  stableFrames: 2,
  stableDurationMs: 250,
  maximumFrameGapMs: 1500,
  maximumYawDeltaPerFrame: 35,
  stepTimeoutMs: 6000,
  overallTimeoutMs: 25000,
  centerMaximumAbsoluteYaw: 12,
  maximumAbsoluteRoll: 18,
  centerMinimumFaceScore: 0.9,
  sideMinimumFaceScore: 0.85,
  centerMinimumAreaRatio: 0.09,
  sideMinimumAreaRatio: 0.07,
  centerMaximumDistance: 0.18,
  sideMaximumDistance: 0.25,
  yawRanges: { shallow: [18, 32], medium: [33, 47], deep: [48, 70] },
}

export type AngleChallengeState = {
  spec: AngleChallengeSpec
  targets: AngleChallengeTarget[]
  status: 'running' | 'passed' | 'failed'
  stepIndex: number
  startedAtMs: number | null
  stepStartedAtMs: number | null
  lastFrameAtMs: number | null
  lastYaw: number | null
  stableCount: number
  stableStartedAtMs: number | null
  failureReason: string | null
}

const DEPTHS: AngleChallengeDepth[] = ['shallow', 'medium', 'deep']

export function allAngleChallengeSpecs(): AngleChallengeSpec[] {
  return (['positive', 'negative'] as const).flatMap((firstDirection) =>
    DEPTHS.flatMap((firstDepth) => DEPTHS.map((secondDepth) => ({ firstDirection, firstDepth, secondDepth }))),
  )
}

export function angleChallengeTargets(spec: AngleChallengeSpec): AngleChallengeTarget[] {
  const secondDirection: AngleChallengeDirection = spec.firstDirection === 'positive' ? 'negative' : 'positive'
  return [
    { kind: 'center' },
    { kind: 'yaw', direction: spec.firstDirection, depth: spec.firstDepth },
    { kind: 'center' },
    { kind: 'yaw', direction: secondDirection, depth: spec.secondDepth },
    { kind: 'center' },
  ]
}

export function createAngleChallenge(spec: AngleChallengeSpec): AngleChallengeState {
  return {
    spec,
    targets: angleChallengeTargets(spec),
    status: 'running',
    stepIndex: 0,
    startedAtMs: null,
    stepStartedAtMs: null,
    lastFrameAtMs: null,
    lastYaw: null,
    stableCount: 0,
    stableStartedAtMs: null,
    failureReason: null,
  }
}

function failed(state: AngleChallengeState, reason: string): AngleChallengeState {
  return { ...state, status: 'failed', failureReason: reason }
}

function targetMatches(frame: ActiveChallengeFrame, target: AngleChallengeTarget, config: AngleChallengeConfig) {
  if (frame.faceCount !== 1 || Math.abs(frame.roll) > config.maximumAbsoluteRoll) return false
  const center = target.kind === 'center'
  if (frame.faceScore < (center ? config.centerMinimumFaceScore : config.sideMinimumFaceScore)) return false
  if (frame.faceAreaRatio < (center ? config.centerMinimumAreaRatio : config.sideMinimumAreaRatio)) return false
  if (frame.faceCenterDistance > (center ? config.centerMaximumDistance : config.sideMaximumDistance)) return false
  if (center) return Math.abs(frame.yaw) <= config.centerMaximumAbsoluteYaw
  const magnitude = target.direction === 'positive' ? frame.yaw : -frame.yaw
  const [minimum, maximum] = config.yawRanges[target.depth]
  return magnitude >= minimum && magnitude <= maximum
}

export function advanceAngleChallenge(
  state: AngleChallengeState,
  frame: ActiveChallengeFrame,
  config: AngleChallengeConfig = ANGLE_CHALLENGE_CONFIG,
): AngleChallengeState {
  if (state.status !== 'running') return state
  if (!activeChallengeFrameIsStructurallyValid(frame)) return failed(state, 'invalid_frame')
  if (state.lastFrameAtMs !== null) {
    if (frame.timestampMs <= state.lastFrameAtMs) return failed(state, 'non_monotonic_frame_time')
    if (frame.timestampMs - state.lastFrameAtMs > config.maximumFrameGapMs) return failed(state, 'frame_gap_too_large')
  }
  if (state.lastYaw !== null && Math.abs(frame.yaw - state.lastYaw) > config.maximumYawDeltaPerFrame) {
    return failed(state, 'yaw_discontinuity')
  }
  const startedAtMs = state.startedAtMs ?? frame.timestampMs
  const stepStartedAtMs = state.stepStartedAtMs ?? frame.timestampMs
  if (frame.timestampMs - startedAtMs > config.overallTimeoutMs) return failed({ ...state, startedAtMs }, 'overall_timeout')
  if (frame.timestampMs - stepStartedAtMs > config.stepTimeoutMs) return failed({ ...state, startedAtMs, stepStartedAtMs }, 'step_timeout')

  const matches = targetMatches(frame, state.targets[state.stepIndex], config)
  const stableCount = matches ? state.stableCount + 1 : 0
  const stableStartedAtMs = matches ? state.stableStartedAtMs ?? frame.timestampMs : null
  const stableDurationMs = stableStartedAtMs === null ? 0 : frame.timestampMs - stableStartedAtMs
  const base = {
    ...state, startedAtMs, stepStartedAtMs, lastFrameAtMs: frame.timestampMs,
    lastYaw: frame.yaw, stableCount, stableStartedAtMs,
  }
  if (!matches || stableCount < config.stableFrames || stableDurationMs < config.stableDurationMs) return base
  const nextStep = state.stepIndex + 1
  if (nextStep >= state.targets.length) {
    return { ...base, status: 'passed', stepIndex: nextStep, stableCount: 0, stableStartedAtMs: null }
  }
  return { ...base, stepIndex: nextStep, stepStartedAtMs: frame.timestampMs, stableCount: 0, stableStartedAtMs: null }
}

export function runAngleChallenge(
  spec: AngleChallengeSpec,
  frames: ActiveChallengeFrame[],
  config: AngleChallengeConfig = ANGLE_CHALLENGE_CONFIG,
) {
  return frames.reduce((state, frame) => advanceAngleChallenge(state, frame, config), createAngleChallenge(spec))
}
