import {advancePersonalPlan} from './personalPlan'
import {eventDetails} from './eventDetails'
import {deletedSyncReceipt} from './deletedSyncData'
import {deletionReview,recoveryStamp,type DeletionReview} from './deletionReview'
import {archiveStamp} from './syncState'
import {canonicalJson} from './cloudContract'
import {editConflict,planEditVersion,metadataEditVersion} from './editVersion'
import type {SyncLink,SyncRecovery} from './syncTypes'
import type {Archive} from './backup'
import type { Capture } from '../types'
import {createRevision,validateRevisionCommit,validateRevisionGraph,type RevisionOperation} from './revisions'
import {advanceCompletedPlan,reminderKindDue,canDeliverClaimedReminder,reminderWindow,type ReminderKind} from './reminders'
import { createSession, emptySnapshot, localDate, validDate, recordRootId, findReusedPhotos, type FamilyEvent, type FamilyMedia, type FamilyProfile, type FamilySession, type FamilySnapshot, type RecordPlan, type SessionDraft } from './model'

const STORES=['profiles','sessions','media','plans','events'] as const
const DB_NAME='headup-family-v1'
export const FAMILY_CHANGE_CHANNEL='headup-family-v1:changes'
export function storageMessage(error:unknown) {
  if(error instanceof DOMException&&error.name==='QuotaExceededError')return '本机存储空间不足，本次没有保存。照片仍在当前页面，请先备份并释放空间后重试。'
  if(error instanceof DOMException&&error.name==='ConstraintError')return '这组照片已经保存在该档案中，请到时间线查看，或选择新的照片。'
  return error instanceof Error?error.message:'本机保存未完成，请保留当前页面并重试。'
}
const request=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
const committed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('保存事务未完成，未写入部分记录'));tx.onerror=()=>{/* onabort is authoritative */}})

