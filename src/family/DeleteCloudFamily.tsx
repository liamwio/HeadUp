import {useEffect,useRef,useState} from 'react'
import {getWorkspace,type Workspace,cloudErrorMessage} from './cloudRuntime'
import {SyncError} from './cloudTransport'
import {createShareActionGate} from './shareActionGate'
import {FAMILY_DELETE_PROTOCOL,validateCloudDeletionPreview,validateCloudDeletionReceipt,saveCloudDeletionIntent,readCloudDeletionIntents,clearCloudDeletionIntent,type CloudDeletionPreview,type CloudDeletionIntent,type CloudDeletionReceipt} from './familyDeletionClient'
import {sharePage} from './sharePages'
export function DeleteCloudFamily({workspace,disabled,onBusyChange,onDeleted}:{workspace:Workspace;disabled:boolean;onBusyChange:(busy:boolean)=>void;onDeleted:()=>void}){
  const [preview,setPreview]=useState<CloudDeletionPreview|null>(null),[pending,setPending]=useState<CloudDeletionIntent[]>([]),[result,setResult]=useState<CloudDeletionReceipt|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),gate=useRef(createShareActionGate()),alive=useRef(true)
  const valid=()=>alive.current&&getWorkspace()?.engine===workspace.engine&&!getWorkspace()?.locked&&getWorkspace()?.family.role==='owner'
  const refreshPending=()=>{if(valid())setPending(readCloudDeletionIntents(workspace.base,workspace.user.id,workspace.family.id))}
  useEffect(()=>{alive.current=true;refreshPending();window.addEventListener('storage',refreshPending);window.addEventListener('focus',refreshPending);return()=>{alive.current=false;gate.current.invalidate();window.removeEventListener('storage',refreshPending);window.removeEventListener('focus',refreshPending)}},[workspace.engine])
  const act=(task:Parameters<ReturnType<typeof createShareActionGate>['run']>[1])=>{if(disabled)return;return gate.current.run(valid,async action=>{setMessage('');await task(action)},e=>setMessage(cloudErrorMessage(e)),value=>{setBusy(value);onBusyChange(value)})}
  const prepare=()=>act(async action=>{
    setPreview(null);setText('');setResult(null)
    const saved=readCloudDeletionIntents(workspace.base,workspace.user.id,workspace.family.id);if(saved.length){setPending(saved);throw new Error('还有结果待核验，请先核对原删除请求')}
    await action.step(signal=>workspace.transport.authenticate(signal))
    const value=await action.step(signal=>workspace.transport.request(`/families/${workspace.family.id}/deletion-preview`,'GET',undefined,{},signal))
    setPreview(validateCloudDeletionPreview(value,workspace.family.id))
  })
  const remove=(retry?:CloudDeletionIntent)=>act(async action=>{
    let intent=retry
    if(!intent){if(!preview||text!=='删除家庭云端档案'||!preview.profiles.length)throw new Error('请核对完整范围并输入确认文字');const saved=readCloudDeletionIntents(workspace.base,workspace.user.id,workspace.family.id);if(saved.length){setPending(saved);throw new Error('其他页面还有待核验的删除请求')};intent={id:crypto.randomUUID(),preview};saveCloudDeletionIntent(workspace.base,workspace.user.id,intent);refreshPending()}
    await action.step(signal=>workspace.transport.authenticate(signal))
    try{
      const response=await action.step(signal=>workspace.transport.request(`/families/${workspace.family.id}/deletions`,'POST',{id:intent!.id,scopeHash:intent!.preview.scopeHash,protocol:FAMILY_DELETE_PROTOCOL},{},signal)),receipt=validateCloudDeletionReceipt(response,intent)
      let saved=true;try{clearCloudDeletionIntent(workspace.base,workspace.user.id,intent)}catch{saved=false}
      setResult(receipt);setPreview(null);setText('');refreshPending();setMessage('服务器已确认删除本次所列全部云端档案。'+(saved?'':'本机未能清除待核验项；重试原请求只核对这次结果，不会扩大删除范围。'));onDeleted()
    }catch(e){if(action.current()&&e instanceof SyncError&&['deletion_scope_changed','deletion_empty'].includes(e.code)){clearCloudDeletionIntent(workspace.base,workspace.user.id,intent);refreshPending();setPreview(null);setText('')}throw e}
  })
  if(workspace.family.role!=='owner')return null
  return <section className="family-settings-section family-danger-zone"><h2>删除家庭云端全部档案</h2><p>家庭：{workspace.family.name}。仅管理者可操作，包含尚未下载到此设备的档案及其云端照片，并停止相关在线分享、拍摄接力和邀请。家庭账号与成员关系保留。</p><p>请先备份需要保留的资料。其他设备会在联网并启用同步时处理删除；离线或暂停的缓存、未同步改动和明确保留的冲突副本需要分别核对。独立本机档案和其他家庭不在此范围。应用外的导出文件和服务器备份需另行管理。</p>
    {pending.length>0?<div><h3>删除结果待核验</h3><p>逐份核对原请求。重试不会删除该请求之后新建的档案。</p>{pending.map(item=><div className="family-confirm" key={item.id}><CloudDeleteScope preview={item.preview}/><button disabled={disabled||busy} onClick={()=>void remove(item)}>核验这次删除结果</button></div>)}</div>:<><button disabled={disabled||busy||Boolean(workspace.locked)} onClick={()=>void prepare()}>预览家庭云端完整范围</button>{preview&&<div className="family-confirm"><CloudDeleteScope key={preview.scopeHash} preview={preview}/>{preview.profiles.length>0?<><p>此删除不能在应用内撤销。预览后如有档案或照片变化，服务器会拒绝本次操作，要求重新预览。</p><label>输入“删除家庭云端档案”确认<input value={text} disabled={disabled||busy} onChange={e=>setText(e.target.value)} autoComplete="off"/></label><div className="family-actions"><button disabled={disabled||busy||text!=='删除家庭云端档案'} onClick={()=>void remove()}>确认删除上述全部云端档案</button><button disabled={disabled||busy} onClick={()=>{setPreview(null);setText('')}}>取消</button></div></>:<p>此家庭目前没有云端档案。</p>}</div>}</>}
    {result&&<p role="status">删除回执：{new Date(result.completedAt).toLocaleString()}，服务器确认处理{result.profiles.length}个档案。请查看上方各设备缓存的同步状态。</p>}{message&&<p role="status" className="family-notice">{message}</p>}
  </section>
}
function CloudDeleteScope({preview}:{preview:CloudDeletionPreview}){
  const [index,setIndex]=useState(0),page=sharePage(preview.profiles,index,20)
  return <div><h3>{preview.family.name} · 完整删除范围</h3><p>共{preview.profiles.length}个云端档案、{preview.profiles.reduce((n,p)=>n+p.records,0)}次记录、{preview.profiles.reduce((n,p)=>n+p.photos,0)}个图片文件（含原图、分析图和待完成上传）。本次包含全部所列档案，不仅是当前页。</p><ul>{page.items.map(p=><li key={p.id}>{p.nickname} · {p.records}次记录、{p.photos}个图片文件</li>)}</ul>{page.count>1&&<nav className="family-actions" aria-label="云端删除范围分页"><button disabled={!page.index} onClick={()=>setIndex(page.index-1)}>上一页</button><span aria-live="polite">{page.index+1}/{page.count}</span><button disabled={page.index+1>=page.count} onClick={()=>setIndex(page.index+1)}>下一页</button></nav>}</div>
}
