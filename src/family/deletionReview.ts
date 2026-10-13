import type {Archive} from './backup'
import type {SyncLink,SyncRecovery} from './syncTypes'
import {archiveStamp} from './syncState'
import {canonicalJson} from './cloudContract'
import {archivePreview} from './archiveExport'
export const recoveryStamp=(r:SyncRecovery)=>canonicalJson({id:r.id,profileId:r.profileId,createdAt:r.createdAt,reason:r.reason,archive:archiveStamp(r.archive)})
export function deletionReview(archive:Archive,links:SyncLink[],recoveries:SyncRecovery[]){
  const profiles=archive.profiles.map(p=>({id:p.id,nickname:p.nickname})).sort((a,b)=>a.id.localeCompare(b.id)),profileIds=new Set(profiles.map(p=>p.id)),connected=links.filter(l=>profileIds.has(l.profileId)&&l.status!=='deleted')
  return {stamp:canonicalJson({archive:archiveStamp(archive),links:[...links].sort((a,b)=>a.profileId.localeCompare(b.profileId)),recoveries:recoveries.map(recoveryStamp).sort()}),profiles,...archivePreview(archive),plans:archive.plans.length,recoveries:recoveries.length,recoveryPhotos:recoveries.reduce((n,r)=>n+r.archive.media.length,0),connected:connected.length,paused:connected.filter(l=>!l.enabled).length}
}
export type DeletionReview=ReturnType<typeof deletionReview>
