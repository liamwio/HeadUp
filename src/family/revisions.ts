import type {Capture} from '../types'
import {createSession,localDate,recordRootId,sessionVersions,type FamilySession} from './model'
export type RevisionOperation='reanalyze'|'supplement'
export function createRevision(source:FamilySession,captures:Capture[],operation:RevisionOperation,views:Array<'front'|'profile'|'right_profile'>,kind:FamilySession['kind']=source.kind){
  const old=new Set(source.captures.map(c=>c.id)),next=new Set(captures.filter(c=>c.url).map(c=>c.id))
  if(!views.length||new Set(views).size!==views.length||views.some(v=>!['front','profile','right_profile'].includes(v))||captures.filter(c=>c.url).length!==next.size)throw new Error('请明确本次修订的视角')
  if(operation==='reanalyze'&&(views.some(v=>!old.has(v))||next.size!==old.size||[...old].some(v=>!next.has(v))))throw new Error('重新检测不能更换或删除原照片')
  if(operation==='supplement'&&(views.some(v=>old.has(v)||!next.has(v))||next.size!==old.size+views.length||[...old].some(v=>!next.has(v))))throw new Error('只能补充当前记录缺少的视角')
  if(operation==='supplement'&&captures.some(c=>views.includes(c.id as 'front'|'profile'|'right_profile')&&c.source==='live'&&(!c.capturedAt||localDate(new Date(c.capturedAt))!==source.recordedOn)))throw new Error('补拍日期与原记录不同，请另建记录')
  const number=(source.revision?.number??0)+1;if(number>100)throw new Error('这次记录已达到100个修订版本，请先导出完整备份')
  const session=createSession({profileId:source.profileId,recordedOn:source.recordedOn,purpose:kind===source.kind?source.purpose:kind==='measurement'?'面部生长记录':'其他',kind,recordedBy:source.recordedBy,note:source.note,protocol:source.protocol},captures)
  return {...session,dateSource:source.dateSource,metadataHistory:source.metadataHistory,revision:{rootId:recordRootId(source),parentId:source.id,number,operation,views}}
}
export function validateRevisionCommit(source:FamilySession,next:FamilySession,records:FamilySession[]){
  const stored=records.find(s=>s.id===source.id),latest=stored&&sessionVersions(records,stored).at(-1)
  if(!stored||stored.profileId!==next.profileId||stored.updatedAt!==source.updatedAt||stored.recordedOn!==source.recordedOn||stored.note!==source.note||JSON.stringify(stored.metadataHistory??[])!==JSON.stringify(source.metadataHistory??[])||latest?.id!==source.id)throw new Error('原记录已被修改或已有新版本。请返回记录详情刷新后重试；旧记录没有被覆盖。')
  if(!next.revision||next.revision.rootId!==recordRootId(stored)||next.revision.number!==(stored.revision?.number??0)+1)throw new Error('修订版本不连续')
  const fingerprints=new Map((next.contentKey??'').split('|').map(x=>{const [view,hash]=x.split(':');return [view,hash] as const}))
  for(const previous of (stored.contentKey??'').split('|')){const [view,hash]=previous.split(':');if(hash&&fingerprints.get(view)!==hash)throw new Error('修订不能替换原照片；请另建记录。')}
  if(next.revision.operation==='supplement'&&new Set([...fingerprints.values()]).size!==fingerprints.size)throw new Error('补充视角不能与已有照片使用同一张图片。')
}
export function validateRevisionGraph(records:FamilySession[]){
  const map=new Map(records.map(s=>[s.id,s])),children=new Set<string>()
  for(const s of records){const r=s.revision;if(!r)continue
    const root=map.get(r.rootId),parent=map.get(r.parentId)
    if(!root||root.revision||!parent||root.profileId!==s.profileId||parent.profileId!==s.profileId||recordRootId(parent)!==root.id||r.number!==(parent.revision?.number??0)+1||r.number>100||s.recordedOn!==parent.recordedOn||children.has(parent.id))throw new Error('记录修订存在缺失或分支冲突，本次未导入。')
    children.add(parent.id)
    const old=new Set(parent.captures.map(c=>c.id)),next=new Set(s.captures.map(c=>c.id))
    if(!r.views.length||new Set(r.views).size!==r.views.length||r.views.some(v=>!['front','profile','right_profile'].includes(v)))throw new Error('修订视角无效')
    if(r.operation==='reanalyze'?(next.size!==old.size||r.views.some(v=>!old.has(v))||[...old].some(v=>!next.has(v))):(r.operation!=='supplement'||r.views.some(v=>old.has(v)||!next.has(v))||next.size!==old.size+r.views.length||[...old].some(v=>!next.has(v))))throw new Error('修订照片关系无效')
  }
}
