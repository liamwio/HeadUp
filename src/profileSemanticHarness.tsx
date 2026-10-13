import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {readCapture} from './lib/readCapture'
import {buildNativeProfilePresentation,buildResearchNativeProfilePresentation,profileSemanticPathD} from './lib/nativeProfilePresentation'
import {ReportPageV2} from './ReportPageV2'
import type {Capture} from './types'
import './appStyles'
const samples=['001_left_profile.jpg','001_right_profile.jpg','002_left_profile.jpg','002_right_profile.jpg','001_front.jpg']
function Harness(){
 const [selected,setSelected]=useState(samples[0]),[busy,setBusy]=useState(false),[status,setStatus]=useState('待运行'),[capture,setCapture]=useState<Capture>(),[rows,setRows]=useState<string[]>([])
 const run=async()=>{setBusy(true);setStatus('检测中');try{const response=await fetch('/data/face-db-real-research/images/face-research-lab-london-v5/'+selected),blob=await response.blob(),result=await readCapture(selected.endsWith('_front.jpg')?'front':'profile',new File([blob],selected,{type:'image/jpeg'}),false),url=URL.createObjectURL(result.file);if(capture?.url)URL.revokeObjectURL(capture.url);const c:Capture={id:selected.endsWith('_front.jpg')?'front':'profile',label:'侧面',hint:'',eyebrow:'',url,poseValidation:result.pose,quality:result.quality};setCapture(c);const native=result.pose?.nativeProfile,text=selected+' · '+result.pose?.estimatedPose+' · '+native?.status+' · '+(native?.geometrySource??'saved_front_landmarks')+' · '+(native?.reason??result.analysisError??'检测完成');setStatus(text);setRows(r=>[...r,text])}catch(e){setStatus(String(e))}finally{setBusy(false)}}
 const p=capture?.poseValidation,old=buildResearchNativeProfilePresentation(p?.nativeProfile,p?.landmarkImageWidth,p?.landmarkImageHeight),fresh=buildNativeProfilePresentation(p?.nativeProfile,p?.landmarkImageWidth,p?.landmarkImageHeight)
 return <main style={{maxWidth:1100,margin:'20px auto',padding:20}}><h1>侧面点位语义验收</h1><p>仅使用本地研究样本；并排展示同一模型点位的旧连线和修正连线。</p><label>样本<select disabled={busy} value={selected} onChange={e=>setSelected(e.target.value)}>{samples.map(s=><option key={s}>{s}</option>)}</select></label><button disabled={busy} onClick={()=>void run()}>运行检测</button><p role="status">{status}</p><ul>{rows.map((r,i)=><li key={i}>{r}</li>)}</ul>{capture?.url&&old&&fresh&&<div className="report-v2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>{[old,fresh].map((o,i)=><figure key={i}><figcaption>{i?'修正连线':'旧连线'}</figcaption><div className="v2-photo-stage"><img src={capture.url}/><svg viewBox={`0 0 ${o.width} ${o.height}`} preserveAspectRatio="xMidYMid meet">{o.paths.filter(p=>p.category==='region'&&p.code!=='neck_aesthetic_line').map(p=><path key={p.code} d={profileSemanticPathD(p.points)} className={'v2-profile-line v2-profile-line--'+p.code}/>)}</svg></div></figure>)}</div>}{capture&&<ReportPageV2 captures={[capture]} mode="youth" onStart={()=>{}} onRetake={()=>{}} onPrivacy={()=>{}}/>}</main>
}
createRoot(document.getElementById('root')!).render(<Harness/> )
