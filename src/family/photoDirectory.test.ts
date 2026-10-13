import 'fake-indexeddb/auto'
import {pendingCameraPhotos,removeCameraPhoto} from './photoCopyOutbox'
import {afterEach,expect,it,vi} from 'vitest'
import {autoSaveCameraPhoto,autoSaveLocalPhotos,configurePhotoDirectory,copyPhotosToDirectory,writePhotoCopy,pendingPhotoCopies,resumePendingPhotoCopies,type PhotoDirectoryApi} from './photoDirectory'
import {archiveFixture} from './backupVolumes.fixture'
const spec={profileId:'p',profileName:'名称',sessionId:'s',date:'2026-10-12',view:'front' as const,variant:'original' as const}
function client():PhotoDirectoryApi{return {photoDirectory:vi.fn(async()=>({directory:'Pictures/HeadUp/p/',shared:true})),beginPhotoCopy:vi.fn(async()=>({token:'t',alreadySaved:false,directory:'Pictures/HeadUp/p/'})),appendPhotoCopy:vi.fn(async()=>{}),finishPhotoCopy:vi.fn(async()=>({directory:'Pictures/HeadUp/p/'})),abortPhotoCopy:vi.fn(async()=>{})}}
afterEach(async()=>{for(const job of await pendingCameraPhotos())await removeCameraPhoto(job.id);configurePhotoDirectory(undefined);vi.unstubAllGlobals()})
it('streams original bytes with their SHA256 and skips an existing verified copy',async()=>{
 const api=client(),bytes=Uint8Array.from({length:500000},(_,i)=>i%255),chunks:Uint8Array[]=[]
 api.appendPhotoCopy=vi.fn(async v=>{const data=Uint8Array.from(atob(v.data),c=>c.charCodeAt(0));expect(data.length).toBeLessThanOrEqual(192*1024);chunks.push(data)})
 await writePhotoCopy(api,spec,new Blob([bytes],{type:'image/png'}))
 const joined=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.length}
 expect(joined).toEqual(bytes);expect(api.beginPhotoCopy).toHaveBeenCalledWith(expect.objectContaining({size:500000,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}))
 api.beginPhotoCopy=vi.fn(async()=>({alreadySaved:true,directory:'Pictures/HeadUp/p/'}));vi.mocked(api.appendPhotoCopy).mockClear()
 await writePhotoCopy(api,spec,new Blob([bytes],{type:'image/png'}));expect(api.appendPhotoCopy).not.toHaveBeenCalled()
})
it('aborts failed writes and never reports success',async()=>{
 const api=client();api.appendPhotoCopy=vi.fn(async()=>{throw Error('disk full')})
 await expect(writePhotoCopy(api,spec,new Blob(['bytes'],{type:'image/png'}))).rejects.toThrow('disk full')
 expect(api.abortPhotoCopy).toHaveBeenCalledWith({token:'t'});expect(api.finishPhotoCopy).not.toHaveBeenCalled()
})
it('copies only committed capture media, separates original and analysis, and leaves source records unchanged',async()=>{
 const a=archiveFixture(),session=a.sessions[0],before=JSON.stringify(session),api=client();configurePhotoDirectory(api)
 const r=await copyPhotosToDirectory(a.profiles[0],[session],async id=>a.media.find(m=>m.id===id))
 expect(r).toMatchObject({phase:'saved',count:2});expect(api.beginPhotoCopy).toHaveBeenCalledTimes(2)
 expect(vi.mocked(api.beginPhotoCopy).mock.calls.map(c=>c[0].variant)).toEqual(['original','analysis'])
 expect(JSON.stringify(session)).toBe(before)
})
it('keeps native-copy failure separate from saved app data and blocks cross-profile media',async()=>{
 const a=archiveFixture(),s=a.sessions[0],api=client();configurePhotoDirectory(api)
 const r=await copyPhotosToDirectory(a.profiles[0],[s],async()=>({...a.media[0],profileId:'other'}))
 expect(r?.phase).toBe('failed');expect(r?.message).toContain('应用内记录仍保留');expect(api.beginPhotoCopy).not.toHaveBeenCalled()
})
it('does not attempt native writes on the web or iOS when the adapter is absent',async()=>{
 const a=archiveFixture(),read=vi.fn();expect(await copyPhotosToDirectory(a.profiles[0],a.sessions,read)).toBeNull();expect(read).not.toHaveBeenCalled()
})
it('resumes requested incomplete records without copying unrelated historic records',async()=>{
 const entries=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>entries.set(key,value)})
 const a=archiveFixture(),api=client();api.appendPhotoCopy=vi.fn(async()=>{throw Error('interrupted')});configurePhotoDirectory(api)
 await copyPhotosToDirectory(a.profiles[0],[a.sessions[0]],async id=>a.media.find(m=>m.id===id))
 expect(pendingPhotoCopies()).toEqual([{profileId:a.profiles[0].id,sessionId:a.sessions[0].id}])
 const retry=client();configurePhotoDirectory(retry);await resumePendingPhotoCopies(a,async id=>a.media.find(m=>m.id===id))
 expect(pendingPhotoCopies()).toEqual([]);expect(retry.beginPhotoCopy).toHaveBeenCalledTimes(2)
 expect(vi.mocked(retry.beginPhotoCopy).mock.calls.every(c=>c[0].sessionId===a.sessions[0].id)).toBe(true)
})

