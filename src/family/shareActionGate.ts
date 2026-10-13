export type ShareAction={signal:AbortSignal;current:()=>boolean;check:()=>void;step:<T>(work:(signal:AbortSignal)=>Promise<T>)=>Promise<T>}
/** Cancellation stops further steps; an already dispatched mutation may still have committed. */
export function createShareActionGate(){
  let active:AbortController|null=null,generation=0
  return {
    invalidate(){generation++;active?.abort();active=null},
    async run(valid:()=>boolean,task:(action:ShareAction)=>Promise<void>,onError:(error:unknown)=>void,onBusy:(busy:boolean)=>void){
      if(active||!valid())return false
      const controller=new AbortController(),ticket=++generation;active=controller
      const current=()=>ticket===generation&&active===controller&&!controller.signal.aborted&&valid()
      const check=()=>{if(!current())throw new DOMException('分享操作已停止','AbortError')}
      const action:ShareAction={signal:controller.signal,current,check,async step(work){check();const value=await work(controller.signal);check();return value}}
      onBusy(true)
      try{await task(action);check();return true}catch(error){if(current())onError(error);return false}finally{if(ticket===generation&&active===controller){active=null;onBusy(false)}}
    },
  }
}
