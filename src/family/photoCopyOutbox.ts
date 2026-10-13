import type {PhotoCopySpec} from './photoDirectory'

export type PhotoCopyJob={id:string;spec:Omit<PhotoCopySpec,'mime'|'size'|'sha256'>;blob:Blob}
// Keep selected camera frames across process exits until the native copy succeeds.
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{
 const request=indexedDB.open('headup-photo-copy-outbox',1)
 request.onupgradeneeded=()=>request.result.createObjectStore('photos',{keyPath:'id'})
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
})}
async function transaction<T>(mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
 const db=await database()
 try{return await new Promise<T>((resolve,reject)=>{
  const tx=db.transaction('photos',mode),request=action(tx.objectStore('photos'))
  tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error??request.error);tx.onerror=()=>reject(tx.error)
 })}finally{db.close()}
}
export const pendingCameraPhotos=()=>transaction('readonly',s=>s.getAll()) as Promise<PhotoCopyJob[]>
export const keepCameraPhoto=(job:PhotoCopyJob)=>transaction('readwrite',s=>s.put(job))
export const removeCameraPhoto=(id:string)=>transaction('readwrite',s=>s.delete(id))
