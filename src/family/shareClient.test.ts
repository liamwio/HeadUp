import {it,expect,vi,afterEach} from 'vitest'
import {shareLink,readShareIntents,saveShareIntent,clearShareIntent,purgeDeletedProfileShares,saveShareToken,readShareToken,validateShareContent,validateSharedView,type ShareIntent} from './shareClient'
const token='A'.repeat(43),scope={from:'',to:'',sessionIds:['record'],eventIds:[],fields:{photos:false,readings:true,notes:false,sources:false,nickname:false},photoMode:'original' as const}
it('keeps share tokens in the fragment and rejects production loopback, remote HTTP or embedded credentials',()=>{expect(shareLink('https://example.test/app?name=private',token)).toBe('https://example.test/app#family/shared/'+token);for(const url of ['http://example.test','http://localhost:5173','https://user:password@example.test'])expect(()=>shareLink(url,token)).toThrow();expect(shareLink('http://localhost:5173/qa',token,true)).toContain('#family/shared/')})
const intent:ShareIntent={id:'share-id',profileId:'profile',token,version:7,recipient:'reader',ttlHours:24,scope,consentVersion:'HEADUP-SHARE-1'}
const legacy='headup-share:/api/family:owner:profile:pending'
function storage(){const data=new Map<string,string>();vi.stubGlobal('localStorage',{get length(){return data.size},key:(i:number)=>[...data.keys()][i]??null,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}});return data}
afterEach(()=>vi.unstubAllGlobals())
it('persists exact creation intents separately for each account, server and profile',()=>{
  storage();saveShareIntent('/api/family','owner','profile',intent)
  expect(readShareIntents('/api/family','owner','profile')).toEqual([intent]);expect(readShareIntents('/api/family','other','profile')).toEqual([]);expect(readShareIntents('/other','owner','profile')).toEqual([]);expect(readShareIntents('/api/family','owner','another')).toEqual([])
  saveShareToken('/api/family','owner','profile','share-id',token);clearShareIntent('/api/family','owner','profile',intent)
  expect(readShareIntents('/api/family','owner','profile')).toEqual([]);expect(readShareToken('/api/family','owner','profile','share-id')).toBe(token)
})
it('keeps two pages independently pending and clears only the acknowledged request',()=>{
  storage();const other={...intent,id:'share-other',recipient:'different-reader',token:'B'.repeat(43)}
  saveShareIntent('/api/family','owner','profile',intent);saveShareIntent('/api/family','owner','profile',other)
  expect(readShareIntents('/api/family','owner','profile')).toEqual([intent,other])
  clearShareIntent('/api/family','owner','profile',intent);expect(readShareIntents('/api/family','owner','profile')).toEqual([other])
  clearShareIntent('/api/family','owner','profile',intent);expect(readShareIntents('/api/family','owner','profile')).toEqual([other])
  expect(()=>saveShareIntent('/api/family','owner','profile',intent)).toThrow('已在其他页面核验')
})
it('recovers legacy pending data and never deletes another legacy request while settling the old one',()=>{
  const data=storage(),other={...intent,id:'legacy-next',token:'B'.repeat(43)}
  data.set(legacy,JSON.stringify(intent));expect(readShareIntents('/api/family','owner','profile')).toEqual([intent])
  data.set(legacy,JSON.stringify(other));clearShareIntent('/api/family','owner','profile',intent)
  expect(readShareIntents('/api/family','owner','profile')).toEqual([other]);expect(data.has(legacy)).toBe(true)
  clearShareIntent('/api/family','owner','profile',other);expect(readShareIntents('/api/family','owner','profile')).toEqual([])
  data.set(legacy,JSON.stringify(intent));expect(readShareIntents('/api/family','owner','profile')).toEqual([])
})
it('deduplicates a legacy request also saved by a new page and rejects request ID reuse',()=>{
  const data=storage();data.set(legacy,JSON.stringify(intent));saveShareIntent('/api/family','owner','profile',intent)
  expect(readShareIntents('/api/family','owner','profile')).toEqual([intent])
  expect(()=>saveShareIntent('/api/family','owner','profile',{...intent,recipient:'changed'})).toThrow('另一份请求')
  expect(readShareIntents('/api/family','owner','profile')).toEqual([intent])
})
it('ignores corrupted, misplaced and wrong-profile pending records without losing valid requests',()=>{
  const data=storage();saveShareIntent('/api/family','owner','profile',intent)
  data.set(legacy+':broken','{');data.set(legacy+':wrong-id',JSON.stringify({...intent,recipient:'forged'}));data.set(legacy+':different',JSON.stringify({...intent,id:'different',profileId:'another'}))
  expect(readShareIntents('/api/family','owner','profile')).toEqual([intent])
})
it('does not overwrite another pending request when storage is full',()=>{
  const data=storage();saveShareIntent('/api/family','owner','profile',intent)
  vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError')})
  expect(()=>saveShareIntent('/api/family','owner','profile',{...intent,id:'new-one'})).toThrow('full')
  expect(JSON.parse(data.get(legacy+':share-id')!)).toEqual(intent)
})
it('rejects arbitrary photo addresses and rejects expiry based on the server clock',()=>{const content={schema:'HEADUP-SHARED-CONTENT-1',range:{from:'',to:''},boundary:'保存的内容',sessions:[{ref:'R1',date:'2026-09-20',kind:'memory',photos:[],readings:[]}],events:[]};expect(validateShareContent({...content,private:'must not render'})).not.toHaveProperty('private');expect(()=>validateShareContent({...content,sessions:[{...content.sessions[0],photos:[{ref:'https://other.test/photo',view:'front',label:'照片'}]}]})).toThrow();expect(()=>validateSharedView({id:'share',createdAt:100,expiresAt:200,serverNow:200,content})).toThrow('过期');expect(validateSharedView({id:'share',createdAt:100,expiresAt:200,serverNow:150,content}).expiresAt).toBe(200)})

