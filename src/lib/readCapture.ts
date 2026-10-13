import type {CaptureId,PhotoQuality,PoseValidation} from '../types'
import {prepareCaptureFile,type PreparedCapture} from './prepareCaptureFile'
import {preflightImageFile} from './imageInputPreflight'
import {inspectImageBitmap} from './imageQuality'
import type {StraighteningRecord} from './photoStraightening'
import {profileMeasurementFailure} from './profileMeasurementFailure'

export type ReadCaptureResult={file:File;width:number;height:number;quality:PhotoQuality;pose?:PoseValidation;straightening?:StraighteningRecord;analysisError?:string}
export const MODEL_UNAVAILABLE_COPY='检测模型暂不可用，照片已保留。可以稍后重试检测，或保存为生活留念。'
export async function readImageWithoutModels(file:File) {
  await preflightImageFile(file)
  const bitmap=await createImageBitmap(file)
  try{return {width:bitmap.width,height:bitmap.height,quality:inspectImageBitmap(bitmap)}}finally{bitmap.close()}
}
type Dependencies={prepare:(id:CaptureId,file:File,auto:boolean)=>Promise<PreparedCapture>;read:typeof readImageWithoutModels;timeoutMs:number}
/** Never turn a model outage into an unreadable-image error or silently drop a valid photo. */
export async function readCapture(id:CaptureId,file:File,auto=true,deps:Dependencies={prepare:prepareCaptureFile,read:readImageWithoutModels,timeoutMs:25000}):Promise<ReadCaptureResult> {
  if(id==='right_profile')id='profile'
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    const result=await Promise.race([deps.prepare(id,file,auto),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('model_timeout')),deps.timeoutMs)})])
    return {...result,analysisError:id==='profile'?profileMeasurementFailure(result.pose,result.quality):undefined}
  }catch {
    // This still throws for corrupt/unsupported/unreadable images. Only readable
    // photos may become a record without a model result.
    const image=await deps.read(file)
    return {...image,file,analysisError:MODEL_UNAVAILABLE_COPY}
  }finally{if(timer)clearTimeout(timer)}
}
