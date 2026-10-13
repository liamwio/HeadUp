import type {FamilyStore} from './store'
import {prepareCloudSnapshot} from './cloudSnapshot'
import {canonicalJson,type CloudRole} from './cloudContract'
import {snapshotHash} from './syncState'
import {deletedCompletionPlan} from './deletedCompletion'
import {SyncError,type CloudTransport} from './cloudTransport'
import type {SyncLink,RemoteState} from './syncTypes'

export type SyncTransport=Pick<CloudTransport,'userId'|'authenticate'|'profiles'|'create'|'get'|'upload'|'commit'|'remove'|'cancel'|'receipt'|'download'>
export class SyncEngine{
  readonly store:FamilyStore;readonly transport:SyncTransport;readonly familyId:string;readonly owner=crypto.randomUUID()
  role:CloudRole;private busy=false;private stopped=false;private controllers=new Map<string,AbortController>();onChange:()=>void=()=>{};onLocked:(message:string)=>void=()=>{}
  constructor(store:FamilyStore,transport:SyncTransport,familyId:string,role:CloudRole){this.store=store;this.transport=transport;this.familyId=familyId;this.role=role}
  stop(){this.stopped=true;this.controllers.forEach(c=>c.abort())}
  resume(){this.stopped=false}
  private verify(remote:RemoteState){if(remote.familyId!==this.familyId)throw new SyncError('wrong_family','该档案属于另一个家庭，未合并任何内容',409)}
  async connect(profileId:string){
    if(this.role!=='owner')throw new Error('请由家庭管理者加入本机档案')
    const state=await this.store.syncState(profileId);if(state.link)return state.link
    const profile=state.archive.profiles[0];if(!profile)throw new Error('本机档案不存在')
    const link:SyncLink={profileId,familyId:this.familyId,userId:this.transport.userId,enabled:true,role:this.role,generation:-1,version:0,baseHash:'',baseStamp:state.stamp,creationProfile:structuredClone(profile),status:'pending',updatedAt:new Date().toISOString()}
    return this.store.saveSyncLink(link,-1)
  }
  async subscribe(profileId:string){
    await this.transport.authenticate();const before=await this.store.syncState(profileId);if(before.link)return
    if(before.archive.profiles.length)throw new Error('本机已有同ID档案，请先处理关联，不能静默覆盖')
    const remote=await this.transport.get(profileId);this.verify(remote);if(remote.deleted||!remote.snapshot)throw new Error('该档案已经删除')
    const archive=await this.transport.download(remote),hash=await snapshotHash(remote.snapshot)
    const link=await this.store.saveSyncLink({profileId,familyId:this.familyId,userId:this.transport.userId,enabled:true,role:this.role,generation:-1,version:remote.version,baseHash:hash,baseSnapshot:remote.snapshot,baseStamp:before.stamp,status:'pending',authors:remote.authors,updatedAt:new Date().toISOString()},-1)
    if(link&&!await this.store.applyCloud(profileId,archive,before.stamp,{...link,status:'synced'}))throw new Error('本机档案在下载期间发生变化，未覆盖')
    this.onChange()
  }
  async pause(profileId:string,paused:boolean){this.controllers.get(profileId)?.abort();const state=await this.store.syncState(profileId);if(state.link)await this.store.saveSyncLink({...state.link,enabled:!paused,status:paused?'paused':'pending',message:undefined},state.link.generation);this.onChange()}
  private async update(link:SyncLink,changes:Partial<SyncLink>){const next=await this.store.saveSyncLink({...link,...changes},link.generation);this.onChange();return next}
  async run(){
    if(this.busy||this.stopped)return;this.busy=true
    try{await this.store.pruneDeletedSyncData();const me=await this.transport.authenticate();const family=me.families.find(f=>f.id===this.familyId);if(!family)throw new SyncError('access_revoked','这个账号已不再属于该家庭',403);this.role=family.role
      const index=(await this.transport.profiles(this.familyId)).profiles as Array<{id:string;version:number;deleted:boolean}>
      for(const link of await this.store.syncLinks()){if(this.stopped)break;if(link.userId!==this.transport.userId||link.familyId!==this.familyId||!link.enabled||['conflict','revoked','deleted'].includes(link.status))continue;const remote=index.find(p=>p.id===link.profileId);const local=await this.store.syncState(link.profileId);if(remote&&!remote.deleted&&remote.version===link.version&&link.status==='synced'&&local.stamp===link.baseStamp)continue;await this.syncOne(link.profileId)}
    }catch(e){const error=e instanceof SyncError?e:new SyncError('offline','同步暂不可用');if(['account_changed','login_required'].includes(error.code))this.onLocked(error.message);for(const link of await this.store.syncLinks())if(link.enabled&&!['conflict','revoked','deleted'].includes(link.status))await this.update(link,{status:error.code==='access_revoked'?'revoked':'offline',message:error.message})}
    finally{this.busy=false;this.onChange()}
  }
  private async syncOne(profileId:string){
    if(!await this.store.syncLease(profileId,this.owner))return
    const controller=new AbortController();this.controllers.set(profileId,controller);const signal=controller.signal
    const heartbeat=setInterval(()=>{void this.store.syncLease(profileId,this.owner).then(ok=>{if(!ok)controller.abort()}).catch(()=>controller.abort())},10000)
    try{
      let state=await this.store.syncState(profileId),link=state.link!;if(!link?.enabled)return
      if(link.version===0){
        if(!state.archive.profiles.length){await this.update(link,{status:'deleted',enabled:false});return}
        let remote:RemoteState
        try{await this.transport.create(this.familyId,link.creationProfile,signal);remote=await this.transport.get(profileId,signal)}catch(e){if(!(e instanceof SyncError)||e.code!=='profile_exists')throw e;remote=await this.transport.get(profileId,signal);this.verify(remote);if(remote.deleted||remote.version!==1||canonicalJson(remote.snapshot?.profile)!==canonicalJson(link.creationProfile))throw new SyncError('initial_conflict','服务器已有该档案，请先选择保留哪份内容',409)}
        this.verify(remote);const next=await this.update(link,{version:remote.version,baseHash:await snapshotHash(remote.snapshot!),baseSnapshot:remote.snapshot!,authors:remote.authors,status:'pending'});if(!next)return;link=next
      }
      state=await this.store.syncState(profileId);link=state.link!
      if(link.job){
        if(state.stamp!==link.job.localStamp){const result=await this.transport.cancel(profileId,link.job.mutationId,signal),receipt=result.receipt;const changes:Partial<SyncLink>={job:undefined,status:'pending'};if(receipt&&!receipt.cancelled){changes.version=receipt.version;changes.baseHash=await snapshotHash(link.job.snapshot);changes.authors=this.jobAuthors(link);changes.baseSnapshot=link.job.snapshot;changes.baseStamp=link.job.localStamp}const next=await this.update(link,changes);if(!next)return;link=next}
        else {await this.deliver(link,signal);return}
      }
      const remote=await this.transport.get(profileId,signal);this.verify(remote)
      state=await this.store.syncState(profileId);link=state.link!
      if(!link.enabled)return
      if(remote.deleted){
        if(state.archive.profiles.length&&state.stamp!==link.baseStamp)throw new SyncError('delete_conflict','云端已删除，本机还有未同步改动。两份状态均保留，请处理冲突',409)
        await this.store.applyCloud(profileId,{profiles:[],sessions:[],plans:[],events:[],media:[]},state.stamp,{...link,version:remote.version,job:undefined,enabled:false,status:'deleted'});return
      }
      if(!state.archive.profiles.length){
        if(remote.version!==link.version)throw new SyncError('delete_conflict','本机请求删除，但另一设备有新改动，请处理冲突',409)
        const result=await this.transport.remove(profileId,link.version,signal);await this.update(link,{version:result.version,enabled:false,status:'deleted',job:undefined,message:undefined});return
      }
      if(this.role==='child'&&remote.version===link.version){const restored=deletedCompletionPlan(state.archive,remote.snapshot!);if(restored){if(!await this.store.replacePlanForSync(profileId,state.stamp,link.generation,restored))return;state=await this.store.syncState(profileId);link=state.link!}}
      const prepared=await prepareCloudSnapshot(state.archive,link.baseSnapshot),localHash=await snapshotHash(prepared.snapshot),remoteHash=await snapshotHash(remote.snapshot!)
      if(localHash===remoteHash){if(link.status!=='synced'||link.version!==remote.version||link.baseHash!==remoteHash)await this.update(link,{version:remote.version,baseHash:remoteHash,baseSnapshot:remote.snapshot!,baseStamp:state.stamp,authors:remote.authors,status:'synced',message:undefined});return}
      if(localHash===link.baseHash){const archive=await this.transport.download(remote,signal,{archive:state.archive,baseline:link.baseSnapshot});await this.store.applyCloud(profileId,archive,state.stamp,{...link,version:remote.version,baseHash:remoteHash,baseSnapshot:remote.snapshot!,authors:remote.authors,job:undefined,status:'synced',message:undefined});return}
      if(remote.version!==link.version)throw new SyncError('version_conflict','本机和云端均有修改，未覆盖任何一方。请选择冲突处理方式',409)
      const job={mutationId:crypto.randomUUID(),version:link.version,snapshot:prepared.snapshot,uploads:[...prepared.uploads].map(([key,blob])=>({key,blob})),localStamp:state.stamp}
      const queued=await this.store.queueSync({...link,job,status:'pending',message:undefined},state.stamp);if(queued)await this.deliver(queued,signal)
    }catch(e){const current=(await this.store.syncState(profileId)).link;if(current?.enabled&&e instanceof SyncError&&e.code!=='cancelled'){const status=e.status===409?'conflict':['forbidden','access_revoked'].includes(e.code)?'revoked':e.status===401||e.code==='csrf_invalid'?'offline':e.status===0?'offline':'error';await this.update(current,{status,message:e.message});if(e.status===401||['account_changed','csrf_invalid'].includes(e.code))this.onLocked(e.message)}else if(current?.enabled&&!(e instanceof SyncError))await this.update(current,{status:'error',message:e instanceof Error?e.message:'同步失败，本机内容仍保留'})}
    finally{clearInterval(heartbeat);this.controllers.delete(profileId);await this.store.syncLease(profileId,this.owner,true);this.onChange()}
  }
  private jobAuthors(link:SyncLink){const authors=[...(link.authors??[])];if(link.job)for(const[kind,items]of [['session',link.job.snapshot.sessions],['event',link.job.snapshot.events]] as const)for(const item of items)if(!authors.some(a=>a.kind===kind&&a.id===item.id))authors.push({kind,id:item.id,userId:this.transport.userId});return authors}
  private async deliver(link:SyncLink,signal:AbortSignal){
    const active=await this.update(link,{status:'syncing',message:undefined});if(!active)return;link=active
    const job=link.job!;let response:any
    const receipt=(await this.transport.receipt(link.profileId,job.mutationId,signal)).receipt
    if(receipt?.cancelled){await this.update(link,{job:undefined,status:'pending',message:'先前尝试已取消，将重新检查本机待同步内容'});return}
    if(receipt)response={version:receipt.version}
    else{
      const remote=await this.transport.get(link.profileId,signal);this.verify(remote)
      if(remote.deleted)throw new SyncError('delete_conflict','云端已删除，本机待同步内容仍保留，请处理冲突',409)
      if(remote.version!==job.version){const late=(await this.transport.receipt(link.profileId,job.mutationId,signal)).receipt;if(late&&!late.cancelled)response={version:late.version};else throw new SyncError('version_conflict','另一设备已更新，待同步内容仍保留',409)}
      // Stored blobs belong to this exact durable job, even if a later edit removes them from the live archive.
      if(!response){
        const previous=new Map(link.baseSnapshot?.media.flatMap(m=>[m.processed,...(m.original?[m.original]:[])]).map(ref=>[ref.key,ref.sha256])??[]),next=new Map(job.snapshot.media.flatMap(m=>[m.processed,...(m.original?[m.original]:[])]).map(ref=>[ref.key,ref.sha256]))
        for(const item of job.uploads)if(previous.get(item.key)!==next.get(item.key))await this.transport.upload(link.profileId,item.key,item.blob,job.version,signal)
        try{response=await this.transport.commit(link.profileId,job.version,job.mutationId,job.snapshot,signal)}catch(e){if(!(e instanceof SyncError)||e.code!=='media_incomplete')throw e;for(const item of job.uploads)await this.transport.upload(link.profileId,item.key,item.blob,job.version,signal);response=await this.transport.commit(link.profileId,job.version,job.mutationId,job.snapshot,signal)}
      }
    }
    const current=await this.store.syncState(link.profileId)
    await this.update(link,{version:response.version,baseHash:await snapshotHash(job.snapshot),baseSnapshot:job.snapshot,authors:this.jobAuthors(link),baseStamp:job.localStamp,job:undefined,status:current.stamp===job.localStamp?'synced':'pending',message:undefined})
  }
  async useServer(profileId:string){
    await this.transport.authenticate();this.controllers.get(profileId)?.abort()
    const leaseOwner=this.owner+':resolve:'+crypto.randomUUID()
    if(!await this.store.syncLease(profileId,leaseOwner))throw new Error('另一页面正在同步，请稍后重试')
    const controller=new AbortController();this.controllers.set(profileId,controller);const signal=controller.signal,heartbeat=setInterval(()=>{void this.store.syncLease(profileId,leaseOwner).then(ok=>{if(!ok)controller.abort()}).catch(()=>controller.abort())},10000)
    try{const initial=await this.store.syncState(profileId);let link=initial.link!;if(!link)throw new Error('同步关联不存在');if(link.job)await this.transport.cancel(profileId,link.job.mutationId,signal)
      const remote=await this.transport.get(profileId,signal);this.verify(remote);const archive=await this.transport.download(remote,signal),hash=remote.snapshot?await snapshotHash(remote.snapshot):''
      if(signal.aborted||this.stopped)throw new Error('已停止处理，本机内容未改变')
      const applied=await this.store.applyCloud(profileId,archive,initial.stamp,{...link,version:remote.version,baseHash:hash,baseSnapshot:remote.snapshot??undefined,authors:remote.authors,job:undefined,status:remote.deleted?'deleted':'synced',enabled:!remote.deleted,message:undefined},'处理同步冲突前保留的本机版本')
      if(!applied)throw new Error('本机又有新改动，未覆盖。请重新查看冲突。')
    }finally{clearInterval(heartbeat);this.controllers.delete(profileId);await this.store.syncLease(profileId,leaseOwner,true);this.onChange()}
  }
}
