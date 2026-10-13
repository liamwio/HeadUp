import { describe, expect, it } from 'vitest'
import { allAngleChallengeSpecs, runAngleChallenge, type AngleChallengeDepth, type AngleChallengeSpec } from './angleChallenge'
import type { ActiveChallengeFrame } from './activeChallenge'

function frame(timestampMs: number, yaw: number): ActiveChallengeFrame {
  return { timestampMs, yaw, roll: 0, faceCount: 1, faceScore: 0.98, faceAreaRatio: 0.2, faceCenterDistance: 0.05 }
}

const targetYaw: Record<AngleChallengeDepth, number> = { shallow: 25, medium: 40, deep: 55 }

function smoothSequence(spec: AngleChallengeSpec) {
  const firstSign = spec.firstDirection === 'positive' ? 1 : -1
  const targets = [0, firstSign * targetYaw[spec.firstDepth], 0, -firstSign * targetYaw[spec.secondDepth], 0]
  const yaws: number[] = [0, 0]
  let current = 0
  for (const target of targets.slice(1)) {
    while (Math.abs(target - current) > 20) {
      current += Math.sign(target - current) * 20
      yaws.push(current)
    }
    current = target
    yaws.push(current, current)
  }
  return yaws.map((yaw, index) => frame(index * 300, yaw))
}

describe('higher-entropy angle challenge candidate', () => {
  it('enumerates eighteen direction and depth combinations', () => {
    expect(allAngleChallengeSpecs()).toHaveLength(18)
    expect(new Set(allAngleChallengeSpecs().map((spec) => JSON.stringify(spec))).size).toBe(18)
  })

  it('accepts smooth valid motion for every challenge combination', () => {
    for (const spec of allAngleChallengeSpecs()) {
      expect(runAngleChallenge(spec, smoothSequence(spec)).status).toBe('passed')
    }
  })

  it('fails closed on an abrupt injected pose jump', () => {
    const spec: AngleChallengeSpec = { firstDirection: 'positive', firstDepth: 'deep', secondDepth: 'deep' }
    const result = runAngleChallenge(spec, [frame(0, 0), frame(300, 0), frame(600, 55)])
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('yaw_discontinuity')
  })

  it('does not let one depth satisfy a different non-overlapping depth target', () => {
    const spec: AngleChallengeSpec = { firstDirection: 'positive', firstDepth: 'shallow', secondDepth: 'deep' }
    const frames = Array.from({ length: 25 }, (_value, index) => frame(index * 300, index < 2 ? 0 : index === 2 ? 20 : 40))
    const result = runAngleChallenge(spec, frames)
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('step_timeout')
  })
})
