import { useEffect, useState } from 'react'
import type { Capture } from '../types'
import type { FamilySession } from './model'
import { familyStore, storageMessage } from './store'

export function useSessionCaptures(session:FamilySession|undefined) {
  const [state,setState]=useState<{captures:Capture[];loading:boolean;error:string}>({captures:[],loading:Boolean(session),error:''})
  useEffect(()=>{
    let alive=true,dispose=()=>{}
    setState({captures:[],loading:Boolean(session),error:''})
    if(session)void familyStore.restoreCaptures(session).then(result=>{if(!alive){result.dispose();return}dispose=result.dispose;setState({captures:result.captures,loading:false,error:result.captures.some(c=>c.inputError)?'部分照片暂不可读，历史读数仍保留。':''})}).catch(error=>{if(alive)setState({captures:[],loading:false,error:storageMessage(error)})})
    return()=>{alive=false;dispose()}
  },[session?.id,session?.updatedAt])
  return state
}

export function useMediaUrl(mediaId:string|undefined,original=false) {
  const key=`${mediaId??''}:${original}`, [state,setState]=useState<{key:string;url:string}>()
  useEffect(()=>{
    let alive=true,created:string|undefined;setState(undefined)
    if(mediaId)void familyStore.getMedia(mediaId).then(media=>{if(!alive||!media)return;created=URL.createObjectURL(original?(media.originalBlob??media.blob):media.blob);setState({key,url:created})}).catch(()=>{})
    return()=>{alive=false;if(created)URL.revokeObjectURL(created)}
  },[mediaId,original])
  return state?.key===key?state.url:undefined
}
