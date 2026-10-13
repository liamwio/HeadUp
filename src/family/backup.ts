import {validProfileConsent} from './profileConsent'
import {isCaptureSelection} from '../lib/captureSelection'
import {eventDetails} from './eventDetails'
import { parseReportRecord, reportFromRecord } from '../lib/reportRecord'
import { preflightImageFile } from '../lib/imageInputPreflight'
import {validateRevisionGraph} from './revisions'
import {isParticipation} from './participation'
import { validDate, validatePlan, photoFingerprint, type FamilySnapshot, type FamilyMedia, type FamilyProfile, type FamilySession, type RecordPlan, type FamilyEvent } from './model'

export type Archive=FamilySnapshot&{media:FamilyMedia[]}
const MAX_BYTES=150*1024*1024,MAX_PHOTO_BYTES=100*1024*1024
const fail=()=>new Error('备份格式不正确或内容不完整，当前档案未被修改。')
const record=(x:unknown):Record<string,any>=>{if(!x||typeof x!=='object'||Array.isArray(x))throw fail();return x as Record<string,any>}
function text(x:unknown,max=1000){if(typeof x!=='string'||x.length>max)throw fail();return x}
function id(x:unknown){const s=text(x,160);if(!/^[a-zA-Z0-9._/-]+$/.test(s))throw fail();return s}
function array(x:unknown,max=10000):any[]{if(!Array.isArray(x)||x.length>max)throw fail();return x}
function timestamp(x:unknown){const s=text(x,40);if(!Number.isFinite(Date.parse(s)))throw fail();return s}
function date(x:unknown){const s=text(x,10);if(!validDate(s))throw fail();return s}
function cleanTree(root:unknown){let nodes=0;const walk=(x:unknown,depth:number)=>{if(++nodes>2_000_000||depth>24)throw fail();if(typeof x==='number'&&!Number.isFinite(x))throw fail();if(x&&typeof x==='object'){for(const [k,v] of Object.entries(x)){if(['__proto__','prototype','constructor'].includes(k))throw fail();walk(v,depth+1)}}};walk(root,0)}
function base64(bytes:Uint8Array){let out='';for(let i=0;i<bytes.length;i+=32768)out+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(out)}
function bytes(value:unknown,max=MAX_BYTES){const s=text(value,Math.ceil(max*4/3)+8);try{return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}catch{throw fail()}}
function buffer(value:Uint8Array):ArrayBuffer{return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength) as ArrayBuffer}
async function key(passphrase:string,salt:Uint8Array){if(passphrase.length<8||passphrase.length>128)throw new Error('备份密码需要8–128个字符，请保存在安全的位置。');const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt:buffer(salt),iterations:210000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}