function memoryStorage(){const entries=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>entries.set(key,value)})}
it('saves the selected camera photo before any record exists and reuses the same destination after commit',async()=>{
 memoryStorage();const a=archiveFixture(),api=client(),at='2026-10-12T10:00:00Z';configurePhotoDirectory(api)
 await autoSaveCameraPhoto(a.profiles[0],'front',a.media[0].blob,at)
 expect(api.finishPhotoCopy).toHaveBeenCalledTimes(1);expect(await pendingCameraPhotos()).toEqual([])
 const first=vi.mocked(api.beginPhotoCopy).mock.calls[0][0]
 const s=a.sessions[0];s.captures[0].source='live';s.captures[0].capturedAt=at
 await copyPhotosToDirectory(a.profiles[0],[s],async id=>a.media.find(m=>m.id===id))
 expect(vi.mocked(api.beginPhotoCopy).mock.calls[1][0]).toEqual(first)
})
it('keeps failed camera photos durably and automatically retries without a saved session',async()=>{
 memoryStorage();const a=archiveFixture(),api=client();api.appendPhotoCopy=vi.fn(async()=>{throw Error('disk full')});configurePhotoDirectory(api)
 await autoSaveCameraPhoto(a.profiles[0],'right_profile',a.media[0].blob,'2026-10-12T10:00:00Z')
 const pending=await pendingCameraPhotos();expect(pending).toHaveLength(1);expect(pending[0].spec.view).toBe('right')
 const retry=client();configurePhotoDirectory(retry)
 await autoSaveLocalPhotos({...a,sessions:[]},async()=>undefined)
 expect(retry.finishPhotoCopy).toHaveBeenCalledTimes(1);expect(await pendingCameraPhotos()).toEqual([])
})
it('automatically backfills historic photos once and retries failed history on the next run',async()=>{
 memoryStorage();const a=archiveFixture(),api=client();api.appendPhotoCopy=vi.fn(async()=>{throw Error('disk full')});configurePhotoDirectory(api)
 await autoSaveLocalPhotos(a,async id=>a.media.find(m=>m.id===id))
 const retry=client();configurePhotoDirectory(retry);await autoSaveLocalPhotos(a,async id=>a.media.find(m=>m.id===id))
 expect(retry.finishPhotoCopy).toHaveBeenCalledTimes(4)
 await autoSaveLocalPhotos(a,async id=>a.media.find(m=>m.id===id));expect(retry.finishPhotoCopy).toHaveBeenCalledTimes(4)
})
it('does not export pending photos for a deleted profile',async()=>{
 memoryStorage();const a=archiveFixture(),api=client();api.appendPhotoCopy=vi.fn(async()=>{throw Error('offline')});configurePhotoDirectory(api)
 await autoSaveCameraPhoto(a.profiles[0],'profile',a.media[0].blob,'2026-10-12T10:00:00Z')
 const retry=client();configurePhotoDirectory(retry);await autoSaveLocalPhotos({...a,profiles:[],sessions:[]},async()=>undefined)
 expect(retry.beginPhotoCopy).not.toHaveBeenCalled();expect(await pendingCameraPhotos()).toEqual([])
})
