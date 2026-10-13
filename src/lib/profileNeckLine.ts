import neckAestheticRuntime from '../data/profile-neck-aesthetic-runtime-v1.json'

export type ProfilePoint={x:number;y:number}

export const PROFILE_NECK_LINE_POLICY='HEADUP-PROFILE-NECK-LINE-RUNTIME-1.0' as const
export const PROFILE_NECK_LINE_COEFFICIENTS=[
  {a:-0.06869647552068929,b:0.14543870130260902},
  {a:-0.23279674084835092,b:0.26372569833279785},
  {a:-0.4406169941990863,b:0.3492823143485829},
]as const
export const PROFILE_NECK_LINE_UNCERTAINTY={pathP95VisibleProfileHeightRatio:0.10662471758190646,jawNeckAngleP95Degrees:14.35448815624138}as const
export const PROFILE_NECK_AESTHETIC_RUNTIME=neckAestheticRuntime as{policyVersion:string;enabled:boolean;mode:'accepted_observed_range'|'preference_band'|'disabled';acceptedObservedRange:{minimum:number;maximum:number}|null;preferenceBand:{minimum:number;maximum:number}|null;labels:{inside:string;outside:string;overlap:string}}

export function neckAngleReferenceState(value:number,uncertainty:number){
  const range=PROFILE_NECK_AESTHETIC_RUNTIME.mode==='preference_band'?PROFILE_NECK_AESTHETIC_RUNTIME.preferenceBand:PROFILE_NECK_AESTHETIC_RUNTIME.acceptedObservedRange
  if(!PROFILE_NECK_AESTHETIC_RUNTIME.enabled||!range)return'disabled' as const
  const low=value-uncertainty,high=value+uncertainty
  if(high<range.minimum||low>range.maximum)return'outside' as const
  if(low>=range.minimum&&high<=range.maximum)return'within' as const
  return'overlap' as const
}

const finite=(point:ProfilePoint)=>Number.isFinite(point.x)&&Number.isFinite(point.y)

/** Right-profile experimental proxy learned from 29 human-reviewed neck lines. */
export function estimateProfileNeckLine(jawPoints:readonly ProfilePoint[]):ProfilePoint[]|null{
  if(jawPoints.length!==7||!jawPoints.every(finite))return null
  const posterior=jawPoints[0],anterior=jawPoints.at(-1)!,dx=anterior.x-posterior.x,dy=anterior.y-posterior.y,length=Math.hypot(dx,dy)
  if(length<=1e-8)return null
  const ux=dx/length,uy=dy/length,vx=-uy,vy=ux
  return PROFILE_NECK_LINE_COEFFICIENTS.map(({a,b})=>({x:anterior.x+(a*ux+b*vx)*length,y:anterior.y+(a*uy+b*vy)*length}))
}

export function jawNeckLineAngleDegrees(jawPoints:readonly ProfilePoint[],neckPoints:readonly ProfilePoint[]):number|null{
  if(jawPoints.length<2||neckPoints.length<2||![...jawPoints,...neckPoints].every(finite))return null
  const jaw={x:jawPoints.at(-1)!.x-jawPoints[0].x,y:jawPoints.at(-1)!.y-jawPoints[0].y},neck={x:neckPoints.at(-1)!.x-neckPoints[0].x,y:neckPoints.at(-1)!.y-neckPoints[0].y},denominator=Math.hypot(jaw.x,jaw.y)*Math.hypot(neck.x,neck.y)
  if(denominator<=1e-8)return null
  return Math.acos(Math.max(-1,Math.min(1,Math.abs(jaw.x*neck.x+jaw.y*neck.y)/denominator)))*180/Math.PI
}
