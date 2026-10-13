import {it,expect} from 'vitest'
import {archiveFixture} from './backupVolumes.fixture'
import {encryptArchive,decryptArchive} from './backup'
import {prepareCloudSnapshot} from './cloudSnapshot'
import {validateCloudSnapshot} from './cloudContract'
import {createProfile} from './model'
it('preserves participation through encrypted backup and cloud contracts while accepting older profiles without it',async()=>{const archive=archiveFixture();archive.profiles[0].participation='together';const restored=await decryptArchive(await encryptArchive(archive,'test-passphrase'),'test-passphrase');expect(restored.profiles[0].participation).toBe('together');const prepared=await prepareCloudSnapshot(archive);expect(validateCloudSnapshot(prepared.snapshot,archive.profiles[0].id).profile.participation).toBe('together');delete prepared.snapshot.profile.participation;expect(()=>validateCloudSnapshot(prepared.snapshot,archive.profiles[0].id)).not.toThrow()})
it('does not accept an account role as a participation selection',async()=>{expect(()=>createProfile({nickname:'工程档案',guardianConfirmed:true,childInformed:true,storage:true,participation:'owner' as any})).toThrow();const archive=archiveFixture(),prepared=await prepareCloudSnapshot(archive);prepared.snapshot.profile.participation='owner';expect(()=>validateCloudSnapshot(prepared.snapshot,archive.profiles[0].id)).toThrow()})
