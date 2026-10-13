import {FamilyStore,localFamilyStore,selectFamilyStore} from './store'
import {CloudTransport,SyncError,type CloudIdentity} from './cloudTransport'
import {SyncEngine} from './syncEngine'
import type {CloudRole} from './cloudContract'
import type {FamilyProfile} from './model'
import type {Archive} from './backup'
import {cloudWritePolicy} from './cloudWritePolicy'
import {configureLogoutNamespace} from './pendingLogout'
import {archiveStamp} from './syncState'
import {purgeDeletedProfileShares} from './shareClient'
export type Workspace={store:FamilyStore;engine:SyncEngine;transport:CloudTransport;user:CloudIdentity['user'];family:{id:string;name:string;role:CloudRole};base:string;locked:string;revision:number;syncLabel:string}
let preferenceKey='headup-active-cloud-workspace'
export const CLOUD_AUTH_CHANGE='headup-cloud-auth-change'
const signalAuth=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event(CLOUD_AUTH_CHANGE))}
let authChannel='headup-cloud-auth',authListener:BroadcastChannel|undefined
export function configureWorkspacePreferences(suffix:string){if(current)throw new Error('不能更改正在使用的工作区设置');preferenceKey='headup-active-cloud-workspace:'+suffix;authChannel='headup-cloud-auth:'+suffix;configureLogoutNamespace(suffix);bindAuthChannel()}
type Preference={user:CloudIdentity['user'];family:Workspace['family'];base:string}
let current:Workspace|null=null,stopWatch=()=>{}
let activationEpoch=0,restoring:Promise<void>|undefined
const listeners=new Set<()=>void>(),emit=()=>listeners.forEach(fn=>fn())
export const getWorkspace=()=>current
export const subscribeWorkspace=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}}
const remember=(value:Preference|null)=>{try{for(const storage of [sessionStorage,localStorage])if(value)storage.setItem(preferenceKey,JSON.stringify(value));else storage.removeItem(preferenceKey)}catch{}}
const authChanged=(userId:string|null)=>{signalAuth();activationEpoch++;try{for(const storage of [sessionStorage,localStorage]){const old=JSON.parse(storage.getItem(preferenceKey)??'null');if(old&&old.user?.id!==userId)storage.removeItem(preferenceKey)}}catch{}if(current&&current.user.id!==userId){current.engine.stop();current={...current,locked:'登录账号已变化，原账号页面和待同步内容仍保留。请重新验证原账号。'};emit()}}
export function notifyCloudAuth(userId:string|null){authChanged(userId);try{const c=new BroadcastChannel(authChannel);c.postMessage({userId});c.close()}catch{}}
function logoutChanged(userId:string){signalAuth();activationEpoch++;try{for(const storage of [sessionStorage,localStorage]){const old=JSON.parse(storage.getItem(preferenceKey)??'null');if(old?.user?.id===userId)storage.removeItem(preferenceKey)}}catch{}if(current?.user.id===userId){current.engine.stop();current={...current,locked:'已退出此账号。待同步内容保留在该账号的本机缓存，重新登录原账号后可继续。'};emit()}}
function bindAuthChannel(){authListener?.close();if(typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'){authListener=new BroadcastChannel(authChannel);authListener.onmessage=e=>{if(typeof e.data?.logoutUserId==='string')logoutChanged(e.data.logoutUserId);else authChanged(typeof e.data?.userId==='string'?e.data.userId:null)}}}
bindAuthChannel()
export async function openWorkspace(me:CloudIdentity,familyId:string,base='/api/family'){
  const epoch=++activationEpoch
  const family=me.families.find(f=>f.id===familyId);if(!family)throw new Error('当前账号未获得这个家庭的权限')
  const transport=new CloudTransport(me.user.id,base),verified=await transport.authenticate();if(!verified.families.some(f=>f.id===familyId))throw new Error('家庭权限已改变，请刷新')
  if(epoch!==activationEpoch)throw new Error('登录状态或工作区已改变，请重新进入家庭')
  return activateWorkspace(verified.user,verified.families.find(f=>f.id===familyId)!,transport,base)
}
async function activateWorkspace(user:CloudIdentity['user'],family:Workspace['family'],transport:CloudTransport,base:string){
  current?.engine.stop();stopWatch()
  const store=new FamilyStore(`headup-cloud-v1:${base}:${user.id}:${family.id}`,true),engine=new SyncEngine(store,transport,family.id,family.role)
  current={store,engine,transport,user,family,base,locked:'',revision:0,syncLabel:'正在检查同步'};remember({user,family,base})
  store.mutationGuard=cloudWritePolicy(store,user.id,()=>engine.role)
  let serial=0
  engine.onChange=()=>{const token=++serial;void store.syncLinks().then(links=>{if(current?.engine!==engine||token!==serial)return;let shareCleanupFailed=false;for(const link of links.filter(l=>l.status==='deleted'))try{purgeDeletedProfileShares(base,user.id,link.profileId)}catch{shareCleanupFailed=true};const statuses=links.map(l=>l.status),syncLabel=statuses.includes('conflict')?'有冲突待处理':statuses.includes('revoked')?'部分授权已撤回，相关内容仅保留本机':statuses.includes('offline')?'离线保留，联网后重试':statuses.includes('syncing')?'正在同步':statuses.includes('pending')?'有内容等待同步':statuses.includes('error')?'同步未完成，请查看状态':statuses.length?'已连接档案已同步或暂停':'尚未开启档案同步';current={...current,family:{...current.family,role:engine.role},syncLabel:shareCleanupFailed?'云端删除已确认；本机分享信息清理未完成，稍后重试':syncLabel,revision:current.revision+1};emit()}).catch(()=>{})}
  engine.onLocked=message=>{if(current?.engine===engine){current={...current,locked:message};emit()}}
  selectFamilyStore(store);emit()
  let timer:ReturnType<typeof setTimeout>|undefined,channel:BroadcastChannel|undefined
  const tick=()=>{void engine.run().catch(()=>{})},changed=()=>{if(timer)clearTimeout(timer);timer=setTimeout(tick,500)}
  try{channel=new BroadcastChannel(store.name+':changes');channel.onmessage=changed}catch{}
  const interval=setInterval(tick,15000);window.addEventListener('online',changed);window.addEventListener('focus',changed)
  stopWatch=()=>{if(timer)clearTimeout(timer);clearInterval(interval);channel?.close();window.removeEventListener('online',changed);window.removeEventListener('focus',changed)}
  tick();return current
}
export function leaveWorkspace(){activationEpoch++;current?.engine.stop();stopWatch();current=null;remember(null);selectFamilyStore(localFamilyStore);emit()}
export function lockWorkspace(userId:string){logoutChanged(userId);try{const c=new BroadcastChannel(authChannel);c.postMessage({logoutUserId:userId});c.close()}catch{}}
export async function unlockWorkspace(){if(!current)return;const saved=current,epoch=activationEpoch,me=await saved.transport.authenticate();if(current?.engine!==saved.engine||epoch!==activationEpoch)throw new Error('工作区已变化，请重新验证');const family=me.families.find(f=>f.id===saved.family.id);if(!family)throw new Error('该账号已不在此家庭中；请保留本机草稿，或返回本机模式');saved.engine.resume();saved.engine.role=family.role;current={...saved,user:me.user,family,locked:'',revision:saved.revision+1};remember({user:me.user,family,base:saved.base});emit();void saved.engine.run()}
export function restoreWorkspace(){return restoring??=restoreSavedWorkspace().finally(()=>{restoring=undefined})}
async function restoreSavedWorkspace(){
  const epoch=activationEpoch
  if(current)return;let saved:Preference|null=null;try{saved=JSON.parse(sessionStorage.getItem(preferenceKey)??localStorage.getItem(preferenceKey)??'null')}catch{}
  if(!saved?.user?.id||!saved.family?.id||!['owner','guardian','child'].includes(saved.family.role))return
  const transport=new CloudTransport(saved.user.id,saved.base)
  try{const me=await transport.authenticate();if(current||epoch!==activationEpoch)return;const family=me.families.find(f=>f.id===saved.family.id);if(!family){remember(null);return}await activateWorkspace(me.user,family,transport,saved.base)}catch(e){if(current||epoch!==activationEpoch)return;if(e instanceof SyncError&&e.code==='offline'){await activateWorkspace(saved.user,saved.family,transport,saved.base)}else remember(null)}
}
export async function copyLocalProfile(profile:FamilyProfile,reviewed:Archive){
  const target=current;if(!target)throw new Error('请先进入家庭工作区');if(target.family.role!=='owner')throw new Error('请由家庭管理者加入本机档案')
  const archive=await localFamilyStore.archive(profile.id);if(archiveStamp(archive)!==archiveStamp(reviewed))throw new Error('本机档案已变化，请重新预览并确认共享范围')
  const state=await target.store.syncState(profile.id);if(current?.engine!==target.engine)throw new Error('工作区已切换，本次未开启同步')
  if(state.archive.profiles.length)throw new Error('该工作区已有同ID档案，请查看现有记录，未覆盖任何内容')
  await target.store.restore(archive);if(current?.engine!==target.engine)throw new Error('工作区已切换，副本仅保留在原账号本机缓存中');await target.engine.connect(profile.id);void target.engine.run();return profile.id
}
export function cloudErrorMessage(e:unknown){return e instanceof SyncError||e instanceof Error?e.message:'家庭同步暂不可用'}
