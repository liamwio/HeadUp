import {useEffect,useRef,useState} from 'react'
import {sortedSessions,type FamilyProfile,type FamilySession} from './model'
import {familyStore,storageMessage} from './store'
import {selectConsultationRecords,createConsultationPdf} from './consultationPdf'
export function ConsultationExport({profile,sessions}:{profile:FamilyProfile;sessions:FamilySession[]}){
 const rows=sortedSessions(sessions,profile.id),[selected,setSelected]=useState<string[]>(()=>rows.slice(0,3).map(s=>s.id)),[name,setName]=useState(false),[photos,setPhotos]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<{url:string;stamp:string}|null>(null)
 const alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(()=>{const available=new Set(rows.map(s=>s.id));setSelected(ids=>ids.filter(id=>available.has(id)))},[rows.map(s=>s.id).join('|')])
 const stamp=JSON.stringify([selected,name,photos,profile.nickname,rows.map(s=>[s.id,s.updatedAt])])
 useEffect(()=>()=>{if(result)URL.revokeObjectURL(result.url)},[result])
 const current=result?.stamp===stamp?result:null
 return <details className="family-protocol consultation-export"><summary>导出就诊资料 PDF</summary><p>选1至3次记录，生成一页照片、读数和拍摄条件；不会自动发送。</p><fieldset disabled={busy}><legend>导出记录</legend>{rows.map(s=><label className="family-inline-check" key={s.id}><input type="checkbox" checked={selected.includes(s.id)} disabled={!selected.includes(s.id)&&selected.length>=3} onChange={e=>setSelected(ids=>e.target.checked?[...ids,s.id]:ids.filter(id=>id!==s.id))}/>{s.recordedOn} · V{(s.revision?.number??0)+1}</label>)}<label className="family-inline-check"><input type="checkbox" checked={photos} onChange={e=>setPhotos(e.target.checked)}/>包含所选记录的照片</label><label className="family-inline-check"><input type="checkbox" checked={name} onChange={e=>setName(e.target.checked)}/>包含档案名称</label></fieldset>{error&&<p className="family-error" role="alert">{error}</p>}<button disabled={busy||!selected.length} onClick={async()=>{setBusy(true);setError('');try{const chosen=selectConsultationRecords(sessions,profile.id,selected),blob=await createConsultationPdf({profile,rows:chosen,getMedia:id=>familyStore.getMedia(id),includeName:name,includePhotos:photos});if(alive.current)setResult({url:URL.createObjectURL(blob),stamp})}catch(e){setError(storageMessage(e))}finally{setBusy(false)}}}>{busy?'生成中…':'生成 PDF'}</button>{current&&<div className="family-actions"><a href={current.url} target="_blank" rel="noreferrer">预览 PDF</a><a href={current.url} download="HeadUp-面部生长记录.pdf">保存 PDF</a></div>}</details>
}
