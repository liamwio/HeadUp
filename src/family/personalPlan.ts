import {addDays,defaultPlan,localDate,sortedSessions,type FamilySession,type RecordPlan} from './model'

export function defaultPersonalPlan(profileId:string,sessions:FamilySession[],today=localDate()):RecordPlan {
  const latest=sortedSessions(sessions,profileId).find(s=>s.captures.length>0)
  return {...defaultPlan(profileId,latest?.recordedOn??today),enabled:true}
}
export function withPlanInterval(plan:RecordPlan,intervalDays:number,sessions:FamilySession[],today=localDate()):RecordPlan {
  const latest=sortedSessions(sessions,plan.profileId).find(s=>s.captures.length>0)
  return {...plan,intervalDays,...(Number.isInteger(intervalDays)&&intervalDays>=1&&intervalDays<=365?{nextDate:addDays(latest?.recordedOn??today,intervalDays)}:{})}
}
/** A photo records a date, irrespective of whether all measurement checks pass. */
export function advancePersonalPlan(plan:RecordPlan,session:FamilySession,previous:FamilySession[]):RecordPlan {
  if(!plan.enabled||session.profileId!==plan.profileId||session.revision||!session.captures.length)return plan
  const latest=sortedSessions(previous,session.profileId).find(s=>s.captures.length>0)
  if(latest&&session.recordedOn<=latest.recordedOn)return plan
  return {...plan,nextDate:addDays(session.recordedOn,plan.intervalDays),windowDays:1,lastNotifiedWindow:undefined,lastNotifiedDate:undefined,lastFollowupWindow:undefined,notificationError:undefined}
}
