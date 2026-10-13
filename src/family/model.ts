import type {ProfileConsent} from './profileConsent'
import type {EventDetails} from './eventDetails'
import {addDays,localDate,validDate} from './dates'
export {addDays,localDate,validDate} from './dates'
import {COMPARISON_REASONS} from './comparisonReasons'
import {isParticipation,type Participation} from './participation'
import {validCompletion,type PlanCompletion} from './planCompletion'
import type { Capture } from '../types'
import { buildConsumerReport } from '../lib/consumerReport'
import { reportVersion } from '../data/report'
import {sessionReadingProvenanceMatches} from './readingProvenance'

export type ProfileSide = 'left_profile' | 'right_profile'
export type FamilyProfile = {
  id:string; nickname:string; birthYear?:number; purpose:string; preferredSide:ProfileSide|null;participation?:Participation;
  createdAt:string; updatedAt:string;
  consent:ProfileConsent
}
export type CaptureProtocol = {
  device:string; camera:'rear'|'front'|'unknown'; distanceCm:number|null; light:'daylight'|'indoor'|'unknown';
  locationNote:string; method:'uploaded'|'live'; version:'FAMILY-PHOTO-1'
}
export type StoredCapture = Omit<Capture,'url'|'originalUrl'> & {mediaId?:string}
export type FamilySession = {
  id:string; profileId:string; recordedOn:string; createdAt:string; updatedAt:string;
  kind:'measurement'|'memory'; purpose?:string; recordedBy:'user'|'together'|'parent'|'child'; note:string;
  protocol:CaptureProtocol; captures:StoredCapture[];
  rightProfileReport?:ReturnType<typeof buildConsumerReport>;
  report:ReturnType<typeof buildConsumerReport>; version:typeof reportVersion;
  contentKey?:string;
  dateSource?:'user_confirmed'|'live_capture'|'photo_metadata';
  metadataHistory?:Array<{at:string;recordedOn:string;note:string}>;
  revision?:{rootId:string;parentId:string;number:number;operation:'reanalyze'|'supplement';views:Array<'front'|'profile'|'right_profile'>};
}
export type FamilyMedia = {id:string;sessionId:string;profileId:string;blob:Blob;originalBlob?:Blob}
export type RecordPlan = {
  profileId:string;enabled:boolean;intervalDays:number;nextDate:string;windowDays:number;
  time:string;quietStart:string;quietEnd:string;owner:'user'|'together'|'parent'|'child';lastNotifiedDate?:string;
  notificationEnabled?:boolean;followupEnabled?:boolean;lastNotifiedWindow?:string;lastFollowupWindow?:string;notificationError?:string;lastCompleted?:PlanCompletion
}
export type FamilyEvent = {id:string;profileId:string;date:string;type:'memory'|'device'|'question'|'followup';text:string;createdAt:string}&EventDetails
export type FamilySnapshot = {profiles:FamilyProfile[];sessions:FamilySession[];plans:RecordPlan[];events:FamilyEvent[]}
export const emptySnapshot=():FamilySnapshot=>({profiles:[],sessions:[],plans:[],events:[]})
export const defaultProtocol=():CaptureProtocol=>({device:'',camera:'unknown',distanceCm:null,light:'unknown',locationNote:'',method:'uploaded',version:'FAMILY-PHOTO-1'})
export function sideLabel(side:ProfileSide|null|undefined){return side==='left_profile'?'左侧面':side==='right_profile'?'右侧面':'任意一侧'}
export function profileSide(session:FamilySession):ProfileSide|null {
  const pose=session.captures.find(c=>c.id==='profile')?.poseValidation
  return pose?.estimatedPose==='left_profile'||pose?.estimatedPose==='right_profile'?pose.estimatedPose:null
}
export function createProfile(input:{nickname:string;birthYear?:number;purpose?:string;preferredSide?:ProfileSide|null;participation?:Participation;guardianConfirmed:boolean;childInformed:boolean;storage:boolean},now=new Date()):FamilyProfile {
  const nickname=input.nickname.trim()
  if(!nickname||nickname.length>40)throw new Error('请填写1–40字的昵称')
  if(input.birthYear!==undefined&&(!Number.isInteger(input.birthYear)||input.birthYear<1900||input.birthYear>now.getFullYear()))throw new Error('出生年份不正确')
  if(!input.guardianConfirmed||!input.childInformed||!input.storage)throw new Error('请先确认共同记录说明与本机保存方式')
  if(input.participation!==undefined&&!isParticipation(input.participation))throw new Error('请选择有效的共同记录方式')
  return {id:crypto.randomUUID(),nickname,birthYear:input.birthYear,purpose:(input.purpose??'一起留下成长记录').trim().slice(0,200),preferredSide:input.preferredSide??null,...(input.participation?{participation:input.participation}:{}),createdAt:now.toISOString(),updatedAt:now.toISOString(),consent:{version:'LOCAL-FAMILY-1',guardianConfirmed:true,childInformed:true,storage:true,at:now.toISOString()}}
}
export function createPersonalProfile(input:{nickname:string;birthYear?:number},now=new Date()):FamilyProfile{
  const nickname=input.nickname.trim();if(!nickname||nickname.length>40)throw new Error('请填写1–40字的名称')
  if(input.birthYear!==undefined&&(!Number.isInteger(input.birthYear)||input.birthYear<1900||input.birthYear>now.getFullYear()))throw new Error('请选择有效出生年份')
  return {id:crypto.randomUUID(),nickname,birthYear:input.birthYear,purpose:'记录照片与变化',preferredSide:null,createdAt:now.toISOString(),updatedAt:now.toISOString(),consent:{version:'LOCAL-USER-1',storage:true,at:now.toISOString()}}
}
export function defaultPlan(profileId:string,today=localDate()):RecordPlan {
  return {profileId,enabled:false,intervalDays:30,nextDate:addDays(today,30),windowDays:1,time:'18:00',quietStart:'21:00',quietEnd:'08:00',owner:'user'}
}
export function validatePlan(plan:RecordPlan) {
  if(plan.lastCompleted!==undefined&&!validCompletion(plan.lastCompleted))throw new Error('计划完成记录无效')
  if(!validDate(plan.nextDate)||!Number.isInteger(plan.intervalDays)||plan.intervalDays<1||plan.intervalDays>365||!Number.isInteger(plan.windowDays)||plan.windowDays<1||plan.windowDays>28)throw new Error('请检查记录日期和周期')
  if([plan.time,plan.quietStart,plan.quietEnd].some(t=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))throw new Error('提醒时间不正确')
}
export const recordRootId=(s:FamilySession)=>s.revision?.rootId??s.id
export function photoFingerprint(session:FamilySession,view:Capture['id']){const value=session.contentKey?.split('|').find(item=>item.startsWith(view+':'))?.slice(view.length+1);return value&&/^[a-f0-9]{64}$/.test(value)?value:undefined}
export function findReusedPhotos(session:FamilySession,records:FamilySession[]){
  const history=sortedSessions(records,session.profileId).filter(s=>s.recordedOn!==session.recordedOn)
  return session.captures.flatMap(c=>{const hash=photoFingerprint(session,c.id);if(!hash)return [];const previous=history.find(s=>s.captures.some(old=>photoFingerprint(s,old.id)===hash));return previous?[{view:c.id,date:previous.recordedOn,sessionId:previous.id}]:[]})
}
export function sessionVersions(sessions:FamilySession[],session:FamilySession){return sessions.filter(s=>s.profileId===session.profileId&&recordRootId(s)===recordRootId(session)).sort((a,b)=>(a.revision?.number??0)-(b.revision?.number??0))}
export function sortedSessions(sessions:FamilySession[],profileId:string) {
  const latest=new Map<string,FamilySession>()
  for(const s of sessions.filter(s=>s.profileId===profileId)){const root=recordRootId(s),old=latest.get(root);if(!old||(s.revision?.number??0)>(old.revision?.number??0))latest.set(root,s)}
  return [...latest.values()].sort((a,b)=>b.recordedOn.localeCompare(a.recordedOn)||b.createdAt.localeCompare(a.createdAt))
}
export function sessionPurpose(session:Pick<FamilySession,'kind'|'purpose'>){return session.purpose==='骨骼发育'?'面部生长记录':session.purpose??(session.kind==='measurement'?'面部生长记录':'生活留念')}
export type SessionDraft = {purpose?:string;dateSource?:FamilySession['dateSource'];profileId:string;recordedOn:string;kind:FamilySession['kind'];recordedBy:FamilySession['recordedBy'];note:string;protocol:CaptureProtocol}
export function createSession(draft:SessionDraft,captures:Capture[],now=new Date()):FamilySession {
  if(!validDate(draft.recordedOn)||draft.recordedOn>localDate(now))throw new Error('请选择今天或过去的拍摄日期')
  if(!captures.some(c=>c.url))throw new Error('至少添加一张可读取的照片后再保存')
  if(draft.protocol.distanceCm!==null&&(!Number.isFinite(draft.protocol.distanceCm)||draft.protocol.distanceCm<10||draft.protocol.distanceCm>1000))throw new Error('距离请填写10–1000厘米，或留空表示未记录')
  if(draft.purpose!==undefined&&(typeof draft.purpose!=='string'||!draft.purpose.trim()||draft.purpose.length>100))throw new Error('用途请填写1–100字')
  const {note,protocol,...rest}=draft
  return {...rest,id:crypto.randomUUID(),dateSource:draft.dateSource??(protocol.method==='live'?'live_capture':'user_confirmed'),...(draft.purpose?{purpose:draft.purpose.trim()}:{}),createdAt:now.toISOString(),updatedAt:now.toISOString(),note:note.trim().slice(0,1000),protocol:{...protocol,device:protocol.device.trim().slice(0,100),locationNote:protocol.locationNote.trim().slice(0,200)},captures:captures.filter(c=>c.url).map(({url,originalUrl,...c})=>c),report:buildConsumerReport(captures),...(captures.some(c=>c.id==='right_profile'&&c.url)?{rightProfileReport:buildConsumerReport(captures.filter(c=>c.id==='front'||c.id==='right_profile').map(c=>c.id==='right_profile'?{...c,id:'profile' as const}:c))}:{}),version:{...reportVersion}}
}

