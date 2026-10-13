import {keepCameraPhoto,pendingCameraPhotos,removeCameraPhoto,type PhotoCopyJob} from './photoCopyOutbox'
import {localDate} from './model'
import type {FamilyProfile,FamilySession,FamilyMedia,StoredCapture,FamilySnapshot} from './model'
export type PhotoCopySpec={profileId:string;profileName:string;sessionId:string;date:string;view:'front'|'left'|'right'|'profile'|'top';variant:'original'|'analysis';mime:string;size:number;sha256:string}
export type PhotoDirectoryApi={
 photoDirectory:(value:{profileId:string;profileName:string})=>Promise<{directory:string;shared:boolean}>
 beginPhotoCopy:(value:PhotoCopySpec)=>Promise<{token?:string;alreadySaved:boolean;directory:string}>
 appendPhotoCopy:(value:{token:string;data:string})=>Promise<unknown>
 finishPhotoCopy:(value:{token:string})=>Promise<{directory:string}>
 abortPhotoCopy:(value:{token:string})=>Promise<unknown>
}
export type PhotoDirectoryState={phase:'working'|'saved'|'failed';count:number;directory:string;message:string;at:string}
let api:PhotoDirectoryApi|undefined,queue=Promise.resolve()
const states=new Map<string,PhotoDirectoryState|null>(),listeners=new Set<()=>void>()
const pendingKey='headup-photo-directory-pending-v1'
type Pending={profileId:string;sessionId:string}
export function pendingPhotoCopies():Pending[]{try{const value=JSON.parse(localStorage.getItem(pendingKey)??'[]');return Array.isArray(value)?value.filter(v=>v&&typeof v.profileId==='string'&&typeof v.sessionId==='string').slice(0,10000):[]}catch{return []}}
function updatePending(add:Pending[],remove:string[]=[]){try{const map=new Map(pendingPhotoCopies().filter(p=>!remove.includes(p.sessionId)).map(p=>[p.sessionId,p]));add.forEach(p=>map.set(p.sessionId,p));localStorage.setItem(pendingKey,JSON.stringify([...map.values()]))}catch{/* App records remain available for manual backfill if receipts cannot be persisted. */}}
export function configurePhotoDirectory(value:PhotoDirectoryApi|undefined){api=value}
export const photoDirectoryAvailable=()=>Boolean(api)
export const subscribePhotoDirectory=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}}
export function photoDirectoryState(profileId:string){
 if(!states.has(profileId)){let saved:PhotoDirectoryState|null=null;try{const r=JSON.parse(localStorage.getItem('headup-photo-directory:'+profileId)??'null');if(r&&['working','saved','failed'].includes(r.phase)&&typeof r.directory==='string'&&Number.isInteger(r.count))saved=r.phase==='working'?{...r,phase:'failed',message:'上次目录保存未确认完成，可在档案页重试补存。'}:r}catch{}states.set(profileId,saved)}
 return states.get(profileId)??null
}
function publish(profileId:string,state:PhotoDirectoryState){states.set(profileId,state);try{localStorage.setItem('headup-photo-directory:'+profileId,JSON.stringify(state))}catch{}listeners.forEach(fn=>fn())}
export function photoDirectoryLocation(profile:FamilyProfile){return api?.photoDirectory({profileId:profile.id,profileName:profile.nickname})}
function photoView(c:StoredCapture):PhotoCopySpec['view']{return c.id==='front'?'front':c.id==='top'?'top':c.id==='right_profile'||c.poseValidation?.estimatedPose==='right_profile'?'right':c.poseValidation?.estimatedPose==='left_profile'?'left':'profile'}
export async function writePhotoCopy(client:PhotoDirectoryApi,spec:Omit<PhotoCopySpec,'mime'|'size'|'sha256'>,blob:Blob){
 if(!['image/png','image/jpeg','image/webp','image/avif'].includes(blob.type)||!blob.size||blob.size>30*1024*1024)throw Error('照片格式或大小不支持目录保存')
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('')
 const start=await client.beginPhotoCopy({...spec,mime:blob.type,size:blob.size,sha256})
 if(start.alreadySaved)return start.directory
 if(!start.token)throw Error('照片目录保存未获得有效会话')
 const token=start.token
 try{
   for(let i=0;i<blob.size;i+=192*1024){const bytes=new Uint8Array(await blob.slice(i,i+192*1024).arrayBuffer());let binary='';for(let j=0;j<bytes.length;j+=8192)binary+=String.fromCharCode(...bytes.subarray(j,j+8192));await client.appendPhotoCopy({token,data:btoa(binary)})}
   return (await client.finishPhotoCopy({token})).directory
 }catch(error){await client.abortPhotoCopy({token}).catch(()=>{});throw error}
}
/** Called only for committed records. Failure never rolls back an app record. */
export function copyPhotosToDirectory(profile:FamilyProfile,sessions:FamilySession[],getMedia:(id:string)=>Promise<FamilyMedia|undefined>):Promise<PhotoDirectoryState|null>{
 const client=api;if(!client)return Promise.resolve(null)
 if(sessions.every(s=>s.profileId===profile.id))updatePending(sessions.map(s=>({profileId:profile.id,sessionId:s.id})))
 const task=queue.then(async()=>{
   let count=0,directory=''
   const state=(phase:PhotoDirectoryState['phase'],message:string)=>{const value={phase,message,count,directory,at:new Date().toISOString()};publish(profile.id,value);return value}
   state('working','应用内记录已保存，正在另存手机照片目录…')
   try{
     if(sessions.some(s=>s.profileId!==profile.id))throw Error('不能跨档案保存照片')
     directory=(await client.photoDirectory({profileId:profile.id,profileName:profile.nickname})).directory
     for(const session of sessions){for(const capture of session.captures){
       if(!capture.mediaId)throw Error('部分照片没有本机文件，请先恢复备份')
       const media=await getMedia(capture.mediaId)
       if(!media||media.profileId!==profile.id||media.sessionId!==session.id)throw Error('部分本机照片不可读，请检查档案或恢复备份')
       const spec={profileId:profile.id,profileName:profile.nickname,sessionId:session.id,date:session.recordedOn,view:photoView(capture)}
       const original=media.originalBlob??media.blob
       const originalSpec=capture.source==='live'&&capture.capturedAt?await cameraPhotoSpec(profile,capture.id,original,capture.capturedAt):{...spec,variant:'original' as const}
       directory=await writePhotoCopy(client,originalSpec,original);count++
       if(media.originalBlob){directory=await writePhotoCopy(client,{...spec,variant:'analysis'},media.blob);count++}
       state('working',`已确认 ${count} 张照片，正在继续归档…`)
     }updatePending([],[session.id]);try{localStorage.setItem('headup-photo-copy-complete:'+session.id,sessionCopyStamp(session))}catch{}}
     return state('saved',`已确认 ${count} 张照片保存在手机目录。`)
   }catch(error){return state('failed',`应用内记录仍保留；目录已完成 ${count} 张。${error instanceof Error?error.message:'目录保存未完成'}，可重试补存。`)}
 })
 queue=task.then(()=>{},()=>{});return task
}
/** Resume only previously requested copies, never export all historic photos implicitly. */
export async function resumePendingPhotoCopies(snapshot:FamilySnapshot,getMedia:(id:string)=>Promise<FamilyMedia|undefined>){
 const pending=pendingPhotoCopies(),ids=new Set(pending.map(p=>p.sessionId))
 const existing=snapshot.sessions.filter(s=>ids.has(s.id)&&pending.some(p=>p.sessionId===s.id&&p.profileId===s.profileId))
 updatePending([],pending.filter(p=>!existing.some(s=>s.id===p.sessionId)||!snapshot.profiles.some(profile=>profile.id===p.profileId)).map(p=>p.sessionId))
 for(const profile of snapshot.profiles){const rows=existing.filter(s=>s.profileId===profile.id);if(rows.length)await copyPhotosToDirectory(profile,rows,getMedia)}
}

