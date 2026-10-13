import {describe,expect,it} from 'vitest'
import {encryptArchive,decryptArchive} from './backup'
import {createProfile,createSession,defaultPlan,defaultProtocol} from './model'
import {createRevision} from './revisions'

describe('encrypted family backup',()=>{
  const p=createProfile({nickname:'孩子的私密昵称',guardianConfirmed:true,childInformed:true,storage:true})
  const archive={profiles:[p],sessions:[],plans:[defaultPlan(p.id)],events:[],media:[]}
  it('does not restore device notification permission, followup preference or delivery markers',async()=>{
    const plans=[{...archive.plans[0],notificationEnabled:true,followupEnabled:true,lastNotifiedWindow:'2026-09-17',lastNotifiedDate:'2026-09-17',lastFollowupWindow:'2026-09-17'}]
    const decoded=await decryptArchive(await encryptArchive({...archive,plans},'test-only-secret'),'test-only-secret')
    expect(decoded.plans).toEqual(archive.plans)
  })
  it('roundtrips authorized profile data without exposing names in the envelope',async()=>{
    const file=await encryptArchive(archive,'test-only-secret')
    expect(await file.text()).not.toContain(p.nickname)
    expect(await decryptArchive(file,'test-only-secret')).toEqual(archive)
  })
  it('rejects wrong passwords and corrupted ciphertext',async()=>{
    const file=await encryptArchive(archive,'test-only-secret')
    await expect(decryptArchive(file,'different-password')).rejects.toThrow('密码不正确')
    const data=JSON.parse(await file.text());data.data='AAAA'+data.data.slice(4)
    await expect(decryptArchive(new Blob([JSON.stringify(data)]),'test-only-secret')).rejects.toThrow()
  })
  it('validates decrypted contents before any storage mutation',async()=>{
    const file=await encryptArchive({...archive,profiles:[{...p,consent:{...p.consent,childInformed:false as any}}]},'test-only-secret')
    await expect(decryptArchive(file,'test-only-secret')).rejects.toThrow('格式不正确')
  })
  it('requires a sufficient backup password',async()=>{
    await expect(encryptArchive(archive,'123')).rejects.toThrow('8–128')
  })
  it('restores revision links and rejects a branching history before writes',async()=>{
    const capture={id:'front' as const,label:'正面',hint:'',eyebrow:'',url:'blob:fixture'}
    const root=createSession({profileId:p.id,recordedOn:'2026-09-17',kind:'memory',recordedBy:'together',note:'',protocol:defaultProtocol()},[capture])
    const revision=createRevision(root,[capture],'reanalyze',['front'])
    const decoded=await decryptArchive(await encryptArchive({...archive,sessions:[root,revision]},'test-only-secret'),'test-only-secret')
    expect(decoded.sessions.find(s=>s.id===revision.id)?.revision).toEqual(revision.revision)
    const fork={...revision,id:'other-fork'}
    await expect(decryptArchive(await encryptArchive({...archive,sessions:[root,revision,fork]},'test-only-secret'),'test-only-secret')).rejects.toThrow('格式不正确')
  })
})
