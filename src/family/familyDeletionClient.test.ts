import {afterEach,it,expect,vi} from 'vitest'
import {FAMILY_DELETE_PROTOCOL,validateCloudDeletionPreview,validateCloudDeletionReceipt,saveCloudDeletionIntent,readCloudDeletionIntents,clearCloudDeletionIntent,type CloudDeletionPreview} from './familyDeletionClient'
const preview:CloudDeletionPreview={protocol:FAMILY_DELETE_PROTOCOL,family:{id:'family',name:'工程家庭'},scopeHash:'a'.repeat(64),profiles:[{id:'profile-a',version:2,nickname:'工程档案',records:3,photos:8}]},intent={id:'request-a',preview}
const receipt={protocol:FAMILY_DELETE_PROTOCOL,id:intent.id,familyId:'family',scopeHash:preview.scopeHash,completedAt:Date.now(),profiles:[{id:'profile-a',version:3}]}
function storage(){const data=new Map<string,string>();vi.stubGlobal('localStorage',{get length(){return data.size},key:(index:number)=>[...data.keys()][index]??null,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}});return data}
afterEach(()=>vi.unstubAllGlobals())
it('preserves the entire cloud scope and rejects wrong-family, duplicate or invalid preview entries',()=>{
  const profiles=Array.from({length:1001},(_,i)=>({...preview.profiles[0],id:'profile-'+i}))
  expect(validateCloudDeletionPreview({...preview,profiles},'family').profiles).toHaveLength(1001)
  expect(()=>validateCloudDeletionPreview(preview,'other')).toThrow();expect(()=>validateCloudDeletionPreview({...preview,profiles:[...preview.profiles,...preview.profiles]},'family')).toThrow();expect(()=>validateCloudDeletionPreview({...preview,profiles:[{...profiles[0],version:0}]},'family')).toThrow()
})
it('accepts only an exact receipt for the original confirmed profile set and next versions',()=>{
  expect(validateCloudDeletionReceipt(receipt,intent)).toEqual(receipt)
  for(const changed of [{...receipt,id:'other'},{...receipt,familyId:'other'},{...receipt,scopeHash:'b'.repeat(64)},{...receipt,profiles:[]},{...receipt,profiles:[{id:'profile-a',version:4}]},{...receipt,profiles:[...receipt.profiles,{id:'new-profile',version:2}]}])expect(()=>validateCloudDeletionReceipt(changed,intent)).toThrow()
})
it('keeps independent pending requests isolated by family, account and service',()=>{
  storage();const other={id:'request-b',preview:{...preview,scopeHash:'b'.repeat(64)}}
  saveCloudDeletionIntent('/api/family','owner',intent);saveCloudDeletionIntent('/api/family','owner',other)
  expect(readCloudDeletionIntents('/api/family','owner','family')).toEqual([intent,other]);expect(readCloudDeletionIntents('/api/family','other','family')).toEqual([]);expect(readCloudDeletionIntents('/other','owner','family')).toEqual([]);expect(readCloudDeletionIntents('/api/family','owner','other')).toEqual([])
  clearCloudDeletionIntent('/api/family','owner',intent);expect(readCloudDeletionIntents('/api/family','owner','family')).toEqual([other])
})
it('rejects overwriting a confirmed request scope and retains unknown results during storage errors',()=>{
  storage();saveCloudDeletionIntent('/api/family','owner',intent)
  expect(()=>saveCloudDeletionIntent('/api/family','owner',{...intent,preview:{...preview,scopeHash:'b'.repeat(64)}})).toThrow('不能覆盖')
  vi.spyOn(localStorage,'removeItem').mockImplementation(()=>{throw new Error('storage unavailable')})
  expect(()=>clearCloudDeletionIntent('/api/family','owner',intent)).toThrow('storage unavailable');expect(readCloudDeletionIntents('/api/family','owner','family')).toEqual([intent])
})
it('ignores malformed or mismatched recovery slots while preserving the valid original request',()=>{
  const data=storage();saveCloudDeletionIntent('/api/family','owner',intent)
  data.set('headup-family-deletion:/api/family:owner:family:broken','{');data.set('headup-family-deletion:/api/family:owner:family:wrong-id',JSON.stringify(intent))
  expect(readCloudDeletionIntents('/api/family','owner','family')).toEqual([intent])
})
