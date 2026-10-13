import {it,expect} from 'vitest'
import {eventDetails,eventSourceText,eventQuestionText} from './eventDetails'
import {archiveFixture} from './backupVolumes.fixture'
import {encryptArchive,decryptArchive} from './backup'
import {prepareBackupVolumes,decryptBackupFiles} from './backupVolumes'
import {readableArchiveHtml} from './archiveExport'
import {stageQuestions} from './stageScope'
import type {FamilyEvent} from './model'
const base={id:'event',profileId:'profile',date:'2026-09-17',type:'question' as const,text:'家庭问题',createdAt:'2026-09-17T00:00:00Z'}
it('keeps old events unchanged while showing missing provenance and default pending questions honestly',()=>{expect(eventDetails(base)).toEqual({});expect(eventQuestionText(base)).toBe('待讨论');expect(eventSourceText({...base,type:'followup'})).toContain('来源未补充')})
it('rejects invalid sources, implicit enum coercion, missing discussion dates and metadata without its version',()=>{
  for(const extra of [{recordedBy:'child'},{detailsVersion:'HEADUP-EVENT-2'},{detailsVersion:'HEADUP-EVENT-1',recordedBy:['child']},{detailsVersion:'HEADUP-EVENT-1',questionStatus:'discussed'},{detailsVersion:'HEADUP-EVENT-1',questionStatus:'open',discussedOn:'2026-09-16'},{detailsVersion:'HEADUP-EVENT-1',discussionNote:'没有日期'},{detailsVersion:'HEADUP-EVENT-1',provenance:{kind:'document',name:'机构',date:'2026-02-30'}}])expect(()=>eventDetails({...base,...extra})).toThrow()
  expect(()=>eventDetails({...base,type:'followup',detailsVersion:'HEADUP-EVENT-1',provenance:{kind:['unknown']}})).toThrow()
})
it('roundtrips professional provenance and reopened discussion through encrypted backup',async()=>{
  const archive=archiveFixture(),common={...base,profileId:archive.profiles[0].id,detailsVersion:'HEADUP-EVENT-1' as const,updatedAt:base.createdAt,recordedBy:'child' as const}
  const question:FamilyEvent={...common,questionStatus:'open',discussedOn:base.date,discussionNote:'讨论后还有问题'},source:FamilyEvent={...common,id:'source',type:'followup',provenance:{kind:'document',name:'工程机构',date:'2026-09-16',reference:'资料编号17'}};archive.events=[question,source]
  const file=await encryptArchive(archive,'test-only-secret'),restored=await decryptArchive(file,'test-only-secret');expect(restored.events).toEqual(archive.events);expect(stageQuestions(restored.events).at(-1)?.text).toContain('讨论后还有问题')
  const envelope=JSON.parse(await file.text()),bytes=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0)),baseKey=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-only-secret'),'PBKDF2',false,['deriveKey']),key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:bytes(envelope.salt),iterations:210000,hash:'SHA-256'},baseKey,{name:'AES-GCM',length:256},false,['decrypt'])
  const payload=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv)},key,bytes(envelope.data))))
  expect(payload.schema).toBe('headup-family-archive-v2') // the former v1-only reader must reject before restoring
  const volumes=await prepareBackupVolumes(archive,'test-only-secret'),parts=await Promise.all(Array.from({length:volumes.count},(_,i)=>volumes.volume(i)))
  expect((await decryptBackupFiles(parts,'test-only-secret')).events).toEqual(archive.events)
})
it('includes explicit event source and discussion only in opted-in readable exports and escapes prose',async()=>{
  const archive=archiveFixture();archive.events=[{...base,profileId:archive.profiles[0].id,detailsVersion:'HEADUP-EVENT-1',type:'followup',provenance:{kind:'conversation',name:'<script>机构</script>',date:base.date},recordedBy:'parent'}]
  const without=await readableArchiveHtml(archive,{nickname:false,photos:false,notes:false}),withNotes=await readableArchiveHtml(archive,{nickname:false,photos:false,notes:true})
  expect(without).not.toContain('家庭问题');expect(withNotes).toContain('用户录入的专业沟通记录');expect(withNotes).toContain('&lt;script&gt;机构');expect(withNotes).not.toContain('<script>机构');expect(withNotes).toContain('用户记录')
})
