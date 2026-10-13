import {it,expect} from 'vitest'
import {archiveFixture} from './backupVolumes.fixture'
import {encryptArchive,decryptArchive} from './backup'
import {prepareCloudSnapshot} from './cloudSnapshot'
import {validateCloudSnapshot} from './cloudContract'
import {isCaptureSelection} from '../lib/captureSelection'
it('retains selected-frame provenance through encrypted backup and cloud snapshot validation',async()=>{
  const archive=archiveFixture(),selection={method:'burst-sharpness-v1' as const,frames:3 as const,selectedIndex:1}
  for(const session of archive.sessions)session.captures[0].captureSelection=selection
  const restored=await decryptArchive(await encryptArchive(archive,'engineering-secret'),'engineering-secret')
  expect(restored.sessions.every(s=>JSON.stringify(s.captures[0].captureSelection)===JSON.stringify(selection))).toBe(true)
  const prepared=await prepareCloudSnapshot(restored),id=archive.profiles[0].id
  expect(validateCloudSnapshot(prepared.snapshot,id).sessions[0].captures[0].captureSelection).toEqual(selection)
  const bad=structuredClone(prepared.snapshot);bad.sessions[0].captures[0].captureSelection.selectedIndex=3
  expect(()=>validateCloudSnapshot(bad,id)).toThrow()
})
it('rejects impossible frame counts, positions, unknown methods and unexpected metadata',()=>{
  const selection={method:'burst-sharpness-v1',frames:3,selectedIndex:1}
  expect(isCaptureSelection(selection)).toBe(true)
  for(const value of [null,[],{...selection,frames:0},{...selection,frames:4},{...selection,selectedIndex:-1},{...selection,selectedIndex:3},{...selection,method:'beautify'},{...selection,extra:'unknown'}])expect(isCaptureSelection(value)).toBe(false)
})
