import {it,expect} from 'vitest'
import {createRevision,validateRevisionCommit,validateRevisionGraph} from './revisions'
import {createSession,defaultProtocol,sortedSessions,compareSessions,stageSummary,findReusedPhotos,type FamilyProfile} from './model'
import type {Capture} from '../types'
const front:Capture={id:'front',label:'正面',hint:'',eyebrow:'',url:'blob:fixture'}
const side:Capture={...front,id:'profile',label:'侧面'}
const root=()=>({...createSession({profileId:'p',recordedOn:'2026-09-17',kind:'memory',recordedBy:'together',note:'原备注',protocol:defaultProtocol()},[front]),contentKey:'front:original'})
it('keeps original snapshots and counts a revision as the same recording occasion',()=>{
  const old=root(),before=JSON.stringify(old),revision=createRevision(old,[front],'reanalyze',['front'])
  expect(JSON.stringify(old)).toBe(before);expect(revision.revision?.rootId).toBe(old.id);expect(revision.id).not.toBe(old.id)
  expect(sortedSessions([old,revision],'p')).toEqual([revision])
  expect(stageSummary([old,revision],{id:'p',preferredSide:null} as FamilyProfile).recorded).toContain('1次记录')
  expect(compareSessions(old,revision,'front').status).toBe('incompatible')
})
it('rejects stale edits, concurrent branches and a replacement disguised as reanalysis',()=>{
  const old=root(),next={...createRevision(old,[front],'reanalyze',['front']),contentKey:old.contentKey}
  expect(()=>validateRevisionCommit(old,next,[old])).not.toThrow()
  expect(()=>validateRevisionCommit(old,next,[old,{...next,id:'other'}])).toThrow('新版本')
  expect(()=>validateRevisionCommit(old,next,[{...old,updatedAt:'changed'}])).toThrow('修改')
  expect(()=>validateRevisionCommit(old,next,[{...old,note:'同毫秒发生的另一处更正'}])).toThrow('修改')
  expect(()=>validateRevisionCommit(old,{...next,contentKey:'front:changed'},[old])).toThrow('替换')
})
it('allows missing views only and rejects actual live photos from a different day',()=>{
  const old=root();expect(createRevision(old,[front,side],'supplement',['profile']).revision?.number).toBe(1)
  expect(()=>createRevision(old,[front],'supplement',['front'])).toThrow('缺少')
  expect(()=>createRevision(old,[front,side],'reanalyze',['profile'])).toThrow('原照片')
  expect(()=>createRevision(old,[front,{...side,source:'live',capturedAt:'2026-09-18T12:00:00Z'}],'supplement',['profile'])).toThrow('日期')
  const duplicate={...createRevision(old,[front,side],'supplement',['profile']),contentKey:'front:original|profile:original'}
  expect(()=>validateRevisionCommit(old,duplicate,[old])).toThrow('同一张')
})
it('rejects missing roots, cross-profile parents, gaps and divergent imported histories',()=>{
  const old=root(),next=createRevision(old,[front],'reanalyze',['front'])
  expect(()=>validateRevisionGraph([old,next])).not.toThrow()
  for(const records of [[next],[old,{...next,profileId:'other'}],[old,{...next,revision:{...next.revision!,number:3}}],[old,next,{...next,id:'fork'}]])expect(()=>validateRevisionGraph(records)).toThrow()
})
it('finds one old photo mixed into a new date and excludes it from longitudinal comparisons',()=>{
  const old={...root(),contentKey:'front:'+ 'a'.repeat(64)},next={...root(),recordedOn:'2026-09-18',contentKey:'front:'+'a'.repeat(64)+'|profile:'+'b'.repeat(64),captures:[...old.captures,{...side,mediaId:'side'}]}
  expect(findReusedPhotos(next,[old])).toEqual([{view:'front',date:old.recordedOn,sessionId:old.id}])
  expect(compareSessions(old,next,'front').status).toBe('incompatible')
  expect(findReusedPhotos({...next,recordedOn:old.recordedOn},[old])).toEqual([])
  expect(findReusedPhotos({...next,profileId:'another-child'},[old])).toEqual([])
})
