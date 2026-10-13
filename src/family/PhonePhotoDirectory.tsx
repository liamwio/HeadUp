import {useEffect,useState,useSyncExternalStore} from 'react'
import type {FamilyProfile} from './model'
import {familyStore,storageMessage} from './store'
import {copyPhotosToDirectory,photoDirectoryAvailable,photoDirectoryLocation,photoDirectoryState,subscribePhotoDirectory} from './photoDirectory'

export function PhonePhotoDirectory({profile}:{profile:FamilyProfile}){
 const [location,setLocation]=useState<{directory:string;shared:boolean}>(),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const state=useSyncExternalStore(subscribePhotoDirectory,()=>photoDirectoryState(profile.id),()=>null)
 useEffect(()=>{let alive=true;setLocation(undefined);setError('');void photoDirectoryLocation(profile)?.then(value=>{if(alive)setLocation(value)}).catch(e=>{if(alive)setError(storageMessage(e))});return()=>{alive=false}},[profile.id,profile.nickname])
 if(!photoDirectoryAvailable())return null
 return <section className="family-settings-section"><h2>手机照片目录</h2><p>保存到档案后，最终保留的照片会另存一份。</p><p className="phone-photo-directory-path">{location?.directory??state?.directory??'正在读取目录…'}</p>{location&&!location.shared&&<p>当前Android版本使用应用专属目录，卸载时这些副本也会被删除。</p>}<p className="family-muted">按档案分文件夹，名称含日期和视角；原图与扶正后的分析图区分保存。应用内删除记录不会删除这些副本，改名也不搬动已有目录。</p>{(state||error)&&<p role={error||state?.phase==='failed'?'alert':'status'}>{error||state?.message}</p>}<button disabled={busy||state?.phase==='working'} onClick={async()=>{setBusy(true);setError('');try{const snapshot=await familyStore.snapshot(),sessions=snapshot.sessions.filter(s=>s.profileId===profile.id);if(!sessions.length)throw Error('当前档案还没有照片记录');await copyPhotosToDirectory(profile,sessions,id=>familyStore.getMedia(id))}catch(e){setError(storageMessage(e))}finally{setBusy(false)}}}>{busy||state?.phase==='working'?'正在保存…':'补存当前档案照片'}</button><small>包含已保存的历史版本；已存在且校验一致的文件会跳过。照片目录不是完整档案备份。</small></section>
}
export function PhotoDirectoryNotice({profileId,onSettings}:{profileId:string;onSettings:()=>void}){
 const state=useSyncExternalStore(subscribePhotoDirectory,()=>photoDirectoryState(profileId),()=>null)
 if(!photoDirectoryAvailable()||!state||state.phase==='saved')return null
 return <div className="family-notice" role={state.phase==='failed'?'alert':'status'}><p>{state.message}</p>{state.phase==='failed'&&<button onClick={onSettings}>查看照片目录</button>}</div>
}
