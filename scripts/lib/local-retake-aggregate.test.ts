import { describe, expect, it } from 'vitest'
// @ts-expect-error JavaScript research utility intentionally has no declaration file.
import { buildRetakeAggregate, evaluateBrowPeakMidfaceRetakePromotion } from './local-retake-aggregate.mjs'

function session(label: 'A' | 'B', token = '8f35b1d2-554f-4c67-9c8e-5e24b084c032') {
  const captures = [1, 2, 3].map((repeat) => ({
    repeat, width: 3024, height: 4032, qualityScore: 90,
    qualityPass: true, posePass: true, combinedPass: true, qualityFlags: [], poseFlags: [],
    geometry: {
      mirrorResidual: 0.02 + repeat * 0.001 + (label === 'B' ? 0.002 : 0),
      visibleFaceLengthWidthRatio: 1.18 + repeat * 0.001,
      pupilDistanceFaceWidthRatio: 0.43 + repeat * 0.001,
      interEyeRatio: 1.2 + repeat * 0.001,
      eyeCanthalTiltDegrees: -1.4 + repeat * 0.01,
      jawWidthRatio: 0.79 + repeat * 0.001,
      mouthWidthRatio: 0.36 + repeat * 0.001,
      midfaceHeightRatio: 0.37 + repeat * 0.001,
      browPeakMidfaceHeightRatio:0.41+repeat*.001,
      lowerFaceHeightRatio: 0.39 + repeat * 0.001,
      noseMouthWidthRatio: 0.68 + repeat * 0.001,
      noseLengthFaceHeightRatio: 0.22 + repeat * 0.001,
      lipHeightMouthWidthRatio: 0.31 + repeat * 0.001,
    },
  }))
  return {
    policyVersion: 'HEADUP-LOCAL-RETAKE-SESSION-3.0', testedAt: label === 'A' ? '2026-08-15T00:00:00.000Z' : '2026-08-16T00:00:00.000Z', pairing: { token },
    session: { label, deviceClass: 'smartphone_front', lighting: 'indirect_daylight', distanceBand: '40_60_cm' },
    protocol: { repeats: 3, protocolComplete: true, subjectLeavesFrameBetweenRepeats: true, cameraReacquiredFocusBetweenRepeats: true, neutralExpressionRequired: true, sameDeviceRequiredAcrossSessions: true, recommendedSessionSeparationHours: 24 },
    captures,
    summary: { attempted: 3, qualityPassed: 3, posePassed: 3, combinedPassed: 3, usableMeasurements: 3 },
    retention: { imagesIncluded: false, fileNamesIncluded: false, imageHashesIncluded: false, landmarksIncluded: false, demographicAttributesIncluded: false, geometryIncludedForTemporaryPairing: true, pairingTokenIncludedForTemporaryPairing: true, browserStorageUsed: false },
    interpretation: 'temporary',
  }
}

describe('cross-session real-person retake aggregation', () => {
  it('pairs A/B sessions and removes tokens and individual measurements from output', () => {
    const result = buildRetakeAggregate([session('A'), session('B')], '2026-08-15T01:00:00.000Z')
    expect(result.pairing).toMatchObject({ completePairs: 1, eligiblePairs: 1 })
    expect(result.metrics.visibleFaceLengthWidthRatio.crossSessionMedianDifference.absoluteDifference.observations).toBe(1)
    expect(Object.keys(result.metrics)).toHaveLength(13)
    expect(result.metrics.browPeakMidfaceHeightRatio.sameImagePerturbationProxy.value).toBe(1.34)
    expect(result.studyStrength.diagnosticOnly).toBe(true)
    expect(result.browPeakMidfacePromotion).toMatchObject({passesProductionPromotionGate:false,decision:'retain_research_candidate'})
    expect(result.retention).toMatchObject({ pairingTokensIncluded: false, individualMeasurementsIncluded: false })
    expect(JSON.stringify(result)).not.toContain('8f35b1d2')
  })

  it('promotes the brow-peak candidate only when sample, error, improvement and coverage gates all pass',()=>{
    const aggregate={pairing:{eligiblePairs:30},coverage:{byDeviceClass:{smartphone_rear:30,smartphone_front:30},byLighting:{indirect_daylight:30,indoor_even:30}},metrics:{browPeakMidfaceHeightRatio:{crossSessionMedianDifference:{relativeDifferencePercent:{p95:4}},withinSessionPairwise:{relativeDifferencePercent:{p95:2}}},midfaceHeightRatio:{crossSessionMedianDifference:{relativeDifferencePercent:{p95:5}}}}}
    const result=evaluateBrowPeakMidfaceRetakePromotion(aggregate)
    expect(result.metrics.relativeImprovementVsLegacy168).toBe(20)
    expect(result.passesProductionPromotionGate).toBe(true)
    expect(result.decision).toContain('eligible_to_replace')
    expect(evaluateBrowPeakMidfaceRetakePromotion({...aggregate,coverage:{...aggregate.coverage,byDeviceClass:{smartphone_rear:10,smartphone_front:50}}}).passesProductionPromotionGate).toBe(false)
  })

  it('rejects unknown fields and duplicate session labels', () => {
    expect(() => buildRetakeAggregate([{ ...session('A'), imagePath: 'face.jpg' }])).toThrow('unexpected structure')
    expect(() => buildRetakeAggregate([session('A'), session('A')])).toThrow('duplicate pairing token')
  })
})
