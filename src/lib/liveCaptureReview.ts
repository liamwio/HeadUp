import {liveGuidance,type LiveInspection} from './liveCamera'

export type CapturedFrameReview={ready:boolean;message:string;inspection?:LiveInspection}
/** Recheck the actual encoded/selected photo, not an earlier preview frame. */
export async function reviewCapturedFrame(file:File,id:'front'|'profile',side:'left_profile'|'right_profile'|null|undefined,inspect:(id:'front'|'profile',bitmap:ImageBitmap)=>Promise<LiveInspection>,decode:(file:File)=>Promise<ImageBitmap>=createImageBitmap,timeoutMs=12000):Promise<CapturedFrameReview>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
    const bitmap=await decode(file)
    const analysis=Promise.resolve().then(()=>inspect(id,bitmap)).finally(()=>bitmap.close())
    const inspection=await Promise.race([analysis,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('capture_review_timeout')),timeoutMs)})])
    return {...liveGuidance(id,inspection,side),inspection}
  }catch{return {ready:false,message:'拍后检查未完成。可以重拍，或保留原照片后重试检测。'}}
  finally{if(timer)clearTimeout(timer)}
}

/** Avoid an endless instruction to twist the head when profile pose is uncertain. */
export function createLiveCaptureCoach(){
  let since:number|undefined,last:number|undefined
  return {
    reset(){since=undefined;last=undefined},
    observe(id:'front'|'profile',result:LiveInspection,message:string,now:number){
      const uncertain=id==='profile'&&result.pose.flags.includes('头部横向倾斜过大')&&message.startsWith('侧面倾斜估计待核对')
      if(!uncertain||!Number.isFinite(now)){since=undefined;last=undefined;return message}
      if(since===undefined||last===undefined||now<last||now-last>3000)since=now
      last=now
      return now-since>=6000?'侧面角度仍待核对。若手机和头部已端正，请不要继续扭头；可拍下后核对，或调整机位再试。':message
    },
  }
}
