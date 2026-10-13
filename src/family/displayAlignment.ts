import type {StoredCapture,FamilySession} from './model'
import {buildFrontLandmarkOverlay} from '../lib/frontLandmarkOverlay'
export type DisplayAlignment={x:number;y:number;scale:number;rotation:number}
export const neutralAlignment=():DisplayAlignment=>({x:0,y:0,scale:1,rotation:0})
export function displayMatrix(value:DisplayAlignment){
  if(!Object.values(value).every(Number.isFinite)||Math.abs(value.x)>30||Math.abs(value.y)>30||value.scale<.5||value.scale>2||Math.abs(value.rotation)>20)throw new Error('显示对齐参数无效')
  const angle=value.rotation*Math.PI/180,a=value.scale*Math.cos(angle),b=value.scale*Math.sin(angle),c=-b,d=a
  return {a,b,c,d,e:500+value.x*10-500*(a+c),f:500+value.y*10-500*(b+d)}
}
export function alignmentTransform(value:DisplayAlignment){const m=displayMatrix(value);return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`}
export type SavedContours={width:number;height:number;paths:Array<{code:string;label:string;points:Array<{x:number;y:number}>}>}
export function savedContours(session:FamilySession,view:'front'|'profile'):SavedContours|null{
  const capture:StoredCapture|undefined=session.captures.find(c=>c.id===view),pose=capture?.poseValidation
  if(!pose||pose.status!=='pass'||capture?.analysisError||session.report.isExample||session.kind==='memory')return null
  let contours:SavedContours|null=null
  if(view==='front'){
    if(pose.estimatedPose!=='front'||!Array.isArray(pose.landmarks)||pose.landmarks.some(p=>!p)||!pose.landmarkImageWidth||!pose.landmarkImageHeight)return null
    const overlay=buildFrontLandmarkOverlay(pose.landmarks,pose.landmarkImageWidth,pose.landmarkImageHeight)
    if(overlay)contours={width:overlay.width,height:overlay.height,paths:overlay.contours}
  }else{
    const saved=session.report.native
    if(!saved||!Array.isArray(saved.paths))return null
    contours={width:saved.width,height:saved.height,paths:saved.paths.filter(p=>p&&p.category==='region'&&!p.provisional&&p.code!=='neck_aesthetic_line')}
  }
  if(!contours||!Number.isFinite(contours.width+contours.height)||Math.min(contours.width,contours.height)<=0||!contours.paths.length||contours.paths.some(p=>!Array.isArray(p.points)||p.points.length<2||p.points.some(v=>!v||!Number.isFinite(v.x+v.y)||v.x<-.25*contours!.width||v.x>1.25*contours!.width||v.y<-.25*contours!.height||v.y>1.25*contours!.height)))return null
  return contours
}
