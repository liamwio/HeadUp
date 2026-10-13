import { describe, expect, it } from 'vitest'
import {
  PROFILE_LANDMARK_COUNT,
  profileContourSegments,
  profileLandmarks,
  profileMeasurementContract,
  profileValidationGates,
} from './profileLandmarkContract'

describe('native profile landmark contract', () => {
  it('keeps all required semantic points distinct and inside the Menpo 39-point tensor', () => {
    const indices = Object.values(profileLandmarks).map((landmark) => landmark.index)
    expect(new Set(indices).size).toBe(indices.length)
    expect(Math.min(...indices)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...indices)).toBeLessThan(PROFILE_LANDMARK_COUNT)
    expect(profileLandmarks.columella.index).not.toBe(profileLandmarks.subnasale.index)
    expect(profileLandmarks.softTissuePogonion.index).not.toBe(profileLandmarks.menton.index)
  })

  it('matches the eight P0 profile measurements in the source specification', () => {
    expect(Object.keys(profileMeasurementContract)).toEqual([
      'softTissueConvexityAngle',
      'eLine',
      'nasolabialAngle',
      'mentolabialAngle',
      'softTissueChinProjection',
      'mandibularPlaneInclinationProxy',
      'cervicomentalAngle',
      'profileVerticalProportion',
    ])
    for (const measurement of Object.values(profileMeasurementContract)) {
      expect(measurement.nativeLandmarks.length).toBeGreaterThanOrEqual(1)
      expect(measurement.formula.length).toBeGreaterThan(12)
      expect(measurement.geometryOutputs.length).toBeGreaterThanOrEqual(1)
      for (const dependency of measurement.nativeLandmarks) expect(profileLandmarks).toHaveProperty(dependency)
    }
    expect(profileMeasurementContract.softTissueConvexityAngle.formula).toContain('vertex subnasale')
    expect(profileMeasurementContract.eLine.formula).toContain('signed distance')
    expect(profileMeasurementContract.nasolabialAngle.formula).toContain('vertex subnasale')
    expect(profileMeasurementContract.mentolabialAngle.formula).toContain('vertex mentolabialFold')
    expect(profileMeasurementContract.profileVerticalProportion.formula).toContain('brow-to-pogonion')
  })

  it('keeps the mandibular contour in range and refuses to invent neck landmarks', () => {
    expect(profileContourSegments.lowerMandibularBorder).toEqual([4, 5, 6, 7, 8])
    expect(Math.max(...profileContourSegments.lowerMandibularBorder)).toBeLessThan(PROFILE_LANDMARK_COUNT)
    expect(profileMeasurementContract.cervicomentalAngle.availability).toBe('requires_neck_landmarks')
    expect(profileValidationGates.requiresNeckLandmarkGroundTruth).toBe(true)
  })

  it('does not let a five-point or reused-holdout candidate satisfy release gates', () => {
    expect(profileValidationGates.minimumNativeOutputPoints).toBe(39)
    expect(profileValidationGates.requiresFreshConfirmatoryHoldout).toBe(true)
    expect(profileValidationGates.requiresProductCameraRetakes).toBe(true)
  })
})
