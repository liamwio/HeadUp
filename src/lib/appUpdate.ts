import {registerSW} from 'virtual:pwa-register'
let ready=false
const listeners=new Set<()=>void>()
export const getUpdateReady=()=>ready
export const subscribeUpdate=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
let update:(reload?:boolean)=>Promise<void>=async()=>{}
export function initializeAppUpdate(){update=registerSW({immediate:true,onNeedRefresh(){ready=true;listeners.forEach(fn=>fn())}})}
export const applyAppUpdate=()=>update(true)
