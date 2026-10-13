import sharp from 'sharp'
import 'fake-indexeddb/auto'
import {afterEach,it,expect} from 'vitest'
import {FamilyStore} from './store'
import {SyncEngine,type SyncTransport} from './syncEngine'
import {SyncError} from './cloudTransport'
import {FamilyDatabase,FamilyError,type Identity} from '../../server/familyDb.ts'
import {archiveFixture} from './backupVolumes.fixture'
import type {Archive} from './backup'
import type {RemoteState} from './syncTypes'
import {CLOUD_CONSENT_VERSION,type CloudSnapshot} from './cloudContract'
import {cloudWritePolicy} from './cloudWritePolicy'
import {defaultPlan,defaultProtocol,localDate} from './model'
const stores:FamilyStore[]=[],dbs:FamilyDatabase[]=[],engines:SyncEngine[]=[]
afterEach(async()=>{engines.forEach(e=>e.stop());engines.length=0;for(const s of stores.splice(0)){await s.close();await new Promise<void>((r,j)=>{const req=indexedDB.deleteDatabase(s.name);req.onsuccess=()=>r();req.onerror=()=>j(req.error)})}dbs.splice(0).forEach(d=>d.close())})
const store=()=>{const value=new FamilyStore('unit-sync-'+crypto.randomUUID());stores.push(value);return value}
class Adapter implements SyncTransport{
  userId:string;offline=false;loseAck=false;downloadHook?:()=>Promise<void>;actualUser:Identity
  constructor(readonly db:FamilyDatabase,readonly user:Identity,readonly familyId:string){this.userId=user.id;this.actualUser=user}
  async check<T>(fn:()=>T):Promise<T>{if(this.offline)throw new SyncError('offline','离线');try{return fn()}catch(e){if(e instanceof FamilyError)throw new SyncError(e.code,e.message,e.status);throw e}}
  async authenticate(){if(this.actualUser.id!==this.userId)throw new SyncError('account_changed','账号已变化',409);return this.check(()=>({user:this.user,csrf:'test',families:this.db.families(this.user)}))}
  profiles(id:string){return this.check(()=>({profiles:this.db.listProfiles(this.actualUser,id)}))}
  create(id:string,p:any){return this.check(()=>this.db.createProfile(this.actualUser,id,p,CLOUD_CONSENT_VERSION))}
  get(id:string){return this.check(()=>this.db.getSnapshot(this.actualUser,id))}
  async upload(id:string,key:string,blob:Blob,v:number){const bytes=new Uint8Array(await blob.arrayBuffer());return this.check(()=>this.db.putAsset(this.actualUser,id,key,blob.type,bytes,v))}
  async commit(id:string,v:number,key:string,s:CloudSnapshot){const result=await this.check(()=>this.db.commit(this.actualUser,id,v,key,structuredClone(s)));if(this.loseAck){this.loseAck=false;throw new SyncError('offline','提交成功但回包丢失')}return result}
  remove(id:string,v:number){return this.check(()=>this.db.deleteProfile(this.actualUser,id,v))}
  receipt(id:string,key:string){return this.check(()=>({receipt:this.db.receipt(this.actualUser,id,key)}))}
  cancel(id:string,key:string){return this.check(()=>({receipt:this.db.cancelMutation(this.actualUser,id,key)}))}
  async download(remote:RemoteState):Promise<Archive>{if(this.downloadHook)await this.downloadHook();if(!remote.snapshot)return{profiles:[],sessions:[],events:[],plans:[],media:[]};const s=structuredClone(remote.snapshot);const media=s.media.map(m=>{const load=(key:string)=>{const a=this.db.getAsset(this.actualUser,remote.id,key);return new Blob([a.data],{type:a.mime})};return{id:m.id,sessionId:m.sessionId,profileId:m.profileId,blob:load(m.processed.key),originalBlob:m.original?load(m.original.key):undefined}});return{profiles:[s.profile],sessions:s.sessions,events:s.events,plans:s.plans,media} as Archive}
}
async function setup(){const db=new FamilyDatabase(':memory:');dbs.push(db);const user=(await db.register('engine-user','test-password-1234','工程测试')).user,family=db.createFamily(user,'工程家庭'),a=store(),b=store(),data=archiveFixture();await a.restore(data);const ta=new Adapter(db,user,family.id),tb=new Adapter(db,user,family.id),ea=new SyncEngine(a,ta,family.id,'owner'),eb=new SyncEngine(b,tb,family.id,'owner');engines.push(ea,eb);await ea.connect(data.profiles[0].id);return{db,user,family,a,b,data,id:data.profiles[0].id,ta,tb,ea,eb}}
const event=(profileId:string,text:string)=>({id:crypto.randomUUID(),profileId,date:'2026-09-17',type:'memory' as const,text,createdAt:new Date().toISOString()})
it('keeps followup preferences and receipts on each device while synchronizing the shared schedule',async()=>{
  const x=await setup(),plan={...defaultPlan(x.id),nextDate:'2026-09-17',time:'18:00',enabled:true,notificationEnabled:true,followupEnabled:true}
  await x.a.putPlan(plan);await x.a.claimReminder(x.id,new Date(2026,8,17,18));await x.a.confirmReminderDelivery(x.id,plan.nextDate,'initial',new Date(2026,8,17,18));await x.ea.run();await x.eb.subscribe(x.id)
  const remote=x.db.getSnapshot(x.user,x.id).snapshot!.plans[0]
  for(const key of ['notificationEnabled','followupEnabled','lastNotifiedWindow','lastNotifiedDate','lastFollowupWindow'])expect(remote).not.toHaveProperty(key)
  expect((await x.b.reminderPlan(x.id))?.followupEnabled).toBeUndefined()
  await x.b.putPlan({...plan,followupEnabled:false});await x.a.putPlan({...plan,intervalDays:56});await x.ea.run();await x.eb.run()
  expect(await x.b.reminderPlan(x.id)).toMatchObject({intervalDays:56,notificationEnabled:true,followupEnabled:false})
})
it('allows a child to choose local followup without changing the shared period',async()=>{
  const x=await setup(),plan={...defaultPlan(x.id),enabled:true};await x.a.putPlan(plan);await x.ea.run()
  const child=(await x.db.register('child-reminder','test-password-1234','工程孩子')).user,invite=x.db.invite(x.user,x.family.id,child.username,'child',[x.id]);x.db.acceptInvite(child,invite.token,CLOUD_CONSENT_VERSION)
  const engine=new SyncEngine(x.b,new Adapter(x.db,child,x.family.id),x.family.id,'child');engines.push(engine);x.b.mutationGuard=cloudWritePolicy(x.b,child.id,()=>engine.role);await engine.subscribe(x.id)
  await x.b.putPlan({...plan,notificationEnabled:true,followupEnabled:true})
  await expect(x.b.putPlan({...plan,intervalDays:56})).rejects.toThrow('角色')
  expect((await x.b.reminderPlan(x.id))?.followupEnabled).toBe(true)
})
it('syncs event provenance and discussion, rejects stale edits/deletes and blocks old-client metadata stripping',async()=>{
  const x=await setup();await x.ea.run();await x.eb.subscribe(x.id)
  const question={...event(x.id,'一起讨论的问题'),type:'question' as const,detailsVersion:'HEADUP-EVENT-1' as const,questionStatus:'discussed' as const,discussedOn:'2026-09-17',discussionNote:'讨论文字继续保留',recordedBy:'together' as const},source={...event(x.id,'已有资料'),type:'followup' as const,detailsVersion:'HEADUP-EVENT-1' as const,provenance:{kind:'document' as const,name:'工程机构',date:'2026-09-16',reference:'资料17'}}
  await x.a.putEvent(question,null);await x.a.putEvent(source,null);await x.ea.run();await x.eb.run()
  expect((await x.b.snapshot()).events.find(e=>e.id===source.id)).toEqual(source)
  await x.b.putEvent({...question,questionStatus:'open'},question);await x.eb.run();await x.ea.run()
  const current=(await x.a.snapshot()).events.find(e=>e.id===question.id)!;expect(current.questionStatus).toBe('open');expect(current.discussionNote).toBe(question.discussionNote)
  await expect(x.a.putEvent({...question,text:'过期输入'},question)).rejects.toThrow('另一页面或设备更新');await expect(x.a.deleteEvent(question.id,question)).rejects.toThrow('另一页面或设备更新')
  const remote=x.db.getSnapshot(x.user,x.id),stripped=structuredClone(remote.snapshot!);stripped.events=stripped.events.map(({id,profileId,date,type,text,createdAt})=>({id,profileId,date,type,text,createdAt}))
  expect(()=>x.db.commit(x.user,x.id,remote.version,crypto.randomUUID(),stripped)).toThrow('更新客户端');expect(x.db.getSnapshot(x.user,x.id).snapshot?.events.find(e=>e.id===question.id)?.discussionNote).toBe(question.discussionNote)
})
it('refuses stale profile, plan and record forms after an incoming update, preserving the newer content',async()=>{
  const s=store(),data=archiveFixture();await s.restore(data);const profile=data.profiles[0],record=data.sessions[0],plan={...defaultPlan(profile.id),enabled:true}
  await s.putProfile({...profile,nickname:'另一设备已更新'},profile)
  await expect(s.putProfile({...profile,nickname:'过期输入'},profile)).rejects.toThrow('另一页面或设备更新')
  await s.putPlan(plan,null);await s.putPlan({...plan,enabled:false},plan)
  await expect(s.putPlan({...plan,nextDate:'2026-12-01'},plan)).rejects.toThrow('另一页面或设备更新')
  await s.updateSessionMetadata(record.id,profile.id,record.recordedOn,'新的备注',record)
  await expect(s.updateSessionMetadata(record.id,profile.id,record.recordedOn,'过期备注',record)).rejects.toThrow('另一页面或设备更新')
  const saved=await s.snapshot();expect(saved.profiles[0].nickname).toBe('另一设备已更新');expect(saved.plans[0].enabled).toBe(false);expect(saved.sessions.every(row=>row.note==='新的备注')).toBe(true)
})
it('uploads complete records, pulls them into another device and propagates later edits and deletion',async()=>{
  const x=await setup();await x.ea.run();expect((await x.a.syncLinks())[0].status).toBe('synced');expect(x.db.getSnapshot(x.user,x.id).snapshot?.sessions.length).toBe(2)
  await x.eb.subscribe(x.id);expect((await x.b.archive()).media.length).toBe(2)
  await x.a.putEvent(event(x.id,'设备A写入'));await x.ea.run();await x.eb.run();expect((await x.b.snapshot()).events[0].text).toBe('设备A写入')
  await x.a.deleteSession(x.data.sessions[0].id);await x.ea.run();await x.eb.run();expect((await x.b.archive()).sessions).toHaveLength(0);expect((await x.b.archive()).media).toHaveLength(0)
})
it('persists an uncertain commit and resolves it after reopening without creating a second version',async()=>{
  const x=await setup();x.ta.loseAck=true;await x.ea.run();const queued=(await x.a.syncLinks())[0];expect(queued.job).toBeTruthy();const version=x.db.getSnapshot(x.user,x.id).version
  x.ea.stop();await x.a.close();const resumed=new SyncEngine(x.a,x.ta,x.family.id,'owner');engines.push(resumed);await resumed.run()
  expect(x.db.getSnapshot(x.user,x.id).version).toBe(version);expect((await x.a.syncLinks())[0].job).toBeUndefined();expect((await x.a.syncLinks())[0].status).toBe('synced')
})
it('keeps both sides of a conflict and saves the local alternative before accepting the server',async()=>{
  const x=await setup();await x.ea.run();await x.eb.subscribe(x.id)
  await x.a.putEvent(event(x.id,'本机待处理'));await x.b.putEvent(event(x.id,'云端已完成'));await x.eb.run();await x.ea.run()
  expect((await x.a.syncLinks())[0].status).toBe('conflict');expect((await x.a.snapshot()).events[0].text).toBe('本机待处理')
  await x.ea.useServer(x.id);expect((await x.a.snapshot()).events[0].text).toBe('云端已完成');expect((await x.a.syncRecoveries())[0].archive.events[0].text).toBe('本机待处理')
})
it('does not overwrite a local edit made while server photos are being downloaded',async()=>{
  const x=await setup();await x.ea.run();await x.eb.subscribe(x.id);await x.a.putEvent(event(x.id,'远程变更'));await x.ea.run()
  x.tb.downloadHook=async()=>{await x.b.putEvent(event(x.id,'下载期间本机写入'));x.tb.downloadHook=undefined};await x.eb.run()
  expect((await x.b.snapshot()).events.map(e=>e.text)).toEqual(['下载期间本机写入']);await x.eb.run();expect((await x.b.syncLinks())[0].status).toBe('conflict')
})
it('preserves offline work, pauses explicitly and refuses an account switch',async()=>{
  const x=await setup();x.ta.offline=true;await x.ea.run();expect((await x.a.syncLinks())[0].status).toBe('offline');expect((await x.a.archive()).media.length).toBe(2)
  await x.ea.pause(x.id,true);x.ta.offline=false;await x.ea.run();expect(x.db.listProfiles(x.user,x.family.id)).toHaveLength(0)
  await x.ea.pause(x.id,false);x.ta.actualUser={...x.user,id:'another'};let locked=false;x.ea.onLocked=()=>{locked=true};await x.ea.run();expect(locked).toBe(true);expect(x.db.listProfiles(x.user,x.family.id)).toHaveLength(0)
})
it('uses a lease so two open pages share one pending publication',async()=>{
  const x=await setup(),second=new SyncEngine(x.a,x.ta,x.family.id,'owner');engines.push(second);await Promise.all([x.ea.run(),second.run()]);expect(x.db.getSnapshot(x.user,x.id).version).toBe(2)
})
it('cancels an obsolete queued attempt before publishing newer local edits',async()=>{
  const x=await setup(),original=x.ta.upload.bind(x.ta);let fail=true;x.ta.upload=async(...args)=>{if(fail)throw new SyncError('offline','模拟照片上传中断');return original(...args)}
  await x.ea.run();const previous=(await x.a.syncLinks())[0].job!;expect(previous).toBeTruthy()
  await x.a.putEvent(event(x.id,'中断后新增的内容'));fail=false;await x.ea.run()
  expect(x.db.receipt(x.user,x.id,previous.mutationId)?.cancelled).toBe(true)
  expect(x.db.getSnapshot(x.user,x.id).snapshot?.events[0].text).toBe('中断后新增的内容')
})
it('does not block a child from editing their own newly synchronized note, but protects parent data locally',async()=>{
  const x=await setup();await x.ea.run();const child=(await x.db.register('child-sync','test-password-1234','工程孩子')).user,invite=x.db.invite(x.user,x.family.id,child.username,'child',[x.id]);x.db.acceptInvite(child,invite.token,CLOUD_CONSENT_VERSION)
  const transport=new Adapter(x.db,child,x.family.id),engine=new SyncEngine(x.b,transport,x.family.id,'child');engines.push(engine);x.b.mutationGuard=cloudWritePolicy(x.b,child.id,()=>engine.role)
  await engine.subscribe(x.id)
  await expect(x.b.deleteSession(x.data.sessions[0].id)).rejects.toThrow('角色')
  const note=event(x.id,'孩子的记录');await x.b.putEvent(note);await engine.run();await x.b.putEvent({...note,text:'孩子更正自己的记录'});await engine.run()
  expect(x.db.getSnapshot(child,x.id).snapshot?.events[0].text).toBe('孩子更正自己的记录')
})
it('does not let self-reported child attribution grant permission to change a parent event',async()=>{
  const x=await setup(),parentEvent={...event(x.id,'家长保存的资料'),type:'followup' as const,detailsVersion:'HEADUP-EVENT-1' as const,provenance:{kind:'unknown' as const}};await x.a.putEvent(parentEvent,null);await x.ea.run()
  const child=(await x.db.register('child-event-source','test-password-1234','工程孩子')).user,invite=x.db.invite(x.user,x.family.id,child.username,'child',[x.id]);x.db.acceptInvite(child,invite.token,CLOUD_CONSENT_VERSION)
  const transport=new Adapter(x.db,child,x.family.id),engine=new SyncEngine(x.b,transport,x.family.id,'child');engines.push(engine);x.b.mutationGuard=cloudWritePolicy(x.b,child.id,()=>engine.role);await engine.subscribe(x.id)
  await expect(x.b.putEvent({...parentEvent,recordedBy:'child',text:'试图更改家长资料'},parentEvent)).rejects.toThrow('角色')
  const remote=x.db.getSnapshot(child,x.id),forged=structuredClone(remote.snapshot!);forged.events[0].recordedBy='child';expect(()=>x.db.commit(child,x.id,remote.version,crypto.randomUUID(),forged)).toThrow()
  expect(x.db.getSnapshot(x.user,x.id).snapshot?.events[0].text).toBe(parentEvent.text)
})
it.each([false,true])('handles child completion deletion with uncertain server acknowledgement=%s',async acknowledged=>{
  const x=await setup(),today=localDate();await x.a.putPlan({...defaultPlan(x.id),enabled:true,nextDate:today});await x.ea.run();const child=(await x.db.register('child-completion','test-password-1234','工程孩子')).user,invite=x.db.invite(x.user,x.family.id,child.username,'child',[x.id]);x.db.acceptInvite(child,invite.token,CLOUD_CONSENT_VERSION)
  const transport=new Adapter(x.db,child,x.family.id),engine=new SyncEngine(x.b,transport,x.family.id,'child');engines.push(engine);x.b.mutationGuard=cloudWritePolicy(x.b,child.id,()=>engine.role);await engine.subscribe(x.id)
  const freshPhoto=await sharp({create:{width:64,height:64,channels:3,background:'#dce8ef'}}).png().toBuffer(),url=URL.createObjectURL(new Blob([new Uint8Array(freshPhoto)],{type:'image/png'}))
  try{const row=await x.b.saveSession({profileId:x.id,recordedOn:today,kind:'measurement',recordedBy:'child',note:'工程完成',protocol:defaultProtocol()},(['front','profile'] as const).map(id=>({id,label:id,hint:'',eyebrow:'',url,quality:{score:90,resolution:90,brightness:90,contrast:90,sharpness:90,flags:[]},poseValidation:{status:'pass',estimatedPose:id==='front'?'front':'left_profile',detectedFaces:1,flags:[]}})))
    expect((await x.b.snapshot()).plans[0].lastCompleted?.sessionId).toBe(row.id)
    if(acknowledged){transport.loseAck=true;await engine.run();expect((await x.b.syncLinks())[0].job).toBeTruthy()}
    await x.b.deleteSession(row.id);await engine.run();expect((await x.b.syncLinks())[0].status).toBe('synced');const plan=(await x.b.snapshot()).plans[0];expect(plan.lastCompleted?.sessionId).toBe(acknowledged?row.id:undefined);expect(plan.nextDate===today).toBe(!acknowledged);expect(x.db.getSnapshot(child,x.id).snapshot?.sessions.some(s=>s.id===row.id)).toBe(false)
  }finally{URL.revokeObjectURL(url)}
})

