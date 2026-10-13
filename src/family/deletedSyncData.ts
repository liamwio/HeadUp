import type {SyncLink} from './syncTypes'
/** Retain the deletion receipt and routing IDs, not the deleted archive or upload payload. */
export function deletedSyncReceipt(link:SyncLink):SyncLink{
  if(link.status!=='deleted')return link
  const {baseSnapshot,creationProfile,job,authors,message,...receipt}=link
  return {...receipt,enabled:false,baseHash:'',baseStamp:''}
}
