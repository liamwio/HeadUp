import type {Capture} from '../types'
import type {FamilySession,ProfileSide} from './model'
export const CAPTURE_SEQUENCE=[{id:'front',label:'正面',side:null},{id:'profile',label:'左侧',side:'left_profile'},{id:'right_profile',label:'右侧',side:'right_profile'}] as const
export type RecordView=typeof CAPTURE_SEQUENCE[number]['id']
export function reportCaptures(captures:Capture[],side:'left_profile'|'right_profile'){
  const right=captures.find(c=>c.id==='right_profile'),legacy=captures.find(c=>c.id==='profile')
  const selected=side==='right_profile'?right??(legacy?.poseValidation?.estimatedPose==='right_profile'?legacy:undefined):legacy
  return [...captures.filter(c=>c.id==='front'),...(selected?[{...selected,id:'profile' as const}]:[])]
}
export function sideCapture(session:FamilySession,side:ProfileSide){return session.captures.find(c=>(c.id==='right_profile'?side==='right_profile':c.id==='profile'&&(session.recordedBy!=='user'||side==='left_profile'))&&c.poseValidation?.estimatedPose===side)}
export function sideSession(session:FamilySession,side:ProfileSide):FamilySession{
  const capture=sideCapture(session,side),id=capture?.id,hash=id?session.contentKey?.split('|').find(p=>p.startsWith(id+':'))?.slice(id.length+1):undefined,front=session.contentKey?.split('|').find(p=>p.startsWith('front:'))
  const missing={...session.report,profile:[],extended:session.report.extended.filter(r=>r.view==='front'),native:null,proxy:null,measuredCount:session.report.front.filter(r=>r.available).length,profileDetection:{title:'未保存此侧面结果',facts:[],issues:['此侧面照片或独立报告缺失。']}}
  const report=!capture?missing:id==='right_profile'?session.rightProfileReport??missing:session.report
  return {...session,captures:[...session.captures.filter(c=>c.id==='front'),...(capture?[{...capture,id:'profile' as const}]:[])],report,contentKey:session.contentKey?[front,hash?'profile:'+hash:undefined].filter(Boolean).sort().join('|'):undefined}
}
