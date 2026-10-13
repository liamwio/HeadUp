import {READING_COPY} from '../lib/readingCopy.ts'
import {twoLevelRssUncertainty,type MetricDisplayUnit} from '../lib/metricUncertainty.ts'
import type {MetricErrorEvidence} from '../lib/errorEvidence'
type NumericReading={code?:string;available:boolean;origin:'measurement'|'experimental'|'demo';view:'front'|'profile';value:string;errors?:MetricErrorEvidence[]}
export const AI_METRICS:Record<string,{unit:MetricDisplayUnit;parts:string[]}>=Object.fromEntries([
  ...['01','02','03','04','05','06','07','08','09','10'].map(n=>[`FRONT-RATIO-${n}`,{unit:['01','03','08','10'].includes(n)?'ratio':'percent',parts:['读数']}]),
  ['FRONT-ANGLE-01',{unit:'degrees',parts:['读数']}],
  ...['01','03','04','06','09'].map(n=>[`PROFILE-ANGLE-${n}`,{unit:'degrees',parts:['读数']}]),
  ['PROFILE-LINE-02',{unit:'percent',parts:['上唇','下唇']}],
  ['PROFILE-RATIO-05',{unit:'percent',parts:['读数']}],
  ['PROFILE-RATIO-07',{unit:'percent',parts:['中面','下面']}],
] as Array<[string,{unit:MetricDisplayUnit;parts:string[]}]>)
export type AiMetric={code:string;values:number[];uncertainty:Array<number|null>;origin:'measurement'|'experimental'}
export const metricLabel=(code:string)=>READING_COPY[code]?.[0]??code
export const metricMeaning=(code:string)=>READING_COPY[code]?.[1]??''
export const metricUnit=(code:string)=>AI_METRICS[code]?.unit
export const metricView=(code:string):'front'|'profile'=>code.startsWith('FRONT-')?'front':'profile'
export function metricText(metric:AiMetric){const spec=AI_METRICS[metric.code];return metric.values.map((v,i)=>`${spec.parts.length>1?spec.parts[i]+' ':''}${v}${spec.unit==='percent'?'%':spec.unit==='degrees'?'°':''}${metric.uncertainty[i]===null?'（无适用误差）':` ± ${metric.uncertainty[i]}${spec.unit==='percent'?' 个百分点':spec.unit==='degrees'?'°':''}`}`).join('；')}
/** Only recognized numeric formats enter AI data; labels, notes, formulas and source text never do. */
export function extractAiMetric(reading:NumericReading):AiMetric|null{
  const code=reading.code??'',spec=Object.hasOwn(AI_METRICS,code)?AI_METRICS[code]:undefined
  if(!spec||!reading.available||reading.origin==='demo'||reading.view!==metricView(code))return null
  const suffix=spec.unit==='percent'?'%':spec.unit==='degrees'?'°':'',numeric='(-?\\d+(?:\\.\\d+)?)'
  const pattern=spec.parts.length===1?`^${numeric}${suffix}$`:`^${spec.parts[0]} ${numeric}${suffix} · ${spec.parts[1]} ${numeric}${suffix}$`
  const match=reading.value.match(new RegExp(pattern));if(!match)return null
  const values=match.slice(1).map(Number);if(values.some(v=>!Number.isFinite(v)||Math.abs(v)>1e6))return null
  const errors=reading.errors??[],indexed=errors.some(e=>e.componentIndex!==undefined)
  const uncertainty=values.map((v,i)=>{const selected=values.length===1?errors:indexed?errors.filter(e=>e.componentIndex===undefined||e.componentIndex===i):errors[i]?[errors[i]]:[];const value=twoLevelRssUncertainty(v,selected,spec.unit);return value===null||!Number.isFinite(value)?null:Number(value.toFixed(spec.unit==='ratio'?3:2))})
  return {code,values,uncertainty,origin:reading.origin}
}
