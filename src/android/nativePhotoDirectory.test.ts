import {expect,it,vi} from 'vitest'
import {installNativePhotoDirectory} from './nativePhotoDirectory'
import {configurePhotoDirectory,photoDirectoryAvailable,autoSaveCameraPhoto,autoSaveLocalPhotos,copyPhotosToDirectory,type PhotoDirectoryApi} from '../family/photoDirectory'
import {archiveFixture} from '../family/backupVolumes.fixture'
it('disables every directory-save route including old pending work without reading photos',async()=>{
 const invoke=vi.fn(async()=>{throw Error('Must never call native photo writer')})
 configurePhotoDirectory({photoDirectory:invoke,beginPhotoCopy:invoke,appendPhotoCopy:invoke,finishPhotoCopy:invoke,abortPhotoCopy:invoke} as PhotoDirectoryApi)
 installNativePhotoDirectory();expect(photoDirectoryAvailable()).toBe(false)
 const a=archiveFixture(),read=vi.fn()
 await autoSaveCameraPhoto(a.profiles[0],'front',a.media[0].blob,'2026-10-13T00:00:00Z')
 await autoSaveLocalPhotos(a,read)
 expect(await copyPhotosToDirectory(a.profiles[0],a.sessions,read)).toBeNull()
 expect(read).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled()
})
