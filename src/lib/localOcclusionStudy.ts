export const LOCAL_OCCLUSION_CONDITIONS = ['open', 'mask', 'sunglasses'] as const
export type LocalOcclusionCondition = typeof LOCAL_OCCLUSION_CONDITIONS[number]

export type LocalOcclusionCaptureResult = {
  condition: LocalOcclusionCondition
  repeat: number
  width: number
  height: number
  qualityPass: boolean
  posePass: boolean
  combinedPass: boolean
  qualityFlags: string[]
  poseFlags: string[]
}

export type LocalOcclusionStudyMetadata = {
  sessionId: string
  deviceClass: 'smartphone_rear' | 'smartphone_front' | 'desktop_webcam' | 'digital_camera'
  lighting: 'indirect_daylight' | 'indoor_even' | 'mixed' | 'other'
}

function counts(values: string[]) {
  const output: Record<string, number> = {}
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

function summarize(items: LocalOcclusionCaptureResult[]) {
  const shortEdges = items.map((item) => Math.min(item.width, item.height)).sort((a, b) => a - b)
  return {
    samples: items.length,
    qualityPassed: items.filter((item) => item.qualityPass).length,
    posePassed: items.filter((item) => item.posePass).length,
    combinedPassed: items.filter((item) => item.combinedPass).length,
    explicitEyeOcclusionFlags: items.filter((item) => item.poseFlags.some((flag) => flag.includes('眼部存在大面积明显遮挡'))).length,
    explicitMouthNoseOcclusionFlags: items.filter((item) => item.poseFlags.some((flag) => flag.includes('口鼻区域存在大面积明显遮挡'))).length,
    shortEdgePixels: shortEdges,
    qualityFlags: counts(items.flatMap((item) => item.qualityFlags.length ? item.qualityFlags : ['none'])),
    poseFlags: counts(items.flatMap((item) => item.poseFlags.length ? item.poseFlags : ['none'])),
  }
}

function pairedTransition(captures: LocalOcclusionCaptureResult[], condition: Exclude<LocalOcclusionCondition, 'open'>) {
  const pairs = [1, 2, 3].flatMap((repeat) => {
    const baseline = captures.find((item) => item.condition === 'open' && item.repeat === repeat)
    const challenged = captures.find((item) => item.condition === condition && item.repeat === repeat)
    return baseline && challenged ? [{ baseline, challenged }] : []
  })
  const baselinePoseEligible = pairs.filter(({ baseline }) => baseline.posePass)
  const baselineCombinedEligible = pairs.filter(({ baseline }) => baseline.combinedPass)
  return {
    pairs: pairs.length,
    baselinePoseEligible: baselinePoseEligible.length,
    blockedByPoseGateAfterBaselinePosePass: baselinePoseEligible.filter(({ challenged }) => !challenged.posePass).length,
    baselineCombinedEligible: baselineCombinedEligible.length,
    blockedByCombinedGateAfterBaselineCombinedPass: baselineCombinedEligible.filter(({ challenged }) => !challenged.combinedPass).length,
  }
}

export function buildLocalOcclusionStudyAggregate(
  captures: LocalOcclusionCaptureResult[],
  metadata: LocalOcclusionStudyMetadata,
  testedAt = new Date().toISOString(),
) {
  const uniqueSlots = new Set(captures.map((item) => `${item.condition}:${item.repeat}`))
  const validSlots = captures.every((item) => LOCAL_OCCLUSION_CONDITIONS.includes(item.condition) && item.repeat >= 1 && item.repeat <= 3)
  const protocolComplete = captures.length === 9 && uniqueSlots.size === 9 && validSlots
  return {
    policyVersion: 'HEADUP-LOCAL-OCCLUSION-PAIR-1.0',
    testedAt,
    session: metadata,
    protocol: {
      repeatsPerCondition: 3,
      conditions: LOCAL_OCCLUSION_CONDITIONS,
      protocolComplete,
      expectedOutcome: { open: 'pass', mask: 'reject', sunglasses: 'reject' },
    },
    byCondition: Object.fromEntries(LOCAL_OCCLUSION_CONDITIONS.map((condition) => [
      condition,
      summarize(captures.filter((item) => item.condition === condition)),
    ])),
    pairedTransitions: {
      mask: pairedTransition(captures, 'mask'),
      sunglasses: pairedTransition(captures, 'sunglasses'),
    },
    retention: {
      imagesIncluded: false,
      fileNamesIncluded: false,
      imageHashesIncluded: false,
      landmarksIncluded: false,
      demographicAttributesIncluded: false,
      aggregateOnly: true,
    },
    interpretation: protocolComplete
      ? 'Only baseline-eligible pairs can estimate whether the challenged condition is blocked. Three repeats are a local diagnostic, not a population performance estimate.'
      : 'Incomplete protocol. Do not use this session to estimate blocking performance.',
  }
}
