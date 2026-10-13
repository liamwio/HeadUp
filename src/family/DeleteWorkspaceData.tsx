import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {getActiveFamilyStore,type FamilyStore,storageMessage} from './store'
import {getWorkspace,subscribeWorkspace} from './cloudRuntime'
import type {DeletionReview} from './deletionReview'
export function DeleteWorkspaceData({onDeleted,disabled=false,onBusyChange}:{onDeleted:()=>void;disabled?:boolean;onBusyChange?:(busy:boolean)=>void}){
  const workspace=useSyncExternalStore(subscribeWorkspace,getWorkspace,()=>null),[review,setReview]=useState<{data:DeletionReview;store:FamilyStore;engine:unknown;label:string}|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),alive=useRef(true),serial=useRef(0),working=useRef(false),errorRef=useRef<HTMLParagraphElement>(null)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;serial.current++}},[])
  useEffect(()=>{serial.current++;setReview(null);setText('');setMessage('');working.current=false;setBusy(false)},[workspace?.engine])
  useEffect(()=>{if(message)errorRef.current?.focus()},[message])
  const allowed=()=>!getWorkspace()?.locked&&(!getWorkspace()||getWorkspace()?.family.role==='owner')
  const current=(store:FamilyStore,engine:unknown)=>alive.current&&getActiveFamilyStore()===store&&getWorkspace()?.engine===engine&&allowed()
  const prepare=async()=>{
    if(disabled||working.current)return
    const store=getActiveFamilyStore(),engine=getWorkspace()?.engine,n=++serial.current
    if(!current(store,engine))return
    working.current=true;onBusyChange?.(true);setBusy(true);setMessage('');setReview(null);setText('')
    try{const data=await store.deletionReview();if(current(store,engine)&&n===serial.current)setReview({data,store,engine,label:workspace?`${workspace.family.name} · ${workspace.user.displayName}的此设备工作区`:'本机档案'})}
    catch(e){if(current(store,engine)&&n===serial.current)setMessage(storageMessage(e))}finally{if(n===serial.current){working.current=false;onBusyChange?.(false);if(alive.current)setBusy(false)}}
  }
  const remove=async()=>{
    if(disabled||working.current||!review||text!=='删除全部档案'||!current(review.store,review.engine))return
    const target=review,n=++serial.current;working.current=true;onBusyChange?.(true);setBusy(true);setMessage('')
    try{await target.store.clear(target.data.stamp,()=>n===serial.current&&current(target.store,target.engine));if(n===serial.current&&current(target.store,target.engine)){setReview(null);setText('');onDeleted()}}
    catch(e){if(n===serial.current&&current(target.store,target.engine)){setReview(null);setText('');setMessage(storageMessage(e))}}finally{if(n===serial.current){working.current=false;onBusyChange?.(false);if(alive.current)setBusy(false)}}
  }
  if(workspace?.family.role!=='owner'&&workspace)return null
  return <section className="family-settings-section family-danger-zone"><h2>删除全部本机档案</h2><p>范围包括此设备当前工作区的全部档案、照片、结果、计划、备注和保留的冲突副本。先逐份导出需要保留的备份。</p>{workspace?<p>已连接的档案将按原同步设置向家庭云端同步删除，影响获授权的其他成员；暂停、离线或冲突时仍待处理。未下载到此设备的云端档案、其他家庭和独立本机工作区不在本次范围。</p>:<p>本次仅删除本机档案，已下载到应用外的文件仍需自行管理。</p>}
    {!review?<button disabled={disabled||busy||Boolean(workspace?.locked)} onClick={()=>void prepare()}>{busy?'正在读取删除范围…':'预览全部删除范围'}</button>:<div className="family-confirm"><h3>核对范围：{review.label}</h3><p>{review.data.profiles.length}个档案、{review.data.records}次记录、{review.data.versions}个版本、{review.data.photos}张版本照片和{review.data.originals}张原图、{review.data.events}条事件、{review.data.plans}个计划。</p><p>另有{review.data.recoveries}份冲突副本，含{review.data.recoveryPhotos}张版本照片。</p>{workspace&&<p>{review.data.connected}个档案已连接家庭同步，其中{review.data.paused}个已暂停；本次不会自动恢复暂停的同步。</p>}<details><summary>查看涉及的档案</summary><ul>{review.data.profiles.map(p=><li key={p.id}>{p.nickname}</li>)}</ul></details><p>确认后不能在应用内撤销，只能用已有备份恢复。预览之后数据变化会停止本次删除。</p><label>输入“删除全部档案”确认<input disabled={disabled||busy} value={text} onChange={e=>setText(e.target.value)} autoComplete="off"/></label><div className="family-actions"><button disabled={disabled||busy||text!=='删除全部档案'||!review.data.profiles.length&&!review.data.recoveries} onClick={()=>void remove()}>确认删除上述全部内容</button><button disabled={disabled||busy} onClick={()=>{setReview(null);setText('')}}>取消</button></div></div>}
    {message&&<p ref={errorRef} tabIndex={-1} className="family-error" role="alert">{message}</p>}
  </section>
}
