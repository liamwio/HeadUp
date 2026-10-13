import{describe,expect,it}from'vitest'
import{PROFILE_NECK_AESTHETIC_RUNTIME,PROFILE_NECK_LINE_UNCERTAINTY,estimateProfileNeckLine,jawNeckLineAngleDegrees,neckAngleReferenceState}from'./profileNeckLine'

const jaw=Array.from({length:7},(_,index)=>({x:.3+index*.05,y:.6+index*.02}))
describe('profile neck line proxy',()=>{
  it('returns three finite neck-line samples and an acute jaw-neck angle',()=>{
    const neck=estimateProfileNeckLine(jaw)!
    expect(neck).toHaveLength(3)
    expect(neck.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y))).toBe(true)
    expect(jawNeckLineAngleDegrees(jaw,neck)).toBeGreaterThanOrEqual(0)
    expect(jawNeckLineAngleDegrees(jaw,neck)).toBeLessThanOrEqual(90)
  })
  it('is invariant to translation and scale',()=>{
    const baseline=jawNeckLineAngleDegrees(jaw,estimateProfileNeckLine(jaw)!)!
    const transformed=jaw.map(point=>({x:point.x*2+3,y:point.y*2-4}))
    expect(jawNeckLineAngleDegrees(transformed,estimateProfileNeckLine(transformed)!)).toBeCloseTo(baseline,10)
  })
  it('keeps the frozen leave-one-out uncertainty explicit',()=>{
    expect(PROFILE_NECK_LINE_UNCERTAINTY.pathP95VisibleProfileHeightRatio).toBeCloseTo(.106625,6)
    expect(PROFILE_NECK_LINE_UNCERTAINTY.jawNeckAngleP95Degrees).toBeCloseTo(14.3545,4)
  })
  it('enables the user-approved observed range without inventing a preference ranking',()=>{
    expect(PROFILE_NECK_AESTHETIC_RUNTIME).toMatchObject({enabled:true,mode:'accepted_observed_range',acceptedObservedRange:{minimum:14.511587057289777,maximum:51.03961722974777}})
    expect(neckAngleReferenceState(30,5)).toBe('within')
    expect(neckAngleReferenceState(10,2)).toBe('outside')
    expect(neckAngleReferenceState(20,14.35448815624138)).toBe('overlap')
  })
})
