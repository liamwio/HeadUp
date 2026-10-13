import {useEffect,useRef,useState} from 'react'
import type {FamilyStore} from './store'
import {storageMessage} from './store'
import type {SyncRecovery} from './syncTypes'
import {recoveryStamp} from './deletionReview'
import {archivePreview} from './archiveExport'
export function DeleteRecovery({recovery,store,current,onDeleted,disabled=false,onBusyChange}:{recovery:SyncRecovery;store:FamilyStore;current:()=>boolean;onDeleted:()=>void;disabled?:boolean;onBusyChange?:(busy:boolean)=>void}){
  const [open,setOpen]=useState(false),[text,setText]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),alive=useRef(true),working=useRef(false),stamp=recoveryStamp(recovery),summary=archivePreview(recovery.archive)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{setOpen(false);setText('');setMessage('')},[stamp])
  const remove=async()=>{
    if(disabled||working.current||text!=='删除副本'||!current())return;working.current=true;onBusyChange?.(true);setBusy(true);setMessage('')
    try{await store.deleteRecovery(recovery.id,stamp,()=>alive.current&&current());if(alive.current&&current()){setOpen(false);setText('');onDeleted()}}
    catch(e){if(alive.current&&current())setMessage(storageMessage(e))}finally{working.current=false;onBusyChange?.(false);if(alive.current)setBusy(false)}
  }
  return <div className="family-recovery-delete">{!open?<button disabled={disabled} onClick={()=>setOpen(true)}>删除这份本机冲突副本…</button>:<div className="family-confirm"><p>将删除{recovery.archive.profiles.map(p=>p.nickname).join('、')||'此档案'}在{new Date(recovery.createdAt).toLocaleString()}保留的这一份副本：{summary.records}次记录、{summary.photos}张版本照片。当前档案、云端内容和已下载文件不受影响。</p><p>不能在应用内撤销；需要保留时请先导出上方的加密备份。</p><label>输入“删除副本”确认<input value={text} disabled={disabled||busy} onChange={e=>setText(e.target.value)} autoComplete="off"/></label><div className="family-actions"><button disabled={disabled||busy||text!=='删除副本'} onClick={()=>void remove()}>确认删除此副本</button><button disabled={disabled||busy} onClick={()=>{setOpen(false);setText('')}}>取消</button></div></div>}{message&&<p role="alert" className="family-error">{message}</p>}</div>
}