it('retains offline deletion state until acknowledgement, then removes the source archive from both device receipts',async()=>{
  const x=await setup();await x.ea.run();await x.eb.subscribe(x.id)
  const state=await x.a.syncState(x.id);await x.a.applyCloud(x.id,state.archive,state.stamp,state.link!,'工程冲突副本')
  expect((await x.a.syncRecoveries()).filter(r=>r.profileId===x.id)).toHaveLength(1)
  x.ta.offline=true;await x.a.deleteProfile(x.id);await x.ea.run()
  expect((await x.a.syncRecoveries()).filter(r=>r.profileId===x.id)).toHaveLength(0)
  expect((await x.a.syncLinks())[0]).toMatchObject({status:'offline'});expect((await x.a.syncLinks())[0].baseSnapshot).toBeDefined()
  x.ta.offline=false;await x.ea.run();await x.eb.run()
  for(const device of [x.a,x.b]){expect((await device.archive()).profiles).toHaveLength(0);const link=(await device.syncLinks())[0];expect(link).toMatchObject({status:'deleted',enabled:false,baseHash:'',baseStamp:''});for(const key of ['baseSnapshot','creationProfile','job','authors'])expect(link).not.toHaveProperty(key)}
})
it('resolves a lost delete acknowledgement without restoring the deleted data',async()=>{
  const x=await setup();await x.ea.run();const remove=x.ta.remove.bind(x.ta);let lose=true
  x.ta.remove=async(...args)=>{const result=await remove(...args);if(lose){lose=false;throw new SyncError('offline','删除完成但回包丢失')}return result}
  await x.a.deleteProfile(x.id);await x.ea.run();expect((await x.a.syncLinks())[0].status).toBe('offline')
  await x.ea.run();expect((await x.a.syncLinks())[0].status).toBe('deleted');expect((await x.a.syncLinks())[0]).not.toHaveProperty('baseSnapshot');expect((await x.a.archive()).media).toHaveLength(0)
})
it('keeps the explicitly promised conflict recovery when accepting a server deletion',async()=>{
  const x=await setup();await x.ea.run();await x.a.putEvent(event(x.id,'需要保留的未同步文字'))
  x.db.deleteProfile(x.user,x.id,x.db.getSnapshot(x.user,x.id).version);await x.ea.run();expect((await x.a.syncLinks())[0].status).toBe('conflict')
  await x.ea.useServer(x.id)
  expect((await x.a.syncLinks())[0]).not.toHaveProperty('baseSnapshot');expect((await x.a.syncRecoveries())[0].archive.events[0].text).toBe('需要保留的未同步文字')
})
it('deletes only the selected profile conflict copies',async()=>{
  const x=await setup(),other=archiveFixture();await x.a.restore(other);await x.ea.connect(other.profiles[0].id)
  for(const id of [x.id,other.profiles[0].id]){const state=await x.a.syncState(id);await x.a.applyCloud(id,state.archive,state.stamp,state.link!,'工程副本')}
  await x.a.deleteProfile(x.id);expect((await x.a.syncRecoveries()).map(r=>r.profileId)).toEqual([other.profiles[0].id]);expect((await x.a.archive(other.profiles[0].id)).media).toHaveLength(2)
})

