import {afterEach,it,expect} from 'vitest'
import {createServer,type Server} from 'node:http'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {resolve,join,sep} from 'node:path'
import {FamilyDatabase,FamilyError,type Identity} from '../../server/familyDb.ts'
import {createFamilyHandler} from '../../server/familyApi.ts'
import {staticApp} from '../../server/staticApp.ts'
import {completedPlan} from './planCompletion'
import {prepareCloudSnapshot} from './cloudSnapshot'
import {archiveFixture} from './backupVolumes.fixture'
import {CLOUD_CONSENT_VERSION,validateCloudSnapshot,type CloudSnapshot} from './cloudContract'
import {SHARE_PROTOCOL,type ShareScope} from './shareContract'
const databases=new Set<FamilyDatabase>(),servers:Server[]=[],folders:string[]=[]
const database=(path=':memory:',now?:()=>number)=>{const db=new FamilyDatabase(path,now);databases.add(db);return db}
afterEach(async()=>{for(const s of servers.splice(0))await new Promise<void>(r=>{s.close(()=>r());s.closeAllConnections()});for(const db of databases)db.close();databases.clear();const base=resolve('.tmp')+sep;for(const folder of folders.splice(0)){const target=resolve(folder);if(!target.startsWith(base))throw new Error('test cleanup boundary');await rm(target,{recursive:true,force:true})}})
const register=async(db:FamilyDatabase,name:string)=>(await db.register(name,'test-password-1234',name)).user
async function seed(db:FamilyDatabase,owner:Identity){const family=db.createFamily(owner,'工程测试家庭'),archive=archiveFixture(),prepared=await prepareCloudSnapshot(archive);db.createProfile(owner,family.id,prepared.snapshot.profile,CLOUD_CONSENT_VERSION);return{family,archive,...prepared,id:archive.profiles[0].id}}
async function upload(db:FamilyDatabase,user:Identity,id:string,uploads:Map<string,Blob>){for(const[key,blob]of uploads)db.putAsset(user,id,key,blob.type,new Uint8Array(await blob.arrayBuffer()))}
function status(fn:()=>unknown,expected:number){try{fn();throw new Error('expected rejection')}catch(e){expect(e).toBeInstanceOf(FamilyError);expect((e as FamilyError).status).toBe(expected)}}
const shareScope=(id:string):ShareScope=>({from:'',to:'',sessionIds:[id],eventIds:[],fields:{photos:true,readings:false,notes:false,sources:false,nickname:false},photoMode:'original'})
async function shareSeed(db:FamilyDatabase){const owner=await register(db,'share-owner'),recipient=await register(db,'share-reader'),stranger=await register(db,'share-stranger'),data=await seed(db,owner);await upload(db,owner,data.id,data.uploads);db.commit(owner,data.id,1,'share-seed',data.snapshot);const scope=shareScope(data.snapshot.sessions.at(-1)!.id),id=crypto.randomUUID(),token='S'.repeat(43);return{owner,recipient,stranger,data,scope,id,token}}
it('shares only selected content with a named external account without granting family or raw-media access',async()=>{
  const db=database(),x=await shareSeed(db),preview=db.previewShare(x.owner,x.data.id,2,x.scope),created=db.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,24,x.scope,SHARE_PROTOCOL)
  expect(created.recipient.username).toBe(x.recipient.username);expect(db.families(x.recipient)).toEqual([]);status(()=>db.getSnapshot(x.recipient,x.data.id),403);status(()=>db.getAsset(x.recipient,x.data.id,[...x.data.uploads.keys()][0]),403)
  status(()=>db.readShare(x.stranger,x.token),404);const shared=db.readShare(x.recipient,x.token);expect(shared.content).toEqual(preview.content);expect(JSON.stringify(shared)).not.toContain(x.data.archive.profiles[0].nickname)
  const photo=shared.content.sessions[0].photos[0];expect(db.readSharedPhoto(x.recipient,x.token,photo.ref).data.length).toBeGreaterThan(0);status(()=>db.readSharedPhoto(x.recipient,x.token,[...x.data.uploads.keys()][0]),404)
  expect(db.listShares(x.owner,x.data.id)).toHaveLength(1);expect(db.db.prepare('SELECT token_hash FROM shares WHERE id=?').get(x.id)?.token_hash).not.toBe(x.token)
})
it('preserves creation intent on retries, freezes notes, and rejects stale previews or request reuse',async()=>{
  const db=database(),x=await shareSeed(db),scope={...x.scope,fields:{...x.scope.fields,notes:true}},first=db.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,1,scope,SHARE_PROTOCOL),saved=db.readShare(x.recipient,x.token).content
  const changed=structuredClone(x.data.snapshot);changed.sessions.forEach(s=>s.note='new-note-after-share');db.commit(x.owner,x.data.id,2,'after-share',changed)
  expect(db.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,1,scope,SHARE_PROTOCOL)).toEqual(first);expect(db.readShare(x.recipient,x.token).content).toEqual(saved)
  status(()=>db.createShare(x.owner,x.data.id,2,crypto.randomUUID(),'T'.repeat(43),x.recipient.username,1,scope,SHARE_PROTOCOL),409)
  status(()=>db.createShare(x.owner,x.data.id,2,x.id,x.token,x.stranger.username,1,scope,SHARE_PROTOCOL),409);status(()=>db.createShare(x.owner,x.data.id,3,crypto.randomUUID(),'X'.repeat(43),x.recipient.username,999,scope,SHARE_PROTOCOL),400)
})
it('expires and revokes both shared JSON and photo access and clears retained content',async()=>{
  let now=Date.parse('2026-09-17T00:00:00Z');const db=database(':memory:',()=>now),x=await shareSeed(db);db.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,1,x.scope,SHARE_PROTOCOL)
  const ref=db.readShare(x.recipient,x.token).content.sessions[0].photos[0].ref;now+=3600000;status(()=>db.readShare(x.recipient,x.token),410);status(()=>db.readSharedPhoto(x.recipient,x.token,ref),410);db.cleanup();expect(db.db.prepare('SELECT content_json FROM shares WHERE id=?').get(x.id)?.content_json).toBeNull()
  const second=crypto.randomUUID();db.createShare(x.owner,x.data.id,2,second,'R'.repeat(43),x.recipient.username,24,x.scope,SHARE_PROTOCOL);status(()=>db.revokeShare(x.recipient,second),403);db.revokeShare(x.owner,second);status(()=>db.readShare(x.recipient,'R'.repeat(43)),410);expect(db.getSnapshot(x.owner,x.data.id).snapshot?.sessions).toHaveLength(2)
})
it('revokes when selected source records are deleted and clears the frozen view',async()=>{
  const db=database(),x=await shareSeed(db);db.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,24,x.scope,SHARE_PROTOCOL)
  const deleted=structuredClone(x.data.snapshot);deleted.sessions=[];deleted.media=[];db.commit(x.owner,x.data.id,2,'delete-source',deleted);status(()=>db.readShare(x.recipient,x.token),410);expect(db.db.prepare('SELECT content_json FROM shares WHERE id=?').get(x.id)?.content_json).toBeNull()
})
it('prevents child sharing and permanently revokes derived shares when a creator leaves',async()=>{
  const db=database(),x=await shareSeed(db),guardian=await register(db,'share-guardian'),child=await register(db,'share-child')
  for(const[user,role]of [[guardian,'guardian'],[child,'child']] as const){const invite=db.invite(x.owner,x.data.family.id,user.username,role,[x.data.id]);db.acceptInvite(user,invite.token,CLOUD_CONSENT_VERSION)}
  status(()=>db.previewShare(child,x.data.id,2,x.scope),403);status(()=>db.createShare(child,x.data.id,2,x.id,x.token,x.recipient.username,24,x.scope,SHARE_PROTOCOL),403)
  db.createShare(guardian,x.data.id,2,x.id,x.token,x.recipient.username,24,x.scope,SHARE_PROTOCOL);db.leave(guardian,x.data.family.id);status(()=>db.readShare(x.recipient,x.token),410)
  const invite=db.invite(x.owner,x.data.family.id,guardian.username,'guardian',[x.data.id]);db.acceptInvite(guardian,invite.token,CLOUD_CONSENT_VERSION);status(()=>db.readShare(x.recipient,x.token),410)
})
it('accepts actual local archive data, publishes photos only on atomic snapshot commit and keeps old reports immutable',async()=>{
  const db=database(),owner=await register(db,'owner'),data=await seed(db,owner),key=[...data.uploads.keys()][0]
  await upload(db,owner,data.id,data.uploads);status(()=>db.getAsset(owner,data.id,key),404)
  expect(db.commit(owner,data.id,1,'mutation-1',data.snapshot).version).toBe(2)
  expect(db.getAsset(owner,data.id,key).data.length).toBe(data.archive.media[0].blob.size)
  expect(db.commit(owner,data.id,1,'mutation-1',data.snapshot)).toEqual({version:2,replayed:true})
  const modified=structuredClone(data.snapshot);modified.sessions[0].report.summaries[0].note='改写旧报告'
  status(()=>db.commit(owner,data.id,2,'mutation-2',modified),409)
  expect(db.getSnapshot(owner,data.id).version).toBe(2)
})
it('rejects stale devices and does not partially commit when photos are missing',async()=>{
  const db=database(),owner=await register(db,'owner'),data=await seed(db,owner)
  status(()=>db.commit(owner,data.id,1,'missing-media',data.snapshot),409);expect(db.getSnapshot(owner,data.id).version).toBe(1)
  await upload(db,owner,data.id,data.uploads)
  db.commit(owner,data.id,1,'device-one',data.snapshot)
  const other=structuredClone(data.snapshot);other.events.push({id:'event-2',profileId:data.id,date:'2026-09-17',createdAt:new Date().toISOString(),type:'memory',text:'另一设备的未同步备注'})
  status(()=>db.commit(owner,data.id,1,'device-two',other),409)
  expect(db.getSnapshot(owner,data.id).snapshot?.events).toHaveLength(0)
})
it('isolates unrelated families, scopes child invitations and revokes access immediately',async()=>{
  const db=database(),owner=await register(db,'parent'),child=await register(db,'child'),outsider=await register(db,'outsider'),data=await seed(db,owner),other=await seed(db,owner)
  await upload(db,owner,data.id,data.uploads);db.commit(owner,data.id,1,'seed',data.snapshot)
  status(()=>db.getSnapshot(outsider,data.id),403);status(()=>db.getAsset(outsider,data.id,[...data.uploads.keys()][0]),403)
  const invitation=db.invite(owner,data.family.id,'child','child',[data.id])
  expect(db.inspectInvite(child,invitation.token).profiles).toEqual([{id:data.id,nickname:data.archive.profiles[0].nickname}])
  status(()=>db.acceptInvite(outsider,invitation.token,CLOUD_CONSENT_VERSION),404)
  db.acceptInvite(child,invitation.token,CLOUD_CONSENT_VERSION)
  expect(db.listProfiles(child,data.family.id).map(p=>p.id)).toEqual([data.id])
  status(()=>db.getSnapshot(child,other.id),403);status(()=>db.invite(child,data.family.id,'outsider','guardian',[data.id]),403)
  status(()=>db.deleteProfile(child,data.id,2),403)
  db.removeMember(owner,data.family.id,child.id)
  status(()=>db.getSnapshot(child,data.id),403);status(()=>db.putAsset(child,data.id,'new','image/png',new Uint8Array([1])),403)
})
it('makes invitations single-use, bound to a login name, revocable and expiring',async()=>{
  let time=Date.now();const db=database(':memory:',()=>time),owner=await register(db,'owner'),child=await register(db,'child'),data=await seed(db,owner)
  const cancelled=db.invite(owner,data.family.id,'child','child',[data.id]);db.revokeInvite(owner,data.family.id,cancelled.id);status(()=>db.acceptInvite(child,cancelled.token,CLOUD_CONSENT_VERSION),404)
  const expired=db.invite(owner,data.family.id,'child','child',[data.id]);time+=8*86400_000;status(()=>db.acceptInvite(child,expired.token,CLOUD_CONSENT_VERSION),404)
  const fresh=db.invite(owner,data.family.id,'child','child',[data.id]);db.acceptInvite(child,fresh.token,CLOUD_CONSENT_VERSION);status(()=>db.acceptInvite(child,fresh.token,CLOUD_CONSENT_VERSION),404)
})
it('erases profile content and photos, leaves a versioned tombstone and blocks offline resurrection',async()=>{
  const db=database(),owner=await register(db,'owner'),data=await seed(db,owner);await upload(db,owner,data.id,data.uploads);db.commit(owner,data.id,1,'seed',data.snapshot)
  expect(db.deleteProfile(owner,data.id,2)).toEqual({version:3,deleted:true})
  expect(db.getSnapshot(owner,data.id)).toEqual({id:data.id,familyId:data.family.id,version:3,deleted:true,snapshot:null,deletedEntities:[],authors:[]})
  expect(db.db.prepare('SELECT count(*) AS n FROM assets WHERE profile_id=?').get(data.id)?.n).toBe(0)
  status(()=>db.commit(owner,data.id,2,'old-device',data.snapshot),410)
})
it('persists across reopen and stores password/session/recovery hashes instead of bearer secrets',async()=>{
  const base=resolve('.tmp');await mkdir(base,{recursive:true});const folder=await mkdtemp(join(base,'cloud-db-'));folders.push(folder)
  const path=join(folder,'family.sqlite'),db=database(path),registration=await db.register('owner','test-password-1234','工程家长'),login=await db.login('owner','test-password-1234'),data=await seed(db,login.user)
  const row=db.db.prepare('SELECT * FROM users').get()!;expect(row.password_hash).not.toBe('test-password-1234');expect(row.recovery_hash).not.toBe(registration.recoveryCode)
  expect(db.db.prepare('SELECT token_hash FROM auth_sessions').get()?.token_hash).not.toBe(login.token)
  expect(db.verifyCsrf(login.token,db.csrfFor(login.token))).toBe(true)
  db.close();databases.delete(db);const reopened=database(path)
  expect(reopened.authenticate(login.token)?.username).toBe('owner');expect(reopened.getSnapshot(login.user,data.id).version).toBe(1)
  await reopened.recover('owner',registration.recoveryCode,'replacement-password-123')
  expect(reopened.authenticate(login.token)).toBeNull();await expect(reopened.recover('owner',registration.recoveryCode,'replacement-password-124')).rejects.toThrow('恢复码')
})
it('preserves child participation while limiting plan changes to pausing and protecting another author’s records',async()=>{
  const db=database(),owner=await register(db,'owner'),child=await register(db,'child'),data=await seed(db,owner);await upload(db,owner,data.id,data.uploads)
  data.snapshot.plans=[{profileId:data.id,enabled:true,intervalDays:28,nextDate:'2026-10-01',windowDays:7,time:'18:00',quietStart:'21:00',quietEnd:'08:00',owner:'together'}];db.commit(owner,data.id,1,'seed',data.snapshot)
  const invite=db.invite(owner,data.family.id,'child','child',[data.id]);db.acceptInvite(child,invite.token,CLOUD_CONSENT_VERSION)
  const pause=structuredClone(data.snapshot);pause.plans[0].enabled=false;expect(db.commit(child,data.id,2,'pause',pause).version).toBe(3)
  const edit=structuredClone(pause);edit.sessions[0].note='改写家长记录';status(()=>db.commit(child,data.id,3,'edit',edit),403)
  const enable=structuredClone(pause);enable.plans[0].enabled=true;status(()=>db.commit(child,data.id,3,'enable',enable),403)
})
it('keeps onboarding participation separate from authenticated family permissions',async()=>{
  const db=database(),owner=await register(db,'role-owner'),child=await register(db,'role-child'),data=await seed(db,owner);await upload(db,owner,data.id,data.uploads)
  data.snapshot.profile.participation='child';db.commit(owner,data.id,1,'participation-seed',data.snapshot)
  const invite=db.invite(owner,data.family.id,'role-child','child',[data.id]);db.acceptInvite(child,invite.token,CLOUD_CONSENT_VERSION)
  expect(db.families(child)[0].role).toBe('child')
  const changed=structuredClone(data.snapshot);changed.profile.participation='parent';status(()=>db.commit(child,data.id,2,'claim-parent',changed),403)
  status(()=>db.deleteProfile(child,data.id,2),403)
})
it('accepts child completion-driven scheduling but rejects arbitrary changes and preserves the completion evidence',async()=>{
  const db=database(),owner=await register(db,'complete-owner'),child=await register(db,'complete-child'),data=await seed(db,owner)
  const plan={profileId:data.id,enabled:true,intervalDays:28,nextDate:'2026-09-17',windowDays:7,time:'18:00',quietStart:'21:00',quietEnd:'08:00',owner:'together' as const};data.archive.plans=[plan]
  const seedData=await prepareCloudSnapshot(data.archive);await upload(db,owner,data.id,seedData.uploads);db.commit(owner,data.id,1,'setup-completion',seedData.snapshot)
  const invite=db.invite(owner,data.family.id,'complete-child','child',[data.id]);db.acceptInvite(child,invite.token,CLOUD_CONSENT_VERSION)
  const session=structuredClone(data.archive.sessions[0]);session.id='child-observation';session.recordedOn='2026-09-17';session.kind='measurement';session.recordedBy='child';session.createdAt='2026-09-17T08:00:00Z';session.revision=undefined;session.captures=['front','profile'].map(view=>({id:view as 'front'|'profile',label:view,eyebrow:'',hint:'',mediaId:session.id+'/'+view,poseValidation:{status:'pass',estimatedPose:view==='front'?'front':'left_profile',detectedFaces:1,flags:[]},quality:{score:90,resolution:90,brightness:90,contrast:90,sharpness:90,flags:[]}}))
  data.archive.sessions.push(session);for(const capture of session.captures)data.archive.media.push({id:capture.mediaId!,sessionId:session.id,profileId:data.id,blob:data.archive.media[0].blob})
  data.archive.plans=[completedPlan(plan,session,session.recordedOn)]
  const prepared=await prepareCloudSnapshot(data.archive);await upload(db,child,data.id,prepared.uploads)
  const forged=structuredClone(prepared.snapshot);forged.plans[0].nextDate='2027-01-01';status(()=>db.commit(child,data.id,2,'forged-date',forged),403)
  expect(db.commit(child,data.id,2,'completed-window',prepared.snapshot).version).toBe(3)
  expect(db.getSnapshot(child,data.id).snapshot?.plans[0].lastCompleted.sessionId).toBe(session.id)
  const noNewRecord=structuredClone(prepared.snapshot);noNewRecord.plans[0].nextDate='2026-11-12';status(()=>db.commit(child,data.id,3,'no-new-record',noNewRecord),403)
})
it('binds handoff tokens to existing access, one device and an expiry; creation and claim retries are idempotent',async()=>{
  let now=Date.now();const db=database(':memory:',()=>now),owner=await register(db,'handoff-owner'),outsider=await register(db,'handoff-outsider'),data=await seed(db,owner),token='a'.repeat(43),claim='b'.repeat(43)
  const task=db.createHandoff(owner,data.id,1,'handoff-1',token,'left_profile')
  expect(db.createHandoff(owner,data.id,1,'handoff-1',token,'left_profile').id).toBe(task.id)
  status(()=>db.inspectHandoff(outsider,token),403)
  expect(db.claimHandoff(owner,token,claim).state).toBe('claimed');expect(db.claimHandoff(owner,token,claim).state).toBe('claimed')
  status(()=>db.claimHandoff(owner,token,'c'.repeat(43)),409)
  const row=db.db.prepare('SELECT token_hash,claim_hash FROM handoffs').get()!;expect(row.token_hash).not.toBe(token);expect(row.claim_hash).not.toBe(claim)
  now+=31*60000;expect(db.handoffStatus(owner,task.id).state).toBe('expired');status(()=>db.claimHandoff(owner,token,claim),410)
})
it('requires a newly synced record from the claiming member, the requested views, and current permission to complete a handoff',async()=>{
  const db=database(),owner=await register(db,'handoff-parent'),child=await register(db,'handoff-child'),data=await seed(db,owner);await upload(db,owner,data.id,data.uploads);db.commit(owner,data.id,1,'handoff-seed',data.snapshot)
  const invitation=db.invite(owner,data.family.id,'handoff-child','child',[data.id]);db.acceptInvite(child,invitation.token,CLOUD_CONSENT_VERSION)
  const token='d'.repeat(43),claim='e'.repeat(43),task=db.createHandoff(owner,data.id,2,'handoff-delivery',token,'left_profile');db.claimHandoff(child,token,claim)
  const wrongSide=db.createHandoff(owner,data.id,2,'handoff-right','g'.repeat(43),'right_profile');db.claimHandoff(child,'g'.repeat(43),'h'.repeat(43))
  status(()=>db.completeHandoff(child,task.id,claim,data.archive.sessions[0].id),409)
  status(()=>db.completeHandoff(child,task.id,claim,'not-synced-yet'),409)
  const row=structuredClone(data.archive.sessions[0]);row.id='handoff-new-record';row.recordedBy='child';row.revision=undefined;row.captures=['front','profile'].map(view=>({id:view as 'front'|'profile',label:view,eyebrow:'',hint:'',mediaId:row.id+'/'+view,poseValidation:{status:'pass',estimatedPose:view==='front'?'front':'left_profile',detectedFaces:1,flags:[]}}));data.archive.sessions.push(row);for(const c of row.captures)data.archive.media.push({id:c.mediaId!,sessionId:row.id,profileId:data.id,blob:data.archive.media[0].blob})
  const prepared=await prepareCloudSnapshot(data.archive);await upload(db,child,data.id,prepared.uploads);db.commit(child,data.id,2,'handoff-uploaded',prepared.snapshot)
  status(()=>db.completeHandoff(child,wrongSide.id,'h'.repeat(43),row.id),409)
  expect(db.completeHandoff(child,task.id,claim,row.id).state).toBe('completed');expect(db.completeHandoff(child,task.id,claim,row.id).sessionId).toBe(row.id)
  expect(db.handoffStatus(owner,task.id).sessionId).toBe(row.id)
  const revoked=db.createHandoff(owner,data.id,3,'handoff-revoke','f'.repeat(43),null);db.revokeHandoff(owner,revoked.id);status(()=>db.claimHandoff(child,'f'.repeat(43),claim),410)
  db.removeMember(owner,data.family.id,child.id);status(()=>db.inspectHandoff(child,token),403)
})
it('rejects cross-profile media references and changed originals in an imported revision',async()=>{
  const archive=archiveFixture(),prepared=await prepareCloudSnapshot(archive),bad=structuredClone(prepared.snapshot)
  bad.media[0].profileId='another';expect(()=>validateCloudSnapshot(bad,archive.profiles[0].id)).toThrow()
  const changed=structuredClone(prepared.snapshot);changed.media[1].original!.sha256='a'.repeat(64);expect(()=>validateCloudSnapshot(changed,archive.profiles[0].id)).toThrow()
})

