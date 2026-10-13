import { describe, expect, it } from 'vitest'
import { buildLocalOcclusionStudyAggregate, type LocalOcclusionCaptureResult } from './localOcclusionStudy'

function capture(condition: LocalOcclusionCaptureResult['condition'], repeat: number, combinedPass: boolean, poseFlags: string[] = []): LocalOcclusionCaptureResult {
  return {
    condition,
    repeat,
    width: 3024,
    height: 4032,
    qualityPass: true,
    posePass: combinedPass,
    combinedPass,
    qualityFlags: [],
    poseFlags,
  }
}

describe('local paired occlusion study aggregate', () => {
  it('summarizes complete baseline, mask and sunglasses repeats without image identifiers', () => {
    const captures = [1, 2, 3].flatMap((repeat) => [
      capture('open', repeat, true),
      capture('mask', repeat, false, ['口鼻区域存在大面积明显遮挡，请摘下口罩或遮挡物']),
      capture('sunglasses', repeat, repeat === 3, repeat === 3 ? [] : ['眼部存在大面积明显遮挡，请摘下墨镜或遮挡物']),
    ])
    const result = buildLocalOcclusionStudyAggregate(captures, {
      sessionId: 'anonymous-session',
      deviceClass: 'smartphone_rear',
      lighting: 'indirect_daylight',
    }, '2026-08-15T00:00:00.000Z')

    expect(result.protocol.protocolComplete).toBe(true)
    expect(result.pairedTransitions.mask.blockedByCombinedGateAfterBaselineCombinedPass).toBe(3)
    expect(result.pairedTransitions.sunglasses.blockedByCombinedGateAfterBaselineCombinedPass).toBe(2)
    expect(result.byCondition.sunglasses.explicitEyeOcclusionFlags).toBe(2)
    expect(result.retention).toMatchObject({ imagesIncluded: false, fileNamesIncluded: false, landmarksIncluded: false })
    expect(JSON.stringify(result)).not.toContain('.jpg')
  })

  it('marks a duplicate or incomplete slot set as unusable', () => {
    const result = buildLocalOcclusionStudyAggregate([
      capture('open', 1, true),
      capture('open', 1, true),
    ], { sessionId: 'anonymous-session', deviceClass: 'desktop_webcam', lighting: 'indoor_even' })
    expect(result.protocol.protocolComplete).toBe(false)
    expect(result.interpretation).toContain('Incomplete')
  })
})
