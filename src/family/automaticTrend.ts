import {trendPhotoRecords} from './trendAlignment'
import {sortedSessions,compareSessions,photoFingerprint,type FamilySession} from './model'
import {sideSession} from './captureViews'
import {extractAiMetric,AI_METRICS} from './aiReadings'
import {sameReadingProvenance} from './readingProvenance'
import {COMPARISON_REASONS} from './comparisonReasons'
import {isPhotoQualityAcceptable} from '../lib/photoQualityAcceptance'
export type TrendView='front'|'left_profile'|'right_profile'
export type TrendPoint={sessionId:string;date:string;values:number[];uncertainty:Array<number|null>;value:string}
export type TrendSeries={code:string;label:string;unit:'ratio'|'percent'|'degrees';parts:string[];points:TrendPoint[];comparable:boolean;reasons:string[];differences:number[]|null;excluded:number}
export type TrendViewReport={view:TrendView;label:string;records:FamilySession[];series:TrendSeries[];missingDates:number}
export function photoRecordRows(sessions:FamilySession[],profileId:string){return sortedSessions(sessions,profileId).filter(s=>s.captures.some(c=>c.mediaId))}
export function automaticTrendReady(sessions:FamilySession[],profileId:string){return photoRecordRows(sessions,profileId).length>=3}
export function trendSaveDestination(sessions:FamilySession[],saved:FamilySession){return automaticTrendReady([...sessions.filter(s=>s.id!==saved.id),saved],saved.profileId)?'summary':'session/'+encodeURIComponent(saved.id)}
const viewNames:Record<TrendView,string>={front:'正面',left_profile:'左侧',right_profile:'右侧'}
const keyCodes=['FRONT-RATIO-07','FRONT-RATIO-01','FRONT-RATIO-04','FRONT-RATIO-05','FRONT-RATIO-06','PROFILE-RATIO-07','PROFILE-LINE-02','PROFILE-RATIO-05']
export function buildAutomaticTrend(sessions:FamilySession[],profileId:string){
 const rows=photoRecordRows(sessions,profileId),ready=rows.length>=3,dateCount=new Set(rows.map(s=>s.recordedOn)).size
 const views=(['front','left_profile','right_profile'] as const).map((view):TrendViewReport=>{
  const modelView=view==='front'?'front':'profile',projected=rows.map(s=>view==='front'?s:sideSession(s,view)),photos=projected.filter(s=>s.captures.some(c=>c.id===modelView&&c.mediaId))
  const candidates=photos.filter(s=>{const c=s.captures.find(c=>c.id===modelView)!;return s.kind==='measurement'&&!s.report.isExample&&!c.analysisError&&!c.inputError&&!c.acceptedWithBias&&c.poseValidation?.status==='pass'&&c.poseValidation.estimatedPose===(view==='front'?'front':view)&&c.quality&&isPhotoQualityAcceptable(c.quality)})
  const codes=[...new Set(candidates.flatMap(s=>s.report[modelView].filter(r=>r.available&&r.evidence&&extractAiMetric(r)).map(r=>r.code!)))].sort((a,b)=>{const ai=keyCodes.indexOf(a),bi=keyCodes.indexOf(b);return(ai<0?99:ai)-(bi<0?99:bi)||a.localeCompare(b)})
  const series=ready?codes.map(code=>{
   const entries=candidates.flatMap(s=>{const r=s.report[modelView].find(r=>r.code===code&&r.available&&r.evidence),metric=r&&extractAiMetric(r);return r&&metric?[{s,r,metric}]:[]})
   const anchor=entries[0],dates=new Set<string>(),hashes=new Set<string>(),chosen:typeof entries=[],excludedReasons=new Set<string>()
   for(const entry of entries){
    if(dates.has(entry.s.recordedOn))continue
    const hash=photoFingerprint(entry.s,modelView)
    if(hash&&hashes.has(hash)){excludedReasons.add('重复照片已排除');continue}
    if(entry!==anchor){const c=compareSessions(anchor.s,entry.s,modelView);if(c.status==='incompatible'||c.reasons.includes(COMPARISON_REASONS.version)||c.reasons.includes(COMPARISON_REASONS.reading_source)||!sameReadingProvenance(anchor.r,entry.r)){excludedReasons.add('部分记录的视角、照片或计算来源不兼容');continue}}
    chosen.push(entry);dates.add(entry.s.recordedOn);if(hash)hashes.add(hash)
   }
   // Prefer a compatible group anchored to the newest reading. Bound pairwise
   // checks to eleven recent dates plus the earliest compatible baseline.
   const close:typeof chosen=[];let oldestClose:typeof anchor|undefined
   for(const entry of chosen){if(entry!==anchor&&compareSessions(anchor.s,entry.s,modelView).status!=='conditions_close')continue;if(close.every(previous=>previous===entry||compareSessions(previous.s,entry.s,modelView).status==='conditions_close')){if(close.length<11)close.push(entry);else oldestClose=entry}}
   const comparableGroup=oldestClose?[...close,oldestClose]:close
   const pool=comparableGroup.length>=3?comparableGroup:chosen
   if(comparableGroup.length>=3&&chosen.some(e=>!pool.includes(e)&&compareSessions(anchor.s,e.s,modelView).status!=='conditions_close'))excludedReasons.add('拍摄条件不同的记录未纳入本项曲线')
   const selected=(pool.length>12?[...pool.slice(0,11),pool[pool.length-1]]:pool).reverse(),reasons=new Set<string>(excludedReasons)
   let comparable=selected.length>=3
   if(selected.length<3)reasons.add('同一测量来源尚不足3个不同日期')
   if(selected.some(e=>!photoFingerprint(e.s,modelView))){comparable=false;reasons.add('部分记录缺少照片指纹，暂不计算变化')}
   for(let i=0;i<selected.length;i++)for(let j=0;j<i;j++){
    const c=compareSessions(selected[j].s,selected[i].s,modelView)
    if(c.status!=='conditions_close'){comparable=false;c.reasons.forEach(reason=>reasons.add(reason))}
   }
   const points=selected.map(e=>({sessionId:e.s.id,date:e.s.recordedOn,values:e.metric.values,uncertainty:e.metric.uncertainty,value:e.r.value})),unit=AI_METRICS[code].unit,precision=unit==='ratio'?3:2
   const differences=comparable?points.at(-1)!.values.map((v,i)=>Number((v-points[0].values[i]).toFixed(precision))):null
   return {code,label:anchor.r.label,unit,parts:AI_METRICS[code].parts,points,comparable,reasons:[...reasons],differences,excluded:entries.length-selected.length}
  }):[]
  return {view,label:viewNames[view],records:trendPhotoRecords(photos),series,missingDates:Math.max(0,3-new Set(candidates.map(s=>s.recordedOn)).size)}
 })
 const comparable=views.reduce((n,v)=>n+v.series.filter(s=>s.comparable).length,0)
 return {profileId,ready,recordCount:rows.length,dateCount,remaining:Math.max(0,3-rows.length),from:rows.at(-1)?.recordedOn,to:rows[0]?.recordedOn,views,comparable,rows,stamp:rows.map(s=>[s.id,s.updatedAt,s.recordedOn,s.kind,s.version.algorithm,s.version.norm].join(':')).join('|')}
}
export function trendChangeText(series:TrendSeries){
 if(!series.differences)return '拍摄条件或数据不足，暂不计算变化'
 const suffix=series.unit==='percent'?'个百分点':series.unit==='degrees'?'°':'',precision=series.unit==='ratio'?3:2
 return series.differences.map((n,i)=>(series.parts.length>1?series.parts[i]+'：':'')+(n===0?'与首次读数相同':`${n>0?'增加':'减少'} ${Math.abs(n).toFixed(precision)}${suffix}`)).join('；')
}
