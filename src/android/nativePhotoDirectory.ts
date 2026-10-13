import {Capacitor,registerPlugin} from '@capacitor/core'
import {configurePhotoDirectory,autoSaveLocalPhotos,type PhotoDirectoryApi} from '../family/photoDirectory'
import {localFamilyStore} from '../family/store'
let installed=false
export function installNativePhotoDirectory(){if(!installed&&Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android'){
 installed=true
 configurePhotoDirectory(registerPlugin<PhotoDirectoryApi>('HeadUpDevice'))
 let running=false,lastRun=0
 const sync=async()=>{
  if(running||Date.now()-lastRun<30000)return
  running=true;lastRun=Date.now()
  try{await autoSaveLocalPhotos(await localFamilyStore.snapshot(),id=>localFamilyStore.getMedia(id))}
  catch(error){console.warn('Automatic photo copy will retry on next foreground',error)}
  finally{running=false}
 }
 void sync()
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void sync()})
 window.addEventListener('focus',()=>void sync())
}}
