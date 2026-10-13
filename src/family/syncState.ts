import type {Archive} from './backup'
import {canonicalJson,type CloudSnapshot} from './cloudContract'
const cleanPlan=(p:any)=>{const{notificationEnabled,followupEnabled,lastFollowupWindow,notificationError,lastNotifiedWindow,lastNotifiedDate,...rest}=p;return rest}
const cleanSession=(s:any)=>{const{profileIdAndContent,...rest}=s;return rest}
const sorted=(rows:any[],key='id')=>[...rows].sort((a,b)=>String(a[key]).localeCompare(String(b[key])))
/** Synchronous CAS stamp: photo identity is immutable in FamilyStore; buffers need not be reread inside a transaction. */
export function archiveStamp(a:Archive){return canonicalJson({profiles:sorted(a.profiles),sessions:sorted(a.sessions.map(cleanSession)),plans:sorted(a.plans.map(cleanPlan),'profileId'),events:sorted(a.events),media:sorted(a.media.map(m=>({id:m.id,size:m.blob.size,type:m.blob.type,originalSize:m.originalBlob?.size,originalType:m.originalBlob?.type})))})}
export async function snapshotHash(snapshot:CloudSnapshot){const canonical={...snapshot,sessions:sorted(snapshot.sessions),plans:sorted(snapshot.plans,'profileId'),events:sorted(snapshot.events),media:sorted(snapshot.media)};const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJson(canonical)));return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('')}
