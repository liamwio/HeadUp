import { describe, expect, it } from 'vitest'
import { compareProfileGeometry, computeProfileGeometry, type ProfilePoint } from './profileGeometry'

function rightProfile(): ProfilePoint[] {
  const points = Array.from({ length: 39 }, (_, index) => ({ x: index * 0.01, y: index * 0.02 }))
  points[4] = { x: -3, y: 8 }
  points[5] = { x: -2, y: 9 }
  points[6] = { x: -1, y: 10 }
  points[7] = { x: 0, y: 11 }
  points[8] = { x: 1, y: 12 }
  points[10] = { x: 2.5, y: 10 }
  points[11] = { x: 1.5, y: 9 }
  points[14] = { x: 0, y: 0 }
  points[17] = { x: 0, y: 2 }
  points[19] = { x: 3, y: 4 }
  points[20] = { x: 2, y: 5 }
  points[21] = { x: 1, y: 6 }
  points[27] = { x: 2, y: 7 }
  points[33] = { x: 2.2, y: 8 }
  return points
}

function transform(points: ProfilePoint[], scale: number, angleDegrees: number, translate: ProfilePoint): ProfilePoint[] {
  const angle = angleDegrees * Math.PI / 180
  return points.map((point) => ({
    x: scale * (point.x * Math.cos(angle) - point.y * Math.sin(angle)) + translate.x,
    y: scale * (point.x * Math.sin(angle) + point.y * Math.cos(angle)) + translate.y,
  }))
}

