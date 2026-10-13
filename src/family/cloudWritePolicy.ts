import type {FamilyStore} from './store'
import {canonicalJson,type CloudRole} from './cloudContract'
import {recordRootId} from './model'
const denied=()=>{throw new Error('当前家庭角色不能修改这项内容，请由管理者处理；本机原内容未改变。')}
export function cloudWritePolicy(store:FamilyStore,userId:string,role:()=>CloudRole){return async(action:string,payload:any)=>{
  if(role()==='owner'||action==='delete-recovery')return
  if(['restore','clear','delete-profile'].includes(action)){if(role()==='child'||action!=='delete-profile')denied();return}
  const all=await store.snapshot()
  let profileId=payload?.profileId??(action==='profile'?payload.id:undefined)
  if(action==='delete-session')profileId=all.sessions.find(s=>s.id===payload)?.profileId
  if(action==='delete-event')profileId=all.events.find(e=>e.id===payload)?.profileId
  if(!profileId)denied()
  const state=await store.syncState(profileId),link=state.link;if(!link||link.userId!==userId)denied()
  if(action==='profile'&&!state.archive.profiles.length)denied()
  if(role()==='guardian')return
  if(action==='profile'){const strip=(p:any)=>{const{preferredSide,updatedAt,...rest}=p;return rest};if(canonicalJson(strip(payload))!==canonicalJson(strip(state.archive.profiles[0])))denied();return}
  if(action==='plan'){const old=state.archive.plans[0],strip=(p:any)=>{const{enabled,notificationEnabled,followupEnabled,lastFollowupWindow,notificationError,lastNotifiedWindow,lastNotifiedDate,...rest}=p;return rest};if(!old||canonicalJson(strip(old))!==canonicalJson(strip(payload))||payload.enabled!==old.enabled&&payload.enabled!==false)denied();return}
  const own=(kind:string,id:string)=>{const author=link!.authors?.find(a=>a.kind===kind&&a.id===id);if(author)return author.userId===userId;const baseline=kind==='session'?link!.baseSnapshot?.sessions:link!.baseSnapshot?.events;return !baseline?.some(item=>item.id===id)}
  if(action==='delete-session'||action==='metadata'){const id=action==='metadata'?payload.id:payload,record=state.archive.sessions.find(s=>s.id===id);if(!record||!own('session',recordRootId(record)))denied()}
  if(action==='event'&&state.archive.events.some(e=>e.id===payload.id)&&!own('event',payload.id))denied()
  if(action==='delete-event'&&!own('event',payload))denied()
}}
