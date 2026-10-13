import type {Archive} from './backup'
import {validateCloudSnapshot,type CloudSnapshot,type CloudPhoto} from './cloudContract'
export async function prepareCloudSnapshot(archive:Archive,baseline?:CloudSnapshot):Promise<{snapshot:CloudSnapshot;uploads:Map<string,Blob>}>{
  if(archive.profiles.length!==1)throw new Error('一次同步仅包含一个明确授权的档案')
  const uploads=new Map<string,Blob>(),media=[]
  const known=new Map(baseline?.media.flatMap(m=>[m.processed,...(m.original?[m.original]:[])]).map(ref=>[ref.key,ref])??[])
  const photo=async(key:string,blob:Blob):Promise<CloudPhoto>=>{uploads.set(key,blob);const old=known.get(key);if(old?.size===blob.size&&old.type===blob.type)return old;const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return{key,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),type:blob.type,size:blob.size}}
  for(const m of archive.media)media.push({id:m.id,sessionId:m.sessionId,profileId:m.profileId,processed:await photo(m.id,m.blob),original:m.originalBlob?await photo(m.id+'~original',m.originalBlob):undefined})
  const data=JSON.parse(JSON.stringify({schema:'HEADUP-SYNC-1',profile:archive.profiles[0],sessions:archive.sessions,plans:archive.plans,events:archive.events,media}))
  return{snapshot:validateCloudSnapshot(data,archive.profiles[0].id),uploads}
}