export function archiveSchema(archive:Archive){return archive.profiles.some(p=>p.consent.version==='LOCAL-USER-1')||archive.sessions.some(s=>s.purpose!==undefined||s.dateSource==='photo_metadata'||s.recordedBy==='user'||s.rightProfileReport||s.captures.some(c=>c.id==='right_profile'))||archive.plans.some(p=>p.owner==='user')||archive.events.some(e=>e.recordedBy==='user'||e.detailsVersion==='HEADUP-EVENT-2')?'headup-family-archive-v3':archive.events.some(e=>e.detailsVersion==='HEADUP-EVENT-1')?'headup-family-archive-v2':'headup-family-archive-v1'}
function decodeFrozen(r:Record<string,any>,version:Record<string,any>){
  const parsed=parseReportRecord(JSON.stringify({schema:'headup-report-record-v2',mode:'youth',isExample:false,createdAt:r.createdAt,measurements:[...array(r.front,30),...array(r.profile,30)],extendedMeasurements:r.extended,detection:{front:r.frontDetection,profile:r.profileDetection},issues:r.issues,summaries:r.summaries,version})),frozen=reportFromRecord(parsed)
  for(const name of ['native','proxy'] as const)if(r[name]){const native=record(r[name]);if(!Number.isFinite(native.width)||!Number.isFinite(native.height)||native.width<=0||native.height<=0)throw fail();for(const path of array(native.paths,100)){if(!['region','contour','evidence'].includes(path.category)||typeof path.code!=='string'||typeof path.label!=='string')throw fail();for(const point of array(path.points,4000))if(!Number.isFinite(point.x)||!Number.isFinite(point.y))throw fail()}frozen[name]=native as any}
  return {frozen,version:parsed.version!}
}
export async function encryptArchive(archive:Archive,passphrase:string):Promise<Blob> {
  const total=archive.media.reduce((n,m)=>n+m.blob.size+(m.originalBlob?.size??0),0)
  if(total>MAX_PHOTO_BYTES)throw new Error('本次备份照片超过100MB，请分别备份每个成长档案。')
  const media=[]
  for(const m of archive.media)media.push({id:m.id,sessionId:m.sessionId,profileId:m.profileId,type:m.blob.type,data:base64(new Uint8Array(await m.blob.arrayBuffer())),originalType:m.originalBlob?.type,originalData:m.originalBlob?base64(new Uint8Array(await m.originalBlob.arrayBuffer())):undefined})
  const plain=new TextEncoder().encode(JSON.stringify({...archive,media,schema:archiveSchema(archive)}))
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),secret=await key(passphrase,salt)
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},secret,plain)
  const result=new Blob([JSON.stringify({schema:'headup-family-encrypted-v1',salt:base64(salt),iv:base64(iv),data:base64(new Uint8Array(encrypted))})],{type:'application/json'})
  if(result.size>MAX_BYTES)throw new Error('备份文件过大，请分别备份每个档案。')
  return result
}

export async function decryptArchive(file:Blob,passphrase:string):Promise<Archive> {
  if(file.size>MAX_BYTES)throw new Error('备份文件超过150MB，无法导入。')
  let envelope:Record<string,any>
  try{envelope=record(JSON.parse(await file.text()))}catch{throw fail()}
  if(envelope.schema!=='headup-family-encrypted-v1')throw fail()
  const salt=bytes(envelope.salt,16),iv=bytes(envelope.iv,12),data=bytes(envelope.data)
  if(salt.length!==16||iv.length!==12)throw fail()
  let plain:ArrayBuffer
  try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:buffer(iv)},await key(passphrase,salt),buffer(data))}catch{throw new Error('密码不正确或备份已损坏，当前档案未被修改。')}
  let root:Record<string,any>
  try{root=record(JSON.parse(new TextDecoder().decode(plain)));cleanTree(root)}catch{throw fail()}
  return validateArchivePayload(root)
}

