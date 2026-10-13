import { describe, expect, it } from 'vitest'
import { advanceActiveChallenge, createActiveChallenge, runActiveChallenge, type ActiveChallengeFrame, type ChallengeTarget } from './activeChallenge'

function frame(timestampMs: number, target: ChallengeTarget): ActiveChallengeFrame {
  const yaw = target === 'center' ? 0 : target === 'positive_yaw' ? 60 : -60
  return { timestampMs, yaw, roll: 0, faceCount: 1, faceScore: 0.98, faceAreaRatio: 0.2, faceCenterDistance: 0.05 }
}

function validFrames(order: 'positive_first' | 'negative_first') {
  const sides: ChallengeTarget[] = order === 'positive_first' ? ['positive_yaw', 'negative_yaw'] : ['negative_yaw', 'positive_yaw']
  const targets: ChallengeTarget[] = ['center', sides[0], 'center', sides[1], 'center']
  let timestamp = 0
  return targets.flatMap((target) => {
    const values = [frame(timestamp, target), frame(timestamp + 300, target)]
    timestamp += 700
    return values
  })
}

describe('active randomized head-turn challenge', () => {
  it('passes both randomized orders only after stable ordered targets', () => {
    expect(runActiveChallenge('positive_first', validFrames('positive_first')).status).toBe('passed')
    expect(runActiveChallenge('negative_first', validFrames('negative_first')).status).toBe('passed')
  })

  it('does not accept a static centered face as active response', () => {
    const frames = Array.from({ length: 20 }, (_value, index) => frame(index * 300, 'center'))
    const result = runActiveChallenge('positive_first', frames)
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('step_timeout')
  })

  it('does not advance on the opposite direction and times out', () => {
    const initial = [frame(0, 'center'), frame(300, 'center')]
    const wrong = Array.from({ length: 16 }, (_value, index) => frame(700 + index * 300, 'negative_yaw'))
    const result = runActiveChallenge('positive_first', [...initial, ...wrong])
    expect(result.status).toBe('failed')
    expect(result.stepIndex).toBe(1)
  })

  it('fails closed on repeated timestamps, long gaps and multiple faces', () => {
    const repeated = runActiveChallenge('positive_first', [frame(0, 'center'), frame(0, 'center')])
    expect(repeated.failureReason).toBe('non_monotonic_frame_time')
    const gap = runActiveChallenge('positive_first', [frame(0, 'center'), frame(2000, 'center')])
    expect(gap.failureReason).toBe('frame_gap_too_large')
    const state = advanceActiveChallenge(createActiveChallenge('positive_first'), { ...frame(0, 'center'), faceCount: 2 })
    expect(state.stepIndex).toBe(0)
    expect(state.stableCount).toBe(0)
  })

  it('fails closed on non-finite or out-of-domain detector evidence', () => {
    const invalidFrames: ActiveChallengeFrame[] = [
      { ...frame(0, 'center'), faceScore: Number.NaN },
      { ...frame(0, 'center'), faceAreaRatio: Number.POSITIVE_INFINITY },
      { ...frame(0, 'center'), faceCenterDistance: Number.NaN },
      { ...frame(0, 'center'), faceScore: 1.01 },
      { ...frame(0, 'center'), faceAreaRatio: -0.01 },
      { ...frame(0, 'center'), faceCenterDistance: -0.01 },
      { ...frame(0, 'center'), faceCount: 1.5 },
      { ...frame(0, 'center'), timestampMs: -1 },
      { ...frame(0, 'center'), yaw: 181 },
    ]
    for (const invalidFrame of invalidFrames) {
      const state = advanceActiveChallenge(createActiveChallenge('positive_first'), invalidFrame)
      expect(state.status).toBe('failed')
      expect(state.failureReason).toBe('invalid_frame')
    }
  })
})