function sessionCopyStamp(session:FamilySession){return JSON.stringify([session.profileId,session.recordedOn,session.captures.map(c=>[c.id,c.mediaId]),session.updatedAt])}
async function cameraPhotoSpec(profile:FamilyProfile,id:StoredCapture['id'],blob:Blob,capturedAt:string){
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('')
 return {profileId:profile.id,profileName:profile.nickname,sessionId:'camera-'+hash.slice(0,32),date:localDate(new Date(capturedAt)),view:(id==='front'?'front':id==='right_profile'?'right':id==='profile'?'left':'top') as PhotoCopySpec['view'],variant:'original' as const}
}
async function sendCameraJob(client:PhotoDirectoryApi,job:PhotoCopyJob){
 const {profileId}=job.spec
 publish(profileId,{phase:'working',count:0,directory:'',message:'正在自动保存拍摄照片…',at:new Date().toISOString()})
 try{
  const directory=await writePhotoCopy(client,job.spec,job.blob)
  await removeCameraPhoto(job.id)
  publish(profileId,{phase:'saved',count:1,directory,message:'拍摄照片已自动保存到手机目录。',at:new Date().toISOString()})
 }catch(error){publish(profileId,{phase:'failed',count:0,directory:'',message:`照片自动保存未完成：${error instanceof Error?error.message:'写入失败'}。已保留待保存照片，下次打开应用自动重试。`,at:new Date().toISOString()})}
}
/** Receives only the selected frame emitted by the camera, not discarded burst frames. */
export async function autoSaveCameraPhoto(profile:FamilyProfile,id:StoredCapture['id'],blob:Blob,capturedAt:string){
 const client=api;if(!client)return
 try{
  const spec=await cameraPhotoSpec(profile,id,blob,capturedAt),job={id:profile.id+':'+spec.sessionId+':'+spec.date+':'+spec.view,spec,blob}
  await keepCameraPhoto(job)
  const task=queue.then(()=>sendCameraJob(client,job));queue=task.catch(()=>{});await task
 }catch(error){publish(profile.id,{phase:'failed',count:0,directory:'',message:`无法暂存拍摄照片：${error instanceof Error?error.message:'本机存储不可用'}。请保留当前页面并保存到档案后重试。`,at:new Date().toISOString()})}
}
/** Automatically backfill existing local records and retry durable camera jobs. */
export async function autoSaveLocalPhotos(snapshot:FamilySnapshot,getMedia:(id:string)=>Promise<FamilyMedia|undefined>){
 const client=api;if(!client)return
 const jobs=await pendingCameraPhotos()
 for(const job of jobs){
  if(!snapshot.profiles.some(p=>p.id===job.spec.profileId)){await removeCameraPhoto(job.id);continue}
  const task=queue.then(()=>sendCameraJob(client,job));queue=task.catch(()=>{});await task
 }
 for(const profile of snapshot.profiles){
  const sessions=snapshot.sessions.filter(s=>{if(s.profileId!==profile.id)return false;try{return localStorage.getItem('headup-photo-copy-complete:'+s.id)!==sessionCopyStamp(s)}catch{return true}})
  if(sessions.length)await copyPhotosToDirectory(profile,sessions,getMedia)
 }
}
