export type MetricErrorMeasure = 'drift' | 'error' | 'difference' | 'repeatability'
export type MetricEvidenceUse='uncertainty_component'|'conservative_radius'|'descriptive_repeatability'
type MetricErrorBase = { source:string;context?:string;statistic:'p95';measure:MetricErrorMeasure;value:number;use:MetricEvidenceUse;componentIndex?:number }
export type MetricErrorEvidence =
  | (MetricErrorBase & {kind:'relative';unit:'percent'})
  | (MetricErrorBase & {kind:'absolute';unit:'percentage_points'|'degrees'|'ratio'|'face_box_diagonal_percent'|'visible_profile_height_percent'})

const number=(value:number)=>Number.isInteger(value)?String(value):value.toFixed(2)
const measureLabel:Record<MetricErrorMeasure,string>={drift:'漂移',error:'误差',difference:'差',repeatability:'左右配对差'}

export function formatMetricErrorEvidence(error:MetricErrorEvidence){
  const prefix=`${error.source}${error.context?`（${error.context}）`:''} P95`
  if(error.use==='conservative_radius'){
    const unit=error.unit==='percentage_points'?' 个百分点':error.unit==='degrees'?'°':error.unit==='visible_profile_height_percent'?'% 可见侧貌高度':error.unit==='face_box_diagonal_percent'?'% 脸框对角线':error.unit==='percent'?'%':''
    return`${prefix} 左右配对差 ${number(error.value)}${unit}（作为区间保守半径）`
  }
  if(error.use==='descriptive_repeatability'){
    const unit=error.unit==='visible_profile_height_percent'?'% 可见侧貌高度':error.unit==='degrees'?'°':error.unit==='percentage_points'?' 个百分点':''
    return`${prefix} 左右配对重复性差 ${number(error.value)}${unit}（非人工真值）`
  }
  if(error.kind==='relative')return`${prefix} 相对${measureLabel[error.measure]} ${number(error.value)}%`
  const value=`${error.measure==='repeatability'?'':'±'}${number(error.value)}`
  if(error.unit==='percentage_points')return`${prefix} ${measureLabel[error.measure]} ${value} 个百分点`
  if(error.unit==='degrees')return`${prefix} ${measureLabel[error.measure]} ${value}°`
  if(error.unit==='face_box_diagonal_percent')return`${prefix} ${measureLabel[error.measure]} ${value}% 脸框对角线`
  if(error.unit==='visible_profile_height_percent')return`${prefix} ${measureLabel[error.measure]} ${value}% 可见侧貌高度`
  return`${prefix} ${measureLabel[error.measure]} ${value}`
}

export const formatMetricErrorEvidenceList=(errors:readonly MetricErrorEvidence[])=>errors.map(formatMetricErrorEvidence).join('；')
export const relativeP95=(source:string,context:string,value:number,measure:MetricErrorMeasure='drift'):MetricErrorEvidence=>({source,context,statistic:'p95',measure,kind:'relative',unit:'percent',value,use:'uncertainty_component'})
export const absoluteP95=(source:string,context:string,value:number,unit:'percentage_points'|'degrees'|'ratio'|'face_box_diagonal_percent'|'visible_profile_height_percent',measure:MetricErrorMeasure='error'):MetricErrorEvidence=>({source,context,statistic:'p95',measure,kind:'absolute',unit,value,use:measure==='difference'?'conservative_radius':measure==='repeatability'?'descriptive_repeatability':'uncertainty_component'})
export const pairedDifferenceP95=(source:string,context:string,value:number,unit:'percentage_points'|'degrees'|'ratio'|'face_box_diagonal_percent'):MetricErrorEvidence=>({source,context,statistic:'p95',measure:'difference',kind:'absolute',unit,value,use:'conservative_radius'})
export const descriptiveRepeatabilityP95=(source:string,context:string,value:number,unit:'visible_profile_height_percent'|'percentage_points'|'degrees'):MetricErrorEvidence=>({source,context,statistic:'p95',measure:'repeatability',kind:'absolute',unit,value,use:'descriptive_repeatability'})
export const evidenceForComponent=(error:MetricErrorEvidence,componentIndex:number):MetricErrorEvidence=>({...error,componentIndex})
