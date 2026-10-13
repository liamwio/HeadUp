import {preflightImageFile} from '../lib/imageInputPreflight'
export type SharePhotoLoader=(ref:string,signal:AbortSignal)=>Promise<Blob>
const cancelled=()=>new DOMException('照片读取已取消','AbortError')
/** Canceled work keeps its slot until the underlying operation settles, even if it ignores abort. */
export function createSharePhotoQueue(loader:SharePhotoLoader,concurrency=2):{load:SharePhotoLoader} {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('照片并发数无效')
  type Job={ref:string;controller:AbortController;cancelled:boolean;complete:(blob?:Blob,error?:unknown)=>void}
  const pending:Job[]=[];let running=0
  const pump=()=>{
    while(running<concurrency&&pending.length){const job=pending.shift()!;if(job.cancelled)continue;running++
      void Promise.resolve().then(()=>{if(job.controller.signal.aborted)throw cancelled();return loader(job.ref,job.controller.signal)}).then(blob=>job.complete(blob),error=>job.complete(undefined,error)).finally(()=>{running--;pump()})
    }
  }
  return {load:(ref,signal)=>new Promise<Blob>((resolve,reject)=>{
    if(signal.aborted){reject(cancelled());return}
    let finished=false
    const job:Job={ref,controller:new AbortController(),cancelled:false,complete:(blob,error)=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);if(error!==undefined)reject(error);else if(blob)resolve(blob);else reject(new Error('未能读取照片'))}}
    const abort=()=>{job.cancelled=true;job.controller.abort();const index=pending.indexOf(job);if(index!==-1)pending.splice(index,1);job.complete(undefined,cancelled())}
    signal.addEventListener('abort',abort,{once:true});pending.push(job);pump()
  })}
}
/** The mounted photo owns both its cancellation signal and exactly one object URL. */
export function createSharePhotoResource({ref,load,onUrl,onFailure,check=async(blob:Blob)=>{await preflightImageFile(new File([blob],'shared-photo',{type:blob.type}))},urls={create:(blob:Blob)=>URL.createObjectURL(blob),revoke:(url:string)=>URL.revokeObjectURL(url)}}:{ref:string;load:SharePhotoLoader;onUrl:(url:string)=>void;onFailure:(error:Error)=>void;check?:(blob:Blob)=>Promise<void>;urls?:{create:(blob:Blob)=>string;revoke:(url:string)=>void}}) {
  let active=true,created='';const controller=new AbortController()
  void Promise.resolve().then(async()=>{if(!active)return;const blob=await load(ref,controller.signal);if(!active)return;await check(blob);if(!active)return;created=urls.create(blob);onUrl(created)}).catch(error=>{if(active)onFailure(error instanceof Error?error:new Error('照片暂不可读'))})
  return {dispose(){if(!active)return;active=false;controller.abort();if(created){urls.revoke(created);created=''}}}
}
