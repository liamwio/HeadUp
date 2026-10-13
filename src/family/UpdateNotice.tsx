import {useState,useSyncExternalStore} from 'react'
import {applyAppUpdate,getUpdateReady,subscribeUpdate} from '../lib/appUpdate'
export function UpdateNotice({busy,hasDraft}:{busy:boolean;hasDraft:()=>boolean}){
  const ready=useSyncExternalStore(subscribeUpdate,getUpdateReady,()=>false),[message,setMessage]=useState('')
  if(!ready)return null
  return <div className="family-notice family-update-notice" role="status"><div><strong>新版本已准备好</strong><p>保存当前记录后可刷新，应用不会自动中断拍摄。</p>{message&&<p>{message}</p>}<button disabled={busy} onClick={()=>{if(hasDraft()){setMessage('当前输入或照片尚未保存，请先完成保存或主动放弃草稿。');return}void applyAppUpdate().catch(()=>setMessage('更新暂未完成，请稍后重试。'))}}>刷新到新版本</button></div></div>
}
