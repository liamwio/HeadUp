import { profileRegionAnnotationDefinitions, type NormalizedAnnotationPoint, type ProfileRegionName } from './profileRegionAnnotationStudy'

export const PROFILE_REGION_ASSISTED_POLICY = 'HEADUP-PROFILE-REGION-ASSISTED-REVIEW-1.2' as const
export type AssistedReviewStatus = 'pending' | 'confirmed' | 'corrected' | 'manual_from_scratch' | 'occluded' | 'model_unavailable'
export type AssistedRegionReview = {
  status: AssistedReviewStatus
  points: NormalizedAnnotationPoint[]
  modelPoints: NormalizedAnnotationPoint[]
  note?: string
}
export type AssistedReviewCase = {
  reviewId: string
  width: number
  height: number
  regions: Record<ProfileRegionName, AssistedRegionReview>
  neckContour: {
    status: 'manual_required' | 'manual_from_scratch' | 'occluded'
    points: NormalizedAnnotationPoint[]
    angleDegrees: number | null
    angleDefinition: 'acute_angle_between_endpoint_fit(mandibularChin,neckContour)'
    visualBand: null
    note?: string
  }
}
export type ProfileRegionAssistedExport = {
  policyVersion: typeof PROFILE_REGION_ASSISTED_POLICY
  createdAt: string
  workflow: 'model_preannotation_then_human_review'
  eligibleForBlindCanonical: false
  cases: AssistedReviewCase[]
}

const names = Object.keys(profileRegionAnnotationDefinitions) as ProfileRegionName[]
const finitePoint = (point: NormalizedAnnotationPoint) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1

export function assistedRegionWasCorrected(region: AssistedRegionReview, tolerance = 0.001) {
  if (region.points.length !== region.modelPoints.length || region.points.length === 0) return false
  return Math.sqrt(region.points.reduce((sum, point, index) => sum + (point.x - region.modelPoints[index].x) ** 2 + (point.y - region.modelPoints[index].y) ** 2, 0) / region.points.length) > tolerance
}

export function submentalCervicalAngle(points: readonly NormalizedAnnotationPoint[]) {
  if (points.length !== 3 || !points.every(finitePoint)) return null
  const [menton, cervical, neck] = points, left = { x: menton.x - cervical.x, y: menton.y - cervical.y }, right = { x: neck.x - cervical.x, y: neck.y - cervical.y }
  const denominator = Math.hypot(left.x, left.y) * Math.hypot(right.x, right.y)
  if (denominator <= 1e-8) return null
  return Math.acos(Math.max(-1, Math.min(1, (left.x * right.x + left.y * right.y) / denominator))) * 180 / Math.PI
}

export function submentalCervicalVisualBand(angle: number | null) {
  if (angle === null || !Number.isFinite(angle)) return null
  return angle < 90 ? 'more_acute' as const : angle <= 105 ? 'reference_band' as const : 'more_open' as const
}

export function jawNeckLineAngle(jawPoints: readonly NormalizedAnnotationPoint[], neckPoints: readonly NormalizedAnnotationPoint[]) {
  if (jawPoints.length < 2 || neckPoints.length < 2 || ![...jawPoints, ...neckPoints].every(finitePoint)) return null
  const jaw = { x: jawPoints.at(-1)!.x - jawPoints[0].x, y: jawPoints.at(-1)!.y - jawPoints[0].y }, neck = { x: neckPoints.at(-1)!.x - neckPoints[0].x, y: neckPoints.at(-1)!.y - neckPoints[0].y }
  const denominator = Math.hypot(jaw.x, jaw.y) * Math.hypot(neck.x, neck.y)
  if (denominator <= 1e-8) return null
  return Math.acos(Math.max(-1, Math.min(1, Math.abs(jaw.x * neck.x + jaw.y * neck.y) / denominator))) * 180 / Math.PI
}

export function neckContourGeometryIssues(points: readonly NormalizedAnnotationPoint[]) {
  if (points.length !== 3 || !points.every(finitePoint)) return []
  const [start, middle, end] = points, errors: string[] = [], total = Math.hypot(end.x - start.x, end.y - start.y)
  if (total < 0.04) errors.push('颈线首尾距离过短')
  if (total > 1e-8) {
    const deviation = Math.abs((end.x - start.x) * (start.y - middle.y) - (start.x - middle.x) * (end.y - start.y)) / total
    if (deviation > 0.04) errors.push('三个采样点未形成稳定颈线')
  }
  return errors
}