it('prunes legacy deleted receipts on startup even while offline, without discarding explicit recovery copies',async()=>{
  const x=await setup();await x.ea.run();const state=await x.a.syncState(x.id),old=state.link!
  await x.a.deleteProfile(x.id)
  const legacy={...old,status:'deleted',enabled:false,job:{mutationId:'old-job',version:old.version,snapshot:old.baseSnapshot!,uploads:[{key:'old-upload',blob:x.data.media[0].blob}],localStamp:old.baseStamp}}
  await new Promise<void>((resolve,reject)=>{const open=indexedDB.open(x.a.name);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('sync','readwrite');tx.objectStore('sync').put({key:'link:'+x.id,value:legacy});tx.objectStore('sync').put({key:'recovery:explicit',value:{id:'explicit',profileId:x.id,createdAt:new Date().toISOString(),reason:'用户明确保留',archive:x.data}});tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}})
  x.ta.offline=true;await x.ea.run()
  const saved=(await x.a.syncLinks())[0];expect(saved.status).toBe('deleted');for(const key of ['baseSnapshot','creationProfile','job','authors'])expect(saved).not.toHaveProperty(key)
  expect((await x.a.syncRecoveries())[0].archive.media).toHaveLength(2);expect(await x.a.pruneDeletedSyncData()).toBe(0)
})

it('tracks each reviewed workspace deletion and preserves a paused cloud profile until explicitly resumed',async()=>{
  const x=await setup(),other=archiveFixture(),otherId=other.profiles[0].id;await x.a.restore(other);await x.ea.connect(otherId);await x.ea.run();await x.ea.pause(otherId,true)
  const review=await x.a.deletionReview();expect(review).toMatchObject({connected:2,paused:1})
  await x.a.clear(review.stamp);await x.ea.run()
  expect(x.db.getSnapshot(x.user,x.id).deleted).toBe(true);expect(x.db.getSnapshot(x.user,otherId).deleted).toBe(false)
  expect((await x.a.syncLinks()).find(l=>l.profileId===otherId)?.status).toBe('paused')
  await x.ea.pause(otherId,false);await x.ea.run();expect(x.db.getSnapshot(x.user,otherId).deleted).toBe(true)
  expect((await x.a.syncLinks()).every(l=>l.status==='deleted'&&!l.baseSnapshot&&!l.job)).toBe(true)
})
