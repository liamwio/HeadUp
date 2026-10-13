import {addDays,validDate} from './dates.ts'
import {isPhotoQualityAcceptable} from '../lib/photoQualityAcceptance.ts'
export type PlanCompletion={windowStart:string;recordedOn:string;sessionId:string}
type Plan={profileId:string;enabled:boolean;nextDate:string;windowDays:number;intervalDays:number;lastCompleted?:PlanCompletion}
type Observation={id:string;profileId:string;recordedOn:string;kind:string;recordedBy?:string;captures:Array<{id:string;analysisError?:string;inputError?:string;acceptedWithBias?:boolean;quality?:{score:number;flags:string[]};poseValidation?:{status:string;estimatedPose:string;detectedFaces:number}}>}
export function photoChecksPass(session:Observation){const views=session.recordedBy==='user'?['front','profile','right_profile']:['front','profile'];return session.kind==='measurement'&&views.every(id=>session.captures.some(c=>c.id===id&&!c.analysisError&&!c.inputError&&!c.acceptedWithBias&&c.poseValidation?.status==='pass'&&c.poseValidation.detectedFaces===1&&(id==='front'?c.poseValidation.estimatedPose==='front':id==='right_profile'?c.poseValidation.estimatedPose==='right_profile':session.recordedBy==='user'?c.poseValidation.estimatedPose==='left_profile':['left_profile','right_profile'].includes(c.poseValidation.estimatedPose))&&c.quality&&isPhotoQualityAcceptable(c.quality)))}
export function completionFor(plan:Plan,session:Observation,today:string):PlanCompletion|null{
  if(!plan.enabled||session.profileId!==plan.profileId||session.kind!=='measurement'||session.recordedOn!==today||!validDate(today)||today<plan.nextDate||today>addDays(plan.nextDate,plan.windowDays-1))return null
  if(!photoChecksPass(session))return null
  return {windowStart:plan.nextDate,recordedOn:today,sessionId:session.id}
}
export function completedPlan<T extends Plan>(plan:T,session:Observation,today:string):T{const completion=completionFor(plan,session,today);return completion?{...plan,nextDate:addDays(today,plan.intervalDays),lastCompleted:completion}:plan}
export function validCompletion(value:unknown){const c=value as PlanCompletion;return Boolean(c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).every(k=>['windowStart','recordedOn','sessionId'].includes(k))&&validDate(c.windowStart)&&validDate(c.recordedOn)&&c.recordedOn>=c.windowStart&&c.recordedOn<=addDays(c.windowStart,27)&&typeof c.sessionId==='string'&&/^[a-zA-Z0-9._-]{1,100}$/.test(c.sessionId))}