export type PairComparison={status:'incompatible'|'visual_only'|'conditions_close';reasons:string[];view:'front'|'profile';leftCapture?:StoredCapture;rightCapture?:StoredCapture}
export function compareSessions(a:FamilySession,b:FamilySession,view:'front'|'profile'):PairComparison {
  const leftCapture=a.captures.find(c=>c.id===view),rightCapture=b.captures.find(c=>c.id===view),reasons:string[]=[]
  if(a.profileId!==b.profileId)reasons.push(COMPARISON_REASONS.other_profile)
  if(a.id===b.id)reasons.push(COMPARISON_REASONS.same_record)
  else if(recordRootId(a)===recordRootId(b))reasons.push(COMPARISON_REASONS.revision)
  if(a.recordedOn!==b.recordedOn&&photoFingerprint(a,view)&&photoFingerprint(a,view)===photoFingerprint(b,view))reasons.push(COMPARISON_REASONS.reused_photo)
  if(!leftCapture||!rightCapture)reasons.push(COMPARISON_REASONS.missing_view)
  if(view==='profile'&&(!profileSide(a)||!profileSide(b)||profileSide(a)!==profileSide(b)))reasons.push(COMPARISON_REASONS.side)
  if(reasons.length)return {status:'incompatible',reasons,view,leftCapture,rightCapture}
  if(a.kind==='memory'||b.kind==='memory')reasons.push(COMPARISON_REASONS.memory)
  if(a.recordedOn===b.recordedOn)reasons.push(COMPARISON_REASONS.same_date)
  if(!a.dateSource||!b.dateSource)reasons.push(COMPARISON_REASONS.date_source)
  if(a.version.algorithm!==b.version.algorithm||a.version.norm!==b.version.norm||a.protocol.version!==b.protocol.version)reasons.push(COMPARISON_REASONS.version)
  if(!sessionReadingProvenanceMatches(a,b,view))reasons.push(COMPARISON_REASONS.reading_source)
  if(!a.protocol.device||!b.protocol.device)reasons.push(COMPARISON_REASONS.device_missing)
  else if(a.protocol.device!==b.protocol.device)reasons.push(COMPARISON_REASONS.device)
  if(a.protocol.camera==='unknown'||b.protocol.camera==='unknown')reasons.push(COMPARISON_REASONS.camera_missing)
  else if(a.protocol.camera!==b.protocol.camera)reasons.push(COMPARISON_REASONS.camera)
  if(a.protocol.distanceCm===null||b.protocol.distanceCm===null)reasons.push(COMPARISON_REASONS.distance_missing)
  else if(Math.abs(a.protocol.distanceCm-b.protocol.distanceCm)>Math.min(a.protocol.distanceCm,b.protocol.distanceCm)*.1)reasons.push(COMPARISON_REASONS.distance)
  if(a.protocol.light==='unknown'||b.protocol.light==='unknown')reasons.push(COMPARISON_REASONS.light_missing)
  else if(a.protocol.light!==b.protocol.light)reasons.push(COMPARISON_REASONS.light)
  if([leftCapture,rightCapture].some(c=>c?.poseValidation?.status!=='pass'||!c.quality||c.quality.flags.length))reasons.push(COMPARISON_REASONS.quality)
  return {status:reasons.length?'visual_only':'conditions_close',reasons:reasons.length?reasons:[COMPARISON_REASONS.uncalibrated],view,leftCapture,rightCapture}
}

