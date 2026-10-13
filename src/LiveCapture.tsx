import {CameraFramingGuide} from './CameraFramingGuide'
import {CameraSideHints} from './CameraSideHints'
import {createLiveCaptureCoach,reviewCapturedFrame,type CapturedFrameReview} from './lib/liveCaptureReview'
import {liveCaptureChecks} from './lib/liveCaptureChecks'
import {useEffect,useId,useRef,useState} from 'react'
import {Camera,ImagePlus,RefreshCcw,Volume2,VolumeX,X,CheckCircle2,Move,Minus} from 'lucide-react'
import type {Capture,PhotoQuality} from './types'
import {captureShortBurst} from './lib/shortBurst'
import {DEFAULT_CAMERA_OPTIONS,requestCaptureHaptic,compactCameraGuidance,type CameraOptions} from './lib/cameraFeedback'
import {createCameraSession,createStableCaptureGate,cameraErrorMessage,liveGuidance,type CameraFacing,type LiveCaptureMeta,type LiveInspection} from './lib/liveCamera'
import {inspectCapturePoseBitmap} from './lib/facePose'
import {inspectImageBitmap} from './lib/imageQuality'
import {buildFrontLandmarkOverlay} from './lib/frontLandmarkOverlay'
import {buildNativeProfilePresentation} from './lib/nativeProfilePresentation'