async function httpServer(){const db=database(),handler=createFamilyHandler(db,{HEADUP_APP_ORIGINS:'http://127.0.0.1:5190',HEADUP_REGISTRATION_CODE:'test-registration-code'}),server=createServer((req,res)=>{void handler(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end()}})});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return{db,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/family`}}
const request=(url:string,body:unknown,cookie='',csrf='',origin='http://127.0.0.1:5190')=>fetch(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-HeadUp-Request':'1',Cookie:cookie,'X-HeadUp-Csrf':csrf},body:JSON.stringify(body)})
it('enforces HTTP share origin, CSRF, exact recipient and no-store photo responses through revocation',async()=>{
  const {db,url}=await httpServer(),x=await shareSeed(db),login=async(name:string)=>{const r=await request(url+'/auth/login',{username:name,password:'test-password-1234'});return{cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:(await r.json()).csrf}}
  const owner=await login(x.owner.username),reader=await login(x.recipient.username),body={profileId:x.data.id,version:2,id:x.id,token:x.token,recipient:x.recipient.username,ttlHours:24,scope:x.scope,consentVersion:SHARE_PROTOCOL}
  expect((await request(url+'/shares',body,owner.cookie,'bad')).status).toBe(403);expect((await request(url+'/shares',body,owner.cookie,owner.csrf,'https://other.example')).status).toBe(403)
  expect((await request(url+'/shares/preview',body,owner.cookie,owner.csrf)).status).toBe(200);expect(db.listShares(x.owner,x.data.id)).toHaveLength(0)
  expect((await request(url+'/shares',body,owner.cookie,owner.csrf)).status).toBe(201);expect((await request(url+'/shares/read',{token:x.token})).status).toBe(401)
  expect((await request(url+'/shares/read',{token:x.token},owner.cookie,owner.csrf)).status).toBe(404)
  const contentResponse=await request(url+'/shares/read',{token:x.token},reader.cookie,reader.csrf),shared=await contentResponse.json();expect(contentResponse.status).toBe(200);expect(contentResponse.headers.get('cache-control')).toBe('no-store')
  const ref=shared.content.sessions[0].photos[0].ref,image=await request(url+'/shares/read-photo',{token:x.token,ref},reader.cookie,reader.csrf);expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/png');expect(image.headers.get('cache-control')).toBe('no-store');expect(image.headers.get('cross-origin-resource-policy')).toBe('same-origin');expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0)
  expect((await fetch(url+'/profiles/'+x.data.id,{headers:{Cookie:reader.cookie}})).status).toBe(403);expect((await fetch(url+'/profiles/'+x.data.id+'/shares',{headers:{Cookie:reader.cookie}})).status).toBe(403)
  const revoked=await fetch(url+'/shares/'+x.id,{method:'DELETE',headers:{Origin:'http://127.0.0.1:5190','X-HeadUp-Request':'1','X-HeadUp-Csrf':owner.csrf,Cookie:owner.cookie}});expect(revoked.status).toBe(200)
  expect((await request(url+'/shares/read-photo',{token:x.token,ref},reader.cookie,reader.csrf)).status).toBe(410);expect((await request(url+'/shares/read',{token:x.token},reader.cookie,reader.csrf)).status).toBe(410)
})
it('upgrades schema 3 without losing existing accounts, records or photos',async()=>{
  await mkdir(resolve('.tmp'),{recursive:true});const folder=await mkdtemp(resolve('.tmp/share-migration-'));folders.push(folder);const path=join(folder,'family.sqlite'),old=database(path),x=await shareSeed(old)
  old.db.exec('DROP TABLE shares; DROP TABLE family_delete_receipts; PRAGMA user_version=3');old.close();databases.delete(old)
  const upgraded=database(path);expect(Number(upgraded.db.prepare('PRAGMA user_version').get()?.user_version)).toBe(5);expect(upgraded.getSnapshot(x.owner,x.data.id).snapshot?.sessions).toHaveLength(2);expect(upgraded.getAsset(x.owner,x.data.id,[...x.data.uploads.keys()][0]).data.length).toBeGreaterThan(0)
  upgraded.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,24,x.scope,SHARE_PROTOCOL);expect(upgraded.readShare(x.recipient,x.token).content.sessions).toHaveLength(1)
})
it('exposes handoff HTTP operations only behind authenticated origin and CSRF checks',async()=>{
  const {db,url}=await httpServer(),owner=await register(db,'handoff-http'),data=await seed(db,owner)
  const login=await request(url+'/auth/login',{username:'handoff-http',password:'test-password-1234'}),cookie=login.headers.get('set-cookie')!.split(';')[0],auth=await login.json(),body={profileId:data.id,version:1,id:'http-handoff',token:'j'.repeat(43),side:null}
  expect((await request(url+'/handoffs',body)).status).toBe(401)
  expect((await request(url+'/handoffs',body,cookie,'invalid')).status).toBe(403)
  expect((await request(url+'/handoffs',body,cookie,auth.csrf)).status).toBe(201)
  expect((await request(url+'/handoffs/inspect',{token:body.token})).status).toBe(401)
  expect((await request(url+'/handoffs/claim',{token:body.token,claimId:'k'.repeat(43)},cookie,auth.csrf,'https://other.example')).status).toBe(403)
  expect((await request(url+'/handoffs/claim',{token:body.token,claimId:'k'.repeat(43)},cookie,auth.csrf)).status).toBe(200)
  expect((await(await fetch(url+'/handoffs/http-handoff',{headers:{Cookie:cookie}})).json()).state).toBe('claimed')
})
it('completes delayed logout for the exact old session without invalidating a newer login',async()=>{
  const{db,url}=await httpServer();const user=await register(db,'offline-owner'),old=await db.login('offline-owner','test-password-1234'),fresh=await db.login('offline-owner','test-password-1234'),proof=db.csrfFor(old.token),cookie=`headup_session=${fresh.token}`
  expect((await request(url+'/auth/logout-proof',{userId:user.id,proof},cookie,'','https://other.example')).status).toBe(403)
  expect(db.authenticate(old.token)).not.toBeNull()
  const result=await request(url+'/auth/logout-proof',{userId:user.id,proof},cookie)
  expect(result.status).toBe(200);expect(result.headers.get('set-cookie')).toBeNull();expect((await result.json()).currentSessionCleared).toBe(false)
  expect(db.authenticate(old.token)).toBeNull();expect(db.authenticate(fresh.token)?.id).toBe(user.id)
  expect((await request(url+'/auth/logout-proof',{userId:user.id,proof},cookie)).status).toBe(200)
  const active=await request(url+'/auth/logout-proof',{userId:user.id,proof:db.csrfFor(fresh.token)},cookie)
  expect((await active.json()).currentSessionCleared).toBe(true);expect(active.headers.get('set-cookie')).toContain('Max-Age=0');expect(db.authenticate(fresh.token)).toBeNull()
})
it('enforces HTTP origin, registration code, HttpOnly cookies and CSRF independently',async()=>{
  const{url}=await httpServer(),registration={username:'test-user',displayName:'工程测试',password:'test-password-1234',registrationCode:'test-registration-code'}
  expect((await request(url+'/auth/register',registration,'','','https://other.example')).status).toBe(403)
  expect((await request(url+'/auth/register',{...registration,registrationCode:'wrong'})).status).toBe(403)
  expect((await request(url+'/auth/register',registration)).status).toBe(201)
  const login=await request(url+'/auth/login',registration),header=login.headers.get('set-cookie')!,cookie=header.split(';')[0],body=await login.json()
  expect(header).toContain('HttpOnly');expect(header).toContain('SameSite=Strict')
  expect((await request(url+'/families',{name:'工程家庭'},cookie,'wrong')).status).toBe(403)
  expect((await fetch(url+'/families',{method:'POST',headers:{Origin:'http://127.0.0.1:5190','Content-Type':'application/json','X-HeadUp-Request':'1','X-HeadUp-Csrf':body.csrf,'X-HeadUp-Account':'another-account',Cookie:cookie},body:JSON.stringify({name:'不应创建'})})).status).toBe(409)
  expect((await request(url+'/families',{name:'工程家庭'},cookie,body.csrf)).status).toBe(201)
  const me=await(await fetch(url+'/me',{headers:{Cookie:cookie}})).json();expect(me.csrf).toBe(body.csrf)
  expect((await request(url+'/auth/logout',{},cookie,body.csrf)).status).toBe(200)
  expect((await fetch(url+'/me',{headers:{Cookie:cookie}})).status).toBe(401)
})
it('moves actual binary photos over authenticated HTTP and accepts exactly one concurrent snapshot version',async()=>{
  const{db,url}=await httpServer();await register(db,'http-owner')
  const login=await request(url+'/auth/login',{username:'http-owner',password:'test-password-1234'}),cookie=login.headers.get('set-cookie')!.split(';')[0],auth=await login.json(),headers={Origin:'http://127.0.0.1:5190','X-HeadUp-Request':'1',Cookie:cookie,'X-HeadUp-Csrf':auth.csrf,'X-HeadUp-Version':'1'}
  const family=await(await request(url+'/families',{name:'HTTP工程家庭'},cookie,auth.csrf)).json(),prepared=await prepareCloudSnapshot(archiveFixture()),id=prepared.snapshot.profile.id
  expect((await request(`${url}/families/${family.id}/profiles`,{profile:prepared.snapshot.profile,consentVersion:CLOUD_CONSENT_VERSION},cookie,auth.csrf)).status).toBe(201)
  const firstKey=[...prepared.uploads.keys()][0]
  expect((await fetch(`${url}/profiles/${id}/media?key=${encodeURIComponent(firstKey)}`,{method:'PUT',headers:{...headers,'Content-Type':'image/png'},body:'broken'})).status).toBe(400)
  for(const[key,blob]of prepared.uploads){const r=await fetch(`${url}/profiles/${id}/media?key=${encodeURIComponent(key)}`,{method:'PUT',headers:{...headers,'Content-Type':blob.type},body:blob});expect(r.status).toBe(200)}
  expect((await fetch(`${url}/profiles/${id}/media?key=${encodeURIComponent(firstKey)}`,{headers:{Cookie:cookie}})).status).toBe(404)
  const commit=(mutationId:string)=>fetch(`${url}/profiles/${id}`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({version:1,mutationId,snapshot:prepared.snapshot})})
  const replies=await Promise.all([commit('device-a'),commit('device-b')]);expect(replies.map(r=>r.status).sort()).toEqual([200,409])
  const image=await fetch(`${url}/profiles/${id}/media?key=${encodeURIComponent(firstKey)}`,{headers:{Cookie:cookie}});expect(await image.arrayBuffer()).toEqual(await prepared.uploads.get(firstKey)!.arrayBuffer());expect(image.headers.get('cache-control')).toBe('no-store')
  expect((await fetch(`${url}/profiles/${id}`,{headers:{Cookie:cookie,'If-None-Match':'"2"'}})).status).toBe(304)
  expect((await fetch(`${url}/profiles/${id}`,{method:'DELETE',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({version:2})})).status).toBe(200)
  expect((await fetch(`${url}/profiles/${id}/media?key=${encodeURIComponent(firstKey)}`,{headers:{Cookie:cookie}})).status).toBe(410)
})
it('bounds simultaneous password work after request bodies have arrived',async()=>{
  const{db,url}=await httpServer();await register(db,'rate-user');const original=db.login.bind(db);let active=0,maximum=0
  db.login=async(...args)=>{active++;maximum=Math.max(maximum,active);try{await new Promise(r=>setTimeout(r,150));return await original(...args)}finally{active--}}
  const replies=await Promise.all(Array.from({length:4},()=>request(url+'/auth/login',{username:'rate-user',password:'test-password-1234'})))
  expect(maximum).toBeLessThanOrEqual(2);expect(replies.filter(r=>r.status===429).length).toBeGreaterThan(0)
})
it('requires HTTPS for remote origins and secure cookies for HTTPS',()=>{
  const db=database();expect(()=>createFamilyHandler(db,{HEADUP_APP_ORIGINS:'http://example.com'})).toThrow('HTTPS')
  expect(()=>createFamilyHandler(db,{HEADUP_APP_ORIGINS:'https://example.com'})).toThrow('COOKIE_SECURE')
  expect(()=>createFamilyHandler(db,{HEADUP_APP_ORIGINS:'https://example.com',HEADUP_COOKIE_SECURE:'1'})).not.toThrow()
})
it('serves the built application while refusing database, hidden and traversal paths',async()=>{
  const base=resolve('.tmp');await mkdir(base,{recursive:true});const folder=await mkdtemp(join(base,'cloud-static-'));folders.push(folder);const directory=join(folder,'public');await mkdir(directory)
  await writeFile(join(directory,'index.html'),'<h1>test-app</h1>');await writeFile(join(directory,'family.sqlite'),'private-database');await writeFile(join(directory,'.private.json'),'private-config');await writeFile(join(folder,'private.html'),'outside-root')
  const handler=staticApp(directory),server=createServer((q,r)=>void handler(q,r));servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  expect(await(await fetch(url)).text()).toContain('test-app')
  for(const path of ['/family.sqlite','/.private.json','/%2e%2e%2fprivate.html'])expect((await fetch(url+path)).status).toBe(404)
})
it('refuses a newer or incomplete database instead of silently resetting family records',async()=>{
  const base=resolve('.tmp');await mkdir(base,{recursive:true});const folder=await mkdtemp(join(base,'cloud-schema-'));folders.push(folder);const path=join(folder,'family.sqlite'),db=database(path)
  db.db.exec('PRAGMA user_version=99');db.close();databases.delete(db)
  expect(()=>new FamilyDatabase(path)).toThrow('更新版本')
  const {DatabaseSync}=await import('node:sqlite'),altered=new DatabaseSync(path);altered.exec('PRAGMA user_version=1; DROP TABLE sync_receipts');altered.close()
  expect(()=>new FamilyDatabase(path)).toThrow('结构不完整')
})
it('records per-record deletions and prevents resurrection even with a newly fetched profile version',async()=>{
  const db=database(),owner=await register(db,'owner'),data=await seed(db,owner);await upload(db,owner,data.id,data.uploads);db.commit(owner,data.id,1,'seed',data.snapshot)
  const partial=structuredClone(data.snapshot);partial.sessions.pop();partial.media.pop();status(()=>db.commit(owner,data.id,2,'drop-history',partial),409)
  const deleted=structuredClone(data.snapshot);deleted.sessions=[];deleted.media=[];db.commit(owner,data.id,2,'delete-record',deleted)
  expect(db.getSnapshot(owner,data.id).deletedEntities).toHaveLength(2)
  const [deletedKey,deletedBlob]=[...data.uploads.entries()][0];status(()=>db.putAsset(owner,data.id,deletedKey,deletedBlob.type,new Uint8Array([1])),409);status(()=>db.commit(owner,data.id,3,'resurrect',data.snapshot),409)
  expect(db.getSnapshot(owner,data.id).snapshot?.sessions).toEqual([])
})

it('atomically deletes every cloud profile in the reviewed family, invalidates derived access and replays without touching later profiles',async()=>{
  const db=database(),x=await shareSeed(db),second=await prepareCloudSnapshot(archiveFixture()),outside=await seed(db,x.owner)
  db.createProfile(x.owner,x.data.family.id,second.snapshot.profile,CLOUD_CONSENT_VERSION);await upload(db,x.owner,second.snapshot.profile.id,second.uploads);db.commit(x.owner,second.snapshot.profile.id,1,'second',second.snapshot)
  db.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,24,x.scope,SHARE_PROTOCOL);db.createHandoff(x.owner,x.data.id,2,'bulk-handoff','H'.repeat(43),null)
  const invite=db.invite(x.owner,x.data.family.id,x.stranger.username,'guardian',[x.data.id]),preview=db.familyDeletionPreview(x.owner,x.data.family.id)
  expect(preview.profiles).toHaveLength(2);expect(preview.profiles.reduce((n,p)=>n+p.records,0)).toBe(2)
  const receipt=db.deleteFamilyProfiles(x.owner,x.data.family.id,'delete-all',preview.scopeHash,preview.protocol)
  for(const profile of preview.profiles){expect(db.getSnapshot(x.owner,profile.id).deleted).toBe(true);expect(db.db.prepare('SELECT count(*) AS n FROM assets WHERE profile_id=?').get(profile.id)?.n).toBe(0)}
  expect(db.getSnapshot(x.owner,outside.id).deleted).toBe(false);status(()=>db.readShare(x.recipient,x.token),410);expect(db.db.prepare('SELECT state FROM handoffs WHERE id=?').get('bulk-handoff')?.state).toBe('revoked');status(()=>db.inspectInvite(x.stranger,invite.token),404)
  const later=archiveFixture().profiles[0];db.createProfile(x.owner,x.data.family.id,later,CLOUD_CONSENT_VERSION)
  expect(db.deleteFamilyProfiles(x.owner,x.data.family.id,'delete-all',preview.scopeHash,preview.protocol)).toEqual(receipt);expect(db.getSnapshot(x.owner,later.id).deleted).toBe(false)
  status(()=>db.deleteFamilyProfiles(x.owner,x.data.family.id,'delete-all','a'.repeat(64),preview.protocol),409)
})
it.each(['add','edit','delete','upload'] as const)('rejects a full-family deletion after a concurrent %s without deleting remaining profiles',async change=>{
  const db=database(),owner=await register(db,'delete-owner'),data=await seed(db,owner),preview=db.familyDeletionPreview(owner,data.family.id)
  if(change==='add')db.createProfile(owner,data.family.id,archiveFixture().profiles[0],CLOUD_CONSENT_VERSION)
  if(change==='edit'){const current=db.getSnapshot(owner,data.id).snapshot!;current.profile.nickname='更正后的昵称';db.commit(owner,data.id,1,'edit',current)}
  if(change==='delete')db.deleteProfile(owner,data.id,1)
  if(change==='upload')await upload(db,owner,data.id,data.uploads)
  const before=db.listProfiles(owner,data.family.id);status(()=>db.deleteFamilyProfiles(owner,data.family.id,'stale-request',preview.scopeHash,preview.protocol),409)
  expect(db.listProfiles(owner,data.family.id)).toEqual(before);expect(db.familyDeletionReceipt(owner,data.family.id,'stale-request')).toBeNull()
})
it('rolls back all family deletion changes if a later profile fails',async()=>{
  const db=database(),x=await shareSeed(db),second=archiveFixture().profiles[0];db.createProfile(x.owner,x.data.family.id,second,CLOUD_CONSENT_VERSION)
  db.createShare(x.owner,x.data.id,2,x.id,x.token,x.recipient.username,24,x.scope,SHARE_PROTOCOL)
  const preview=db.familyDeletionPreview(x.owner,x.data.family.id),last=preview.profiles.at(-1)!.id
  db.db.exec(`CREATE TRIGGER fail_later_delete BEFORE UPDATE OF deleted ON profiles WHEN OLD.id='${last}' BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END`)
  expect(()=>db.deleteFamilyProfiles(x.owner,x.data.family.id,'rollback',preview.scopeHash,preview.protocol)).toThrow('injected deletion failure')
  expect(db.familyDeletionPreview(x.owner,x.data.family.id)).toEqual(preview);expect(db.readShare(x.recipient,x.token).content.sessions).toHaveLength(1);expect(db.familyDeletionReceipt(x.owner,x.data.family.id,'rollback')).toBeNull()
})
it('enforces owner-only full-family deletion with HTTP authentication, origin, CSRF and receipt validation',async()=>{
  const {db,url}=await httpServer(),owner=await register(db,'bulk-owner'),guardian=await register(db,'bulk-guardian'),data=await seed(db,owner)
  const invite=db.invite(owner,data.family.id,guardian.username,'guardian',[data.id]);db.acceptInvite(guardian,invite.token,CLOUD_CONSENT_VERSION)
  const login=async(name:string)=>{const response=await request(url+'/auth/login',{username:name,password:'test-password-1234'});return{cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:(await response.json()).csrf}},auth=await login(owner.username),other=await login(guardian.username),path=url+'/families/'+data.family.id
  expect((await fetch(path+'/deletion-preview')).status).toBe(401);expect((await fetch(path+'/deletion-preview',{headers:{Cookie:other.cookie}})).status).toBe(403)
  const response=await fetch(path+'/deletion-preview',{headers:{Cookie:auth.cookie}}),preview=await response.json();expect(response.headers.get('cache-control')).toBe('no-store')
  const body={id:'http-full-delete',scopeHash:preview.scopeHash,protocol:preview.protocol}
  expect((await request(path+'/deletions',body,auth.cookie,'bad')).status).toBe(403);expect((await request(path+'/deletions',body,auth.cookie,auth.csrf,'https://other.example')).status).toBe(403);expect((await request(path+'/deletions',body,other.cookie,other.csrf)).status).toBe(403)
  const deleted=await request(path+'/deletions',body,auth.cookie,auth.csrf),receipt=await deleted.json();expect(deleted.status).toBe(200);expect(deleted.headers.get('cache-control')).toBe('no-store')
  expect(await(await request(path+'/deletions',body,auth.cookie,auth.csrf)).json()).toEqual(receipt)
  expect((await(await fetch(path+'/deletions/http-full-delete',{headers:{Cookie:auth.cookie}})).json()).receipt).toEqual(receipt)
  expect((await fetch(path+'/deletions/http-full-delete',{headers:{Cookie:other.cookie}})).status).toBe(403)
})
it('upgrades schema 4 with existing photos and retains deletion receipts across restart',async()=>{
  await mkdir(resolve('.tmp'),{recursive:true});const folder=await mkdtemp(resolve('.tmp/delete-migration-'));folders.push(folder);const path=join(folder,'family.sqlite'),old=database(path),x=await shareSeed(old)
  old.db.exec('DROP TABLE family_delete_receipts; PRAGMA user_version=4');old.close();databases.delete(old)
  const upgraded=database(path);expect(upgraded.getSnapshot(x.owner,x.data.id).snapshot?.sessions).toHaveLength(2);expect(upgraded.getAsset(x.owner,x.data.id,[...x.data.uploads.keys()][0]).data.length).toBeGreaterThan(0)
  const preview=upgraded.familyDeletionPreview(x.owner,x.data.family.id),receipt=upgraded.deleteFamilyProfiles(x.owner,x.data.family.id,'persist-delete',preview.scopeHash,preview.protocol);upgraded.close();databases.delete(upgraded)
  const reopened=database(path);expect(reopened.familyDeletionReceipt(x.owner,x.data.family.id,'persist-delete')).toEqual(receipt);expect(reopened.deleteFamilyProfiles(x.owner,x.data.family.id,'persist-delete',preview.scopeHash,preview.protocol)).toEqual(receipt)
})
