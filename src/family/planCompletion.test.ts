import {it,expect} from 'vitest'
import {archiveFixture} from './backupVolumes.fixture'
import {defaultPlan} from './model'
import {validCompletion} from './planCompletion'
import {encryptArchive,decryptArchive} from './backup'
it('keeps the completion marker in encrypted backups without requiring a new archive version',async()=>{const data=archiveFixture(),record=data.sessions[0],marker={windowStart:record.recordedOn,recordedOn:record.recordedOn,sessionId:record.id};data.plans=[{...defaultPlan(record.profileId),lastCompleted:marker}];const restored=await decryptArchive(await encryptArchive(data,'completion-test-pass'),'completion-test-pass');expect(restored.plans[0].lastCompleted).toEqual(marker)})
it('rejects invented marker fields, out-of-window dates and invalid record identifiers',()=>{const marker={windowStart:'2026-09-01',recordedOn:'2026-09-07',sessionId:'record-1'};expect(validCompletion(marker)).toBe(true);for(const value of [{...marker,recordedOn:'2026-10-01'},{...marker,sessionId:'../../private'},{...marker,claim:'healthy growth'},{}])expect(validCompletion(value)).toBe(false)})