export function profileRegionAssistedCoverage(output: { cases: AssistedReviewCase[] }) {
  const regions = output.cases.flatMap((item) => names.map((name) => item.regions[name]))
  return {
    cases: output.cases.length,
    total: regions.length,
    confirmed: regions.filter((item) => item.status === 'confirmed').length,
    corrected: regions.filter((item) => item.status === 'corrected').length,
    manualFromScratch: regions.filter((item) => item.status === 'manual_from_scratch').length,
    occluded: regions.filter((item) => item.status === 'occluded').length,
    modelUnavailable: regions.filter((item) => item.status === 'model_unavailable').length,
    pending: regions.filter((item) => item.status === 'pending').length,
    complete: regions.every((item) => ['confirmed', 'corrected', 'manual_from_scratch', 'occluded'].includes(item.status)),
    neck: {
      total: output.cases.length,
      manualFromScratch: output.cases.filter((item) => item.neckContour.status === 'manual_from_scratch').length,
      occluded: output.cases.filter((item) => item.neckContour.status === 'occluded').length,
      pending: output.cases.filter((item) => item.neckContour.status === 'manual_required').length,
      complete: output.cases.every((item) => item.neckContour.status !== 'manual_required'),
    },
  }
}

export function validateProfileRegionAssistedExport(value: unknown) {
  const errors: string[] = []
  if (!value || typeof value !== 'object') return ['assisted export must be an object']
  const output = value as Partial<ProfileRegionAssistedExport>
  if (output.policyVersion !== PROFILE_REGION_ASSISTED_POLICY) errors.push('unexpected policyVersion')
  if (output.workflow !== 'model_preannotation_then_human_review') errors.push('unexpected workflow')
  if (output.eligibleForBlindCanonical !== false) errors.push('assisted review must not be eligible for blind canonical')
  if (!Array.isArray(output.cases) || output.cases.length !== 30) return [...errors, 'assisted export must contain 30 cases']
  const ids = new Set<string>()
  output.cases.forEach((item, caseIndex) => {
    if (!item.reviewId || ids.has(item.reviewId)) errors.push(`case ${caseIndex} missing or duplicate reviewId`)
    ids.add(item.reviewId)
    if (!Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0) errors.push(`case ${caseIndex} invalid dimensions`)
    const neck = item.neckContour
    if (!neck) errors.push(`case ${caseIndex} missing neckContour`)
    else {
      if (!['manual_required', 'manual_from_scratch', 'occluded'].includes(neck.status)) errors.push(`case ${caseIndex} neckContour invalid status`)
      if (neck.status === 'manual_from_scratch' && neck.points.length !== 3) errors.push(`case ${caseIndex} neckContour requires 3 points`)
      if (neck.status === 'occluded' && neck.points.length !== 0) errors.push(`case ${caseIndex} occluded neckContour must not contain points`)
      if (neck.status === 'manual_required' && neck.points.length > 3) errors.push(`case ${caseIndex} pending neckContour has too many points`)
      if (!neck.points.every(finitePoint)) errors.push(`case ${caseIndex} neckContour invalid point`)
      const angle = jawNeckLineAngle(item.regions.mandibularChin.points, neck.points)
      for (const issue of neckContourGeometryIssues(neck.points)) errors.push(`case ${caseIndex} neckContour: ${issue}`)
      if (neck.status === 'manual_from_scratch' && (angle === null || neck.angleDegrees === null || Math.abs(angle - neck.angleDegrees) > 0.01)) errors.push(`case ${caseIndex} neckContour angle mismatch`)
      if (neck.angleDefinition !== 'acute_angle_between_endpoint_fit(mandibularChin,neckContour)') errors.push(`case ${caseIndex} neckContour angle definition mismatch`)
      if (neck.visualBand !== null) errors.push(`case ${caseIndex} neckContour visual band must remain null until validated`)
    }
    for (const name of names) {
      const region = item.regions?.[name]
      if (!region) { errors.push(`case ${caseIndex} missing ${name}`); continue }
      if (!['pending', 'confirmed', 'corrected', 'manual_from_scratch', 'occluded', 'model_unavailable'].includes(region.status)) errors.push(`case ${caseIndex} ${name} invalid status`)
      const expected = profileRegionAnnotationDefinitions[name].pointCount
      if (region.status === 'occluded' || region.status === 'model_unavailable') {
        if (region.points.length !== 0) errors.push(`case ${caseIndex} ${name} unavailable region must not contain review points`)
      } else if (region.points.length !== expected) errors.push(`case ${caseIndex} ${name} requires ${expected} review points`)
      if (region.status !== 'model_unavailable' && region.status !== 'manual_from_scratch' && region.modelPoints.length !== expected) errors.push(`case ${caseIndex} ${name} requires ${expected} model points`)
      if (region.status === 'manual_from_scratch' && region.modelPoints.length !== 0) errors.push(`case ${caseIndex} ${name} manual-from-scratch must not claim model points`)
      if (![...region.points, ...region.modelPoints].every(finitePoint)) errors.push(`case ${caseIndex} ${name} invalid point`)
      if (region.status === 'corrected' && !assistedRegionWasCorrected(region)) errors.push(`case ${caseIndex} ${name} corrected status without point change`)
    }
  })
  return errors
}
