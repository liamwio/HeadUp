import{describe,expect,it}from'vitest'
import type{Measurement}from'../types'
import{FRONT_REPORT_TARGET_COUNT,frontReportCoverage,frontReportCoverageContract}from'./frontReportCoverage'

const measurement=(code:string):Measurement=>({code,label:code,value:'1',score:90,note:'',group:'比例'})

describe('front research coverage with corrected eye tilt awaiting calibration',()=>{
  it('counts eight declared measurements and retains four named reference-only observations',()=>{
    const codes=[...frontReportCoverageContract.counted,...Object.keys(frontReportCoverageContract.referenceOnly)],result=frontReportCoverage(codes.map(measurement))
    expect(FRONT_REPORT_TARGET_COUNT).toBe(12)
    expect(result).toMatchObject({target:12,observed:12,counted:8,completeContract:true})
    expect(result.referenceOnly.map(item=>item.code)).toEqual(['FRONT-ANGLE-01','FRONT-SYM-01','FRONT-RATIO-03','FRONT-RATIO-08'])
    expect(result.referenceOnly.every(item=>item.reason.includes('P95'))).toBe(true)
  })

  it('does not fabricate 9/12 when a measurement is missing',()=>{
    expect(frontReportCoverage(frontReportCoverageContract.counted.slice(0,8).map(measurement))).toMatchObject({observed:8,counted:8,completeContract:false})
  })
})
