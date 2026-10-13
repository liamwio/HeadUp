import type { CaptureId } from '../types'
import { inspectCaptureFile } from './captureAnalysis'
import { isPhotoQualityAcceptable } from './imageQuality'
import { preflightImageFile } from './imageInputPreflight'
import { estimateFrontTilt, rotatedFaceFits, straighteningAlignmentRms, STRAIGHTENING_LIMITS as limits, STRAIGHTENING_VERSION, uprightEligibility, type StraighteningRecord } from './photoStraightening'

export type CaptureInspection = Awaited<ReturnType<typeof inspectCaptureFile>>
export type PreparedCapture = CaptureInspection & { file:File; straightening:StraighteningRecord }
export type StraighteningDependencies = {
  inspect:typeof inspectCaptureFile
  rotate:(file:File,degrees:number)=>Promise<File>
}

export async function rotatePhotoFile(file:File,degrees:number):Promise<File> {
  if(!Number.isFinite(degrees)||Math.abs(degrees)>limits.maximumDegrees)throw new Error('rotation_angle_limit')
  await preflightImageFile(file)
  const bitmap=await createImageBitmap(file)
  try {
    if(bitmap.width*bitmap.height>limits.maximumInputPixels)throw new Error('rotation_size_limit')
    const sample=document.createElement('canvas');sample.width=16;sample.height=16
    const sampleContext=sample.getContext('2d',{willReadFrequently:true})
    if(!sampleContext)throw new Error('rotation_canvas_unavailable')
    sampleContext.drawImage(bitmap,0,0,16,16)
    const pixels=sampleContext.getImageData(0,0,16,16).data,channels=[[],[],[]] as number[][]
    for(let y=0;y<16;y++)for(let x=0;x<16;x++)if(x===0||x===15||y===0||y===15)for(let k=0;k<3;k++)channels[k].push(pixels[(y*16+x)*4+k])
    const background=channels.map(values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)])
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height
    const context=canvas.getContext('2d')
    if(!context)throw new Error('rotation_canvas_unavailable')
    context.fillStyle=`rgb(${background.join(',')})`;context.fillRect(0,0,canvas.width,canvas.height)
    context.translate(canvas.width/2,canvas.height/2);context.rotate(degrees*Math.PI/180)
    context.drawImage(bitmap,-bitmap.width/2,-bitmap.height/2)
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('rotation_encode_failed')),'image/png'))
    if(blob.size>30*1024*1024)throw new Error('rotation_file_size_limit')
    return new File([blob],'straightened.png',{type:'image/png',lastModified:file.lastModified})
  } finally {bitmap.close()}
}

/** Product entry: raw inspection -> candidate -> full reinspection -> adopt or keep original.
 * The raw inspectCaptureFile remains available to research and to prevent recursion. */
export async function prepareCaptureFile(expected:CaptureId,file:File,autoStraighten=true,dependencies:StraighteningDependencies={inspect:inspectCaptureFile,rotate:rotatePhotoFile}):Promise<PreparedCapture> {
  const original=await dependencies.inspect(expected,file)
  const base:StraighteningRecord={version:STRAIGHTENING_VERSION,status:'not_applied',reason:'',originalFlags:[...new Set([...original.quality.flags,...original.pose.flags])]}
  const keep=(status:StraighteningRecord['status'],reason:string,extra:Partial<StraighteningRecord>={}):PreparedCapture=>({...original,file,straightening:{...base,...extra,status,reason}})
  if(!autoStraighten)return keep('disabled','自动扶正已关闭，使用原图。')
  if(expected==='top')return keep('not_needed','头顶照片不参与自动扶正。')
  if(expected==='profile')return keep('not_applied','侧面水平参照尚未验证，本次保留原图；若提示歪头，请保持头部竖直后重拍。')
  if(!isPhotoQualityAcceptable(original.quality))return keep('not_applied','原图质量未通过，自动扶正不会代替清晰度和曝光要求。')
  const ineligible=uprightEligibility(original.pose,original.quality)
  if(ineligible)return keep('not_applied',ineligible)
  const estimate=estimateFrontTilt(original.pose.landmarks,original.width,original.height)
  if(!estimate)return keep('not_applied','双眼与面部中轴的倾斜判断不一致，保留原图。')
  const evidence={estimatedTiltDegrees:estimate.degrees}
  if(Math.abs(estimate.degrees)<limits.minimumDegrees)return keep('not_needed','未发现需要自动扶正的平面倾斜，使用原图。',evidence)
  if(Math.abs(estimate.degrees)>limits.maximumDegrees)return keep('not_applied','歪头超过自动扶正范围，请保持头部竖直后重拍。',evidence)
  if(original.width*original.height>limits.maximumInputPixels)return keep('not_applied','照片过大，未生成扶正副本；保留原图。',evidence)
  const rotationDegrees=-estimate.degrees
  if(!rotatedFaceFits(original.pose.landmarks!,original.width,original.height,rotationDegrees))return keep('not_applied','扶正可能裁到面部或周围安全边界，已保留原图；请留出更多取景空间后重拍。',evidence)
  try {
    const correctedFile=await dependencies.rotate(file,rotationDegrees)
    const corrected=await dependencies.inspect(expected,correctedFile)
    const residual=estimateFrontTilt(corrected.pose.landmarks,corrected.width,corrected.height)
    const rms=straighteningAlignmentRms(original.pose.landmarks!,corrected.pose.landmarks??[],original.width,original.height,corrected.width,corrected.height,rotationDegrees)
    const valid=corrected.pose.status==='pass'&&corrected.pose.detectedFaces===1&&corrected.pose.estimatedPose==='front'&&isPhotoQualityAcceptable(corrected.quality)&&!uprightEligibility(corrected.pose,corrected.quality)
      &&corrected.quality.score>=original.quality.score-8&&residual!==null&&Math.abs(residual.degrees)<=limits.maximumResidualDegrees
      &&Math.abs(residual.degrees)<=Math.abs(estimate.degrees)*.25&&rms<=limits.maximumAlignmentRms
    if(!valid)return keep('not_applied','扶正候选未通过质量、姿态或关键点复核，已保留原图和原检测结果。',evidence)
    return {...corrected,file:correctedFile,straightening:{...base,...evidence,status:'applied',rotationDegrees,residualTiltDegrees:residual!.degrees,reason:'自动扶正后重新检测通过。'}}
  } catch {
    return keep('not_applied','本次自动扶正未完成，已保留原图和原检测结果。',evidence)
  }
}
