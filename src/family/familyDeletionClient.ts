import {cloudId,canonicalJson} from './cloudContract'
export const FAMILY_DELETE_PROTOCOL='HEADUP-FAMILY-DELETE-1'
export type CloudDeletionPreview={protocol:typeof FAMILY_DELETE_PROTOCOL;family:{id:string;name:string};scopeHash:string;profiles:Array<{id:string;version:number;nickname:string;records:number;photos:number}>}
export type CloudDeletionIntent={id:string;preview:CloudDeletionPreview}
export type CloudDeletionReceipt={protocol:typeof FAMILY_DELETE_PROTOCOL;id:string;familyId:string;scopeHash:string;completedAt:number;profiles:Array<{id:string;version:number}>}
const fail=():never=>{throw new Error('家庭删除范围或回执无法核验，请重新读取')}
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min
export function validateCloudDeletionPreview(v:any,familyId:string):CloudDeletionPreview{
  if(v?.protocol!==FAMILY_DELETE_PROTOCOL||!cloudId(familyId)||v.family?.id!==familyId||typeof v.family.name!=='string'||!v.family.name.trim()||v.family.name.length>80||typeof v.scopeHash!=='string'||!/^[a-f0-9]{64}$/.test(v.scopeHash)||!Array.isArray(v.profiles))fail()
  const profiles=v.profiles.map((p:any)=>{if(!cloudId(p.id)||!integer(p.version,1)||typeof p.nickname!=='string'||!p.nickname.trim()||p.nickname.length>40||!integer(p.records)||!integer(p.photos))fail();return{id:p.id,version:p.version,nickname:p.nickname,records:p.records,photos:p.photos}})
  if(new Set(profiles.map((p:any)=>p.id)).size!==profiles.length)fail()
  return {protocol:FAMILY_DELETE_PROTOCOL,family:{id:familyId,name:v.family.name},scopeHash:v.scopeHash,profiles}
}
export function validateCloudDeletionReceipt(v:any,intent:CloudDeletionIntent):CloudDeletionReceipt{
  const expected=intent.preview.profiles.map(p=>({id:p.id,version:p.version+1})).sort((a,b)=>a.id.localeCompare(b.id))
  if(v?.protocol!==FAMILY_DELETE_PROTOCOL||v.id!==intent.id||v.familyId!==intent.preview.family.id||v.scopeHash!==intent.preview.scopeHash||!integer(v.completedAt,1)||v.completedAt>8640000000000000||!Array.isArray(v.profiles))fail()
  const profiles=v.profiles.map((p:any)=>{if(!cloudId(p.id)||!integer(p.version,1))fail();return{id:p.id,version:p.version}}).sort((a:any,b:any)=>a.id.localeCompare(b.id))
  if(canonicalJson(profiles)!==canonicalJson(expected))fail()
  return {protocol:FAMILY_DELETE_PROTOCOL,id:v.id,familyId:v.familyId,scopeHash:v.scopeHash,completedAt:v.completedAt,profiles}
}
const prefix=(base:string,user:string,family:string)=>`headup-family-deletion:${base}:${user}:${family}:`
export function saveCloudDeletionIntent(base:string,user:string,intent:CloudDeletionIntent){
  if(!cloudId(intent.id))fail();const checked={id:intent.id,preview:validateCloudDeletionPreview(intent.preview,intent.preview.family.id)},key=prefix(base,user,checked.preview.family.id)+intent.id,old=localStorage.getItem(key)
  if(old&&canonicalJson(JSON.parse(old))!==canonicalJson(checked))throw new Error('删除编号已用于另一范围，不能覆盖原请求')
  localStorage.setItem(key,JSON.stringify(checked))
}
export function readCloudDeletionIntents(base:string,user:string,family:string):CloudDeletionIntent[]{
  try{const scope=prefix(base,user,family),items:CloudDeletionIntent[]=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key?.startsWith(scope))continue;try{const v=JSON.parse(localStorage.getItem(key)??'null');if(!cloudId(v?.id)||key!==scope+v.id)continue;items.push({id:v.id,preview:validateCloudDeletionPreview(v.preview,family)})}catch{}}return items.sort((a,b)=>a.id.localeCompare(b.id))}catch{return []}
}
export function clearCloudDeletionIntent(base:string,user:string,intent:CloudDeletionIntent){
  const key=prefix(base,user,intent.preview.family.id)+intent.id,old=localStorage.getItem(key)
  if(old&&canonicalJson(JSON.parse(old))===canonicalJson(intent))localStorage.removeItem(key)
}
