import {useEffect,useRef,useState} from 'react'
import {ArrowLeft,Camera,RefreshCcw,Save} from 'lucide-react'
import {CaptureFlow} from '../App'
import {LiveCapture} from '../LiveCapture'
import {PersonalReport} from './PersonalReport'
import type {Capture} from '../types'
import {readCapture} from '../lib/readCapture'
import {correctMirroredFrontFile} from '../lib/mirrorCorrection'
import type {LiveCaptureMeta} from '../lib/liveCamera'
import {familyStore,storageMessage} from './store'
import {useSessionCaptures} from './hooks'
import {localDate,type FamilySession,type FamilyProfile} from './model'
import type {RevisionOperation} from './revisions'

export function ReviseSession({session,profile,operation,onSaved,onExit,onBusy,onDirty}:{session:FamilySession;profile:FamilyProfile;operation:RevisionOperation;onSaved:(s:FamilySession)=>void;onExit:()=>void;onBusy:(b:boolean)=>void;onDirty:(b:boolean)=>void}){
  const restored=useSessionCaptures(session),alive=useRef(true),ownedUrls=useRef<string[]>([])
  const [selected,setSelected]=useState<Array<'front'|'profile'|'right_profile'>>(()=>session.captures.filter(c=>c.id!=='top'&&(c.analysisError||!c.poseValidation||((c.id==='profile'||c.id==='right_profile')&&c.poseValidation.nativeProfile?.status!=='measured'))).map(c=>c.id as 'front'|'profile'|'right_profile'))
  const [extras,setExtras]=useState<Capture[]>(()=>(session.recordedBy==='user'?['front','profile','right_profile']:['front','profile']).filter(id=>!session.captures.some(c=>c.id===id)).map(id=>({id:id as 'front'|'profile'|'right_profile',label:id==='front'?'正面':id==='right_profile'?'右侧':'左侧',eyebrow:'补充视角',hint:`请选择${session.recordedOn}同次拍摄的照片。`})))
  const [candidate,setCandidate]=useState<Capture[]|null>(null),[working,setWorking]=useState(false),[uploadBusy,setUploadBusy]=useState(false),[saving,setSaving]=useState(false),[camera,setCamera]=useState<'front'|'profile'|'right_profile'|null>(null),[error,setError]=useState(''),[failures,setFailures]=useState<string[]>([]),[changed,setChanged]=useState<Array<'front'|'profile'|'right_profile'>>([]),[confirmed,setConfirmed]=useState(false),[kind,setKind]=useState(session.kind)
  const currentExtras=useRef(extras);currentExtras.current=extras
  const busy=working||uploadBusy||saving||Boolean(camera),dirty=Boolean(candidate)||extras.some(c=>c.url)
  useEffect(()=>{onDirty(dirty)},[dirty,onDirty]);useEffect(()=>onBusy(busy),[busy,onBusy])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;ownedUrls.current.forEach(u=>URL.revokeObjectURL(u));for(const c of currentExtras.current){if(c.url)URL.revokeObjectURL(c.url);if(c.originalUrl)URL.revokeObjectURL(c.originalUrl)}onBusy(false)}},[onBusy])
  useEffect(()=>{if(!dirty&&!busy)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[dirty,busy])
  const own=(blob:Blob)=>{const url=URL.createObjectURL(blob);ownedUrls.current.push(url);return url}
  const run=async()=>{
    if(busy||restored.loading||restored.error||!selected.length)return
    setWorking(true);setError('');setCandidate(null);setConfirmed(false);setFailures([]);ownedUrls.current.forEach(u=>URL.revokeObjectURL(u));ownedUrls.current=[]
    const next=[...restored.captures],completed:Array<'front'|'profile'|'right_profile'>=[],failed:string[]=[]
    for(const id of selected){if(!alive.current)break;const previous=next.find(c=>c.id===id);if(!previous?.url){failed.push(`${id==='front'?'正面':'侧面'}原图不可读`);continue}
      try{const response=await fetch(previous.originalUrl??previous.url);if(!response.ok)throw new Error('照片不可读');const blob=await response.blob(),file=new File([blob],previous.fileName??'saved-photo',{type:blob.type}),result=await readCapture(id==='right_profile'?'profile':id,file,true)
        if(!alive.current)break
        if(result.analysisError){failed.push(`${previous.label}：${result.analysisError}`);continue}
        next[next.findIndex(c=>c.id===id)]={...previous,url:own(result.file),originalUrl:result.straightening?.status==='applied'?own(file):undefined,straightening:result.straightening,quality:result.quality,poseValidation:result.pose,analysisError:undefined,inputError:undefined,acceptedWithBias:false};completed.push(id)
      }catch(e){failed.push(`${previous.label}：${e instanceof Error?e.message:'检测失败'}`)}
    }
    if(alive.current){setChanged(completed);setFailures(failed);setWorking(false);if(completed.length)setCandidate(next);else setError('本次没有完成新的检测，原记录和旧结果完整保留。可以稍后再试。')}
  }
  const live=async(id:'front'|'profile'|'right_profile',file:File,meta?:LiveCaptureMeta,mirror=false)=>{
    setCamera(null);if(meta&&localDate(new Date(meta.capturedAt))!==session.recordedOn){setError('这张照片的拍摄日期与原记录不同，请新建一次记录。');return}
    setWorking(true);setError('');setConfirmed(false)
    try{const analysisFile=id==='front'&&mirror?await correctMirroredFrontFile(file):file,result=await readCapture(id==='right_profile'?'profile':id,analysisFile,true);if(!alive.current)return;setExtras(rows=>rows.map(c=>c.id===id?{...c,source:meta?.source??'upload',capturedAt:meta?.capturedAt,cameraFacing:meta?.cameraFacing,mirrorCorrected:id==='front'&&mirror,inputError:undefined,acceptedWithBias:false,fileName:file.name,url:own(result.file),originalUrl:result.straightening?.status==='applied'?own(analysisFile):undefined,quality:result.quality,poseValidation:result.pose,straightening:result.straightening,analysisError:result.analysisError}:c))}catch(e){if(alive.current)setError(storageMessage(e))}finally{if(alive.current)setWorking(false)}
  }
  const preview=()=>{if(!extras.some(c=>c.url)){setError('请先添加可读取的补充照片。');return}setConfirmed(false);setChanged(extras.filter(c=>c.url).map(c=>c.id as 'front'|'profile'|'right_profile'));setCandidate([...restored.captures,...extras.filter(c=>c.url)])}
  return <section className="family-revision"><button className="family-back" disabled={busy} onClick={onExit}><ArrowLeft size={17}/>返回原记录</button><div className="family-page-heading"><div><span className="family-eyebrow">{profile.nickname} · {session.recordedOn} · 原记录V{(session.revision?.number??0)+1}</span><h1>{operation==='reanalyze'?'重新检测已保存的照片':'补齐这次记录的视角'}</h1><p>保存为同一次记录的新版本，原照片和旧报告继续保留，不增加成长记录次数。</p></div></div>
    {restored.loading?<p role="status">正在恢复原照片…</p>:restored.error?<p role="alert">{restored.error} 请先检查备份。</p>:!candidate?operation==='reanalyze'?<div className="family-form"><h2>选择需要重新检测的照片</h2><p>只重跑所选照片的检测；整份新报告按当前算法生成。之前的版本不会被覆盖。</p>{restored.captures.filter(c=>c.id!=='top').map(c=><label className="family-inline-check" key={c.id}><input type="checkbox" disabled={busy} checked={selected.includes(c.id as 'front'|'profile'|'right_profile')} onChange={e=>setSelected(ids=>e.target.checked?[...ids,c.id as 'front'|'profile'|'right_profile']:ids.filter(id=>id!==c.id))}/>{c.label} · {c.analysisError?'此前检测未完成':'已保存的照片'}</label>)}<button className="family-primary" disabled={busy||!selected.length} onClick={()=>void run()}><RefreshCcw size={18}/>{working?'正在重新检测…':'开始本机重新检测'}</button></div>:<><p>只能补充{session.recordedOn}当天同次拍摄、条件一致的照片。其他日期或条件不同的照片，请另建记录。</p>{session.recordedOn===localDate()&&<div className="family-actions">{extras.map(c=><button disabled={busy} key={c.id} onClick={()=>setCamera(c.id as 'front'|'profile'|'right_profile')}><Camera size={18}/>拍摄{c.label}</button>)}</div>}<div className="family-form">{extras.map(c=><label key={c.id}>选择{c.label}照片<input disabled={busy} type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)void live(c.id as 'front'|'profile'|'right_profile',file)}}/>{c.url&&<img src={c.originalUrl??c.url} alt={c.label} style={{maxHeight:180,objectFit:'contain'}}/>}</label>)}<button disabled={busy||!extras.some(c=>c.url)} onClick={preview}>核对补充照片</button></div>{camera&&<LiveCapture id={camera==='front'?'front':'profile'} profileName={profile.nickname} preferredSide={camera==='right_profile'?'right_profile':'left_profile'} stepLabel={camera==='front'?'正面':camera==='right_profile'?'右侧':'左侧'} onClose={()=>setCamera(null)} onCapture={(file,meta)=>void live(camera,file,meta)} onAlbum={(file,mirror)=>void live(camera,file,undefined,mirror)}/>}</>:<><div className="family-form"><h2>检查后保存新版本</h2><label>本版用途<select disabled={saving} value={kind} onChange={e=>setKind(e.target.value as FamilySession['kind'])}><option value="measurement">面部生长记录</option><option value="memory">其他</option></select></label><label className="family-inline-check"><input type="checkbox" checked={confirmed} disabled={saving} onChange={e=>setConfirmed(e.target.checked)}/>{operation==='supplement'?`确认新增照片属于${profile.nickname}，拍摄于${session.recordedOn}同次、同条件，愿意作为该次记录的新版本保存。`:'已查看新结果，保存为修订版本，保留旧版。'}</label><div className="family-actions"><button className="family-primary" disabled={saving||!confirmed} onClick={async()=>{setSaving(true);setError('');try{const saved=await familyStore.saveRevision(session,candidate,operation,changed,kind);onDirty(false);onSaved(saved)}catch(e){setError(storageMessage(e))}finally{if(alive.current)setSaving(false)}}}><Save size={17}/>{saving?'保存中…':'保存新版本'}</button><button disabled={saving} onClick={()=>{setCandidate(null);setConfirmed(false)}}>返回调整</button></div></div><PersonalReport captures={candidate} onRetake={()=>setCandidate(null)} onPrivacy={()=>setError('本次修订只在本机检测与保存；可返回档案设置查看数据管理。')}/></>}
    {failures.length>0&&<div className="family-notice" role="status"><p>以下视角未取得新结果，继续保留原版本中的结果：</p><ul>{failures.map(f=><li key={f}>{f}</li>)}</ul></div>}{error&&<p className="family-error" role="alert">{error}</p>}
  </section>
}
