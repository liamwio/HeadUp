import {useCallback,useEffect,useRef,useState} from 'react'
export function useLeaveConfirmation(){
  const pending=useRef<((leave:boolean)=>void)|null>(null),element=useRef<HTMLDialogElement>(null),[open,setOpen]=useState(false)
  const confirmLeave=useCallback((dirty:boolean)=>{if(!dirty)return Promise.resolve(true);if(pending.current)return Promise.resolve(false);return new Promise<boolean>(resolve=>{pending.current=resolve;setOpen(true)})},[])
  const answer=useCallback((leave:boolean)=>{const resolve=pending.current;pending.current=null;setOpen(false);resolve?.(leave)},[])
  useEffect(()=>{if(open&&!element.current?.open)element.current?.showModal();else if(!open&&element.current?.open)element.current.close()},[open])
  useEffect(()=>()=>{pending.current?.(false);pending.current=null},[])
  const dialog=<dialog ref={element} className="family-leave-dialog" aria-labelledby="family-leave-title" aria-describedby="family-leave-description" onCancel={e=>{e.preventDefault();answer(false)}}><h2 id="family-leave-title">还有未保存的内容</h2><p id="family-leave-description">离开会放弃本页尚未保存的输入或照片。已经保存的记录不受影响。</p><div className="family-actions"><button autoFocus className="family-primary" onClick={()=>answer(false)}>继续编辑</button><button onClick={()=>answer(true)}>放弃本页修改并离开</button></div></dialog>
  return{confirmLeave,dialog}
}
