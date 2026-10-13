import {sideCapture} from './captureViews'
import {profileSide,sortedSessions,type FamilySession,type FamilyEvent} from './model'
export type TimelineView='all'|'front'|'left_profile'|'right_profile'|'unknown_profile'
export type TimelinePreferences={filter:'all'|'measurement'|'memory';view:TimelineView;month:string;selection:string[];period?:string;showEvents?:boolean;focusId?:string}
export function readTimelinePreferences(key:string):TimelinePreferences{const fallback:TimelinePreferences={filter:'all',view:'all',month:'',selection:[]};try{const p=JSON.parse(sessionStorage.getItem(key)??'null');if(!p||!['all','measurement','memory'].includes(p.filter)||!['all','front','left_profile','right_profile','unknown_profile'].includes(p.view)||typeof p.month!=='string'||p.month!==''&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)||!Array.isArray(p.selection)||p.selection.length>2||p.selection.some((id:unknown)=>typeof id!=='string'||id.length>160))return fallback;return{filter:p.filter,view:p.view,month:p.month,selection:[...new Set(p.selection)] as string[],period:validTimelinePeriod(p.period)?p.period:'',showEvents:p.showEvents!==false,focusId:typeof p.focusId==='string'&&p.focusId.length<=160?p.focusId:''}}catch{return fallback}}
export function saveTimelinePreferences(key:string,value:TimelinePreferences){try{sessionStorage.setItem(key,JSON.stringify(value))}catch{/* Browsing filters are optional; stored records are unaffected. */}}
export function validTimelinePeriod(value:unknown):value is string{return typeof value==='string'&&(value===''||/^(year:\d{4}|term:\d{4}:(spring|fall))$/.test(value))}
export function timelineTerm(date:string){const year=Number(date.slice(0,4)),month=Number(date.slice(5,7));return `term:${month===1?year-1:year}:${month>=2&&month<=8?'spring':'fall'}`}
export function timelinePeriodLabel(period:string){const parts=period.split(':');return parts[0]==='year'?`${parts[1]}年全年`:`${parts[1]}年${parts[2]==='spring'?'春季':'秋季'}学期`}
export function inTimelinePeriod(date:string,month:string,period=''){return month?date.startsWith(month):period.startsWith('year:')?date.startsWith(period.slice(5)):period.startsWith('term:')?timelineTerm(date)===period:true}
export type TimelineEntry={kind:'session';id:string;date:string;session:FamilySession}|{kind:'event';id:string;date:string;event:FamilyEvent}
/** Events keep their own dates; a nearby photo is not evidence of causation. */
export function timelineEntries(sessions:FamilySession[],events:FamilyEvent[],profileId:string,query:TimelinePreferences):TimelineEntry[]{
  const photos:TimelineEntry[]=sortedSessions(sessions,profileId).filter(s=>hasTimelineView(s,query.view)&&(query.filter==='all'||s.kind===query.filter)&&inTimelinePeriod(s.recordedOn,query.month,query.period)).map(session=>({kind:'session',id:'session:'+session.id,date:session.recordedOn,session}))
  const notes:TimelineEntry[]=query.showEvents===false?[]:events.filter(e=>e.profileId===profileId&&inTimelinePeriod(e.date,query.month,query.period)).map(event=>({kind:'event',id:'event:'+event.id,date:event.date,event}))
  return [...photos,...notes].sort((a,b)=>b.date.localeCompare(a.date)||(a.kind===b.kind?a.id.localeCompare(b.id):a.kind==='session'?-1:1))
}
export function hasTimelineView(session:FamilySession,view:TimelineView){if(view==='all')return true;if(view==='front')return session.captures.some(c=>c.id==='front');if(view==='unknown_profile')return session.captures.some(c=>(c.id==='profile'||c.id==='right_profile')&&!['left_profile','right_profile'].includes(c.poseValidation?.estimatedPose??''));return Boolean(sideCapture(session,view))}
/** Full history, latest revision per event. Memory photos and same-day pairs are not a longitudinal baseline. */
export function firstBaselinePair(sessions:FamilySession[],profileId:string,view:TimelineView){
  const comparisonView=view==='all'||view==='front'?'front':view==='right_profile'?'right_profile':'profile'
  const rows=sortedSessions(sessions,profileId).filter(s=>s.kind==='measurement'&&hasTimelineView(s,view==='all'?'front':view))
  const latest=rows[0];if(!latest)return null
  const first=[...rows].reverse().find(s=>s.recordedOn<latest.recordedOn&&(comparisonView==='front'||view==='left_profile'||view==='right_profile'||Boolean(profileSide(latest))&&profileSide(s)===profileSide(latest)))
  return first?{ids:[first.id,latest.id],view:comparisonView as 'front'|'profile'|'right_profile',dates:[first.recordedOn,latest.recordedOn]}:null
}
