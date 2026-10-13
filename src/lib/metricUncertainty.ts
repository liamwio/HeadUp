import type{MetricErrorEvidence}from'./errorEvidence'

export type MetricDisplayUnit='percent'|'degrees'|'ratio'
export type MetricConfidenceGrade='comparable'|'recordable'|'reference_only'
export type MetricUncertaintySummary={
  display:string
  uncertainty:number|null
  grade:MetricConfidenceGrade
  gradeLabel:'可比较'|'可记录'|'仅参考'
  normalizedUncertainty:number|null
}

const gradeLabel:Record<MetricConfidenceGrade,MetricUncertaintySummary['gradeLabel']>={comparable:'可比较',recordable:'可记录',reference_only:'仅参考'}

function deltaInDisplayUnit(observed:number,error:MetricErrorEvidence,unit:MetricDisplayUnit):number|null{
  if(error.use==='descriptive_repeatability')return null
  if(error.kind==='relative')return Math.abs(observed)*error.value/100
  if(error.unit==='degrees')return unit==='degrees'?error.value:null
  if(error.unit==='percentage_points')return unit==='percent'?error.value:unit==='ratio'?error.value/100:null
  if(error.unit==='ratio')return unit==='ratio'?error.value:unit==='percent'?error.value*100:null
  // Conservative interim conversion: normalized-image percent is treated as
  // percentage points for percentage displays and as /100 for ratios.
  if(error.unit==='face_box_diagonal_percent')return unit==='percent'?error.value:unit==='ratio'?error.value/100:null
  if(error.unit==='visible_profile_height_percent')return null
  return null
}

/** Same-source components RSS first, independent validation sources RSS second. */
export function twoLevelRssUncertainty(observed:number,errors:readonly MetricErrorEvidence[],unit:MetricDisplayUnit):number|null{
  const bySource=new Map<string,number[]>()
  for(const error of errors){
    const delta=deltaInDisplayUnit(observed,error,unit)
    if(delta===null)continue
    const components=bySource.get(error.source)??[]
    components.push(delta)
    bySource.set(error.source,components)
  }
  if(bySource.size===0)return null
  const sourceTotals=[...bySource.values()].map(components=>Math.sqrt(components.reduce((sum,value)=>sum+value**2,0)))
  return Math.sqrt(sourceTotals.reduce((sum,value)=>sum+value**2,0))
}

export function confidenceGrade(observed:number,uncertainty:number|null,scale:number):Pick<MetricUncertaintySummary,'grade'|'gradeLabel'|'normalizedUncertainty'>{
  if(uncertainty===null)return{grade:'reference_only',gradeLabel:'仅参考',normalizedUncertainty:null}
  // Near-zero guard: a meaningful zero must not turn a small absolute error
  // into an arbitrarily large relative ratio.
  const normalizedUncertainty=uncertainty/Math.max(Math.abs(observed),scale)
  const grade:MetricConfidenceGrade=normalizedUncertainty<=.10?'comparable':normalizedUncertainty<=.25?'recordable':'reference_only'
  return{grade,gradeLabel:gradeLabel[grade],normalizedUncertainty}
}

const defaultScale=(unit:MetricDisplayUnit)=>unit==='degrees'?10:unit==='percent'?5:.05
const unitFromSuffix=(suffix:string):MetricDisplayUnit=>suffix==='°'?'degrees':suffix==='%'?'percent':'ratio'
const uncertaintyText=(value:number,unit:MetricDisplayUnit)=>unit==='degrees'?`${value.toFixed(2)}°`:unit==='percent'?`${value.toFixed(2)} 个百分点`:value.toFixed(3)
const severity:Record<MetricConfidenceGrade,number>={comparable:0,recordable:1,reference_only:2}

/**
 * Keeps every displayed observation and attaches its uncertainty inline.
 * Multi-value strings pair errors positionally (for example upper/lower E-Line).
 */
export function summarizeMetricValue(value:string,errors:readonly MetricErrorEvidence[],scales:readonly number[]=[]):MetricUncertaintySummary{
  const matches=[...value.matchAll(/-?\d+(?:\.\d+)?(?<suffix>%|°)?/g)]
  if(matches.length===0)return{display:value,uncertainty:null,grade:'reference_only',gradeLabel:'仅参考',normalizedUncertainty:null}
  const hasIndexedComponents=errors.some(error=>error.componentIndex!==undefined)
  const summaries=matches.map((match,index)=>{
    const observed=Number(match[0].replace(/[%°]/g,''))
    const suffix=match.groups?.suffix??''
    const unit=unitFromSuffix(suffix)
    const componentErrors=matches.length===1?errors:hasIndexedComponents?errors.filter(error=>error.componentIndex===undefined||error.componentIndex===index):errors[index]?[errors[index]]:[]
    const uncertainty=twoLevelRssUncertainty(observed,componentErrors,unit)
    const grade=confidenceGrade(observed,uncertainty,scales[index]??defaultScale(unit))
    return{match,observed,unit,uncertainty,...grade}
  })
  let cursor=0
  let display=''
  for(const summary of summaries){
    const index=summary.match.index??cursor
    display+=value.slice(cursor,index)+summary.match[0]
    if(summary.uncertainty!==null)display+=` ± ${uncertaintyText(summary.uncertainty,summary.unit)}`
    cursor=index+summary.match[0].length
  }
  display+=value.slice(cursor)
  const worst=summaries.reduce((left,right)=>severity[right.grade]>severity[left.grade]?right:left)
  return{display,uncertainty:summaries.length===1?summaries[0].uncertainty:null,grade:worst.grade,gradeLabel:worst.gradeLabel,normalizedUncertainty:worst.normalizedUncertainty}
}
