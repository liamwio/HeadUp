import type {CloudSnapshot,CloudRole} from './cloudContract'
import {CLOUD_CONSENT_VERSION,validateCloudSnapshot} from './cloudContract'
import type {Archive} from './backup'
import type {RemoteState} from './syncTypes'
import {preflightImageFile} from '../lib/imageInputPreflight'
import {flushPendingLogout} from './pendingLogout'
export class SyncError extends Error{code:string;status:number;constructor(code:string,message:string,status=0){super(message);this.code=code;this.status=status}}
export type CloudIdentity={user:{id:string;username:string;displayName:string};csrf:string;families:Array<{id:string;name:string;role:CloudRole}>}
export class CloudTransport{
  readonly base:string;readonly userId:string;private csrf=''
  constructor(userId:string,base='/api/family'){if(!/^\/[a-zA-Z0-9/_-]+$/.test(base)||base.startsWith('//'))throw new Error('同步接口必须位于当前站点');this.base=base;this.userId=userId}
  async request(path:string,method='GET',body?:unknown,headers:Record<string,string>={},signal?:AbortSignal):Promise<any>{
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),body instanceof Blob?120000:30000),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)abort.abort()
    try{const response=await fetch(this.base+path,{method,redirect:'error',credentials:'same-origin',cache:'no-store',signal:abort.signal,headers:{'Content-Type':body instanceof Blob?body.type:'application/json','X-HeadUp-Request':'1','X-HeadUp-Csrf':this.csrf,'X-HeadUp-Account':this.userId,...headers},body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});if(!response.ok){let error:any;try{error=await response.json()}catch{}throw new SyncError(error?.error??'service_error',error?.message??'同步服务暂不可用',response.status)}return headers.Accept==='application/octet-stream'?response.blob():response.json()}catch(e){if(e instanceof SyncError)throw e;throw new SyncError(signal?.aborted?'cancelled':'offline',signal?.aborted?'本次同步已停止':'网络暂不可用，待同步内容已保存在本机')}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel)}
  }
  async authenticate(signal?:AbortSignal):Promise<CloudIdentity>{await flushPendingLogout();const me=await this.request('/me','GET',undefined,{},signal);if(me.user?.id!==this.userId)throw new SyncError('account_changed','登录账号已变化，请切回原账号后继续同步',409);this.csrf=me.csrf;return me}
  profiles(familyId:string,signal?:AbortSignal){return this.request(`/families/${familyId}/profiles`,'GET',undefined,{},signal)}
  create(familyId:string,profile:any,signal?:AbortSignal){return this.request(`/families/${familyId}/profiles`,'POST',{profile,consentVersion:CLOUD_CONSENT_VERSION},{},signal)}
  get(id:string,signal?:AbortSignal):Promise<RemoteState>{return this.request(`/profiles/${id}`,'GET',undefined,{},signal)}
  upload(id:string,key:string,blob:Blob,version:number,signal?:AbortSignal){return this.request(`/profiles/${id}/media?key=${encodeURIComponent(key)}`,'PUT',blob,{'X-HeadUp-Version':String(version)},signal)}
  commit(id:string,version:number,mutationId:string,snapshot:CloudSnapshot,signal?:AbortSignal){return this.request(`/profiles/${id}`,'PUT',{version,mutationId,snapshot},{},signal)}
  remove(id:string,version:number,signal?:AbortSignal){return this.request(`/profiles/${id}`,'DELETE',{version},{},signal)}
  cancel(id:string,mutationId:string,signal?:AbortSignal){return this.request(`/profiles/${id}/mutations/${mutationId}`,'DELETE',undefined,{},signal)}
  receipt(id:string,mutationId:string,signal?:AbortSignal){return this.request(`/profiles/${id}/mutations/${mutationId}`,'GET',undefined,{},signal)}
  async download(state:RemoteState,signal?:AbortSignal,cache?:{archive:Archive;baseline?:CloudSnapshot}):Promise<Archive>{
    if(!state.snapshot)return{profiles:[],sessions:[],media:[],plans:[],events:[]}
    const snapshot=validateCloudSnapshot(structuredClone(state.snapshot),state.id),media:Archive['media']=[]
    for(const m of snapshot.media){const load=async(ref:typeof m.processed)=>{const prior=cache?.baseline?.media.find(old=>old.id===m.id),local=cache?.archive.media.find(old=>old.id===m.id),isOriginal=ref.key.endsWith('~original'),oldRef=isOriginal?prior?.original:prior?.processed,oldBlob=isOriginal?local?.originalBlob:local?.blob;if(oldRef?.sha256===ref.sha256&&oldBlob?.size===ref.size&&oldBlob?.type===ref.type)return oldBlob;const blob=await this.request(`/profiles/${state.id}/media?key=${encodeURIComponent(ref.key)}`,'GET',undefined,{Accept:'application/octet-stream'},signal) as Blob;if(blob.size!==ref.size||blob.type!==ref.type)throw new SyncError('media_corrupt','同步照片大小或格式不一致');const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());if(Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')!==ref.sha256)throw new SyncError('media_corrupt','同步照片校验失败，当前档案未改变');await preflightImageFile(new File([blob],'cloud-photo',{type:blob.type}));return blob};media.push({id:m.id,sessionId:m.sessionId,profileId:m.profileId,blob:await load(m.processed),originalBlob:m.original?await load(m.original):undefined})}
    return {profiles:[snapshot.profile],sessions:snapshot.sessions,plans:snapshot.plans,events:snapshot.events,media} as Archive
  }
}
