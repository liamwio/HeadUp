import type {Archive} from './backup'
import type {CloudSnapshot,CloudRole} from './cloudContract'
export type SyncStatus='pending'|'syncing'|'synced'|'paused'|'conflict'|'offline'|'revoked'|'deleted'|'error'
export type SyncJob={mutationId:string;version:number;snapshot:CloudSnapshot;uploads:Array<{key:string;blob:Blob}>;localStamp:string}
export type SyncLink={profileId:string;familyId:string;userId:string;enabled:boolean;role:CloudRole;generation:number;version:number;baseHash:string;baseStamp:string;baseSnapshot?:CloudSnapshot;creationProfile?:Record<string,any>;job?:SyncJob;status:SyncStatus;message?:string;updatedAt:string;authors?:Array<{kind:string;id:string;userId:string}>}
export type SyncRecovery={id:string;profileId:string;createdAt:string;reason:string;archive:Archive}
export type RemoteState={id:string;familyId:string;version:number;deleted:boolean;snapshot:CloudSnapshot|null;authors:Array<{kind:string;id:string;userId:string}>;deletedEntities:Array<{kind:string;id:string;deletedAt:number}>}
