import 'fake-indexeddb/auto'
import sharp from 'sharp'
import {afterEach,it,expect,vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {ProfileForm} from './ProfileForm'
import {FamilySettings} from './FamilySettings'
import {RecordFlow} from './RecordFlow'
import {readCapture} from '../lib/readCapture'
import {createPersonalProfile,defaultPlan,defaultProtocol,type FamilySession} from './model'
import {CAPTURE_SEQUENCE,sideSession} from './captureViews'
import {FamilyStore} from './store'
import {encryptArchive,decryptArchive,archiveSchema} from './backup'
import {prepareBackupVolumes,decryptBackupFiles} from './backupVolumes'
import {validProfileConsent} from './profileConsent'
import {hasTimelineView} from './timelineQuery'
import {photoChecksPass} from './planCompletion'
import {FAMILY_SERVICES_ENABLED} from '../productMode'
import {archiveFixture} from './backupVolumes.fixture'
const stores:FamilyStore[]=[],urls:string[]=[]
afterEach(async()=>{urls.splice(0).forEach(URL.revokeObjectURL);for(const s of stores.splice(0)){await s.close();await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase(s.name);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})}})
async function recorded(purpose?:string){
  const store=new FamilyStore('unit-personal-'+crypto.randomUUID());stores.push(store);const profile=createPersonalProfile({nickname:'用户档案',birthYear:2010});await store.putProfile(profile)
  const captures=await Promise.all(CAPTURE_SEQUENCE.map(async(view,index)=>{const bytes=await sharp({create:{width:64,height:64,channels:3,background:['#963f51','#586f91','#94a65e'][index]}}).png().toBuffer(),url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/png'}));urls.push(url);return{id:view.id,label:view.label,hint:'工程照片',eyebrow:'',url,quality:{score:95,resolution:100,brightness:90,contrast:90,sharpness:90,flags:[]},poseValidation:{status:'pass' as const,estimatedPose:view.side??'front' as const,detectedFaces:1,flags:[]}}}))
  const session=await store.saveSession({profileId:profile.id,recordedOn:'2026-09-20',kind:purpose?'memory':'measurement',purpose,dateSource:purpose?'photo_metadata':undefined,recordedBy:'user',note:'个人备注',protocol:defaultProtocol()},captures)
  return {store,profile,session}
}
it('renders one profile step with only name and year and no role, side or consent checkboxes',()=>{
  const html=renderToStaticMarkup(<ProfileForm onSave={async()=>{}}/>)
  expect(html.match(/<input /g)).toHaveLength(1);expect(html.match(/<select(?: |>)/g)).toHaveLength(1);expect(html).toContain('创建档案');expect(html).toContain('出生年份')
  for(const text of ['type="checkbox"','type="radio"','家长','监护人','共同记录方式','下一步','默认侧面'])expect(html).not.toContain(text)
  expect(FAMILY_SERVICES_ENABLED).toBe(false)
})
it('records local personal storage without inventing guardian or child confirmations',()=>{
  const p=createPersonalProfile({nickname:' 测试名称 ',birthYear:2000});expect(p.nickname).toBe('测试名称');expect(p.consent.version).toBe('LOCAL-USER-1');expect(p.consent).not.toHaveProperty('guardianConfirmed');expect(p.consent).not.toHaveProperty('childInformed');expect(p.participation).toBeUndefined();expect(p.preferredSide).toBeNull();expect(validProfileConsent(p.consent)).toBe(true)
  expect(validProfileConsent({...p.consent,guardianConfirmed:true})).toBe(false);expect(()=>createPersonalProfile({nickname:''})).toThrow();expect(()=>createPersonalProfile({nickname:'测试',birthYear:9999})).toThrow()
})
it('hides family account and sharing actions from personal settings',()=>{
  const noop=()=>{},profile=createPersonalProfile({nickname:'用户'})
  const html=renderToStaticMarkup(<FamilySettings profile={profile} onShare={noop} onCreate={noop} onEdit={noop} onProfile={noop} onRefresh={async()=>{}} onDeleted={noop} onAccount={noop}/>)
  for(const label of ['管理家庭账号','管理限时分享','邀请家庭成员','默认侧面','另一位孩子'])expect(html).not.toContain(label)
  expect(html).toContain('编辑档案');expect(html).toContain('创建新档案')
})
it('starts recording at the front and presents a fixed front-left-right sequence',()=>{
  const noop=()=>{},html=renderToStaticMarkup(<RecordFlow profile={createPersonalProfile({nickname:'用户'})} onAccount={noop} onHandoffOpen={noop} onSaved={noop} onExit={noop} onBusy={noop} onDirty={noop} onPrivacy={noop}/>)
  expect(CAPTURE_SEQUENCE.map(v=>v.label)).toEqual(['正面','左侧','右侧']);expect(html).toContain('拍摄正面');expect(html).not.toContain('拍摄左侧');expect(html).not.toContain('拍摄右侧');expect(html).not.toContain('生成接力');expect(html).toContain('1/2');expect(html).toContain('2. 侧面');expect(html).not.toContain('2. 左侧');expect(html).not.toContain('3. 右侧');expect(html).not.toContain('用户 · 本次记录');expect(html).toContain('用户的本次记录')
})
it('routes the right storage slot through side analysis while preserving its detected orientation',async()=>{
  const file=new File([archiveFixture().media[0].blob],'right.png',{type:'image/png'}),quality={score:90,resolution:100,brightness:90,contrast:90,sharpness:90,flags:[]},prepare=vi.fn(async()=>({file,width:64,height:64,quality,straightening:{version:'test',status:'not_applied' as const,reason:'side',originalFlags:[]},pose:{status:'pass' as const,estimatedPose:'right_profile' as const,detectedFaces:1,flags:[]}}))
  const result=await readCapture('right_profile',file,true,{prepare,read:async()=>({width:64,height:64,quality}),timeoutMs:1000})
  expect(prepare).toHaveBeenCalledExactlyOnceWith('profile',file,true);expect(result.pose?.estimatedPose).toBe('right_profile')
})
it('saves front, left and right as one record with three independent photo identities',async()=>{
  const {store,session}=await recorded();expect(session.captures.map(c=>c.id)).toEqual(['front','profile','right_profile']);expect(new Set(session.captures.map(c=>c.mediaId)).size).toBe(3);expect((await store.archive()).sessions).toHaveLength(1);expect((await store.archive()).media).toHaveLength(3);expect(session.rightProfileReport).toBeDefined()
  const restored=await store.restoreCaptures(session);expect(restored.captures).toHaveLength(3);expect(new Set(restored.captures.map(c=>c.url)).size).toBe(3);restored.dispose()
})
it('roundtrips both frozen side reports and personal metadata through single and multi-volume backups',async()=>{
  const {store}=await recorded(),archive=await store.archive(),s=archive.sessions[0];s.report.profileDetection.facts=['LEFT SNAPSHOT'];s.rightProfileReport!.profileDetection.facts=['RIGHT SNAPSHOT'];archive.plans=[defaultPlan(s.profileId)]
  expect(archiveSchema(archive)).toBe('headup-family-archive-v3')
  const single=await decryptArchive(await encryptArchive(archive,'engineering-personal'),'engineering-personal'),plan=await prepareBackupVolumes(archive,'engineering-personal',2048),files=[]
  for(let i=0;i<plan.count;i++)files.push(await plan.volume(i))
  const volume=await decryptBackupFiles(files,'engineering-personal')
  for(const result of [single,volume]){expect(result.profiles[0].consent.version).toBe('LOCAL-USER-1');expect(result.sessions[0].recordedBy).toBe('user');expect(result.sessions[0].captures).toHaveLength(3);expect(result.media).toHaveLength(3);expect(result.sessions[0].report.profileDetection.facts).toEqual(['LEFT SNAPSHOT']);expect(result.sessions[0].rightProfileReport?.profileDetection.facts).toEqual(['RIGHT SNAPSHOT']);expect(result.plans[0].owner).toBe('user')}
})
it('projects right-side photos, hashes and frozen readings together without borrowing the left report',async()=>{
  const {session}=await recorded(),right=sideSession(session,'right_profile'),left=sideSession(session,'left_profile')
  expect(right.report).toBe(session.rightProfileReport);expect(left.report).toBe(session.report);expect(right.captures.find(c=>c.id==='profile')?.mediaId).toContain('/right_profile');expect(left.captures.find(c=>c.id==='profile')?.mediaId).toContain('/profile');expect(right.contentKey).not.toBe(left.contentKey);expect(hasTimelineView(session,'left_profile')).toBe(true);expect(hasTimelineView(session,'right_profile')).toBe(true)
})
it('requires all three correctly oriented views to complete a new personal recording plan',async()=>{
  const {session}=await recorded();expect(photoChecksPass(session)).toBe(true);expect(photoChecksPass({...session,captures:session.captures.slice(0,2)})).toBe(false)
  const wrong=structuredClone(session);wrong.captures[2].poseValidation!.estimatedPose='left_profile';expect(photoChecksPass(wrong)).toBe(false)
})
it('does not display left readings when a record has no right-side photo or right report',async()=>{
  const {session}=await recorded();session.report.profile=[{code:'PROFILE-LINE-02',value:'1.0%',label:'左侧独有',score:0,note:'',group:'侧貌',view:'profile',available:true,origin:'measurement',errors:[]}]
  const missingPhoto={...session,captures:session.captures.filter(c=>c.id!=='right_profile')}
  expect(sideSession(missingPhoto,'right_profile').report.profile).toEqual([])
  expect(sideSession({...session,rightProfileReport:undefined},'right_profile').report.profile).toEqual([])
})
it('retains legacy profiles, consent and two-view backups without rewriting their history',async()=>{
  const old=archiveFixture(),restored=await decryptArchive(await encryptArchive(old,'engineering-personal'),'engineering-personal')
  expect(restored.profiles).toEqual(old.profiles);expect(restored.sessions.map(s=>s.recordedBy)).toEqual(old.sessions.map(s=>s.recordedBy));expect(restored.sessions.every(s=>s.rightProfileReport===undefined)).toBe(true)
})

it('keeps a custom purpose and imported date through save, revision and encrypted backup',async()=>{
  const {store,session}=await recorded('牙齿矫正记录'),restored=await store.restoreCaptures(session)
  try {
    const saved=await store.saveRevision(session,restored.captures,'reanalyze',['front'],'memory')
    expect(saved.purpose).toBe('牙齿矫正记录');expect(saved.dateSource).toBe('photo_metadata')
    const archive=await store.archive(),roundtrip=await decryptArchive(await encryptArchive(archive,'purpose-roundtrip'),'purpose-roundtrip')
    expect(roundtrip.sessions.find(s=>s.id===saved.id)?.purpose).toBe('牙齿矫正记录')
    expect(roundtrip.sessions.find(s=>s.id===saved.id)?.dateSource).toBe('photo_metadata')
  } finally {restored.dispose()}
})
