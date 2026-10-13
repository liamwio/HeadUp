import type {LiveInspection} from './liveCamera'
import {evaluateLiveFraming,type FramingCheck} from './liveFraming'
import {isPhotoQualityAcceptable} from './imageQuality'
export function liveCaptureChecks(expected:'front'|'profile',result:LiveInspection|null,preferredSide?:'left_profile'|'right_profile'|null):FramingCheck[]{
  const labels=['距离','完整入镜','位置','角度','光线','清晰度']
  if(!result||result.pose.estimatedPose==='no_face'||result.pose.estimatedPose==='multiple_faces'||(result.pose.detectedFaces!==1&&!(expected==='profile'&&result.pose.detectedFaces===0&&result.pose.faceBounds&&['left_profile','right_profile'].includes(result.pose.estimatedPose))))return labels.map(label=>({label,state:'unknown',detail:'等待检测'}))
  const {pose,quality}=result,framing=evaluateLiveFraming(pose,expected),flags=[...pose.flags,...quality.flags]
  const poseFlags=flags.some(f=>/俯仰|抬头|低头|眼睛同高|横向倾斜|直视镜头|90°/.test(f))
  const direction=expected==='front'?pose.estimatedPose==='front'&&(!Number.isFinite(pose.yaw)||Math.abs(pose.yaw!)<=12):preferredSide?pose.estimatedPose===preferredSide:['left_profile','right_profile'].includes(pose.estimatedPose)
  const angleGood=direction&&!poseFlags&&(expected!=='front'||!Number.isFinite(pose.pitch)||Math.abs(pose.pitch!)<=9)&&(!Number.isFinite(pose.roll)||Math.abs(pose.roll!)<=(expected==='front'?12:18))
  const light=flags.find(f=>/光线不足|过曝|光照|反差|对比度/.test(f)),blur=flags.some(f=>/模糊|低清|分辨率/.test(f)),pixels=isPhotoQualityAcceptable(quality)
  return [{...framing.distance,label:'距离',detail:framing.distance.state==='unknown'?'等待检测':framing.distance.state==='good'?'画面大小合适':framing.distance.label},{...framing.completeness,label:'完整入镜',detail:framing.completeness.state==='unknown'?'等待检测':framing.completeness.state==='good'?'边缘留白合适':framing.completeness.detail.split('，')[0]},{...framing.position,label:'位置',detail:framing.position.state==='unknown'?'等待检测':framing.position.state==='good'?'位于中央':framing.position.detail.replace('请','').replace('移动头部，让面部居中','移到中央')},{label:'角度',state:angleGood?'good':'adjust',detail:angleGood?'角度合适':!direction?(expected==='front'?'正对镜头':preferredSide==='right_profile'?'转向右侧':'转向左侧'):expected==='profile'&&pose.flags.includes('头部横向倾斜过大')?'倾斜估计待核对':'头部扶正、镜头同高'},
    {label:'光线',state:light?'adjust':pixels?'good':'unknown',detail:light?/过曝/.test(light)?'避开强光':'调整光线':pixels?'光线合适':'等待确认'},
    {label:'清晰度',state:blur?'adjust':pixels?'good':'unknown',detail:blur?'拿稳并对焦':pixels?'清晰':'等待确认'}]
}
