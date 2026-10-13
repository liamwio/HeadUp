import {evaluateLiveFraming} from './liveFraming'
import {isHeadUpAndroid,isHeadUpIOS} from './appPlatform'
import type {CaptureId,PhotoQuality,PoseValidation,CaptureSelection} from '../types'
import {isPhotoQualityAcceptable} from './imageQuality'

export type CameraFacing='user'|'environment'
export type LiveCaptureMeta={source:'live';capturedAt:string;cameraFacing:CameraFacing|'unknown';captureSelection?:CaptureSelection}
export type LiveInspection={pose:PoseValidation;quality:PhotoQuality}
export function stopCameraStream(stream:MediaStream|null|undefined){stream?.getTracks().forEach(track=>track.stop())}
export function createCameraSession(getMedia:(c:MediaStreamConstraints)=>Promise<MediaStream>) {
  let generation=0,current:MediaStream|undefined
  return {
    async open(facing:CameraFacing) {
      const token=++generation;stopCameraStream(current);current=undefined
      try{
        const stream=await getMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080}}})
        if(token!==generation){stopCameraStream(stream);return null}
        current=stream;return stream
      }catch(error){if(token!==generation)return null;throw error}
    },
    stop(){generation++;stopCameraStream(current);current=undefined},
  }
}
export function cameraErrorMessage(error:unknown) {
  const name=error instanceof Error?error.name:''
  if(name==='NotAllowedError'||name==='SecurityError')return isHeadUpAndroid()?'相机权限未开启。可到系统设置 → 应用 → HeadUp → 权限中允许相机，或直接选择相册照片。':isHeadUpIOS()?'相机权限未开启。请在iPhone设置中找到HeadUp并允许相机，或选择相册照片。':'相机权限未开启。可以在浏览器设置中允许相机，或直接选择相册照片。'
  if(name==='NotFoundError'||name==='OverconstrainedError')return '没有找到可用的相机。可以切换摄像头，或选择相册照片。'
  if(name==='NotReadableError')return '相机可能正被其他应用占用。请关闭占用相机的应用后重试，或使用相册。'
  return '相机暂时无法启动。可以重试，或直接选择相册照片。'
}

/** Continuous good observations, not a timer that keeps running after a bad frame. */
export function createStableCaptureGate(stableMs=1000,countdownMs=2000,maxGapMs=2000) {
  let started:number|null=null,last:number|null=null,fired=false
  return {
    reset(){started=null;last=null;fired=false},
    observe(ready:boolean,now:number){
      if(fired)return {capture:false,countdown:null as number|null}
      if(!ready||!Number.isFinite(now)||(last!==null&&(now<last||now-last>maxGapMs))){started=null;last=now;return{capture:false,countdown:null as number|null}}
      if(started===null)started=now;last=now
      const elapsed=now-started
      if(elapsed<stableMs)return{capture:false,countdown:null as number|null}
      const remaining=stableMs+countdownMs-elapsed
      if(remaining<=0){fired=true;return{capture:true,countdown:0}}
      return{capture:false,countdown:Math.ceil(remaining/1000)}
    },
  }
}
export function liveGuidance(expected:CaptureId,result:LiveInspection,preferredSide?:'left_profile'|'right_profile'|null):{ready:boolean;message:string} {
  const {pose,quality}=result,flags=[...pose.flags,...quality.flags]
  if(pose.detectedFaces>1||pose.estimatedPose==='multiple_faces')return{ready:false,message:'画面中只保留一个人。'}
  if(pose.estimatedPose==='no_face')return{ready:false,message:'让完整面部进入画面，并留出额头和下巴。'}
  if(flags.some(f=>/遮挡|口罩|眼镜/.test(f)))return{ready:false,message:'请露出面部，摘下遮挡轮廓的眼镜或口罩。'}
  if(expected==='front'||expected==='profile'){const framing=evaluateLiveFraming(pose,expected);if(!framing.ready)return{ready:false,message:framing.message??'请将头部放进取景框，留出上下边缘。'}}
  if(flags.some(f=>/太小|靠近/.test(f)))return{ready:false,message:'面部偏小，请靠近一点，让头部进入取景框。'}
  if(flags.some(f=>/中央/.test(f)))return{ready:false,message:'把面部完整放到画面中间。'}
  if(flags.some(f=>/俯仰|抬头|低头|眼睛同高/.test(f)))return{ready:false,message:'调整手机高度，让镜头与眼睛同高。'}
  if(flags.some(f=>/横向倾斜/.test(f)))return{ready:false,message:expected==='profile'?'侧面倾斜估计待核对：先把手机拿正、镜头移到眼睛高度，保持自然侧面。':'头部轻轻扶正，保持自然放松。'}
  if(expected==='front'&&pose.estimatedPose!=='front'||flags.some(f=>/直视镜头/.test(f)))return{ready:false,message:'正面看向镜头，脸和双肩尽量朝前。'}
  if(expected==='profile'&&!['left_profile','right_profile'].includes(pose.estimatedPose))return{ready:false,message:'转向侧面接近90°，完整露出额、鼻、唇和下巴。'}
  if(expected==='profile'&&preferredSide&&pose.estimatedPose!==preferredSide)return{ready:false,message:`请拍${preferredSide==='left_profile'?'左':'右'}侧面，保持头部自然竖直。`}
  if(flags.some(f=>/光线不足/.test(f)))return{ready:false,message:'面向柔和光源，让面部更明亮。'}
  if(flags.some(f=>/过曝/.test(f)))return{ready:false,message:'避开直射强光，保留面部纹理。'}
  if(flags.some(f=>/模糊|低清|分辨率/.test(f)))return{ready:false,message:'保持手机稳定、重新对焦，或使用清晰的相册原图。'}
  if(pose.status!=='pass'||!isPhotoQualityAcceptable(quality))return{ready:false,message:'保持自然表情与清晰轮廓，稍微调整取景。'}
  return{ready:true,message:'拍摄条件已满足，保持一下。'}
}
