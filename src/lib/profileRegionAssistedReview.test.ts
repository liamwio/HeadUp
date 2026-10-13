import { describe, expect, it } from 'vitest'
import { PROFILE_REGION_ASSISTED_POLICY, assistedRegionWasCorrected, jawNeckLineAngle, neckContourGeometryIssues, profileRegionAssistedCoverage, submentalCervicalAngle, submentalCervicalVisualBand, validateProfileRegionAssistedExport, type AssistedReviewCase } from './profileRegionAssistedReview'
import { profileRegionAnnotationDefinitions } from './profileRegionAnnotationStudy'

const regions = () => Object.fromEntries(Object.entries(profileRegionAnnotationDefinitions).map(([name, definition]) => {
  const points = Array.from({ length: definition.pointCount }, (_, index) => ({ x: 0.2 + index * 0.01, y: 0.3 + index * 0.01 }))
  return [name, { status: 'pending', points: points.map((point) => ({ ...point })), modelPoints: points }]
})) as AssistedReviewCase['regions']
const output = () => ({ policyVersion: PROFILE_REGION_ASSISTED_POLICY, createdAt: new Date().toISOString(), workflow: 'model_preannotation_then_human_review' as const, eligibleForBlindCanonical: false as const, cases: Array.from({ length: 30 }, (_, index) => ({ reviewId: `case-${index}`, width: 1350, height: 1350, regions: regions(), neckContour: { status: 'manual_required' as const, points: [], angleDegrees: null, angleDefinition: 'acute_angle_between_endpoint_fit(mandibularChin,neckContour)' as const, visualBand: null } })) })

describe('profile region assisted review contract', () => {
  it('validates a 30-case model preannotation batch without treating it as canonical truth', () => {
    expect(validateProfileRegionAssistedExport(output())).toEqual([])
    expect(profileRegionAssistedCoverage(output())).toMatchObject({ total: 120, pending: 120, manualFromScratch: 0, complete: false })
  })
  it('detects human point corrections', () => {
    const region = regions().forehead
    expect(assistedRegionWasCorrected(region)).toBe(false)
    region.points[2].x += 0.02
    expect(assistedRegionWasCorrected(region)).toBe(true)
  })
  it('rejects assisted exports that claim blind-canonical eligibility', () => {
    const value = { ...output(), eligibleForBlindCanonical: true }
    expect(validateProfileRegionAssistedExport(value)).toContain('assisted review must not be eligible for blind canonical')
  })
  it('computes the visible submental-cervical angle at the cervical point', () => {
    expect(submentalCervicalAngle([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toBeCloseTo(90, 8)
    expect(submentalCervicalVisualBand(90)).toBe('reference_band')
    expect(submentalCervicalVisualBand(106)).toBe('more_open')
  })
  it('accepts three near-collinear samples as a neck line and compares it with the jaw line', () => {
    expect(neckContourGeometryIssues([{ x: 0.65, y: 0.7 }, { x: 0.6, y: 0.7 }, { x: 0.55, y: 0.71 }])).toEqual([])
    expect(jawNeckLineAngle([{ x: 0.4, y: 0.6 }, { x: 0.7, y: 0.75 }], [{ x: 0.65, y: 0.7 }, { x: 0.55, y: 0.7 }])).toBeGreaterThan(20)
  })
})
