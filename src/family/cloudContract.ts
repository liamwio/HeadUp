import {validProfileConsent} from './profileConsent.ts'
import {isCaptureSelection} from '../lib/captureSelection.ts'
import {eventDetails} from './eventDetails.ts'
/** Wire contract: raw photos travel through authenticated binary uploads, never JSON URLs. */
import {parseReportRecord} from '../lib/reportRecordValidation.ts'
import {isParticipation} from './participation.ts'
import {validCompletion} from './planCompletion.ts'
export const CLOUD_CONSENT_VERSION='HEADUP-CLOUD-1'
export type CloudRole='owner'|'guardian'|'child'
export type CloudObject=Record<string,any>
export type CloudPhoto={key:string;sha256:string;type:string;size:number}
export type CloudMedia={id:string;sessionId:string;profileId:string;processed:CloudPhoto;original?:CloudPhoto}
export type CloudSnapshot={schema:'HEADUP-SYNC-1';profile:CloudObject;sessions:CloudObject[];plans:CloudObject[];events:CloudObject[];media:CloudMedia[]}
export const canonicalJson=(value:any):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)
export const cloudId=(v:unknown)=>typeof v==='string'&&!['__proto__','constructor','prototype'].includes(v)&&/^[a-zA-Z0-9._-]{1,100}$/.test(v)
export const cloudMediaKey=(v:unknown)=>{if(typeof v!=='string')return false;const match=v.match(/^([a-zA-Z0-9._-]{1,100})\/(front|profile|right_profile|top)(~original)?$/);return Boolean(match&&cloudId(match[1]))}
const bad=():never=>{throw new Error('同步数据格式不正确')}
const object=(v:any):CloudObject=>v&&typeof v==='object'&&!Array.isArray(v)?v:bad()
const list=(v:any,max=5000):any[]=>Array.isArray(v)&&v.length<=max?v:bad()
const text=(v:any,max:number)=>typeof v==='string'&&v.length<=max?v:bad()
const date=(v:any)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v
const stamp=(v:any)=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))
export function validateCloudSnapshot(raw:unknown,profileId:string):CloudSnapshot{
  let nodes=0;const walk=(v:any,depth=0)=>{if(++nodes>2_000_000||depth>24)bad();if(typeof v==='number'&&!Number.isFinite(v))bad();if(typeof v==='string'&&v.length>10000)bad();if(v&&typeof v==='object')for(const[k,item]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))bad();walk(item,depth+1)}};walk(raw)
  const value=object(raw);if(value.schema!=='HEADUP-SYNC-1'||Object.keys(value).some(k=>!['schema','profile','sessions','plans','events','media'].includes(k)))bad()
  const p=object(value.profile),consent=object(p.consent)
  if(p.id!==profileId||!cloudId(p.id)||!text(p.nickname,40).trim()||!stamp(p.createdAt)||!stamp(p.updatedAt)||!['left_profile','right_profile',null].includes(p.preferredSide)||!validProfileConsent(consent)||!stamp(consent.at))bad()
  text(p.purpose,200);if(p.birthYear!==undefined&&(!Number.isInteger(p.birthYear)||p.birthYear<1900||p.birthYear>new Date().getFullYear()))bad()
  if(p.participation!==undefined&&!isParticipation(p.participation))bad()
  const sessions=list(value.sessions),sessionMap=new Map<string,CloudObject>()
  for(const s of sessions){object(s);if(!cloudId(s.id)||s.profileId!==profileId||sessionMap.has(s.id)||!date(s.recordedOn)||!stamp(s.createdAt)||!stamp(s.updatedAt)||!['memory','measurement'].includes(s.kind)||!['user','together','parent','child'].includes(s.recordedBy))bad();sessionMap.set(s.id,s);text(s.note,1000);if(s.purpose!==undefined)text(s.purpose,100);object(s.protocol);object(s.report);object(s.version)
    const captures=list(s.captures,4),views=new Set<string>();for(const c of captures){object(c);if(!['front','profile','right_profile','top'].includes(c.id)||views.has(c.id)||!cloudMediaKey(c.mediaId)||'url'in c||'originalUrl'in c)bad();views.add(c.id);text(c.label,100);text(c.hint,500);text(c.eyebrow,100);if(c.captureSelection!==undefined&&!isCaptureSelection(c.captureSelection))bad()
      if(c.quality){object(c.quality);if(!Number.isFinite(c.quality.score))bad();list(c.quality.flags,50).forEach(v=>text(v,1000))}
      if(c.poseValidation){const pose=object(c.poseValidation);if(!['pass','review','reject'].includes(pose.status)||!['front','left_profile','right_profile','oblique','no_face','multiple_faces'].includes(pose.estimatedPose)||!Number.isInteger(pose.detectedFaces)||pose.detectedFaces<0)bad();list(pose.flags,50).forEach(v=>text(v,1000));if(pose.landmarks)for(const point of list(pose.landmarks,478))if(!Number.isFinite(point.x)||!Number.isFinite(point.y))bad()}
      if(c.straightening){const st=object(c.straightening);if(!['applied','not_applied','not_needed','disabled'].includes(st.status))bad();text(st.reason,1000);list(st.originalFlags,50).forEach(v=>text(v,1000))}
    }
    if(!captures.length)bad();if(!stamp(s.report.createdAt)||s.report.isExample!==false)bad();list(s.report.front,30);list(s.report.profile,30);list(s.report.issues,100);list(s.report.summaries,100);object(s.report.coverage)
    if(!Number.isInteger(s.report.measuredCount)||s.report.measuredCount!==[...s.report.front,...s.report.profile].filter(r=>r.available).length||s.report.frontTendency!=null)bad()
    if(s.protocol.version!=='FAMILY-PHOTO-1'||!['rear','front','unknown'].includes(s.protocol.camera)||!['daylight','indoor','unknown'].includes(s.protocol.light)||!['uploaded','live'].includes(s.protocol.method))bad()
    if(s.protocol.distanceCm!==null&&(!Number.isFinite(s.protocol.distanceCm)||s.protocol.distanceCm<10||s.protocol.distanceCm>1000))bad()
    for(const key of ['algorithm','norm','copy'])text(s.version[key],200)
    const r=s.report;parseReportRecord(JSON.stringify({schema:'headup-report-record-v2',mode:'youth',isExample:false,createdAt:r.createdAt,measurements:[...r.front,...r.profile],extendedMeasurements:r.extended,detection:{front:r.frontDetection,profile:r.profileDetection},issues:r.issues,summaries:r.summaries,version:s.version}))
    for(const name of ['native','proxy'])if(r[name]){const drawing=object(r[name]);if(!Number.isFinite(drawing.width)||!Number.isFinite(drawing.height)||drawing.width<=0||drawing.height<=0)bad();for(const path of list(drawing.paths,100)){if(!['region','contour','evidence'].includes(path.category))bad();text(path.code,100);text(path.label,300);for(const point of list(path.points,4000))if(!Number.isFinite(point.x)||!Number.isFinite(point.y))bad()}}
  }
  const children=new Set<string>()
  for(const s of sessions)if(s.revision){const r=object(s.revision),root=sessionMap.get(r.rootId),parent=sessionMap.get(r.parentId)
    if(!root||root.revision||!parent||(parent.revision?.rootId??parent.id)!==root.id||!Number.isInteger(r.number)||r.number<1||r.number>100||r.number!==(parent.revision?.number??0)+1||s.recordedOn!==parent.recordedOn||children.has(parent.id)||!['reanalyze','supplement'].includes(r.operation))bad();children.add(parent!.id)
    const views=list(r.views,3),old=new Set(parent!.captures.map((c:any)=>c.id)),next=new Set(s.captures.map((c:any)=>c.id));if(!views.length||new Set(views).size!==views.length||views.some(v=>!['front','profile','right_profile'].includes(v))||[...old].some(v=>!next.has(v)))bad()
    if(r.operation==='reanalyze'?(old.size!==next.size||views.some(v=>!old.has(v))):(next.size!==old.size+views.length||views.some(v=>old.has(v)||!next.has(v))))bad()
  }
  const media=list(value.media,15000),mediaMap=new Map<string,CloudMedia>()
  for(const m of media){object(m);const s=sessionMap.get(m.sessionId);if(!s||m.profileId!==profileId||!cloudMediaKey(m.id)||mediaMap.has(m.id)||!s.captures.some((c:any)=>c.mediaId===m.id&&m.id===s.id+'/'+c.id))bad()
    for(const kind of ['processed','original'] as const){const photo=m[kind];if(kind==='original'&&photo===undefined)continue;object(photo);if(photo.key!==m.id+(kind==='original'?'~original':'')||!cloudMediaKey(photo.key)||typeof photo.sha256!=='string'||!/^[a-f0-9]{64}$/.test(photo.sha256)||!['image/png','image/jpeg','image/webp','image/avif'].includes(photo.type)||!Number.isSafeInteger(photo.size)||photo.size<1||photo.size>30*1024*1024)bad()}mediaMap.set(m.id,m)
  }
  for(const s of sessions)for(const c of s.captures)if(mediaMap.get(c.mediaId)?.sessionId!==s.id)bad()
  for(const s of sessions){s.contentKey=s.captures.map((c:any)=>{const m=mediaMap.get(c.mediaId)!;return c.id+':'+(m.original??m.processed).sha256}).sort().join('|');delete s.profileIdAndContent}
  for(const s of sessions)if(s.revision){const parent=sessionMap.get(s.revision.parentId)!;for(const c of parent.captures){const old=mediaMap.get(c.mediaId)!,current=mediaMap.get(s.captures.find((item:any)=>item.id===c.id).mediaId)!;if((old.original??old.processed).sha256!==(current.original??current.processed).sha256)bad()}}
  const events=list(value.events,10000),eventIds=new Set<string>();for(const e of events){object(e);if(!cloudId(e.id)||e.profileId!==profileId||eventIds.has(e.id)||!date(e.date)||!stamp(e.createdAt)||!['memory','device','question','followup'].includes(e.type))bad();text(e.text,1000);try{eventDetails(e)}catch{bad()};eventIds.add(e.id)}
  const plans=list(value.plans,1);for(const plan of plans){object(plan);if(plan.profileId!==profileId||typeof plan.enabled!=='boolean'||!date(plan.nextDate)||!Number.isInteger(plan.intervalDays)||plan.intervalDays<1||plan.intervalDays>365||!Number.isInteger(plan.windowDays)||plan.windowDays<1||plan.windowDays>28||!['user','together','parent','child'].includes(plan.owner)||['time','quietStart','quietEnd'].some(k=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(plan[k])))bad();for(const key of ['notificationEnabled','followupEnabled','lastFollowupWindow','notificationError','lastNotifiedWindow','lastNotifiedDate'])delete plan[key]}
  for(const plan of plans)if(plan.lastCompleted!==undefined&&!validCompletion(plan.lastCompleted))bad()
  return value as CloudSnapshot
}
