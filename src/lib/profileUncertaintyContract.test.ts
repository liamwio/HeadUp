import{describe,expect,it}from'vitest'
import{DIRECT_PROFILE_DISAGREEMENT_LIMITS,DIRECT_PROFILE_UNCERTAINTY,OVERLAY_PROFILE_UNCERTAINTY}from'./profileUncertaintyContract'

describe('profile uncertainty single-source contract',()=>{
  it('derives every RSS from manual truth and same-version paired difference',()=>{
    expect(DIRECT_PROFILE_UNCERTAINTY.convexityDegrees.rss).toBeCloseTo(18.0701,3)
    expect(DIRECT_PROFILE_UNCERTAINTY.eLineUpperPercentagePoints.rss).toBeCloseTo(4.3658,3)
    expect(DIRECT_PROFILE_UNCERTAINTY.eLineLowerPercentagePoints.rss).toBeCloseTo(4.6487,3)
    expect(OVERLAY_PROFILE_UNCERTAINTY.mandibularInclinationDegrees.rss).toBeCloseTo(11.7046,3)
  })

  it('uses the larger component RSS for max-component disagreement values',()=>{
    expect(DIRECT_PROFILE_DISAGREEMENT_LIMITS.eLinePercentagePoints).toBe(DIRECT_PROFILE_UNCERTAINTY.eLineLowerPercentagePoints.rss)
    expect(DIRECT_PROFILE_DISAGREEMENT_LIMITS.verticalPercentagePoints).toBe(DIRECT_PROFILE_UNCERTAINTY.verticalLowerFacePercentagePoints.rss)
  })
})
