import {createContext,useContext,useEffect,useId,useCallback} from 'react'
export const DraftGuardContext=createContext<(id:string,dirty:boolean)=>void>(()=>{})
export function useDraftGuard(dirty:boolean){
  const id=useId(),mark=useContext(DraftGuardContext)
  useEffect(()=>{mark(id,dirty)},[id,dirty,mark])
  useEffect(()=>()=>mark(id,false),[id,mark])
  return useCallback(()=>mark(id,false),[id,mark])
}
