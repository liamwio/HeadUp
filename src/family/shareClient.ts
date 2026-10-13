import {cloudId,canonicalJson} from './cloudContract'
import {handoffLink,validHandoffSecret} from './handoff'
import {validateShareScope,SHARE_PROTOCOL,type ShareContent,type ShareScope} from './shareContract'
export type ShareInfo={id:string;profileId:string;creatorId:string;creatorName:string;recipient:{username:string;displayName:string};createdAt:number;expiresAt:number;state:'active'|'revoked'|'expired';scope:ShareScope}
export type ShareIntent={id:string;token:string;profileId:string;version:number;recipient:string;ttlHours:number;scope:ShareScope;consentVersion:typeof SHARE_PROTOCOL}
const fail=():never=>{throw new Error('分享响应无法核验，请重新读取')}
const string=(v:any,max=2000)=>typeof v==='string'&&v.length<=max?v:fail()
const number=(v:any)=>Number.isFinite(v)&&v>0&&v<=8640000000000000?v:fail()
const array=(v:any,max:number)=>Array.isArray(v)&&v.length<=max?v:fail()
export function shareLink(href:string,token:string,allowLocal=false){try{return handoffLink(href,token,allowLocal).replace('#family/handoff/','#family/shared/')}catch{throw new Error('分享链接需要接收方可访问的HTTPS入口；本机地址仅用于工程验收。')}}
export function validateShareInfo(v:any):ShareInfo{if(!v||![v.id,v.profileId,v.creatorId].every(cloudId)||!['active','revoked','expired'].includes(v.state))fail();return{id:v.id,profileId:v.profileId,creatorId:v.creatorId,creatorName:string(v.creatorName,40),recipient:{username:string(v.recipient?.username,64),displayName:string(v.recipient?.displayName,40)},createdAt:number(v.createdAt),expiresAt:number(v.expiresAt),state:v.state,scope:validateShareScope(v.scope)}}
export function validateShareContent(v:any):ShareContent{
  if(v?.schema!=='HEADUP-SHARED-CONTENT-1')fail()
  const sessions=array(v.sessions,100).map(s=>({ref:string(s.ref,20),date:string(s.date,10),kind:['measurement','memory'].includes(s.kind)?s.kind:fail(),photos:array(s.photos,6).map(p=>({ref:typeof p.ref==='string'&&/^R\d+-(front|profile|top)-(original|analysis)$/.test(p.ref)?p.ref:fail(),view:string(p.view,10),label:string(p.label,100)})),readings:array(s.readings,500).map(r=>({label:string(r.label,300),value:string(r.value),view:string(r.view,10),experimental:typeof r.experimental==='boolean'?r.experimental:fail()})),...(s.note!==undefined?{note:string(s.note,1000)}:{}),...(s.issues!==undefined?{issues:array(s.issues,100).map(x=>string(x))}:{}),...(s.versions?{versions:{algorithm:string(s.versions.algorithm),norm:string(s.versions.norm)}}:{})}))
  const events=array(v.events,100).map(e=>({ref:string(e.ref,20),date:string(e.date,10),type:string(e.type,20),...Object.fromEntries(['text','source','author','status','discussedOn','discussionNote'].filter(k=>e[k]!==undefined).map(k=>[k,string(e[k])]))}))
  return {schema:v.schema,...(v.nickname!==undefined?{nickname:string(v.nickname,40)}:{}),range:{from:string(v.range?.from,10),to:string(v.range?.to,10)},sessions,events,boundary:string(v.boundary)}
}
export function validateSharedView(v:any){if(!cloudId(v?.id))fail();const createdAt=number(v.createdAt),expiresAt=number(v.expiresAt),serverNow=number(v.serverNow);if(expiresAt<=serverNow||expiresAt<createdAt)throw new Error('分享已过期');return{id:v.id,createdAt,expiresAt,serverNow,content:validateShareContent(v.content)}}
const key=(base:string,user:string,profile:string)=>'headup-share:'+base+':'+user+':'+profile
function parseShareIntent(raw:string|null,profile:string):ShareIntent|null{try{const v=JSON.parse(raw??'null');if(!v||!cloudId(v.id)||v.profileId!==profile||!validHandoffSecret(v.token)||!Number.isInteger(v.version)||v.version<1||typeof v.recipient!=='string'||!/^[-a-zA-Z0-9_.]{3,64}$/.test(v.recipient)||![1,24,168].includes(v.ttlHours)||v.consentVersion!==SHARE_PROTOCOL)return null;return{id:v.id,token:v.token,profileId:v.profileId,version:v.version,recipient:v.recipient,ttlHours:v.ttlHours,consentVersion:SHARE_PROTOCOL,scope:validateShareScope(v.scope)}}catch{return null}}
export function saveShareIntent(base:string,user:string,profile:string,intent:ShareIntent){
  const checked=parseShareIntent(JSON.stringify(intent),profile);if(!checked)throw new Error('待核验分享格式不正确')
  const prefix=key(base,user,profile),name=prefix+':pending:'+checked.id,prior=localStorage.getItem(name)
  if(localStorage.getItem(prefix+':deleted'))throw new Error('此档案的删除已同步，不能恢复或新建分享')
  if(localStorage.getItem(prefix+':pending-resolved:'+checked.id))throw new Error('这份请求已在其他页面核验，请刷新分享状态')
  if(prior&&canonicalJson(parseShareIntent(prior,profile))!==canonicalJson(checked))throw new Error('分享编号已用于另一份请求，请保留原请求核验')
  localStorage.setItem(name,JSON.stringify(checked))
}
export function readShareIntents(base:string,user:string,profile:string):ShareIntent[]{
  try{
    const prefix=key(base,user,profile),legacy=prefix+':pending',names=[legacy],found=new Map<string,ShareIntent>()
    if(localStorage.getItem(prefix+':deleted'))return []
    for(let i=0;i<localStorage.length;i++){const name=localStorage.key(i);if(name?.startsWith(legacy+':'))names.push(name)}
    for(const name of names){const item=parseShareIntent(localStorage.getItem(name),profile);if(!item||name!==legacy&&name!==legacy+':'+item.id||localStorage.getItem(prefix+':pending-resolved:'+item.id)===item.token)continue;found.set(item.id,item)}
    return [...found.values()].sort((a,b)=>a.id.localeCompare(b.id))
  }catch{return []}
}
export function clearShareIntent(base:string,user:string,profile:string,intent:ShareIntent){
  const prefix=key(base,user,profile)
  if(localStorage.getItem(prefix+':deleted'))return
  // Keep a receipt so a late old-page save cannot revive this request. Never delete the shared legacy slot.
  localStorage.setItem(prefix+':pending-resolved:'+intent.id,intent.token)
  const name=prefix+':pending:'+intent.id,prior=parseShareIntent(localStorage.getItem(name),profile)
  if(prior&&canonicalJson(prior)===canonicalJson(intent))localStorage.removeItem(name)
}
export function saveShareToken(base:string,user:string,profile:string,id:string,token:string){if(localStorage.getItem(key(base,user,profile)+':deleted'))throw new Error('此档案的删除已同步，不能保存分享链接');localStorage.setItem(key(base,user,profile)+':link:'+id,token)}
export function readShareToken(base:string,user:string,profile:string,id:string){try{if(localStorage.getItem(key(base,user,profile)+':deleted'))return null;const token=localStorage.getItem(key(base,user,profile)+':link:'+id);return validHandoffSecret(token)?token:null}catch{return null}}

export function purgeDeletedProfileShares(base:string,user:string,profile:string){
  const prefix=key(base,user,profile)+':',marker=prefix+'deleted'
  if(localStorage.getItem(marker)!=='1')localStorage.setItem(marker,'1')
  const names:string[]=[]
  for(let i=0;i<localStorage.length;i++){const name=localStorage.key(i);if(name?.startsWith(prefix)&&name!==marker)names.push(name)}
  for(const name of names)localStorage.removeItem(name)
}
