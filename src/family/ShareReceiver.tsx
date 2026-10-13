import {useCallback,useEffect,useRef,useState} from 'react'
import {CloudAccountPanel} from './CloudAccountPanel'
import {handoffIdentity,validHandoffSecret} from './handoff'
import {CLOUD_AUTH_CHANGE} from './cloudRuntime'
import {createShareReader,emptyShareReaderState,shareReadError} from './shareReader'
import {SharedDocument} from './SharedDocument'
export function ShareReceiver({base,token,onBack}:{base:string;token:string;onBack:()=>void}){
  const [state,setState]=useState(emptyShareReaderState),[login,setLogin]=useState(false),readerRef=useRef<ReturnType<typeof createShareReader>|null>(null)
  const {auth,view,busy,error}=state
  useEffect(()=>{
    setState(emptyShareReaderState());if(login)return
    if(!validHandoffSecret(token)){setState({...emptyShareReaderState(),error:'分享链接格式不正确，请核对完整链接。'});return}
    const reader=createShareReader({token,identify:signal=>handoffIdentity(base,signal),onState:setState,isVisible:()=>document.visibilityState!=='hidden'});readerRef.current=reader
    const hidden=()=>reader.invalidate('页面已隐藏，已清除当前内容；返回后会重新验证。'),visibility=()=>{if(document.visibilityState==='hidden')hidden();else void reader.refresh()},offline=()=>reader.invalidate('网络不可用，已清除分享内容；联网后可重新验证。'),authChange=()=>reader.invalidate('登录状态已变化，请重新验证分享。'),again=()=>void reader.refresh()
    reader.start();document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',hidden);window.addEventListener('pageshow',again);window.addEventListener('offline',offline);window.addEventListener('online',again);window.addEventListener('focus',again);window.addEventListener(CLOUD_AUTH_CHANGE,authChange)
    return()=>{reader.dispose();if(readerRef.current===reader)readerRef.current=null;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',hidden);window.removeEventListener('pageshow',again);window.removeEventListener('offline',offline);window.removeEventListener('online',again);window.removeEventListener('focus',again);window.removeEventListener(CLOUD_AUTH_CHANGE,authChange)}
  },[base,token,login])
  useEffect(()=>{if(state.needsLogin)setLogin(true)},[state.needsLogin])
  const loadPhoto=useCallback(async(ref:string,signal:AbortSignal)=>{if(!auth)throw new Error('请重新验证账号');return await auth.transport.request('/shares/read-photo','POST',{token,ref},{Accept:'application/octet-stream'},signal) as Blob},[auth,token])
  const failed=useCallback((e:Error)=>readerRef.current?.invalidate(shareReadError(e)),[])
  return <section className="family-share-receiver"><button onClick={()=>{readerRef.current?.invalidate('');onBack()}}>返回应用</button><span className="family-eyebrow">限时只读分享</span><h1>查看对方明确选择的资料</h1><p>仅指定接收账号可读，不会加入家庭或开启档案同步。请勿把链接交给其他人。</p>{error&&<p role="alert" className="family-notice">{error}</p>}{login?<CloudAccountPanel compact apiBase={base} onSignedIn={()=>{setLogin(false)}} onBack={()=>{setLogin(false)}} backLabel="返回分享验证"/>:<><div className="family-actions"><button onClick={()=>{readerRef.current?.invalidate('');setLogin(true)}}>登录或切换接收账号</button><button disabled={busy} onClick={()=>{readerRef.current?.invalidate('');void readerRef.current?.refresh()}}>重新验证分享</button></div>{busy&&!view&&<p role="status">正在验证账号和分享范围…</p>}{view&&auth&&<><p>当前账号：{auth.me.user.displayName}（{auth.me.user.username}）</p><p>创建于{new Date(view.createdAt).toLocaleString()}；有效至{new Date(view.expiresAt).toLocaleString()}。</p><SharedDocument content={view.content} loadPhoto={loadPhoto} onFailure={failed}/></>}</>}</section>
}
