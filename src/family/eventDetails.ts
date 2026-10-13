import {validDate} from './dates.ts'
export type EventDetails={detailsVersion?:'HEADUP-EVENT-1'|'HEADUP-EVENT-2';height?:{centimeters:number;source:string};updatedAt?:string;recordedBy?:'user'|'child'|'parent'|'together';provenance?:{kind:'document'|'conversation'|'unknown';name?:string;date?:string;reference?:string};questionStatus?:'open'|'discussed';discussedOn?:string;discussionNote?:string}
type Details=EventDetails
type DescribedEvent={type:string}&EventDetails
const invalid=():never=>{throw new Error('事件来源或讨论状态格式不正确')}
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max?value:invalid()
/** Preserve absent legacy fields exactly; never invent a source or discussion date. */
export function eventDetails(value:Record<string,unknown>):Details {
  const out:Details={}
  if(value.detailsVersion!==undefined){if(value.detailsVersion!=='HEADUP-EVENT-1'&&value.detailsVersion!=='HEADUP-EVENT-2')invalid();out.detailsVersion=value.detailsVersion as Details['detailsVersion']}
  if(value.height!==undefined){
    if(value.detailsVersion!=='HEADUP-EVENT-2'||value.type!=='memory'||!value.height||typeof value.height!=='object'||Array.isArray(value.height))invalid()
    const h=value.height as Record<string,unknown>
    if(Object.keys(h).some(k=>!['centimeters','source'].includes(k))||typeof h.centimeters!=='number'||!Number.isFinite(h.centimeters)||h.centimeters<30||h.centimeters>250)invalid()
    const source=text(h.source,120);if(!source.trim())invalid()
    out.height={centimeters:h.centimeters as number,source}
  }
  if(value.detailsVersion==='HEADUP-EVENT-2'&&!out.height)invalid()
  if(['updatedAt','recordedBy','provenance','questionStatus','discussedOn','discussionNote'].some(k=>value[k]!==undefined)&&!out.detailsVersion)invalid()
  if(value.updatedAt!==undefined){const v=text(value.updatedAt,40);if(!Number.isFinite(Date.parse(v)))invalid();out.updatedAt=v}
  if(value.recordedBy!==undefined){if(!['user','child','parent','together'].includes(value.recordedBy as string))invalid();out.recordedBy=value.recordedBy as Details['recordedBy']}
  if(value.provenance!==undefined){
    if(value.type!=='followup'||!value.provenance||typeof value.provenance!=='object'||Array.isArray(value.provenance))invalid()
    const p=value.provenance as Record<string,unknown>;if(Object.keys(p).some(k=>!['kind','name','date','reference'].includes(k))||!['document','conversation','unknown'].includes(p.kind as string))invalid()
    if(p.kind==='unknown'){if(p.name!==undefined||p.date!==undefined||p.reference!==undefined)invalid();out.provenance={kind:'unknown'}}
    else {const name=text(p.name,160),date=text(p.date,10);if(!name.trim()||!validDate(date))invalid();out.provenance={kind:p.kind as 'document'|'conversation',name,date};if(p.reference!==undefined)out.provenance.reference=text(p.reference,300)}
  }
  if(value.questionStatus!==undefined){if(value.type!=='question'||!['open','discussed'].includes(value.questionStatus as string))invalid();out.questionStatus=value.questionStatus as Details['questionStatus']}
  if(value.discussedOn!==undefined){if(value.type!=='question'||!out.questionStatus)invalid();const d=text(value.discussedOn,10);if(!validDate(d)||typeof value.date!=='string'||d<value.date)invalid();out.discussedOn=d}
  if(value.discussionNote!==undefined){if(!out.discussedOn)invalid();out.discussionNote=text(value.discussionNote,1000)}
  if(out.questionStatus==='discussed'&&!out.discussedOn)invalid()
  return out
}
export function eventSourceText(event:DescribedEvent){
  if(event.height)return `手动身高记录 · ${event.height.source}`
  if(event.type!=='followup')return '用户记录'
  const p=event.provenance
  if(!p||p.kind==='unknown')return '用户录入的随访资料 · 来源未补充'
  return `用户录入的${p.kind==='document'?'专业资料':'专业沟通记录'} · ${p.name} · 资料日期 ${p.date}${p.reference?' · '+p.reference:''}`
}
export function eventQuestionText(event:DescribedEvent){if(event.type!=='question')return '';return event.questionStatus==='discussed'?'已讨论':'待讨论'}
export function eventAuthorText(_event:DescribedEvent){return '用户记录'}
