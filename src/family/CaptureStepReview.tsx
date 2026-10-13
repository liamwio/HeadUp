import {useEffect,useRef} from 'react'
import type {Capture} from '../types'
import {isPhotoQualityAcceptable} from '../lib/photoQualityAcceptance'
import {plainIssue} from '../lib/plainResult'

/** A short stop between views, with the camera released while a photo is inspected. */
export function CaptureStepReview({id,photo,busy,error,nextLabel,onNext,onRetake,onClose}:{id:'front'|'profile';photo?:Capture;busy:boolean;error:string;nextLabel:string;onNext:()=>void;onRetake:()=>void;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null)
  useEffect(()=>{const modal=ref.current,overflow=document.body.style.overflow;modal?.showModal();document.body.style.overflow='hidden';return()=>{modal?.close();document.body.style.overflow=overflow}},[])
  const good=photo?.quality&&photo.poseValidation?.status==='pass'&&!photo.analysisError&&!photo.acceptedWithBias&&isPhotoQualityAcceptable(photo.quality)
  return <dialog ref={ref} className="capture-step-review" aria-labelledby="capture-step-title" onCancel={event=>{event.preventDefault();if(!busy)onClose()}}>
    <header><span>{id==='front'?'正面 1/2':'侧面 2/2'}</span><h2 id="capture-step-title">{busy?'正在检查照片':error?'这张照片未采用':good?'✓ 照片可用':photo?plainIssue(photo).headline:'照片已保留'}</h2></header>
    {photo?.url&&<img src={photo.originalUrl??photo.url} alt={busy||error?'此前保留的照片':`本次${id==='front'?'正面':'侧面'}原始照片`}/>}
    <p role="status">{busy?'稍等几秒，现有照片不会变。':error||(good?'确认是本人、角度对就继续。':photo?plainIssue(photo).tip:'')}</p>
    <footer><button className="family-primary" disabled={busy||Boolean(error)||!photo?.url} onClick={onNext}>{nextLabel}</button><button disabled={busy} onClick={onRetake}>重新拍摄或选图</button><button disabled={busy} onClick={onClose}>返回照片列表</button></footer>
  </dialog>
}
