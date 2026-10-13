import {useState} from 'react'
import type {Capture} from '../types'
import type {FamilySession} from './model'
import {ReportPageV2} from '../ReportPageV2'
import {reportCaptures} from './captureViews'
import {RecordVerdict} from './RecordVerdict'
export function PersonalReport({captures,session,showVerdict=true,onRetake,onPrivacy}:{captures:Capture[];session?:FamilySession;showVerdict?:boolean;onRetake:()=>void;onPrivacy:()=>void}){
  const [view,setView]=useState<'front'|'left_profile'|'right_profile'>('front')
  const hasRight=Boolean(session?.captures.some(c=>c.id==='right_profile')||captures.some(c=>c.id==='right_profile'&&c.url))
  const legacyRight=!hasRight&&(captures.find(c=>c.id==='profile')??session?.captures.find(c=>c.id==='profile'))?.poseValidation?.estimatedPose==='right_profile'
  const side=view==='right_profile'?'right_profile':'left_profile'
  const rows=view==='left_profile'&&legacyRight?captures.filter(c=>c.id==='front'):reportCaptures(captures,side)
  const frozen=view==='right_profile'&&!legacyRight?session?.rightProfileReport:session?.report
  return <div className="personal-report">{showVerdict&&<RecordVerdict captures={captures}/>}<div className="personal-report-tabs" role="tablist" aria-label="照片结果视角">{([['front','正面'],['left_profile','左侧'],['right_profile','右侧']] as const).map(([key,label])=><button key={key} id={'report-tab-'+key} role="tab" aria-selected={view===key} aria-controls="personal-report-panel" tabIndex={view===key?0:-1} onClick={()=>setView(key)} onKeyDown={e=>{const keys=['front','left_profile','right_profile'] as const,index=keys.indexOf(key);if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=keys[e.key==='Home'?0:e.key==='End'?2:(index+(e.key==='ArrowRight'?1:2))%3];setView(next);document.getElementById('report-tab-'+next)?.focus()}}}>{label}</button>)}</div><div id="personal-report-panel" role="tabpanel" aria-labelledby={'report-tab-'+view}><ReportPageV2 key={view} visibleView={view==='front'?'front':'profile'} embedded captures={rows} frozenReport={view==='left_profile'&&legacyRight?undefined:frozen} mode="youth" onStart={onRetake} onRetake={onRetake} onPrivacy={onPrivacy}/></div></div>
}
