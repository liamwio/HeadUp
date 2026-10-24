import {compareSessions,photoFingerprint,type FamilySession} from './model'
import {sameReadingProvenance} from './readingProvenance'
import type {MeasurementEvidence,EvidencePoint} from '../lib/measurementEvidence'
export type Similarity=[number,number,number,number,number,number]
export const transformPoint=(m:Similarity,p:{x:number;y:number})=>({x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]})
/** A rigid rotation plus one uniform scale; no face warp or new measurement. */
export function alignReference(a:EvidencePoint,b:EvidencePoint,c:EvidencePoint,d:EvidencePoint):Similarity|null{
 const dx=b.x-a.x,dy=b.y-a.y,x=d.x-c.x,y=d.y-c.y,den=dx*dx+dy*dy
 if(![dx,dy,x,y,den].every(Number.isFinite)||den<1e-8||Math.hypot(x,y)<1e-4)return null
 const u=(x*dx+y*dy)/den,v=(y*dx-x*dy)/den
 return [u,v,-v,u,c.x-u*a.x+v*a.y,c.y-v*a.x-u*a.y]
}
function reference(e:MeasurementEvidence){
 if(!Number.isFinite(e.width)||!Number.isFinite(e.height)||e.width<=0||e.height<=0||e.version!=='HEADUP-POINT-LINE-1')return null
 if(e.points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return null
 const segment=e.segments.find(s=>s.role==='reference'&&s.id==='denominator')??e.segments.find(s=>s.role==='reference')
 const a=e.points.find(p=>p.id===segment?.from),b=e.points.find(p=>p.id===segment?.to)
 if(!segment||!a||!b||Math.hypot(b.x-a.x,b.y-a.y)<Math.hypot(e.width,e.height)*.05)return null
 return {segment,a,b}
}
export function trendAlignment(before:FamilySession,after:FamilySession,view:'front'|'profile'){
 const reject=(reason:string)=>({ok:false as const,reason})
 if(compareSessions(before,after,view).status!=='conditions_close')return reject('拍摄条件或测量来源不同，保留并排回看。')
 if(!photoFingerprint(before,view)||!photoFingerprint(after,view))return reject('缺少照片来源记录，暂不叠加。')
 if([before,after].some(s=>s.report.isExample||s.captures.some(c=>c.id===view&&(c.analysisError||c.inputError||c.acceptedWithBias))))return reject('照片带有检测或拍摄偏差提醒，暂不叠加。')
 const readings=(s:FamilySession)=>[...s.report[view],...s.report.extended.filter(r=>r.view===view)]
 const priority=view==='front'?['FRONT-RATIO-07','FRONT-RATIO-01']:['PROFILE-RATIO-07','PROFILE-RATIO-05']
 const candidates=[...readings(before)].sort((a,b)=>{const rank=(code:string|undefined)=>{const i=priority.indexOf(code??'');return i<0?99:i};return rank(a.code)-rank(b.code)})
 for(const left of candidates){
  const right=readings(after).find(r=>r.code===left.code&&r.available)
  if(!left.available||!left.evidence||!right?.evidence||!sameReadingProvenance(left,right)||left.evidence.source!==(view==='front'?'saved_front_landmarks':'saved_profile_landmarks'))continue
  const l=reference(left.evidence),r=reference(right.evidence)
  if(!l||!r||l.segment.id!==r.segment.id||l.segment.from!==r.segment.from||l.segment.to!==r.segment.to||l.segment.label!==r.segment.label)continue
  const matrix=alignReference(l.a,l.b,r.a,r.b);if(!matrix)continue
  const angle=Math.abs(Math.atan2(matrix[1],matrix[0])*180/Math.PI)
  const relativeScale=Math.hypot(matrix[0],matrix[1])*Math.hypot(left.evidence.width,left.evidence.height)/Math.hypot(right.evidence.width,right.evidence.height)
  if(angle>25||relativeScale<.6||relativeScale>1.6)continue
  const corners=[{x:0,y:0},{x:left.evidence.width,y:0},{x:0,y:left.evidence.height},{x:left.evidence.width,y:left.evidence.height}].map(p=>transformPoint(matrix,p)).concat([{x:0,y:0},{x:right.evidence.width,y:right.evidence.height}])
  const x=Math.min(...corners.map(p=>p.x)),y=Math.min(...corners.map(p=>p.y)),w=Math.max(...corners.map(p=>p.x))-x,h=Math.max(...corners.map(p=>p.y))-y
  return {ok:true as const,matrix,box:[x,y,w,h].join(' '),before:left.evidence,after:right.evidence,referenceLabel:r.segment.label}
 }
 return reject('缺少同源参考点或对齐幅度过大，保留并排回看。')
}
/** Keep the actual first record plus recent visits, rather than dropping the baseline. */
export function trendPhotoRecords(rows:FamilySession[]){
 const ordered=[...rows].sort((a,b)=>a.recordedOn.localeCompare(b.recordedOn)||a.updatedAt.localeCompare(b.updatedAt))
 const byDate=new Map<string,FamilySession>();for(const row of ordered)byDate.set(row.recordedOn,row)
 const unique=[...byDate.values()];return unique.length>12?[unique[0],...unique.slice(-11)]:unique
}
