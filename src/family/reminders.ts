import {addDays,localDate,validDate,validatePlan,type RecordPlan,type FamilySession} from './model'
import {completedPlan} from './planCompletion'
export const reminderWindow=(plan:RecordPlan)=>plan.nextDate
export type ReminderKind='initial'|'followup'
export function inQuietTime(time:string,start:string,end:string){return start===end?false:start<end?time>=start&&time<end:time>=start||time<end}
export function reminderKindDue(plan:RecordPlan,now=new Date()):ReminderKind|null{
  try{validatePlan(plan)}catch{return null}
  const date=localDate(now),time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
  if(!plan.enabled||!plan.notificationEnabled||time<plan.time||inQuietTime(time,plan.quietStart,plan.quietEnd)||plan.lastCompleted?.windowStart===plan.nextDate)return null
  const end=addDays(plan.nextDate,plan.windowDays-1)
  if(date>=plan.nextDate&&date<=end&&plan.lastNotifiedWindow!==reminderWindow(plan))return 'initial'
  if(plan.followupEnabled&&plan.lastNotifiedWindow===plan.nextDate&&plan.lastNotifiedDate&&validDate(plan.lastNotifiedDate)&&plan.lastNotifiedDate>=plan.nextDate&&plan.lastNotifiedDate<=end&&plan.lastFollowupWindow!==plan.nextDate&&date>=addDays(end,2)&&date<=addDays(end,4))return 'followup'
  return null
}
export const reminderDue=(plan:RecordPlan,now=new Date())=>reminderKindDue(plan,now)==='initial'
export function canDeliverClaimedReminder(plan:RecordPlan,window:string,kind:ReminderKind,now:Date){if(plan.nextDate!==window||(kind==='initial'?plan.lastNotifiedWindow:plan.lastFollowupWindow)!==window)return false;return reminderKindDue({...plan,...(kind==='initial'?{lastNotifiedWindow:undefined}:{lastFollowupWindow:undefined})},now)===kind}
export function advanceCompletedPlan(plan:RecordPlan,session:FamilySession,today=localDate()):RecordPlan {
  const next=completedPlan(plan,session,today)
  return next===plan?plan:{...next,lastNotifiedWindow:undefined,lastNotifiedDate:undefined,lastFollowupWindow:undefined,notificationError:undefined}
}
function foldLine(line:string){let result='',chunk='',bytes=0;for(const char of line){const length=new TextEncoder().encode(char).length;if(bytes+length>75){result+=chunk+'\r\n';chunk=' ';bytes=1}chunk+=char;bytes+=length}return result+chunk}
export function planCalendar(plan:RecordPlan,now=new Date()){
  validatePlan(plan)
  if(!plan.enabled)throw new Error('请先启用并保存计划，再导出日历。')
  if(inQuietTime(plan.time,plan.quietStart,plan.quietEnd))throw new Error('提醒时间位于安静时段，请先调整时间。')
  const timestamp=now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//HeadUp//Family Recording//ZH','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:${crypto.randomUUID()}@headup.local`,`DTSTAMP:${timestamp}`,`DTSTART:${plan.nextDate.replace(/-/g,'')}T${plan.time.replace(':','')}00`,'DURATION:PT5M',`RRULE:FREQ=DAILY;INTERVAL=${plan.intervalDays}`,'SUMMARY:留下成长记录','DESCRIPTION:这是可随时暂停的个人记录计划。请在日历中确认提醒设置。HeadUp计划变更不会自动更新已导入的日历。','BEGIN:VALARM','TRIGGER:PT0S','ACTION:DISPLAY','DESCRIPTION:到了约定的记录时间，可以完成或自行顺延。','END:VALARM','END:VEVENT','END:VCALENDAR',''].map(foldLine).join('\r\n')
}
export async function showRecordingNotification(kind:ReminderKind='initial',canSend:()=>Promise<boolean>=async()=>true){
  if(typeof Notification==='undefined'||Notification.permission!=='granted')throw new Error('通知权限未开启。')
  const title=kind==='followup'?'这次也可以改约时间':'到了约定的记录时间',options={body:kind==='followup'?'不用补打卡。可以一起记录，也可以调整或暂停计划；本期不再跟进。':'可以现在记录，也可以调整到合适的时间。',tag:'headup-family-record',renotify:false}
  const registration='serviceWorker' in navigator?await navigator.serviceWorker.getRegistration():undefined
  if(!await canSend())return false
  if(registration?.active)await registration.showNotification(title,options)
  else new Notification(title,options)
  return true
}