export async function validateArchivePayload(value:unknown, binary?:{photo:(media:Record<string,any>,original:boolean)=>Blob;maxPhotoBytes:number}):Promise<Archive>{
  const root=record(value);cleanTree(root)
  if(!['headup-family-archive-v1','headup-family-archive-v2','headup-family-archive-v3'].includes(root.schema))throw fail()
  const profiles:FamilyProfile[]=array(root.profiles,100).map(v=>{
    const p=record(v),consent=record(p.consent)
    if(!text(p.nickname,40).trim()||!['left_profile','right_profile',null].includes(p.preferredSide)||!validProfileConsent(consent))throw fail()
    if(p.birthYear!==undefined&&(!Number.isInteger(p.birthYear)||p.birthYear<1900||p.birthYear>new Date().getFullYear()))throw fail()
    if(p.participation!==undefined&&!isParticipation(p.participation))throw fail()
    return {id:id(p.id),nickname:text(p.nickname,40),birthYear:p.birthYear,purpose:text(p.purpose,200),preferredSide:p.preferredSide,...(p.participation?{participation:p.participation}:{}),createdAt:timestamp(p.createdAt),updatedAt:timestamp(p.updatedAt),consent:consent.version==='LOCAL-USER-1'?{version:'LOCAL-USER-1',storage:true,at:timestamp(consent.at)}:{version:'LOCAL-FAMILY-1',guardianConfirmed:true,childInformed:true,storage:true,at:timestamp(consent.at)}}
  })
  const profileIds=new Set(profiles.map(p=>p.id));if(profileIds.size!==profiles.length)throw fail()
  const sessions:FamilySession[]=array(root.sessions,5000).map(v=>{
    const s=record(v),p=record(s.protocol),r=record(s.report),version=record(s.version)
    if(!profileIds.has(s.profileId)||!['measurement','memory'].includes(s.kind)||!['user','together','parent','child'].includes(s.recordedBy)||!['rear','front','unknown'].includes(p.camera)||!['daylight','indoor','unknown'].includes(p.light)||!['uploaded','live'].includes(p.method)||p.version!=='FAMILY-PHOTO-1')throw fail()
    if(p.distanceCm!==null&&(!Number.isFinite(p.distanceCm)||p.distanceCm<10||p.distanceCm>1000))throw fail()
    const decoded=decodeFrozen(r,version),frozen=decoded.frozen,rightProfileReport=s.rightProfileReport===undefined?undefined:decodeFrozen(record(s.rightProfileReport),version).frozen
    const captures=array(s.captures,4).map(v=>{
      const c=record(v);if(!['front','profile','right_profile','top'].includes(c.id)||'url' in c||'originalUrl' in c)throw fail()
      text(c.label,100);text(c.hint,500);text(c.eyebrow,100)
      for(const key of ['fileName','inputError','analysisError'])if(c[key]!==undefined)text(c[key],1000)
      if(c.source!==undefined&&!['upload','live'].includes(c.source))throw fail()
      if(c.cameraFacing!==undefined&&!['user','environment','unknown'].includes(c.cameraFacing))throw fail()
      if(c.photoDate!==undefined)date(c.photoDate)
      if(c.photoDateSource!==undefined&&!['live','exif'].includes(c.photoDateSource))throw fail()
      if(c.capturedAt!==undefined)timestamp(c.capturedAt)
      if(c.captureSelection!==undefined&&!isCaptureSelection(c.captureSelection))throw fail()
      for(const key of ['mirrorCorrected','acceptedWithBias'])if(c[key]!==undefined&&typeof c[key]!=='boolean')throw fail()
      if(c.poseValidation){const pose=record(c.poseValidation);if(!['pass','review','reject'].includes(pose.status)||!['front','left_profile','right_profile','oblique','no_face','multiple_faces'].includes(pose.estimatedPose)||!Number.isInteger(pose.detectedFaces)||pose.detectedFaces<0)throw fail();array(pose.flags,50).forEach(x=>text(x));if(pose.landmarks)for(const point of array(pose.landmarks,478))if(!Number.isFinite(point.x)||!Number.isFinite(point.y))throw fail()}
      if(c.quality){const q=record(c.quality);if(!Number.isFinite(q.score))throw fail();array(q.flags,50).forEach(x=>text(x))}
      if(c.straightening){const st=record(c.straightening);if(!['applied','not_applied','not_needed','disabled'].includes(st.status))throw fail();text(st.reason,1000);array(st.originalFlags,50).forEach(x=>text(x))}
      if(c.mediaId)id(c.mediaId)
      return c as FamilySession['captures'][number]
    })
    if(captures.some(c=>c.id==='right_profile')!==Boolean(rightProfileReport))throw fail()
    if(s.dateSource!==undefined&&!['user_confirmed','live_capture','photo_metadata'].includes(s.dateSource))throw fail()
    if(new Set(captures.map(c=>c.id)).size!==captures.length)throw fail()
    let revision:FamilySession['revision']
    if(s.revision!==undefined){const v=record(s.revision);if(!Number.isInteger(v.number)||v.number<1||v.number>100||!['reanalyze','supplement'].includes(v.operation))throw fail();revision={rootId:id(v.rootId),parentId:id(v.parentId),number:v.number,operation:v.operation,views:array(v.views,3).map(view=>{if(!['front','profile','right_profile'].includes(view))throw fail();return view})}}
    return {revision,id:id(s.id),profileId:id(s.profileId),recordedOn:date(s.recordedOn),dateSource:s.dateSource,metadataHistory:s.metadataHistory===undefined?undefined:array(s.metadataHistory,20).map(h=>({at:timestamp(h.at),recordedOn:date(h.recordedOn),note:text(h.note)})),createdAt:timestamp(s.createdAt),updatedAt:timestamp(s.updatedAt),kind:s.kind,...(s.purpose!==undefined?{purpose:text(s.purpose,100)}:{}),recordedBy:s.recordedBy,note:text(s.note),protocol:{device:text(p.device,100),camera:p.camera,distanceCm:p.distanceCm,light:p.light,locationNote:text(p.locationNote,200),method:p.method,version:'FAMILY-PHOTO-1'},captures,report:frozen,...(rightProfileReport?{rightProfileReport}:{}),version:decoded.version,contentKey:s.contentKey===undefined?undefined:text(s.contentKey,400)}
  })
  const sessionMap=new Map(sessions.map(s=>[s.id,s]));if(sessionMap.size!==sessions.length)throw fail()
  try{validateRevisionGraph(sessions)}catch{throw fail()}
  const media:FamilyMedia[]=[];let byteCount=0
  for(const value of array(root.media,15000)) {
    const m=record(value),session=sessionMap.get(m.sessionId)
    if(!session||m.profileId!==session.profileId||!session.captures.some(c=>c.mediaId===m.id))throw fail()
    const photo=async(original:boolean)=>{const type=original?m.originalType:m.type;if(!['image/jpeg','image/png','image/webp','image/avif'].includes(String(type)))throw fail();const content=binary?binary.photo(m,original):new Blob([buffer(bytes(original?m.originalData:m.data,30*1024*1024))]);byteCount+=content.size;if(!content.size||content.size>30*1024*1024||byteCount>(binary?.maxPhotoBytes??MAX_PHOTO_BYTES))throw fail();const file=new File([content],'backup-photo',{type:String(type)});await preflightImageFile(file);return file}
    const blob=await photo(false),originalBlob=(binary?m.original!==undefined:Boolean(m.originalData))?await photo(true):undefined
    media.push({id:id(m.id),sessionId:id(m.sessionId),profileId:id(m.profileId),blob,originalBlob})
  }
  const mediaIds=new Set(media.map(m=>m.id));if(mediaIds.size!==media.length||sessions.some(s=>s.captures.some(c=>c.mediaId&&!mediaIds.has(c.mediaId))))throw fail()
  // Internal identity comes from authenticated photo bytes, never a claimed hash in an imported file.
  const mediaMap=new Map(media.map(m=>[m.id,m]))
  for(const session of sessions){const fingerprints:string[]=[];for(const capture of session.captures){const m=capture.mediaId?mediaMap.get(capture.mediaId):undefined;if(!m)continue;const digest=await crypto.subtle.digest('SHA-256',await(m.originalBlob??m.blob).arrayBuffer());fingerprints.push(capture.id+':'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''))}session.contentKey=fingerprints.length===session.captures.length&&fingerprints.length?fingerprints.sort().join('|'):undefined}
  for(const session of sessions)if(session.revision){const parent=sessionMap.get(session.revision.parentId)!;if(parent.captures.some(c=>photoFingerprint(parent,c.id)&&photoFingerprint(parent,c.id)!==photoFingerprint(session,c.id)))throw fail()}
  const plans:RecordPlan[]=array(root.plans,100).map(v=>{const p=record(v);if(!profileIds.has(p.profileId)||typeof p.enabled!=='boolean'||!['user','together','parent','child'].includes(p.owner))throw fail();validatePlan(p as RecordPlan);return {profileId:id(p.profileId),enabled:p.enabled,intervalDays:p.intervalDays,nextDate:date(p.nextDate),windowDays:p.windowDays,time:p.time,quietStart:p.quietStart,quietEnd:p.quietEnd,owner:p.owner,...(p.lastCompleted?{lastCompleted:{...p.lastCompleted}}:{})}})
  const events:FamilyEvent[]=array(root.events,10000).map(v=>{const e=record(v);if(!profileIds.has(e.profileId)||!['memory','device','question','followup'].includes(e.type))throw fail();return {id:id(e.id),profileId:id(e.profileId),date:date(e.date),type:e.type,text:text(e.text),createdAt:timestamp(e.createdAt),...eventDetails(e)}})
  return {profiles,sessions,media,plans,events}
}
