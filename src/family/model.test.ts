import {describe,expect,it} from 'vitest'
import {addDays,compareSessions,createProfile,createSession,defaultProtocol,stageSummary,validDate,type FamilySession} from './model'
import type {Capture} from '../types'

const profile=()=>createProfile({nickname:'小禾',guardianConfirmed:true,childInformed:true,storage:true})
const capture=(id:'front'|'profile',side:'left_profile'|'right_profile'='left_profile'):Capture=>({id,url:'blob:local',label:id,hint:'',eyebrow:'',quality:{score:95,resolution:100,brightness:90,sharpness:90,contrast:90,flags:[]},poseValidation:{status:'pass',estimatedPose:id==='front'?'front':side,detectedFaces:1,flags:[]}})
const session=(id:string,date='2026-09-01'):FamilySession=>({...createSession({profileId:'child-a',recordedOn:date,kind:'measurement',recordedBy:'together',note:'',protocol:{...defaultProtocol(),device:'phone A',camera:'rear',distanceCm:100,light:'daylight'}},[capture('front'),capture('profile')],new Date('2026-09-17T08:00:00Z')),id})

describe('family records and comparability',()=>{
  it('requires child participation and local storage consent rather than defaulting them on',()=>{
    expect(()=>createProfile({nickname:'小禾',guardianConfirmed:true,childInformed:false,storage:true})).toThrow('确认')
    expect(()=>createProfile({nickname:' ',guardianConfirmed:true,childInformed:true,storage:true})).toThrow('昵称')
    expect(profile().consent.storage).toBe(true)
  })
  it('preserves snapshot versions and omits transient media URLs',()=>{
    const a=session('a')
    expect(a.captures.every(c=>!('url'in c)&&!('originalUrl'in c))).toBe(true)
    expect(a.version.algorithm).toBeTruthy();expect(a.report.isExample).toBe(false)
  })
  it('does not turn close conditions into an unsupported growth conclusion',()=>{
    const a=session('a','2026-08-01'),b=session('b')
    const result=compareSessions(a,b,'front')
    expect(result.status).toBe('conditions_close')
    expect(result.reasons.join()).toContain('真实跨期误差尚未验证')
  })
  it('never compares different children, duplicate sessions or opposite profile sides',()=>{
    const a=session('a'),b=session('b');b.captures[1].poseValidation!.estimatedPose='right_profile'
    expect(compareSessions(a,b,'profile').status).toBe('incompatible')
    expect(compareSessions(a,{...b,profileId:'child-b'},'front').status).toBe('incompatible')
    expect(compareSessions(a,a,'front').status).toBe('incompatible')
    expect(compareSessions(a,{...b,captures:[]},'front').status).toBe('incompatible')
  })
  it.each(['device','distance','version','memory','quality'])('downgrades a %s boundary while retaining photo viewing',boundary=>{
    const a=session('a','2026-08-01'),b=session('b')
    if(boundary==='device')b.protocol.device=''
    if(boundary==='distance')b.protocol.distanceCm=150
    if(boundary==='version')b.version.algorithm='older-version'
    if(boundary==='memory')b.kind='memory'
    if(boundary==='quality')b.captures[0].quality!.flags=['光线不足']
    expect(compareSessions(a,b,'front').status).toBe('visual_only')
  })
  it('validates calendar days, leap years and future capture dates',()=>{
    expect(validDate('2026-02-30')).toBe(false)
    expect(addDays('2024-02-28',1)).toBe('2024-02-29')
    expect(addDays('2026-12-31',1)).toBe('2027-01-01')
    expect(()=>createSession({profileId:'a',recordedOn:'2099-01-01',kind:'memory',recordedBy:'child',note:'',protocol:defaultProtocol()},[capture('front')])).toThrow('过去')
  })
  it('does not pressure memory photos to become measurement sessions',()=>{
    const p=profile(),a={...session('a'),profileId:p.id,kind:'memory' as const,captures:[session('a').captures[0]]}
    const summary=stageSummary([a],p)
    expect(summary.observed).toContain('生活留念')
    expect(summary.actions.join()).not.toContain('补齐')
    expect(stageSummary([],p).sourceIds).toEqual([])
  })
})
