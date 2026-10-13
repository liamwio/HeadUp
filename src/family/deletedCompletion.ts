import type {Archive} from './backup'
import {canonicalJson,type CloudSnapshot} from './cloudContract'
import {addDays,type RecordPlan} from './model'
/** A child cannot retain an automatic advance whose new evidence was deleted before the server received it. */
export function deletedCompletionPlan(local:Archive,remote:CloudSnapshot):RecordPlan|null{
  const plan=local.plans[0],before=remote.plans[0] as RecordPlan|undefined,completion=plan?.lastCompleted
  if(!plan||!before||!completion||local.sessions.some(s=>s.id===completion.sessionId)||remote.sessions.some(s=>s.id===completion.sessionId)||before.lastCompleted?.sessionId===completion.sessionId||completion.windowStart!==before.nextDate||plan.nextDate!==addDays(completion.recordedOn,before.intervalDays))return null
  const fixed=(p:RecordPlan)=>{const{enabled,nextDate,lastCompleted,notificationEnabled,followupEnabled,lastFollowupWindow,notificationError,lastNotifiedDate,lastNotifiedWindow,...rest}=p;return rest}
  if(canonicalJson(fixed(plan))!==canonicalJson(fixed(before)))return null
  // The user has just deleted this completion: do not immediately nudge the same window again.
  return {...before,enabled:plan.enabled?before.enabled:false,notificationEnabled:plan.notificationEnabled,followupEnabled:plan.followupEnabled,lastNotifiedWindow:completion.windowStart,notificationError:undefined}
}
