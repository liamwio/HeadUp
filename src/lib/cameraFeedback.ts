export type CameraOptions={auto:boolean;voice:boolean;burst:boolean;haptics:boolean}
export const DEFAULT_CAMERA_OPTIONS:CameraOptions={auto:true,voice:false,burst:true,haptics:false}
/** Compact preview copy; full diagnostic guidance remains in the settings panel. */
export function compactCameraGuidance(message:string){
  if(message.startsWith('侧面角度仍待核对'))return '侧面角度待核对；已端正时不要继续扭头。'
  if(message.startsWith('侧面倾斜估计待核对'))return '侧面角度待核对，请先拿正手机。'
  if(message==='拍摄条件已满足，保持一下。')return '已就绪，请保持不动。'
  if(message==='让完整面部进入画面，并留出额头和下巴。')return '面部入框，留出头顶和下巴。'
  if(message==='实时检测暂不可用，仍可手动拍摄并保存照片。')return '检测暂不可用，可手动拍摄。'
  if(message==='保持手机稳定、重新对焦，或使用清晰的相册原图。')return '拿稳手机，对焦面部。'
  return message
}
/** Invoke only after taking the final frame. API acceptance is not proof of hardware feedback. */
export function requestCaptureHaptic({enabled,visible,vibrate}:{enabled:boolean;visible:boolean;vibrate?:((duration:number)=>boolean)}):boolean{
  if(!enabled||!visible||!vibrate)return false
  try{return vibrate(40)===true}catch{return false}
}
