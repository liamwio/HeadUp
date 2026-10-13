import {autoSaveCameraPhoto} from './photoDirectory'
import {readPhotoDate,captureDateSummary} from '../lib/photoDate'
import {useEffect,useRef,useState} from 'react'
import {Camera,ImagePlus,ArrowLeft,Save} from 'lucide-react'
import type {Capture} from '../types'
import {LiveCapture,type CameraDependencies} from '../LiveCapture'
import {DEFAULT_CAMERA_OPTIONS} from '../lib/cameraFeedback'
import type {LiveCaptureMeta} from '../lib/liveCamera'
import {readCapture} from '../lib/readCapture'
import {correctMirroredFrontFile} from '../lib/mirrorCorrection'
import {revokeCaptureImages} from '../lib/captureImageUrls'
import {familyStore,storageMessage} from './store'
import {defaultProtocol,localDate,type CaptureProtocol,type FamilyProfile,type FamilySession,type ProfileSide} from './model'
import {CAPTURE_SEQUENCE,type RecordView} from './captureViews'
import {PersonalReport} from './PersonalReport'
import {useSessionCaptures} from './hooks'
import {RecordVerdict} from './RecordVerdict'
import {captureStatus,plainIssue} from '../lib/plainResult'
export function RecordFlow({cameraRuntime,profile,previousSession,onSaved,onExit,onBusy,onDirty,onPrivacy}:{cameraRuntime?:CameraDependencies;receivingHandoff?:boolean;allowLocalHandoff?:boolean;onAccount:()=>void;onHandoffOpen:(id:string)=>void;requestedSide?:ProfileSide;profile:FamilyProfile;cloudFamilyName?:string;previousSession?:FamilySession;onSaved:(s:FamilySession)=>void;onExit:()=>void;onBusy:(b:boolean)=>void;onDirty:(b:boolean)=>void;onPrivacy:()=>void}){
  const [captures,setCaptures]=useState<Capture[]>(()=>CAPTURE_SEQUENCE.map((view,i)=>({id:view.id,label:view.label,eyebrow:`0${i+1}`,hint:view.id==='front'?'看镜头，闭上嘴，表情放松。':`转到${view.label}面，露出额头到下巴。`})))
  const [index,setIndex]=useState(0),[stage,setStage]=useState<'capture'|'confirm'|'review'>('capture'),[cameraOpen,setCameraOpen]=useState(false),[options,setOptions]=useState(DEFAULT_CAMERA_OPTIONS),[working,setWorking]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[recordedOn,setRecordedOn]=useState(''),[kind,setKind]=useState<'measurement'|'memory'>('measurement'),[otherPurpose,setOtherPurpose]=useState(''),[dateEdited,setDateEdited]=useState(false),[note,setNote]=useState(''),[protocol,setProtocol]=useState(defaultProtocol()),[mirrored,setMirrored]=useState(false)
  const alive=useRef(true),busyNow=useRef(false),current=useRef(captures),picker=useRef<HTMLInputElement>(null),heading=useRef<HTMLHeadingElement>(null);current.current=captures
  const previous=useSessionCaptures(previousSession),view=CAPTURE_SEQUENCE[index],photo=captures.find(c=>c.id===view.id),busy=working||saving
  const dirty=captures.some(c=>c.url)
  useEffect(()=>{onDirty(dirty)},[dirty,onDirty])
  useEffect(()=>{onBusy(busy||cameraOpen)},[busy,cameraOpen,onBusy])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;current.current.forEach(revokeCaptureImages);onBusy(false)}},[onBusy])
  useEffect(()=>{window.scrollTo(0,0);heading.current?.focus({preventScroll:true})},[stage,index])
  const dateSummary=captureDateSummary(captures)
  useEffect(()=>{const photos=captures.filter(c=>c.url);if(!photos.length)return;setRecordedOn(captureDateSummary(captures).date);setDateEdited(false);const live=photos.every(c=>c.source==='live'),modes=new Set(photos.map(c=>c.cameraFacing));setProtocol(p=>({...p,method:live?'live':'uploaded',camera:live&&modes.size===1&&modes.has('environment')?'rear':live&&modes.size===1&&modes.has('user')?'front':'unknown'}))},[captures.map(c=>c.url).join('|')])
  const field=<K extends keyof CaptureProtocol>(key:K,value:CaptureProtocol[K])=>setProtocol(p=>({...p,[key]:value}))
  const take=async(id:RecordView,file:File,meta?:LiveCaptureMeta,mirror=false)=>{
    if(busyNow.current)return;busyNow.current=true;setCameraOpen(false);setWorking(true);setError('')
    try{
      if(meta?.source==='live')void autoSaveCameraPhoto(profile,id,file,meta.capturedAt)
      const photoDate=meta?.capturedAt?localDate(new Date(meta.capturedAt)):await readPhotoDate(file)
      const original=id==='front'&&mirror?await correctMirroredFrontFile(file):file,result=await readCapture(id==='front'?'front':'profile',original,true)
      if(!alive.current)return
      const expected=id==='front'?'front':id==='profile'?'left_profile':'right_profile',actual=result.pose?.estimatedPose
      if(actual&&['front','left_profile','right_profile'].includes(actual)&&actual!==expected)throw new Error(`当前步骤需要${CAPTURE_SEQUENCE.find(v=>v.id===id)!.label}照片，请按提示重拍或重新选择；已有照片未更改。`)
      const url=URL.createObjectURL(result.file),originalUrl=result.straightening?.status==='applied'?URL.createObjectURL(original):undefined
      setCaptures(rows=>rows.map(c=>{if(c.id!==id)return c;revokeCaptureImages(c);return {...c,url,originalUrl,fileName:file.name,source:meta?.source??'upload',capturedAt:meta?.capturedAt,photoDate,photoDateSource:photoDate?(meta?'live':'exif'):undefined,captureSelection:meta?.captureSelection,cameraFacing:meta?.cameraFacing,mirrorCorrected:id==='front'&&mirror,quality:result.quality,poseValidation:result.pose,straightening:result.straightening,analysisError:result.analysisError,inputError:undefined}}));
      if(id==='profile'&&!result.analysisError&&result.pose?.nativeProfile?.status==='measured'&&result.pose?.status==='pass'&&actual==='left_profile'){setIndex(2);setStage('capture');setMirrored(false);setCameraOpen(Boolean(meta))}else setStage('confirm')
    }catch(e){if(alive.current)setError(storageMessage(e))}finally{busyNow.current=false;if(alive.current)setWorking(false)}
  }
  const retry=async()=>{
    if(busyNow.current||!photo?.url||photo.id==='front')return
    const previous=photo
    busyNow.current=true;setWorking(true);setError('')
    try {
      const response=await fetch(previous.originalUrl??previous.url!)
      if(!response.ok)throw new Error('照片无法读取，请重新选择原图。')
      const blob=await response.blob(),file=new File([blob],previous.fileName??'photo',{type:blob.type})
      const result=await readCapture(previous.id,file,true)
      if(!alive.current)return
      // Side analysis preserves the original pixels. Keep URLs and capture date
      // metadata too, so a retry is not treated as a newly imported photo.
      setCaptures(rows=>rows.map(c=>c.id===previous.id?{...c,quality:result.quality,poseValidation:result.pose,analysisError:result.analysisError}:c))
      setStage('confirm')
    }catch(e){if(alive.current)setError(storageMessage(e))}finally{busyNow.current=false;if(alive.current)setWorking(false)}
  }
  const next=()=>{if(busyNow.current||cameraOpen)return;setError('');setMirrored(false);if(index<2){setIndex(index+1);setStage('capture')}else setStage('review')}
  const reference=previous.captures.find(c=>c.id===view.id&&(view.side===null||c.poseValidation?.estimatedPose===view.side))
  const save=async()=>{if(busyNow.current||!dirty||!recordedOn)return;busyNow.current=true;setSaving(true);setError('');try{const saved=await familyStore.saveSession({profileId:profile.id,recordedOn,kind,purpose:kind==='measurement'?'面部生长记录':otherPurpose.trim()||'其他',dateSource:dateEdited?'user_confirmed':protocol.method==='live'?'live_capture':'photo_metadata',recordedBy:'user',note,protocol},captures);if(alive.current){onDirty(false);onSaved(saved)}}catch(e){if(alive.current)setError(storageMessage(e))}finally{busyNow.current=false;if(alive.current)setSaving(false)}}
  return <section className="personal-capture-flow"><button className="family-back" disabled={busy} onClick={onExit}><ArrowLeft size={16}/>返回档案</button><div className="family-record-context"><strong>{profile.nickname}的本次记录</strong><span>正面 → 侧面</span></div><ol className="personal-capture-steps" aria-label="拍摄顺序"><li aria-current={stage!=='review'&&index===0?'step':undefined}>1. 正面{captures[0].url?' · 已添加':''}</li><li aria-current={stage!=='review'&&index>0?'step':undefined}>2. 侧面{captures[1].url&&captures[2].url?' · 已添加':''}</li></ol>
    {stage!=='review'?<><h1 ref={heading} tabIndex={-1}>{index===0?'正面 · 1/2':'侧面 · 2/2'}</h1><p>{photo?.hint}</p>{photo?.url&&<figure className="personal-capture-preview"><figcaption>{captureStatus(photo)==='ok'?<strong className="plain-ok">✓ 照片可用</strong>:(()=>{const issue=plainIssue(photo);return <div className="plain-issue" role="status"><strong>{issue.headline}</strong><span>{issue.tip}</span>{issue.detail&&<details><summary>详细原因</summary><p>{issue.detail}</p></details>}</div>})()}</figcaption><img src={photo.originalUrl??photo.url} alt={view.label+'照片'}/></figure>}
      <div className="family-actions">{photo?.url&&photo.id!=='front'&&photo.analysisError&&<button disabled={busy} onClick={()=>void retry()}>重新检测这张照片</button>}<button className="family-primary" disabled={busy} onClick={()=>setCameraOpen(true)}><Camera size={18}/>{photo?.url?'重拍':'拍摄'}{view.label}</button><button disabled={busy} onClick={()=>picker.current?.click()}><ImagePlus size={18}/>{photo?.url?'更换':'选择'}{view.label}照片</button>{stage==='confirm'&&photo?.url&&<button className="family-primary" disabled={busy} onClick={next}>{index===2?'核对并保存':'保留并继续'+CAPTURE_SEQUENCE[index+1].label}</button>}<button disabled={busy} onClick={next}>{photo?.url?'继续':'稍后补充此视角'}</button></div>
      <input ref={picker} hidden type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)void take(view.id,file,undefined,mirrored)}}/>{view.id==='front'&&<details className="family-protocol"><summary>相册照片选项</summary><label className="family-inline-check"><input type="checkbox" checked={mirrored} onChange={e=>setMirrored(e.target.checked)}/>所选正面照片是镜像自拍</label></details>}
      {cameraOpen&&<LiveCapture id={view.id==='front'?'front':'profile'} key={view.id} stepLabel={index===0?'正面 1/2':'侧面 2/2'} profileName="" preferredSide={view.side} reference={reference} runtime={cameraRuntime} options={options} onOptionsChange={setOptions} onClose={()=>setCameraOpen(false)} onCapture={(file,meta)=>void take(view.id,file,meta)} onAlbum={(file,mirror)=>void take(view.id,file,undefined,mirror)}/>}</>:<><h1 ref={heading} tabIndex={-1}>本次结果</h1><RecordVerdict captures={captures} busy={busy} onView={id=>{const i=CAPTURE_SEQUENCE.findIndex(v=>v.id===id);if(i<0)return;setIndex(i);setStage('capture');setError('')}}/>
      <form className="family-save-form" onSubmit={e=>{e.preventDefault();void save()}}><p className="family-muted">保存到 {profile.nickname} 的档案，只存在本机。</p><div className="family-form-grid"><label>拍摄日期<input type="date" required max={localDate()} value={recordedOn} onChange={e=>{setRecordedOn(e.target.value);setDateEdited(true)}}/></label><label>记录用途<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="measurement">面部生长记录</option><option value="memory">其他</option></select></label></div><p className="family-muted" role="status">{dateEdited?'日期已手动修改。':dateSummary.message}</p>{kind==='memory'&&<label>自定义用途（选填）<input value={otherPurpose} maxLength={100} placeholder="填写本次记录的用途" onChange={e=>setOtherPurpose(e.target.value)}/></label>}<details className="family-protocol"><summary>拍摄条件（选填）</summary><label>设备备注<input value={protocol.device} maxLength={100} onChange={e=>field('device',e.target.value)}/></label><label>摄像头<select value={protocol.camera} onChange={e=>field('camera',e.target.value as CaptureProtocol['camera'])}><option value="unknown">未记录</option><option value="rear">后置</option><option value="front">前置</option></select></label><label>实际距离（厘米）<input type="number" min={10} max={1000} value={protocol.distanceCm??''} onChange={e=>field('distanceCm',e.target.value?Number(e.target.value):null)}/></label><label>光线<select value={protocol.light} onChange={e=>field('light',e.target.value as CaptureProtocol['light'])}><option value="unknown">未记录</option><option value="daylight">自然光</option><option value="indoor">室内灯光</option></select></label><label>位置或方法<input value={protocol.locationNote} maxLength={200} onChange={e=>field('locationNote',e.target.value)}/></label></details><label>备注（选填）<textarea value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label><button className="family-primary" disabled={busy||!dirty||!recordedOn}><Save size={18}/>{saving?'正在保存…':'保存到档案'}</button></form>{kind==='measurement'&&<PersonalReport captures={captures} showVerdict={false} onRetake={()=>{setIndex(0);setStage('capture')}} onPrivacy={onPrivacy}/>}</>}
    {working&&<p role="status" className="family-notice">正在检查照片，已有照片保持不变…</p>}{error&&<p role="alert" className="family-error">{error}</p>}
  </section>
}