export class FamilyStore {
  private connection?:Promise<IDBDatabase>
  mutationGuard?: (action:string,payload:any)=>Promise<void>
  constructor(readonly name=DB_NAME,readonly appVisible=name===DB_NAME){}
  private changed(){
    if(typeof BroadcastChannel==='undefined')return
    try{for(const name of new Set([`${this.name}:changes`,...(this.appVisible?[FAMILY_CHANGE_CHANNEL]:[])])){const channel=new BroadcastChannel(name);channel.postMessage({type:'changed'});channel.close()}}catch{/* refresh on focus remains available */}
  }
  private db(){
    return this.connection??=new Promise<IDBDatabase>((resolve,reject)=>{
      if(typeof indexedDB==='undefined'){reject(new Error('当前环境不支持本机档案存储，请使用支持IndexedDB的浏览器。'));return}
      const r=indexedDB.open(this.name,2)
      r.onupgradeneeded=(event)=>{
        const db=r.result
        if(event.oldVersion<1){db.createObjectStore('profiles',{keyPath:'id'})
        const sessions=db.createObjectStore('sessions',{keyPath:'id'});sessions.createIndex('profileId','profileId');sessions.createIndex('content','profileIdAndContent',{unique:true})
        const media=db.createObjectStore('media',{keyPath:'id'});media.createIndex('sessionId','sessionId');media.createIndex('profileId','profileId')
        db.createObjectStore('plans',{keyPath:'profileId'})
        const events=db.createObjectStore('events',{keyPath:'id'});events.createIndex('profileId','profileId')}
        if(!db.objectStoreNames.contains('sync'))db.createObjectStore('sync',{keyPath:'key'})
      }
      r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.connection=undefined};resolve(r.result)}
      r.onerror=()=>{this.connection=undefined;reject(r.error??new Error('无法打开本机档案'))}
      r.onblocked=()=>{reject(new Error('档案升级被另一个页面占用，请关闭其他HeadUp页面后重试。'));this.connection=undefined}
    })
  }
  async snapshot():Promise<FamilySnapshot> {
    const db=await this.db(),tx=db.transaction(['profiles','sessions','plans','events'],'readonly'),done=committed(tx)
    const [profiles,sessions,plans,events]=await Promise.all(['profiles','sessions','plans','events'].map(s=>request(tx.objectStore(s).getAll())))
    await done
    return {profiles,sessions,plans,events} as FamilySnapshot
  }
  async putProfile(profile:FamilyProfile,expected?:FamilyProfile|null){await this.mutationGuard?.('profile',profile);const db=await this.db(),tx=db.transaction('profiles','readwrite'),done=committed(tx),store=tx.objectStore('profiles'),r=store.get(profile.id);let conflict=false;r.onsuccess=()=>{if(expected!==undefined&&canonicalJson(r.result??null)!==canonicalJson(expected)){conflict=true;tx.abort();return}store.put(profile)};try{await done}catch(e){throw conflict?editConflict():e}this.changed()}
  async putPlan(plan:RecordPlan,expected?:RecordPlan|null){await this.mutationGuard?.('plan',plan);const db=await this.db(),tx=db.transaction(['profiles','plans'],'readwrite'),done=committed(tx);let conflict=false;const r=tx.objectStore('profiles').get(plan.profileId);r.onsuccess=()=>{if(!r.result){tx.abort();return}const store=tx.objectStore('plans'),old=store.get(plan.profileId);old.onsuccess=()=>{const saved=old.result as RecordPlan|undefined;if(expected!==undefined&&planEditVersion(saved)!==planEditVersion(expected)){conflict=true;tx.abort();return}store.put({...plan,lastNotifiedWindow:saved&&reminderWindow(saved)===reminderWindow(plan)?saved.lastNotifiedWindow:undefined,lastNotifiedDate:saved&&reminderWindow(saved)===reminderWindow(plan)?saved.lastNotifiedDate:undefined,lastFollowupWindow:saved&&reminderWindow(saved)===reminderWindow(plan)?saved.lastFollowupWindow:undefined})}};try{await done}catch(e){throw conflict?editConflict():e}this.changed()}
  async reminderPlans():Promise<RecordPlan[]>{const db=await this.db();return request(db.transaction('plans','readonly').objectStore('plans').getAll())}
  async reminderPlan(id:string):Promise<RecordPlan|undefined>{const db=await this.db();return request(db.transaction('plans','readonly').objectStore('plans').get(id))}
  async claimReminder(profileId:string,now:Date,kind:ReminderKind='initial',expectedWindow?:string){let claimed=false;const db=await this.db(),tx=db.transaction('plans','readwrite'),done=committed(tx),store=tx.objectStore('plans'),r=store.get(profileId);r.onsuccess=()=>{const plan=r.result as RecordPlan|undefined;if(plan&&(expectedWindow===undefined||plan.nextDate===expectedWindow)&&reminderKindDue(plan,now)===kind){store.put({...plan,...(kind==='initial'?{lastNotifiedWindow:reminderWindow(plan),lastNotifiedDate:undefined}:{lastFollowupWindow:reminderWindow(plan)}),notificationError:undefined});claimed=true}};await done;return claimed}
  async confirmReminderDelivery(profileId:string,window:string,kind:ReminderKind,now:Date){if(kind!=='initial')return;const db=await this.db(),tx=db.transaction('plans','readwrite'),done=committed(tx),store=tx.objectStore('plans'),r=store.get(profileId);r.onsuccess=()=>{const plan=r.result as RecordPlan|undefined;if(plan&&canDeliverClaimedReminder(plan,window,kind,now))store.put({...plan,lastNotifiedDate:localDate(now)})};await done}
  async failReminder(profileId:string,window:string,kind:ReminderKind='initial'){const db=await this.db(),tx=db.transaction('plans','readwrite'),done=committed(tx),store=tx.objectStore('plans'),r=store.get(profileId);r.onsuccess=()=>{const plan=r.result as RecordPlan|undefined;if(plan?.nextDate===window&&(kind==='initial'?plan.lastNotifiedWindow:plan.lastFollowupWindow)===window)store.put({...plan,notificationEnabled:false,notificationError:'系统通知未能送达，已暂停本设备页面通知与跟进。可重新开启或导出日历。'})};await done;this.changed()}
  async putEvent(event:FamilyEvent,expected?:FamilyEvent|null){
    if(!validDate(event.date)||!event.text.trim()||event.text.length>1000||!['memory','device','question','followup'].includes(event.type)||!Number.isFinite(Date.parse(event.createdAt)))throw new Error('请检查事件日期和内容')
    eventDetails(event);await this.mutationGuard?.('event',event)
    const db=await this.db(),tx=db.transaction(['profiles','events'],'readwrite'),done=committed(tx),events=tx.objectStore('events');let conflict=false
    const profile=tx.objectStore('profiles').get(event.profileId);profile.onsuccess=()=>{if(!profile.result){tx.abort();return}const existing=events.get(event.id);existing.onsuccess=()=>{if(expected!==undefined&&canonicalJson(existing.result??null)!==canonicalJson(expected)||existing.result?.detailsVersion==='HEADUP-EVENT-1'&&!event.detailsVersion||existing.result?.detailsVersion==='HEADUP-EVENT-2'&&event.detailsVersion!=='HEADUP-EVENT-2'){conflict=true;tx.abort();return}events.put(event)}}
    try{await done}catch(e){throw conflict?editConflict():e}this.changed()
  }
  async getMedia(id:string):Promise<FamilyMedia|undefined>{const db=await this.db();return request(db.transaction('media','readonly').objectStore('media').get(id))}
  async saveSession(draft:SessionDraft,captures:Capture[]):Promise<FamilySession> {
    await this.mutationGuard?.('session',draft)
    return this.persistSession(createSession(draft,captures),captures)
  }
  async saveRevision(source:FamilySession,captures:Capture[],operation:RevisionOperation,views:Array<'front'|'profile'|'right_profile'>,kind:FamilySession['kind']=source.kind){
    await this.mutationGuard?.('revision',source)
    return this.persistSession(createRevision(source,captures,operation,views,kind),captures,source)
  }
  private async persistSession(session:FamilySession,captures:Capture[],source?:FamilySession):Promise<FamilySession>{
    const media:FamilyMedia[]=[]
    const fingerprints:string[]=[]
    // Fetch local Blob URLs before starting a transaction; no network image upload.
    for(const source of captures.filter(c=>c.url)) {
      if(!source.url!.startsWith('blob:'))throw new Error('只能保存本次本地选择的照片')
      const response=await fetch(source.url!);if(!response.ok)throw new Error('照片暂不可读，请重新选择后保存')
      const blob=await response.blob()
      if(!blob.size||blob.size>30*1024*1024)throw new Error('照片为空或超过本机单张30MB限制')
      let originalBlob:Blob|undefined
      if(source.originalUrl){if(!source.originalUrl.startsWith('blob:'))throw new Error('扶正前照片来源无效');const r=await fetch(source.originalUrl);if(!r.ok)throw new Error('扶正前照片暂不可读');originalBlob=await r.blob();if(!originalBlob.size||originalBlob.size>30*1024*1024)throw new Error('扶正前照片过大或为空')}
      const id=`${session.id}/${source.id}`;media.push({id,sessionId:session.id,profileId:session.profileId,blob,originalBlob})
      const digest=await crypto.subtle.digest('SHA-256',await (originalBlob??blob).arrayBuffer())
      fingerprints.push(`${source.id}:${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}`)
      session.captures.find(c=>c.id===source.id)!.mediaId=id
    }
    session.contentKey=fingerprints.sort().join('|')
    const db=await this.db(),tx=db.transaction(['profiles','sessions','media','plans'],'readwrite'),done=committed(tx)
    let failure:Error|undefined
    const profileRequest=tx.objectStore('profiles').get(session.profileId)
    profileRequest.onsuccess=()=>{
      const profile=profileRequest.result as FamilyProfile|undefined
      if(!profile){failure=new Error('成长档案已不存在，本次未保存');tx.abort();return}
      const siblings=tx.objectStore('sessions').index('profileId').getAll(session.profileId)
      siblings.onsuccess=()=>{
        try{
          const records=siblings.result as FamilySession[]
          if(source)validateRevisionCommit(source,session,records)
          else if(records.some(s=>s.contentKey===session.contentKey))throw new DOMException('这组照片已经保存在该档案中，请到时间线查看。','ConstraintError')
          if(!source&&session.kind==='measurement'){const reused=findReusedPhotos(session,records);if(reused.length)throw new Error(`${reused.map(item=>`${item.view==='front'?'正面':item.view==='profile'?'侧面':'头顶'}照片已用于${item.date}`).join('；')}。请核对实际拍摄日期或更换照片；旧照片留念可选择“其他”，不作为新日期的测量。`)}
          const identity=session.profileId+':'+session.contentKey+(source?':revision:'+session.id:'')
          tx.objectStore('sessions').add({...session,profileIdAndContent:identity})
          media.forEach(item=>tx.objectStore('media').add(item))
          const planRequest=tx.objectStore('plans').get(session.profileId);planRequest.onsuccess=()=>{const plan=planRequest.result as RecordPlan|undefined;if(plan){const next=profile.consent.version==='LOCAL-USER-1'?advancePersonalPlan(plan,session,records):advanceCompletedPlan(plan,session);if(next!==plan)tx.objectStore('plans').put(next)}}
          const pose=session.captures.find(c=>c.id==='profile')?.poseValidation
          if(profile.consent.version==='LOCAL-FAMILY-1'&&!profile.preferredSide&&pose?.status==='pass'&&(pose.estimatedPose==='left_profile'||pose.estimatedPose==='right_profile'))tx.objectStore('profiles').put({...profile,preferredSide:pose.estimatedPose,updatedAt:new Date().toISOString()})
        }catch(e){failure=e instanceof Error?e:new Error('修订保存失败');tx.abort()}
      }
    }
    try{await done}catch(e){throw failure??e}this.changed();return session
  }
  async restoreCaptures(session:FamilySession):Promise<{captures:Capture[];dispose:()=>void}> {
    const urls:string[]=[],captures:Capture[]=[]
    try {
      for(const saved of session.captures) {
        const media=saved.mediaId?await this.getMedia(saved.mediaId):undefined
        const capture:Capture={...saved}
        if(media){capture.url=URL.createObjectURL(media.blob);urls.push(capture.url);if(media.originalBlob){capture.originalUrl=URL.createObjectURL(media.originalBlob);urls.push(capture.originalUrl)}}
        else capture.inputError='该记录的照片未能恢复；已有读数仍按原版本保留。'
        captures.push(capture)
      }
      return {captures,dispose:()=>urls.forEach(url=>URL.revokeObjectURL(url))}
    }catch(error){urls.forEach(url=>URL.revokeObjectURL(url));throw error}
  }
  private deleteIndex(store:IDBObjectStore,index:string,id:string){const r=store.index(index).openKeyCursor(IDBKeyRange.only(id));r.onsuccess=()=>{const cursor=r.result;if(cursor){store.delete(cursor.primaryKey);cursor.continue()}}}
  async deleteSession(id:string){
    await this.mutationGuard?.('delete-session',id)
    const db=await this.db(),tx=db.transaction(['sessions','media'],'readwrite'),done=committed(tx),store=tx.objectStore('sessions'),r=store.get(id)
    r.onsuccess=()=>{const selected=r.result as FamilySession|undefined;if(!selected)return;const siblings=store.index('profileId').getAll(selected.profileId);siblings.onsuccess=()=>{for(const row of siblings.result as FamilySession[])if(recordRootId(row)===recordRootId(selected)){store.delete(row.id);this.deleteIndex(tx.objectStore('media'),'sessionId',row.id)}}}
    await done;this.changed()
  }
  async updateSessionMetadata(id:string,profileId:string,recordedOn:string,note:string,expected?:FamilySession) {
    await this.mutationGuard?.('metadata',{id,profileId})
    if(!validDate(recordedOn)||recordedOn>localDate())throw new Error('请选择今天或过去的拍摄日期')
    const db=await this.db(),tx=db.transaction('sessions','readwrite'),done=committed(tx),store=tx.objectStore('sessions'),r=store.get(id)
    let conflict=false
    r.onsuccess=()=>{const saved=r.result as FamilySession|undefined;if(!saved||saved.profileId!==profileId){tx.abort();return}if(expected&&metadataEditVersion(saved)!==metadataEditVersion(expected)){conflict=true;tx.abort();return}const all=store.index('profileId').getAll(profileId);all.onsuccess=()=>{const now=new Date().toISOString();for(const row of all.result as FamilySession[])if(recordRootId(row)===recordRootId(saved))store.put({...row,recordedOn,note:note.trim().slice(0,1000),dateSource:'user_confirmed',updatedAt:now,metadataHistory:[...(row.metadataHistory??[]),{at:now,recordedOn:row.recordedOn,note:row.note}].slice(-20)})}}
    try{await done}catch(e){throw conflict?editConflict():e}this.changed()
  }
  async deleteProfile(id:string){await this.mutationGuard?.('delete-profile',id);const db=await this.db(),tx=db.transaction([...STORES,'sync'],'readwrite'),done=committed(tx);tx.objectStore('profiles').delete(id);tx.objectStore('plans').delete(id);for(const name of ['sessions','media','events'])this.deleteIndex(tx.objectStore(name),'profileId',id);const cursor=tx.objectStore('sync').openCursor();cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(row.value.key.startsWith('recovery:')&&row.value.value.profileId===id)row.delete();row.continue()};await done;this.changed()}
  async deleteEvent(id:string,expected?:FamilyEvent){await this.mutationGuard?.('delete-event',id);const db=await this.db(),tx=db.transaction('events','readwrite'),done=committed(tx),events=tx.objectStore('events');let conflict=false;const existing=events.get(id);existing.onsuccess=()=>{if(expected!==undefined&&canonicalJson(existing.result??null)!==canonicalJson(expected)){conflict=true;tx.abort();return}events.delete(id)};try{await done}catch(e){throw conflict?editConflict():e}this.changed()}
  private allRows(tx:IDBTransaction,callback:(archive:Archive,links:SyncLink[],recoveries:SyncRecovery[])=>void){
    const data:any={};let remaining=STORES.length+1
    for(const name of [...STORES,'sync']){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{data[name]=r.result;if(--remaining===0)callback(data as Archive,data.sync.filter((r:any)=>r.key.startsWith('link:')).map((r:any)=>r.value),data.sync.filter((r:any)=>r.key.startsWith('recovery:')).map((r:any)=>r.value))}}
  }
  async deletionReview():Promise<DeletionReview>{const db=await this.db(),tx=db.transaction([...STORES,'sync'],'readonly'),done=committed(tx);let review:DeletionReview|undefined;this.allRows(tx,(archive,links,recoveries)=>{review=deletionReview(archive,links,recoveries)});await done;return review!}
  async clear(expectedStamp?:string,canDelete:()=>boolean=()=>true){
    await this.mutationGuard?.('clear',null)
    const db=await this.db(),tx=db.transaction([...STORES,'sync'],'readwrite'),done=committed(tx);let conflict=false
    this.allRows(tx,(archive,links,recoveries)=>{
      if(!canDelete()||expectedStamp!==undefined&&deletionReview(archive,links,recoveries).stamp!==expectedStamp){conflict=true;tx.abort();return}
      STORES.forEach(s=>tx.objectStore(s).clear());for(const recovery of recoveries)tx.objectStore('sync').delete('recovery:'+recovery.id)
    })
    try{await done}catch(e){throw conflict?new Error('档案或同步状态已变化，本次未删除。请重新预览全部范围。'):e}this.changed()
  }
  async deleteRecovery(id:string,expectedStamp:string,canDelete:()=>boolean=()=>true){
    await this.mutationGuard?.('delete-recovery',id)
    const db=await this.db(),tx=db.transaction('sync','readwrite'),done=committed(tx),store=tx.objectStore('sync'),r=store.get('recovery:'+id);let conflict=false
    r.onsuccess=()=>{const recovery=r.result?.value as SyncRecovery|undefined;if(!canDelete()||!recovery||recoveryStamp(recovery)!==expectedStamp){conflict=true;tx.abort();return}store.delete('recovery:'+id)}
    try{await done}catch(e){throw conflict?new Error('此副本已变化或已被另一页面删除，请刷新后核对。'):e}this.changed();this.syncChanged()
  }
  async archive(profileId?:string):Promise<FamilySnapshot&{media:FamilyMedia[]}> {
    const db=await this.db(),tx=db.transaction([...STORES],'readonly'),done=committed(tx)
    const [profiles,sessions,media,plans,events]=await Promise.all(STORES.map(name=>{const store=tx.objectStore(name);if(!profileId)return request(store.getAll());if(name==='profiles'||name==='plans')return request(store.get(profileId)).then(value=>value?[value]:[]);return request(store.index('profileId').getAll(profileId))}))
    await done
    return {profiles:profiles.filter(p=>!profileId||p.id===profileId),sessions:sessions.filter(s=>!profileId||s.profileId===profileId),media:media.filter(m=>!profileId||m.profileId===profileId),plans:plans.filter(p=>!profileId||p.profileId===profileId),events:events.filter(e=>!profileId||e.profileId===profileId)}
  }
  /** Merge only absent keys. Existing local content is never overwritten. */
  async restore(archive:FamilySnapshot&{media:FamilyMedia[]}) {
    await this.mutationGuard?.('restore',archive)
    const db=await this.db(),tx=db.transaction([...STORES],'readwrite'),done=committed(tx)
    let failure:Error|undefined
    const existing=tx.objectStore('sessions').getAll()
    existing.onsuccess=()=>{
      try{
        const ids=new Set(existing.result.map(s=>s.id));validateRevisionGraph([...existing.result,...archive.sessions.filter(s=>!ids.has(s.id))])
        for(const name of STORES)for(const item of archive[name]) {
          const store=tx.objectStore(name),key=name==='plans'?(item as RecordPlan).profileId:(item as {id:string}).id,r=store.get(key)
          r.onsuccess=()=>{if(!r.result){const session=item as FamilySession;store.add(name==='sessions'&&session.contentKey?{...session,profileIdAndContent:session.profileId+':'+session.contentKey+(session.revision?':revision:'+session.id:'')}:item)}}
        }
      }catch(e){failure=e instanceof Error?e:new Error('备份导入失败');tx.abort()}
    }
    try{await done}catch(e){throw failure??e}this.changed()
  }
  private profileRows(tx:IDBTransaction,profileId:string,callback:(archive:Archive)=>void){
    const data:any={};let remaining=STORES.length
    for(const name of STORES){const store=tx.objectStore(name),r=name==='profiles'||name==='plans'?store.get(profileId):store.index('profileId').getAll(profileId);r.onsuccess=()=>{data[name]=name==='profiles'||name==='plans'?(r.result?[r.result]:[]):r.result;if(--remaining===0)callback(data as Archive)}}
  }
  async pruneDeletedSyncData(){const db=await this.db(),tx=db.transaction('sync','readwrite'),done=committed(tx),r=tx.objectStore('sync').openCursor();let count=0;r.onsuccess=()=>{const row=r.result;if(!row)return;const value=row.value;if(value.key.startsWith('link:')&&value.value.status==='deleted'){const cleaned=deletedSyncReceipt(value.value);if(canonicalJson(cleaned)!==canonicalJson(value.value)){row.update({...value,value:cleaned});count++}}row.continue()};await done;if(count)this.syncChanged();return count}
  async syncLinks():Promise<SyncLink[]>{const db=await this.db();const rows=await request(db.transaction('sync','readonly').objectStore('sync').getAll());return rows.filter(r=>r.key.startsWith('link:')).map(r=>r.value)}
  async syncState(profileId:string):Promise<{archive:Archive;stamp:string;link?:SyncLink}>{const db=await this.db(),tx=db.transaction([...STORES,'sync'],'readonly'),done=committed(tx);let result:Archive|undefined;this.profileRows(tx,profileId,a=>{result=a});const row=await request(tx.objectStore('sync').get('link:'+profileId));await done;return{archive:result!,stamp:archiveStamp(result!),link:row?.value}}
  private syncChanged(){try{const c=new BroadcastChannel(this.name+':sync');c.postMessage({type:'sync'});c.close()}catch{}}
  async saveSyncLink(link:SyncLink,expectedGeneration:number):Promise<SyncLink|undefined>{
    const db=await this.db(),tx=db.transaction('sync','readwrite'),done=committed(tx),store=tx.objectStore('sync'),r=store.get('link:'+link.profileId);let saved:SyncLink|undefined
    r.onsuccess=()=>{const old=r.result?.value as SyncLink|undefined;if((old?.generation??-1)!==expectedGeneration)return;saved=deletedSyncReceipt({...link,generation:expectedGeneration+1,updatedAt:new Date().toISOString()});store.put({key:'link:'+link.profileId,value:saved})};await done;if(saved)this.syncChanged();return saved
  }
  async queueSync(link:SyncLink,expectedStamp:string):Promise<SyncLink|undefined>{
    const db=await this.db(),tx=db.transaction([...STORES,'sync'],'readwrite'),done=committed(tx),meta=tx.objectStore('sync');let saved:SyncLink|undefined
    const r=meta.get('link:'+link.profileId);r.onsuccess=()=>{if(r.result?.value.generation!==link.generation)return;this.profileRows(tx,link.profileId,current=>{if(archiveStamp(current)!==expectedStamp)return;saved={...link,generation:link.generation+1,updatedAt:new Date().toISOString()};meta.put({key:'link:'+link.profileId,value:saved})})};await done;if(saved)this.syncChanged();return saved
  }
  async applyCloud(profileId:string,archive:Archive,expectedStamp:string,link:SyncLink,recoveryReason?:string):Promise<boolean>{
    if(archive.profiles.some(p=>p.id!==profileId)||archive.sessions.some(s=>s.profileId!==profileId)||archive.media.some(m=>m.profileId!==profileId)||archive.events.some(e=>e.profileId!==profileId)||archive.plans.some(p=>p.profileId!==profileId))throw new Error('不能跨档案应用同步数据')
    validateRevisionGraph(archive.sessions)
    const db=await this.db(),tx=db.transaction([...STORES,'sync'],'readwrite'),done=committed(tx),meta=tx.objectStore('sync');let applied=false
    const r=meta.get('link:'+profileId);r.onsuccess=()=>{if(r.result?.value.generation!==link.generation)return;this.profileRows(tx,profileId,current=>{
      if(archiveStamp(current)!==expectedStamp)return
      if(recoveryReason&&current.profiles.length){const recovery:SyncRecovery={id:crypto.randomUUID(),profileId,createdAt:new Date().toISOString(),reason:recoveryReason,archive:current};meta.put({key:'recovery:'+recovery.id,value:recovery})}
      for(const name of STORES){const store=tx.objectStore(name);for(const row of current[name])store.delete(name==='plans'?(row as RecordPlan).profileId:(row as {id:string}).id)}
      for(const name of STORES)for(const item of archive[name]){let value:any=item;if(name==='sessions'){const s=item as FamilySession;value=s.contentKey?{...s,profileIdAndContent:s.profileId+':'+s.contentKey+(s.revision?':revision:'+s.id:'')}:s}if(name==='plans'){const prior=current.plans[0];value={...item,notificationEnabled:prior?.notificationEnabled,followupEnabled:prior?.followupEnabled,lastNotifiedWindow:prior?.lastNotifiedWindow,lastNotifiedDate:prior?.lastNotifiedDate,lastFollowupWindow:prior?.lastFollowupWindow,notificationError:prior?.notificationError}}tx.objectStore(name).put(value)}
      meta.put({key:'link:'+profileId,value:deletedSyncReceipt({...link,generation:link.generation+1,baseStamp:archiveStamp(archive),updatedAt:new Date().toISOString()})});applied=true
    })};await done;if(applied){this.changed();this.syncChanged()}return applied
  }
  async syncRecoveries():Promise<SyncRecovery[]>{const db=await this.db();return(await request(db.transaction('sync','readonly').objectStore('sync').getAll())).filter(r=>r.key.startsWith('recovery:')).map(r=>r.value)}
  async replacePlanForSync(profileId:string,expectedStamp:string,generation:number,plan:RecordPlan){const db=await this.db(),tx=db.transaction([...STORES,'sync'],'readwrite'),done=committed(tx);let applied=false;const r=tx.objectStore('sync').get('link:'+profileId);r.onsuccess=()=>{if(r.result?.value.generation!==generation)return;this.profileRows(tx,profileId,current=>{if(archiveStamp(current)!==expectedStamp||plan.profileId!==profileId)return;tx.objectStore('plans').put(plan);applied=true})};await done;if(applied)this.changed();return applied}
  async syncLease(profileId:string,owner:string,release=false):Promise<boolean>{const db=await this.db(),tx=db.transaction('sync','readwrite'),done=committed(tx),store=tx.objectStore('sync'),key='lease:'+profileId,r=store.get(key);let acquired=false;r.onsuccess=()=>{const old=r.result;if(release){if(old?.owner===owner)store.delete(key);return}if(!old||old.owner===owner||old.until<Date.now()){store.put({key,owner,until:Date.now()+120000});acquired=true}};await done;return acquired}
  async close(){const db=await this.connection;db?.close();this.connection=undefined}
}
export let localFamilyStore=new FamilyStore()
let selectedStore=localFamilyStore
export const STORE_SWITCH_EVENT='headup-family-store-switch'
export function getActiveFamilyStore(){return selectedStore}
export function selectFamilyStore(store:FamilyStore){selectedStore=store;if(typeof window!=='undefined')window.dispatchEvent(new Event(STORE_SWITCH_EVENT))}
export function configureLocalFamilyStore(store:FamilyStore){localFamilyStore=store;selectFamilyStore(store)}
export const familyStore=new Proxy(localFamilyStore,{get(_target,key){const value=Reflect.get(selectedStore,key,selectedStore);return typeof value==='function'?value.bind(selectedStore):value}})
export {emptySnapshot}