export type CameraDependencies={getMedia:(c:MediaStreamConstraints)=>Promise<MediaStream>;inspect:(id:'front'|'profile',bitmap:ImageBitmap,stage?:'preview'|'captured')=>Promise<LiveInspection>}
const dependencies:CameraDependencies={getMedia:c=>navigator.mediaDevices.getUserMedia(c),inspect:async(id,bitmap)=>({quality:inspectImageBitmap(bitmap),pose:await inspectCapturePoseBitmap(id,bitmap)})}
export function LiveCapture({id,profileName,preferredSide,stepLabel,reference,onCapture,onAlbum,onClose,options:providedOptions,onOptionsChange,runtime=dependencies}:{id:'front'|'profile';profileName:string;stepLabel?:string;preferredSide?:'left_profile'|'right_profile'|null;reference?:Capture;onCapture:(file:File,meta:LiveCaptureMeta)=>void;onAlbum:(file:File,mirror:boolean)=>void;onClose:()=>void;options?:CameraOptions;onOptionsChange?:(options:CameraOptions)=>void;runtime?:CameraDependencies}) {
  const dialog=useRef<HTMLDialogElement>(null),video=useRef<HTMLVideoElement>(null),canvas=useRef<HTMLCanvasElement|undefined>(undefined)
  const albumInput=useRef<HTMLInputElement>(null),stopNow=useRef<()=>void>(()=>{}),[paused,setPaused]=useState(false),[mirrorAlbum,setMirrorAlbum]=useState(false)
  const [facing,setFacing]=useState<CameraFacing>('environment'),[restart,setRestart]=useState(0),[phase,setPhase]=useState<'opening'|'ready'|'error'>('opening'),[message,setMessage]=useState('正在请求相机…'),[error,setError]=useState(''),[showReference,setShowReference]=useState(false),[countdown,setCountdown]=useState<number|null>(null),[capturing,setCapturing]=useState(false),[ready,setReady]=useState(false)
  const [inspection,setInspection]=useState<LiveInspection|null>(null),[dimensions,setDimensions]=useState({width:4,height:3})
  const [pending,setPending]=useState<{file:File;meta:LiveCaptureMeta;url:string;review:CapturedFrameReview}|null>(null)
  const reviewHeading=useRef<HTMLHeadingElement>(null)
  const [localOptions,setLocalOptions]=useState(DEFAULT_CAMERA_OPTIONS),options=providedOptions??localOptions,{auto,voice,burst,haptics}=options
  const setOption=<K extends keyof CameraOptions>(key:K,value:CameraOptions[K])=>{const next={...options,[key]:value};if(onOptionsChange)onOptionsChange(next);else setLocalOptions(next)}
  const hapticHelpId=useId(),moreId=useId()
  const [moreOpen,setMoreOpen]=useState(false),moreButton=useRef<HTMLButtonElement>(null),moreHeading=useRef<HTMLHeadingElement>(null)
  const hasHapticApi=typeof navigator!=='undefined'&&typeof navigator.vibrate==='function'
  const latest=useRef({auto,voice,burst,haptics,onCapture,onClose,moreOpen});latest.current={auto,voice,burst,haptics,onCapture,onClose,moreOpen}
  const captureAction=useRef<()=>Promise<void>>(async()=>{}),gate=useRef(createStableCaptureGate())
  const referencePose=reference?.poseValidation
  const front=referencePose?.landmarks&&referencePose.landmarkImageWidth&&referencePose.landmarkImageHeight?buildFrontLandmarkOverlay(referencePose.landmarks,referencePose.landmarkImageWidth,referencePose.landmarkImageHeight):null
  const side=buildNativeProfilePresentation(referencePose?.nativeProfile,referencePose?.landmarkImageWidth,referencePose?.landmarkImageHeight)
  const hasReference=id==='front'?Boolean(front):Boolean(side)
  useEffect(()=>{gate.current.reset();setCountdown(null)},[auto,moreOpen])
  useEffect(()=>()=>{if(pending)URL.revokeObjectURL(pending.url)},[pending])
  useEffect(()=>{if(pending)reviewHeading.current?.focus()},[pending])
  useEffect(()=>{if((!voice||moreOpen)&&typeof speechSynthesis!=='undefined')speechSynthesis.cancel()},[voice,moreOpen])
  useEffect(()=>{if(moreOpen)moreHeading.current?.focus()},[moreOpen])
  useEffect(()=>{
    const modal=dialog.current,oldOverflow=document.body.style.overflow;modal?.showModal();document.body.style.overflow='hidden'
    return()=>{modal?.close();document.body.style.overflow=oldOverflow}
  },[])
  useEffect(()=>{
    let active=true,disposed=false,busy=false,timer:ReturnType<typeof setTimeout>|undefined,stream:MediaStream|null=null,modelErrors=0,lastSpoken='',lastSpokenAt=0
    const controller=createCameraSession(runtime.getMedia),coach=createLiveCaptureCoach()
    const stop=()=>{if(disposed)return;disposed=true;active=false;if(timer)clearTimeout(timer);controller.stop();if(video.current)video.current.srcObject=null;if(latest.current.voice&&typeof speechSynthesis!=='undefined')speechSynthesis.cancel()}
    stopNow.current=stop
    if(paused){setInspection(null);setPhase('opening');setReady(false);gate.current.reset();setCountdown(null);return stop}
    const frame=()=>{
      const v=video.current
      if(!v||v.readyState<2||!v.videoWidth||!v.videoHeight)throw new Error('相机画面尚未准备好')
      if(v.videoWidth*v.videoHeight>16_000_000)throw new Error('相机画面过大，请切换摄像头或使用相册')
      const c=canvas.current??=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight
      const context=c.getContext('2d');if(!context)throw new Error('无法读取相机画面');context.drawImage(v,0,0,c.width,c.height);return c
    }
    captureAction.current=async()=>{
      if(!active||busy||!stream)return
      busy=true;setMoreOpen(false);setCapturing(true);setMessage('正在选取清晰画面…');gate.current.reset();setCountdown(null)
      try{
        const useBurst=latest.current.burst
        const selected=await captureShortBurst({enabled:useBurst,current:()=>active,take:async()=>{
          const capturedAt=new Date().toISOString(),c=frame();let bitmap:ImageBitmap|undefined,quality:PhotoQuality|undefined
          try{bitmap=await createImageBitmap(c);if(!active)throw new DOMException('拍摄已停止','AbortError');quality=inspectImageBitmap(bitmap)}catch(e){if(!active)throw e}finally{bitmap?.close()}
          const blob=await new Promise<Blob>((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('拍摄未完成，请再试一次')),'image/png'))
          return {blob,capturedAt,quality}
        }})
        const {capturedAt,blob}=selected.frame
        if(!active)return
        const direction=stream.getVideoTracks()[0]?.getSettings().facingMode
        const cameraFacing=direction==='user'||direction==='environment'?direction:'unknown'
        const file=new File([blob],`headup-${id}.png`,{type:'image/png',lastModified:Date.parse(capturedAt)})
        const meta:LiveCaptureMeta={source:'live',capturedAt,cameraFacing,...(useBurst?{captureSelection:selected.selection}:{})}
        setMessage('正在复核刚拍下的照片…')
        const review=await reviewCapturedFrame(file,id,preferredSide,(view,bitmap)=>runtime.inspect(view,bitmap,'captured'))
        if(!active)return
        if(!review.ready){
          setInspection(review.inspection??null);setReady(false);setCapturing(false)
          setPending({file,meta,url:URL.createObjectURL(file),review});stop();return
        }
        stop()
        requestCaptureHaptic({enabled:latest.current.haptics,visible:document.visibilityState==='visible',vibrate:typeof navigator.vibrate==='function'?duration=>navigator.vibrate(duration):undefined})
        latest.current.onCapture(file,meta)
      }catch(e){if(active){setError(e instanceof Error?e.message:'拍摄失败');setCapturing(false);busy=false}}
    }
    const inspect=async()=>{
      if(!active||busy)return
      let bitmap:ImageBitmap|undefined
      try{
        if(document.visibilityState==='hidden'){setInspection(null);gate.current.reset();setCountdown(null);timer=setTimeout(inspect,500);return}
        bitmap=await createImageBitmap(frame())
        const result=await runtime.inspect(id,bitmap,'preview')
        if(!active||busy)return
        setInspection(result);const guidance=liveGuidance(id,result,preferredSide);guidance.message=coach.observe(id,result,guidance.message,performance.now());setReady(guidance.ready);setMessage(guidance.message);modelErrors=0
        if(latest.current.voice&&!latest.current.moreOpen&&guidance.message!==lastSpoken&&Date.now()-lastSpokenAt>4000&&typeof speechSynthesis!=='undefined'){
          const utterance=new SpeechSynthesisUtterance(guidance.message);utterance.lang='zh-CN';speechSynthesis.cancel();speechSynthesis.speak(utterance);lastSpoken=guidance.message;lastSpokenAt=Date.now()
        }
        const stable=gate.current.observe(latest.current.auto&&!latest.current.moreOpen&&guidance.ready,performance.now());setCountdown(stable.countdown)
        if(stable.capture){await captureAction.current();return}
      }catch{
        if(!active||busy)return
        setInspection(null);coach.reset();gate.current.reset();setCountdown(null);setReady(false);modelErrors++
        setMessage(modelErrors>=2?'实时检测暂不可用，仍可手动拍摄并保存照片。':'正在准备检测，请保持自然姿态。')
      }finally{bitmap?.close()}
      if(active&&!busy)timer=setTimeout(inspect,modelErrors>=2?2000:500)
    }
    setInspection(null);setPhase('opening');setError('');setReady(false);setCapturing(false);setMessage('正在请求相机…');gate.current.reset();setCountdown(null)
    if(!window.isSecureContext||(runtime===dependencies&&!navigator.mediaDevices?.getUserMedia)){setPhase('error');setError('当前页面无法访问相机。请使用HTTPS或本机地址，或者选择相册照片。');return stop}
    void controller.open(facing).then(async media=>{
      if(!media||!active)return
      stream=media
      const v=video.current;if(!v)return
      v.srcObject=media;await v.play()
      if(!active)return
      const track=media.getVideoTracks()[0]
      track?.addEventListener('ended',()=>{if(active){setInspection(null);setPhase('error');setError('相机已断开，可以重试或返回相册。');stop()}},{once:true})
      setPhase('ready');setMessage('请将面部完整放入画面。');timer=setTimeout(inspect,250)
    }).catch(e=>{if(active){setPhase('error');setError(cameraErrorMessage(e));controller.stop()}})
    const onHidden=()=>{if(document.visibilityState==='hidden'){setInspection(null);stop();setPaused(true)}}
    document.addEventListener('visibilitychange',onHidden)
    return()=>{document.removeEventListener('visibilitychange',onHidden);stop()}
  },[id,facing,restart,runtime,preferredSide,paused])
  const close=()=>{stopNow.current();onClose()}
  const openAlbum=()=>{setMoreOpen(false);setInspection(null);stopNow.current();setPaused(true);gate.current.reset();setCountdown(null);albumInput.current?.click()}
  const closeMore=()=>{setMoreOpen(false);requestAnimationFrame(()=>moreButton.current?.focus())}
  const checks=liveCaptureChecks(id,inspection,preferredSide)
  const keepPending=()=>{if(!pending)return;stopNow.current();latest.current.onCapture(pending.file,pending.meta)}
  return <dialog ref={dialog} className="live-camera" aria-label={`${profileName?profileName+'的':''}${stepLabel??(id==='front'?'正面':'侧面')}实时拍摄`} onCancel={e=>{e.preventDefault();if(moreOpen)closeMore();else close()}}>
    <header><div className="live-camera-heading"><strong>{stepLabel??(id==='front'?'正面 1/2':'侧面 2/2')}</strong>{id==='profile'&&<small>{preferredSide==='left_profile'?'左侧面':preferredSide==='right_profile'?'右侧面':'任意一侧'}</small>}</div><div className="live-camera-header-actions"><button ref={moreButton} disabled={capturing||Boolean(pending)} aria-expanded={moreOpen} aria-controls={moreId} onClick={()=>moreOpen?closeMore():setMoreOpen(true)}>更多</button><button aria-label="关闭相机" onClick={close}><X size={21}/></button></div></header>
    <div className="live-camera-stage">{pending&&<img className="live-captured-preview" src={pending.url} alt="刚拍下的待核对照片"/>}<video ref={video} aria-hidden={Boolean(pending)} autoPlay playsInline muted onLoadedMetadata={e=>{const v=e.currentTarget;setDimensions({width:v.videoWidth||4,height:v.videoHeight||3})}}/>{!pending&&(!showReference||!hasReference)&&<CameraFramingGuide {...dimensions} view={id} side={preferredSide} ready={ready&&Boolean(inspection)} pose={inspection?.pose}/>}{!pending&&showReference&&hasReference&&<svg viewBox={`0 0 ${id==='front'?front!.width:side!.width} ${id==='front'?front!.height:side!.height}`} preserveAspectRatio="xMidYMid meet" aria-label="上次构图参考">{(id==='front'?front!.contours:side!.paths.filter(p=>p.category==='region')).map(p=><polyline key={p.code} points={p.points.map(point=>`${point.x},${point.y}`).join(' ')}/>)}</svg>}{!pending&&(phase==='opening'||paused)&&<div className="live-camera-loading">{paused?'相机已暂停，照片不会自动拍下。':'等待相机权限与画面…'}<small>{paused?'取消选图后，可继续使用相册或恢复相机。':'也可以直接选择相册。'}</small></div>}{!pending&&!moreOpen&&!paused&&phase==='ready'&&!error&&<CameraSideHints checks={checks} message={message}/>} {countdown!==null&&<div className="live-countdown" aria-live="polite">{countdown||'拍摄'}</div>}</div>
    <div className="live-camera-bottom">
      {pending?<section className="live-capture-review" aria-label="拍后检查"><h2 ref={reviewHeading} tabIndex={-1}>这张照片需要核对</h2><p role="status">{pending.review.message}</p><p>原照片已暂存，尚未确认可用于测量。</p><div className="family-actions"><button className="live-shutter" onClick={()=>{setPending(null);setPaused(false);setRestart(v=>v+1)}}>返回相机重拍</button><button onClick={keepPending}>仍保留这张照片</button></div></section>:<>

      {paused?<div className="live-camera-error" role="status"><button onClick={()=>{setError('');setPaused(false);setRestart(v=>v+1)}}>恢复相机</button></div>:error?<div className="live-camera-error" role="alert"><p>{error}</p><button onClick={()=>setRestart(v=>v+1)}>重试开启相机</button></div>:<p className={`live-camera-guidance sr-only ${ready?'is-ready':''}`} role="status">{capturing?message:moreOpen?'调整设置中，自动拍摄已暂停。':countdown!==null?`保持不动，${countdown}秒后拍摄。`:compactCameraGuidance(message)}</p>}

      <div className="live-camera-controls live-camera-controls--three"><button aria-label="选择相册" disabled={capturing||moreOpen} onClick={openAlbum}><ImagePlus size={20}/><span>相册</span></button><button aria-label="拍摄这张" className="live-shutter" disabled={paused||phase!=='ready'||capturing||moreOpen} onClick={()=>void captureAction.current()}><Camera size={26}/><span>{capturing?'处理中…':'拍摄'}</span></button><button aria-label="切换镜头" disabled={paused||phase!=='ready'||capturing||moreOpen} onClick={()=>setFacing(v=>v==='environment'?'user':'environment')}><RefreshCcw size={20}/><span>切换镜头</span></button></div>
      <input ref={albumInput} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)onAlbum(file,id==='front'&&mirrorAlbum)}}/>