describe('profile geometry', () => {
  it('computes seven native metrics and explicitly withholds the neck-dependent eighth metric', () => {
    const result = computeProfileGeometry({ landmarks: rightProfile(), orientation: 'right' })
    expect(result.status).toBe('measured')
    if (result.status !== 'measured') return
    expect(result.measuredMetricCount).toBe(7)
    expect(result.geometry.cervicomentalAngleDegrees).toBeNull()
    expect(result.unavailableMetrics.cervicomentalAngle).toBe('native_39_markup_has_no_neck_tangent')
    expect(result.geometry.softTissueConvexityAngleDegrees).toBeCloseTo(173.4801982483431, 8)
    expect(result.geometry.eLineUpperLipDistanceFaceHeightRatio).toBeCloseTo(-0.062284109890304994, 8)
    expect(result.geometry.eLineLowerLipDistanceFaceHeightRatio).toBeCloseTo(-0.03875455726507865, 8)
    expect(result.geometry.nasolabialAngleDegrees).toBeCloseTo(90, 8)
    expect(result.geometry.mentolabialAngleDegrees).toBeCloseTo(100.00797980144134, 8)
    expect(result.geometry.softTissueChinProjectionFaceHeightRatio).toBeCloseTo(0.04042260417272218, 8)
    expect(result.geometry.mandibularPlaneInclinationDegrees).toBeCloseTo(45, 8)
    expect(result.geometry.verticalMidfaceShare).toBeCloseTo(0.6, 8)
    expect(result.geometry.verticalLowerFaceShare).toBeCloseTo(0.4, 8)
  })

  it('is invariant to translation, scale, declared head-axis rotation and left/right mirroring', () => {
    const baseline = computeProfileGeometry({ landmarks: rightProfile(), orientation: 'right' })
    const rotated = computeProfileGeometry({
      landmarks: transform(rightProfile(), 3.4, 17, { x: 100, y: -40 }),
      orientation: 'right',
      headAxisAngleDegrees: 17,
    })
    const mirrored = computeProfileGeometry({
      landmarks: rightProfile().map((point) => ({ x: -point.x, y: point.y })),
      orientation: 'left',
    })
    expect(baseline.status).toBe('measured')
    expect(rotated.status).toBe('measured')
    expect(mirrored.status).toBe('measured')
    if (baseline.status !== 'measured' || rotated.status !== 'measured' || mirrored.status !== 'measured') return
    for (const key of Object.keys(baseline.geometry) as (keyof typeof baseline.geometry)[]) {
      const expected = baseline.geometry[key]
      if (expected === null) expect(rotated.geometry[key]).toBeNull()
      else expect(rotated.geometry[key]).toBeCloseTo(expected, 8)
      if (expected === null) expect(mirrored.geometry[key]).toBeNull()
      else expect(mirrored.geometry[key]).toBeCloseTo(expected, 8)
    }
  })

  it('keeps E-Line and chin projection signs oriented toward the visible anterior face',()=>{
    const anterior=rightProfile(),posterior=rightProfile()
    anterior[27]={x:4,y:7};posterior[27]={x:0,y:7}
    const front=computeProfileGeometry({landmarks:anterior,orientation:'right'}),back=computeProfileGeometry({landmarks:posterior,orientation:'right'})
    expect(front.status).toBe('measured');expect(back.status).toBe('measured')
    if(front.status!=='measured'||back.status!=='measured')return
    expect(front.geometry.eLineUpperLipDistanceFaceHeightRatio).toBeGreaterThan(0)
    expect(back.geometry.eLineUpperLipDistanceFaceHeightRatio).toBeLessThan(0)
    expect(front.geometry.softTissueChinProjectionFaceHeightRatio).toBeGreaterThan(0)
  })

  it('reports direct-head versus landmark-derived disagreement in display units',()=>{
    const base=computeProfileGeometry({landmarks:rightProfile(),orientation:'right'})
    expect(base.status).toBe('measured');if(base.status!=='measured')return
    const other={...base.geometry,softTissueConvexityAngleDegrees:base.geometry.softTissueConvexityAngleDegrees+2,eLineUpperLipDistanceFaceHeightRatio:base.geometry.eLineUpperLipDistanceFaceHeightRatio+.03,softTissueChinProjectionFaceHeightRatio:base.geometry.softTissueChinProjectionFaceHeightRatio-.04,mandibularPlaneInclinationDegrees:base.geometry.mandibularPlaneInclinationDegrees+5,verticalMidfaceShare:base.geometry.verticalMidfaceShare+.02,verticalLowerFaceShare:base.geometry.verticalLowerFaceShare-.02}
    const disagreement=compareProfileGeometry(base.geometry,other)
    expect(disagreement).toMatchObject({softTissueConvexityAngleDegrees:2,eLinePercentagePoints:3,chinProjectionPercentagePoints:4,mandibularInclinationDegrees:5})
    expect(disagreement.verticalPercentagePoints).toBeCloseTo(2,10)
  })

  it('computes the eighth metric only when a non-degenerate neck tangent is supplied', () => {
    const result = computeProfileGeometry({
      landmarks: rightProfile(),
      orientation: 'right',
      neckLandmarks: {
        cervicomentalPoint: { x: -0.5, y: 13 },
        lowerNeckPoint: { x: -2, y: 16 },
      },
    })
    expect(result.status).toBe('measured')
    if (result.status !== 'measured') return
    expect(result.measuredMetricCount).toBe(8)
    expect(result.geometry.cervicomentalAngleDegrees).not.toBeNull()
    expect(result.unavailableMetrics.cervicomentalAngle).toBeUndefined()
  })

  it('rejects short, non-finite, collapsed and vertically disordered inputs', () => {
    expect(computeProfileGeometry({ landmarks: rightProfile().slice(0, 38), orientation: 'right' })).toMatchObject({
      status: 'insufficient', reason: 'native_39_landmarks_required',
    })
    const nonFinite = rightProfile()
    nonFinite[19] = { x: Number.NaN, y: 4 }
    expect(computeProfileGeometry({ landmarks: nonFinite, orientation: 'right' })).toMatchObject({
      status: 'insufficient', reason: 'non_finite_profile_geometry',
    })
    const collapsed = rightProfile()
    collapsed[19] = { ...collapsed[10] }
    expect(computeProfileGeometry({ landmarks: collapsed, orientation: 'right' })).toMatchObject({
      status: 'insufficient', reason: 'collapsed_required_profile_landmarks',
    })
    const disordered = rightProfile()
    disordered[21] = { x: 1, y: -1 }
    expect(computeProfileGeometry({ landmarks: disordered, orientation: 'right' })).toMatchObject({
      status: 'insufficient', reason: 'vertical_landmark_order_invalid',
    })
  })
})
