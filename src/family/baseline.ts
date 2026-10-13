import {isPhotoQualityAcceptable} from '../lib/imageQuality'
import {profileSide,sortedSessions,type FamilyProfile,type FamilySession,type ProfileSide,type StoredCapture,type CaptureProtocol} from './model'
export function captureReady(c:StoredCapture|undefined){return Boolean(c?.mediaId&&!c.inputError&&!c.analysisError&&!c.acceptedWithBias&&c.poseValidation?.status==='pass'&&c.poseValidation.detectedFaces===1&&c.quality&&isPhotoQualityAcceptable(c.quality))}
export function completeBaseline(s:FamilySession,side:ProfileSide){const front=s.captures.find(c=>c.id==='front'),profile=s.captures.find(c=>c.id==='profile');return s.kind==='measurement'&&!s.report.isExample&&front?.poseValidation?.estimatedPose==='front'&&profileSide(s)===side&&captureReady(front)&&captureReady(profile)}
export function conditionChanges(a:FamilySession,b:FamilySession):string[]{
  const before=a.protocol,after=b.protocol,changed:string[]=[]
  if(before.device.trim()&&after.device.trim()&&before.device.trim()!==after.device.trim())changed.push('设备记录改变')
  if(before.camera!=='unknown'&&after.camera!=='unknown'&&before.camera!==after.camera)changed.push('前后摄像头改变')
  if(before.distanceCm!==null&&after.distanceCm!==null&&Math.abs(before.distanceCm-after.distanceCm)>Math.min(before.distanceCm,after.distanceCm)*.1)changed.push('记录距离改变')
  if(before.light!=='unknown'&&after.light!=='unknown'&&before.light!==after.light)changed.push('光线条件改变')
  if(before.locationNote.trim()&&after.locationNote.trim()&&before.locationNote.trim()!==after.locationNote.trim())changed.push('位置或方法备注改变')
  if(a.version.algorithm!==b.version.algorithm||a.version.norm!==b.version.norm||before.version!==after.version)changed.push('算法、误差依据或拍摄协议改变')
  return changed
}
export function profileBaseline(sessions:FamilySession[],profile:FamilyProfile,side:ProfileSide){
  const observations=sortedSessions(sessions,profile.id).filter(s=>s.kind==='measurement'&&!s.report.isExample).reverse(),rows=observations.filter(s=>profileSide(s)===side)
  const first=rows.find(s=>completeBaseline(s,side)),breakpoints=rows.flatMap((s,i)=>{const changes=i?conditionChanges(rows[i-1],s):[];return changes.length?[{session:s,changes}]:[]})
  const start=breakpoints.length?rows.findIndex(s=>s.id===breakpoints.at(-1)!.session.id):0,current=rows.slice(start).find(s=>completeBaseline(s,side))
  return {first,current,latest:rows.at(-1),latestAny:observations.at(-1),firstAny:observations[0],count:rows.length,breakpoints}
}
export function captureReferenceSession(sessions:FamilySession[],profileId:string,side:ProfileSide|null){return sortedSessions(sessions,profileId).find(s=>s.kind==='measurement'&&!s.report.isExample&&(side?profileSide(s)===side:s.captures.some(c=>c.id==='front')))}
export function protocolSummary(p:CaptureProtocol){return {device:p.device.trim()||'未记录',camera:p.camera==='rear'?'后置摄像头':p.camera==='front'?'前置摄像头':'未记录',distance:p.distanceCm===null?'未记录':`${p.distanceCm}厘米（手动记录）`,light:p.light==='daylight'?'自然光':p.light==='indoor'?'室内灯光':'未记录',method:p.locationNote.trim()||'未记录'}}
