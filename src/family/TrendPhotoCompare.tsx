import {buildFrontLandmarkOverlay} from '../lib/frontLandmarkOverlay'
import {resolveProfileDisplayPaths} from '../lib/profileDisplayPolicy'
import type {FamilySession} from './model'
import {useMemo,useState} from 'react'
import {useMediaUrl} from './hooks'
import {trendAlignment} from './trendAlignment'
import type {TrendViewReport} from './automaticTrend'
import type {MeasurementEvidence} from '../lib/measurementEvidence'
function Lines({evidence,color}:{evidence:MeasurementEvidence;color:string}){
 const points=new Map(evidence.points.map(p=>[p.id,p]))
 return <g>{evidence.segments.map(s=>{const a=points.get(s.from),b=points.get(s.to);return a&&b?<line key={s.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={s.role==='measure'?undefined:'5 4'}><title>{s.label}</title></line>:null})}</g>
}
function SavedContours({session,kind,color}:{session:FamilySession;kind:'front'|'profile';color:string}){
 let paths:Array<{code:string;points:Array<{x:number;y:number}>}>=[]
 if(kind==='front'){
  const pose=session.captures.find(c=>c.id==='front')?.poseValidation
  if(pose?.landmarks&&pose.landmarkImageWidth&&pose.landmarkImageHeight){try{paths=buildFrontLandmarkOverlay(pose.landmarks,pose.landmarkImageWidth,pose.landmarkImageHeight)?.contours.filter(c=>['face_oval','outer_lips','nose_bridge'].includes(c.code))??[]}catch{}}
 }else if(session.report.native)paths=resolveProfileDisplayPaths(session.report.native).filter(p=>p.category==='region'&&!p.provisional&&p.code!=='neck_aesthetic_line')
 return <g>{paths.map(p=><polyline key={p.code} points={p.points.map(v=>`${v.x},${v.y}`).join(' ')} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke"/>)}</g>
}
export function TrendPhotoCompare({view,onOpen}:{view:TrendViewReport;onOpen:(id:string)=>void}){
 const [selected,setSelected]=useState(''),[mode,setMode]=useState<'overlay'|'pair'>('overlay'),[blend,setBlend]=useState(50),[lines,setLines]=useState(true),[photos,setPhotos]=useState(true)
 const rows=view.records,first=rows[0],last=rows.find(s=>s.id===selected&&s.id!==first?.id)??rows.at(-1),kind=view.view==='front'?'front':'profile'
 const before=useMediaUrl(first?.captures.find(c=>c.id===kind)?.mediaId),after=useMediaUrl(last?.captures.find(c=>c.id===kind)?.mediaId)
 const alignment=useMemo(()=>first&&last?trendAlignment(first,last,kind):null,[first,last,kind])
 if(!first||!last)return <p className="trend-empty">还没有这个视角的照片</p>
 if(rows.length<2)return <p className="trend-empty">{first.recordedOn} · 再保存一个日期后显示照片对照</p>
 const overlay=mode==='overlay'&&alignment?.ok,loaded=Boolean(before&&after)
 return <div className="trend-compare"><div className="trend-compare-dates"><span><i className="trend-date-dot trend-date-dot--before"/>首次 · {first.recordedOn}</span><span><i className="trend-date-dot trend-date-dot--after"/>{last.id===rows.at(-1)?.id?'最近':'本次'} · {last.recordedOn}</span></div>
 <div className="trend-compare-toolbar"><div role="group" aria-label={`${view.label}照片对照方式`}><button aria-pressed={overlay} disabled={!alignment?.ok} onClick={()=>setMode('overlay')}>叠加</button><button aria-pressed={!overlay} onClick={()=>setMode('pair')}>并排</button></div>{overlay&&<div><button aria-pressed={lines} onClick={()=>setLines(v=>!v)}>测量线</button><button aria-pressed={!photos} onClick={()=>setPhotos(v=>!v)}>仅看线</button></div>}</div>
 {!loaded?<div className="trend-compare-placeholder" role="status">照片加载中或本机照片缺失，可打开记录检查。</div>:overlay&&alignment?.ok?<svg className="trend-overlay-stage" viewBox={alignment.box} role="img" aria-label={`${view.label}首次与${last.recordedOn}等比例对齐叠加`}>
 <g transform={`matrix(${alignment.matrix.join(' ')})`}>{photos&&<image href={before} width={alignment.before.width} height={alignment.before.height} opacity={1}/>}</g>
 {photos&&<image href={after} width={alignment.after.width} height={alignment.after.height} opacity={blend/100}/>}
 {(lines||!photos)&&<><g transform={`matrix(${alignment.matrix.join(' ')})`}><SavedContours session={first} kind={kind} color="#af4a70"/><Lines evidence={alignment.before} color="#af4a70"/></g><SavedContours session={last} kind={kind} color="#168a91"/><Lines evidence={alignment.after} color="#168a91"/></>}
 </svg>:<div className="trend-photo-pair"><img src={before} alt={`${first.recordedOn}${view.label}首次照片`}/><img src={after} alt={`${last.recordedOn}${view.label}照片`}/></div>}
 {overlay&&<label className="trend-blend"><span>首次</span><input type="range" min="0" max="100" step="1" value={blend} aria-label={`${view.label}最近照片叠加比例`} disabled={!photos||!loaded} onChange={e=>setBlend(Number(e.target.value))}/><span>本次 {blend}%</span></label>}
 <p className="trend-alignment-note">{alignment?.ok?`按“${alignment.referenceLabel}”等长对齐，仅比较比例，不表示实际尺寸变化。`:alignment?.reason}</p>
 <div className="trend-date-strip" aria-label={`${view.label}拍摄日期`}>{rows.slice(1).map(s=><button key={s.id} aria-pressed={s.id===last.id} onClick={()=>{setSelected(s.id);setBlend(50)}}>{s.recordedOn}<small>{s.id===rows.at(-1)?.id?'最近记录':'历史记录'}</small></button>)}</div>
 <div className="trend-original-links"><button onClick={()=>onOpen(first.id)}>查看首次记录</button><button onClick={()=>onOpen(last.id)}>查看本次记录</button></div>
 </div>
}