</>}
    </div>
    <section id={moreId} className="live-camera-more" hidden={!moreOpen} aria-label="拍摄设置与检查"><div className="live-camera-more-heading"><h2 ref={moreHeading} tabIndex={-1}>拍摄设置</h2><button onClick={closeMore}>收起</button></div>

      <p className="live-capture-setup">{id==='front'?'镜头与眼睛同高，正对镜头，自然闭唇。':'镜头与眼睛同高，保持自然侧面，露出鼻尖、双唇与下巴。'}</p><p className="live-camera-full-guidance">{message}</p>
      <ul className="live-coach-checks" aria-label="实时拍摄检查">{checks.map(check=><li key={check.label} className={'is-'+check.state}>{check.state==='good'?<CheckCircle2 size={15} aria-hidden="true"/>:check.state==='adjust'?<Move size={15} aria-hidden="true"/>:<Minus size={15} aria-hidden="true"/>}<div><span>{check.label}</span><strong>{check.detail}</strong></div></li>)}</ul>
      <div className="live-camera-options"><label><input type="checkbox" disabled={capturing} checked={auto} onChange={e=>setOption('auto',e.target.checked)}/>自动拍摄</label><label><input type="checkbox" disabled={capturing} checked={burst} onChange={e=>setOption('burst',e.target.checked)}/>短连拍选清晰帧</label><label><input type="checkbox" aria-describedby={hapticHelpId} disabled={capturing||!hasHapticApi} checked={haptics&&hasHapticApi} onChange={e=>setOption('haptics',e.target.checked)}/>拍摄完成时轻振</label><button onClick={()=>setOption('voice',!voice)} aria-pressed={voice}>{voice?<Volume2 size={19}/>:<VolumeX size={19}/>}语音{voice?'开':'关'}</button>{hasReference&&<label><input type="checkbox" checked={showReference} onChange={e=>setShowReference(e.target.checked)}/>上次构图参考</label>}</div>
      <details className="live-camera-details"><summary>取景说明与相册选项</summary><p id={hapticHelpId}>{hasHapticApi?'轻振只在取帧完成后提示一次；实际效果取决于浏览器和设备设置。':'当前浏览器未提供震动接口，文字和语音提示仍可使用。'}</p>{id==='front'&&<label><input type="checkbox" checked={mirrorAlbum} onChange={e=>setMirrorAlbum(e.target.checked)}/>所选相册正面图是镜像自拍</label>}<p>虚线提示头部和眼睛位置，细线跟随检测到的面部。距离按画面中的面部大小估计，不是厘米测距；边缘留白检查不能确认头发、头顶或后脑勺完整，请一并留在画面内。预览和拍照方向一致。短连拍最多取3帧，只保留一张原始画面，不合成或锐化；设备较慢时可能少于3帧。选帧后会复核实际保留照片的姿态、取景和像素质量；未通过时先停留核对页。自动拍摄须持续满足条件；拍后仍会检测，条件满足不代表发育正常。</p></details><p className="live-camera-privacy">仅使用摄像头，不访问麦克风。</p></section>
  </dialog>
}
