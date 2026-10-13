import {cloudId,type CloudSnapshot,type CloudObject} from './cloudContract.ts'
import {validDate} from './dates.ts'
import {summarizeMetricValue} from '../lib/metricUncertainty.ts'
import {eventDetails,eventSourceText,eventAuthorText,eventQuestionText} from './eventDetails.ts'

export const SHARE_PROTOCOL='HEADUP-SHARE-1'
export type ShareFields={photos:boolean;readings:boolean;notes:boolean;sources:boolean;nickname:boolean}
export type ShareScope={from:string;to:string;sessionIds:string[];eventIds:string[];fields:ShareFields;photoMode:'original'|'analysis'|'both'}
export type SharedPhoto={ref:string;view:string;label:string}
export type SharedReading={label:string;value:string;view:string;experimental:boolean}
export type SharedSession={ref:string;date:string;kind:'measurement'|'memory';photos:SharedPhoto[];readings:SharedReading[];note?:string;issues?:string[];versions?:{algorithm:string;norm:string}}
export type SharedEvent={ref:string;date:string;type:string;text?:string;source?:string;author?:string;status?:string;discussedOn?:string;discussionNote?:string}
export type ShareContent={schema:'HEADUP-SHARED-CONTENT-1';nickname?:string;range:{from:string;to:string};sessions:SharedSession[];events:SharedEvent[];boundary:string}
export type ShareAsset={ref:string;key:string;sha256:string}
const bad=():never=>{throw new Error('请检查分享范围、内容选项和记录选择')}
export function validateShareScope(raw:unknown):ShareScope {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))bad();const s=raw as Record<string,any>
  if(Object.keys(s).some(k=>!['from','to','sessionIds','eventIds','fields','photoMode'].includes(k)))bad()
  if(typeof s.from!=='string'||typeof s.to!=='string'||s.from&&!validDate(s.from)||s.to&&!validDate(s.to)||s.from&&s.to&&s.from>s.to)bad()
  for(const key of ['sessionIds','eventIds'])if(!Array.isArray(s[key])||s[key].length>100||new Set(s[key]).size!==s[key].length||s[key].some((id:unknown)=>!cloudId(id)))bad()
  if(!s.sessionIds.length&&!s.eventIds.length||!['original','analysis','both'].includes(s.photoMode))bad()
  if(!s.fields||typeof s.fields!=='object'||Array.isArray(s.fields)||Object.keys(s.fields).sort().join(',')!=='nickname,notes,photos,readings,sources'||Object.values(s.fields).some(v=>typeof v!=='boolean')||!['photos','readings','notes','sources'].some(k=>s.fields[k]))bad()
  if(s.sessionIds.length&&!['photos','readings','notes'].some(k=>s.fields[k])||s.eventIds.length&&!['notes','sources'].some(k=>s.fields[k]))bad()
  return {from:s.from,to:s.to,sessionIds:[...s.sessionIds].sort(),eventIds:[...s.eventIds].sort(),fields:{photos:s.fields.photos,readings:s.fields.readings,notes:s.fields.notes,sources:s.fields.sources,nickname:s.fields.nickname},photoMode:s.photoMode}
}
/** Build a whitelist-only frozen view. It contains no profile/user ids, landmarks, plans, or account metadata. */
export function buildShareContent(snapshot:CloudSnapshot,raw:unknown):{scope:ShareScope;content:ShareContent;assets:ShareAsset[]} {
  const scope=validateShareScope(raw),within=(date:string)=>(!scope.from||date>=scope.from)&&(!scope.to||date<=scope.to)
  const latest=new Map<string,CloudObject>();for(const s of snapshot.sessions){const root=s.revision?.rootId??s.id,old=latest.get(root);if(!old||(s.revision?.number??0)>(old.revision?.number??0))latest.set(root,s)}
  const selected=scope.sessionIds.map(id=>[...latest.values()].find(s=>s.id===id&&within(s.recordedOn)));if(selected.some(s=>!s))bad()
  const events=scope.eventIds.map(id=>snapshot.events.find(e=>e.id===id&&within(e.date)));if(events.some(e=>!e))bad()
  const assets:ShareAsset[]=[],media=new Map(snapshot.media.map(m=>[m.id,m]))
  const sessions:SharedSession[]=selected.filter((s):s is CloudObject=>Boolean(s)).sort((a,b)=>a.recordedOn.localeCompare(b.recordedOn)||a.id.localeCompare(b.id)).map((s,index)=>{
    const ref='R'+(index+1),photos:SharedPhoto[]=[],readings:SharedReading[]=[]
    if(scope.fields.photos)for(const c of s.captures){const m=media.get(c.mediaId)??bad();const caption=c.id==='front'?'正面':c.id==='top'?'头顶':c.poseValidation?.estimatedPose==='left_profile'?'左侧面':c.poseValidation?.estimatedPose==='right_profile'?'右侧面':'侧面方向未确认'
      for(const kind of scope.photoMode==='both'&&m.original?['original','analysis']:scope.photoMode==='analysis'?['analysis']:[m.original?'original':'analysis']){
        const item=kind==='original'?m.original!:m.processed,photoRef=ref+'-'+c.id+'-'+kind;assets.push({ref:photoRef,key:item.key,sha256:item.sha256});photos.push({ref:photoRef,view:c.id,label:caption+' · '+(kind==='original'?'扶正前原图':m.original?'分析用图':'保存照片')})
      }
    }
    if(scope.fields.readings&&s.kind==='measurement'&&!s.report.isExample)for(const r of [...s.report.front,...s.report.profile,...s.report.extended])if(r.available&&r.origin!=='demo')readings.push({label:r.label,value:summarizeMetricValue(r.value,r.errors??[]).display,view:r.view,experimental:r.origin==='experimental'})
    return {ref,date:s.recordedOn,kind:s.kind,photos,readings,...(scope.fields.notes&&s.note?{note:s.note}:{}),...(scope.fields.readings?{issues:[...s.report.issues],versions:{algorithm:s.version.algorithm,norm:s.version.norm}}:{})}
  })
  const sharedEvents:SharedEvent[]=scope.fields.notes||scope.fields.sources?events.filter((e):e is CloudObject=>Boolean(e)).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id)).map((e,i)=>{
    const described={type:e.type,...eventDetails(e)}
    return {ref:'E'+(i+1),date:e.date,type:e.type,...(scope.fields.notes?{text:e.text,...(e.type==='question'?{status:eventQuestionText(described)}:{}),...(e.discussedOn?{discussedOn:e.discussedOn,discussionNote:e.discussionNote??''}:{})}:{}),...(scope.fields.sources?{source:eventSourceText(described),author:eventAuthorText(described)}:{})}
  }):[]
  if(!sessions.length&&!sharedEvents.length)bad()
  return {scope,assets,content:{schema:'HEADUP-SHARED-CONTENT-1',...(scope.fields.nickname?{nickname:snapshot.profile.nickname}:{}),range:{from:scope.from,to:scope.to},sessions,events:sharedEvents,boundary:'这是创建分享时选定的记录快照，不自动包含之后的修改。照片读数和差异不能判断健康发育、改善或退步；已下载或截图的副本不能远程收回。'}}
}