it('keeps the pending request recoverable if recording its resolution fails',()=>{
  storage();saveShareIntent('/api/family','owner','profile',intent)
  vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError')})
  expect(()=>clearShareIntent('/api/family','owner','profile',intent)).toThrow('full')
  expect(readShareIntents('/api/family','owner','profile')).toEqual([intent])
})

it('purges only the deleted profile share scope, retaining other accounts and profiles',()=>{
  const data=storage();saveShareIntent('/api/family','owner','profile',intent);saveShareToken('/api/family','owner','profile',intent.id,token);data.set(legacy,JSON.stringify(intent));data.set(legacy.replace(':pending',':pending-resolved:old'),token)
  saveShareIntent('/api/family','another-owner','profile',intent);saveShareIntent('/api/family','owner','profile2',{...intent,profileId:'profile2'});saveShareIntent('/other','owner','profile',intent)
  purgeDeletedProfileShares('/api/family','owner','profile')
  expect([...data.keys()].filter(k=>k.startsWith('headup-share:/api/family:owner:profile:'))).toEqual(['headup-share:/api/family:owner:profile:deleted'])
  expect(readShareIntents('/api/family','another-owner','profile')).toEqual([intent]);expect(readShareIntents('/other','owner','profile')).toEqual([intent]);expect(readShareIntents('/api/family','owner','profile2')).toHaveLength(1)
  expect(readShareToken('/api/family','owner','profile',intent.id)).toBeNull();expect(()=>saveShareIntent('/api/family','owner','profile',intent)).toThrow('删除已同步');expect(()=>saveShareToken('/api/family','owner','profile',intent.id,token)).toThrow('删除已同步')
  clearShareIntent('/api/family','owner','profile',intent);expect(data.has(legacy.replace(':pending',':pending-resolved:share-id'))).toBe(false)
})
it('reports interrupted cleanup, hides deleted shares and completes on retry',()=>{
  const data=storage();saveShareIntent('/api/family','owner','profile',intent);saveShareToken('/api/family','owner','profile',intent.id,token)
  const remove=vi.spyOn(localStorage,'removeItem').mockImplementationOnce(()=>{throw new Error('storage unavailable')})
  expect(()=>purgeDeletedProfileShares('/api/family','owner','profile')).toThrow('storage unavailable')
  expect(readShareIntents('/api/family','owner','profile')).toEqual([]);expect(readShareToken('/api/family','owner','profile',intent.id)).toBeNull()
  remove.mockRestore();purgeDeletedProfileShares('/api/family','owner','profile');expect(data.size).toBe(1)
})