export function stageSummary(sessions:FamilySession[],profile:FamilyProfile) {
  const rows=sortedSessions(sessions,profile.id),photos=rows.reduce((sum,s)=>sum+s.captures.length,0),observations=rows.filter(s=>s.kind==='measurement'),missing=observations.filter(s=>!(s.recordedBy==='user'?['front','profile','right_profile']:['front','profile']).every(id=>s.captures.some(c=>c.id===id))).length
  return {recorded:rows.length?`已留下${rows.length}次记录、${photos}张视角照片，其中${observations.length}次为照片观察。`:'还没有保存记录，可以从一次正面和同侧面照片开始。',observed:rows.length?`最近一次记录日期为${rows[0].recordedOn}。${missing?`${missing}次照片观察尚未补齐所需视角。`:observations.length?'照片观察均包含正面和侧面。':'目前都是生活留念，不作测量趋势。'}`:'记录无需每天完成。',limitations:'这些记录不能单独判断健康发育；目前没有适用的真实跨期误差校准，照片差异可能来自拍摄条件。',actions:[...(missing?['下次补齐缺失视角。']:[]),profile.preferredSide?`下次尽量继续拍${sideLabel(profile.preferredSide)}，保持设备和取景一致。`:'下次先约定拍摄同一侧，保持设备和取景一致。','设置合适的下次记录时间。'].slice(0,3),sourceIds:rows.map(s=>s.id)}
}
