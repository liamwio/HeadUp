import type{Measurement}from'../types'

export const FRONT_REPORT_TARGET_COUNT=12 as const
export const frontReportCoverageContract={
  counted:['FRONT-RATIO-01','FRONT-RATIO-02','FRONT-RATIO-04','FRONT-RATIO-05','FRONT-RATIO-06','FRONT-RATIO-07','FRONT-RATIO-09','FRONT-RATIO-10'],
  referenceOnly:{
    'FRONT-ANGLE-01':'双眼倾斜符号已修正；旧公式P95不适用，待重新校准。',
    'FRONT-SYM-01':'12点镜像残差缺少独立人工真值，MUCT光照P95绝对漂移16.23个百分点。',
    'FRONT-RATIO-03':'眼间距比WFLW独立留出P95相对误差34.99%，不进入可测出计数。',
    'FRONT-RATIO-08':'鼻嘴宽度比WFLW独立留出P95相对误差46.37%，不进入可测出计数。',
  },
}as const

const countedCodes=new Set<string>(frontReportCoverageContract.counted)
const referenceReasons=frontReportCoverageContract.referenceOnly as Record<string,string>

export function frontReportCoverage(measurements:readonly Measurement[]){
  const observed=measurements.filter(item=>item.code)
  const counted=observed.filter(item=>countedCodes.has(item.code!))
  const referenceOnly=observed.filter(item=>referenceReasons[item.code!]).map(item=>({code:item.code!,label:item.label,reason:referenceReasons[item.code!]}))
  return{target:FRONT_REPORT_TARGET_COUNT,observed:observed.length,counted:counted.length,referenceOnly,completeContract:observed.length===FRONT_REPORT_TARGET_COUNT&&counted.length===frontReportCoverageContract.counted.length&&referenceOnly.length===Object.keys(referenceReasons).length}
}
