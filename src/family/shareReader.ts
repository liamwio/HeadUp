import {SyncError,type CloudIdentity,type CloudTransport} from './cloudTransport'
import {validateSharedView} from './shareClient'
export type ShareReaderIdentity={me:CloudIdentity;transport:Pick<CloudTransport,'authenticate'|'request'>}
export type ShareReaderState={auth:ShareReaderIdentity|null;view:ReturnType<typeof validateSharedView>|null;busy:boolean;error:string;needsLogin:boolean}
export const emptyShareReaderState=():ShareReaderState=>({auth:null,view:null,busy:false,error:'',needsLogin:false})
export const SHARE_RECHECK_MS=15000
export const SHARE_VIEW_LEASE_MS=30000
export function shareReadError(error:unknown){return error instanceof SyncError&&error.code==='offline'?'网络不可用，已清除分享内容，请联网后重试。':error instanceof Error?error.message:'分享暂不可用，内容已清除'}

/** The UI consumes this state directly. Invalidated async work may neither publish nor cache an identity. */
export function createShareReader({token,identify,onState,isVisible=()=>true,now=()=>performance.now(),pollMs=SHARE_RECHECK_MS,leaseMs=SHARE_VIEW_LEASE_MS}:{token:string;identify:(signal:AbortSignal)=>Promise<ShareReaderIdentity>;onState:(state:ShareReaderState)=>void;isVisible?:()=>boolean;now?:()=>number;pollMs?:number;leaseMs?:number}) {
  let active=true,checking=false,epoch=0,identity:ShareReaderIdentity|null=null,contentStamp='',state=emptyShareReaderState(),controller:AbortController|undefined,deadline:ReturnType<typeof setTimeout>|undefined,requestDeadline:ReturnType<typeof setTimeout>|undefined,interval:ReturnType<typeof setInterval>|undefined
  const publish=(patch:Partial<ShareReaderState>)=>{if(active){state={...state,...patch};onState(state)}}
  const invalidate=(message:string,needsLogin=false)=>{if(!active)return;epoch++;checking=false;controller?.abort();if(deadline)clearTimeout(deadline);if(requestDeadline)clearTimeout(requestDeadline);deadline=undefined;requestDeadline=undefined;identity=null;publish({view:null,auth:null,busy:false,error:message,needsLogin})}
  const refresh=async()=>{
    if(!active||checking||!isVisible())return
    checking=true;const turn=++epoch,started=now(),current=()=>active&&turn===epoch;controller=new AbortController();const signal=controller.signal;publish({busy:true})
    requestDeadline=setTimeout(()=>{if(current())invalidate('未能及时确认分享状态，已停止等待并清除内容，请重新验证。')},leaseMs)
    try{
      const candidate=identity??await identify(signal);if(!current())return
      await candidate.transport.authenticate(signal);if(!current())return
      const raw=await candidate.transport.request('/shares/read','POST',{token},{},signal);if(!current())return
      const next=validateSharedView(raw),stamp=JSON.stringify([next.id,next.content])
      if(contentStamp&&stamp!==contentStamp)throw new Error('分享内容已改变，请重新打开链接核对')
      const elapsed=Math.max(0,now()-started),remaining=Math.min(next.expiresAt-next.serverNow,leaseMs)-elapsed
      if(remaining<=0)throw new Error('未能及时确认本次查看的有效期，内容已清除，请重新验证。')
      identity=candidate;contentStamp=stamp
      if(deadline)clearTimeout(deadline)
      deadline=setTimeout(()=>invalidate('未能继续确认分享有效状态，内容已清除；请重新验证。'),remaining)
      publish({auth:candidate,view:next,error:'',needsLogin:false})
    }catch(error){if(current())invalidate(shareReadError(error),error instanceof SyncError&&error.status===401)}
    finally{if(current()){if(requestDeadline)clearTimeout(requestDeadline);requestDeadline=undefined;checking=false;publish({busy:false})}}
  }
  return {refresh,invalidate,start(){if(!active||interval)return;void refresh();interval=setInterval(()=>void refresh(),pollMs)},dispose(){if(!active)return;active=false;epoch++;checking=false;controller?.abort();if(deadline)clearTimeout(deadline);if(requestDeadline)clearTimeout(requestDeadline);if(interval)clearInterval(interval);identity=null;state=emptyShareReaderState()}}
}
