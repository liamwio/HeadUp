import 'fake-indexeddb/auto'
import {afterEach,it,expect,vi} from 'vitest'
import {FamilyStore} from './store'
import {createProfile,defaultPlan} from './model'
import {deliverReminder} from './reminderDelivery'
import {reminderKindDue,type ReminderKind} from './reminders'
const stores:FamilyStore[]=[]
afterEach(async()=>{const names=new Set(stores.map(s=>s.name));for(const s of stores.splice(0))await s.close();for(const name of names)await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})})
async function setup(){
  const name='unit-reminder-'+crypto.randomUUID(),a=new FamilyStore(name),b=new FamilyStore(name);stores.push(a,b)
  const profile=createProfile({nickname:'工程测试',guardianConfirmed:true,childInformed:true,storage:true})
  await a.putProfile(profile)
  const plan={...defaultPlan(profile.id,'2026-08-20'),intervalDays:28,windowDays:7,nextDate:'2026-09-17',time:'18:00',enabled:true,notificationEnabled:true,followupEnabled:true}
  await a.putPlan(plan)
  const run=(store=a,kind:ReminderKind='initial',notify:(canSend:()=>Promise<boolean>)=>Promise<boolean>=async check=>check(),current=()=>true)=>deliverReminder({store,profileId:profile.id,window:plan.nextDate,kind,now:()=>new Date(2026,8,kind==='initial'?17:25,18),current,notify})
  return {a,b,plan,run}
}
it('atomically allows one initial and one followup across two tabs and retains markers through form saves',async()=>{
  const {a,b,plan,run}=await setup(),notify=vi.fn(async check=>check())
  expect((await Promise.all([run(a,'initial',notify),run(b,'initial',notify)])).filter(Boolean)).toHaveLength(1)
  expect(notify).toHaveBeenCalledTimes(1);expect((await a.reminderPlan(plan.profileId))?.lastNotifiedDate).toBe(plan.nextDate)
  await a.putPlan({...plan,owner:'parent'},plan)
  expect((await Promise.all([run(a,'followup',notify),run(b,'followup',notify)])).filter(Boolean)).toHaveLength(1)
  const saved=(await a.reminderPlan(plan.profileId))!
  await a.putPlan({...saved,followupEnabled:false},saved)
  await a.putPlan({...saved,followupEnabled:true},{...saved,followupEnabled:false})
  expect(await run()).toBe(false);expect(await run(a,'followup',notify)).toBe(false);expect(notify).toHaveBeenCalledTimes(2)
  expect(await a.reminderPlan(plan.profileId)).toMatchObject({lastNotifiedWindow:plan.nextDate,lastNotifiedDate:plan.nextDate,lastFollowupWindow:plan.nextDate})
})
it('rechecks a paused plan immediately before showing and never records delivery for a claim alone',async()=>{
  const {a,plan,run}=await setup()
  expect(await run(a,'initial',async check=>{await a.putPlan({...plan,enabled:false});return check()})).toBe(false)
  expect((await a.reminderPlan(plan.profileId))?.lastNotifiedDate).toBeUndefined()
})
it('suppresses a notification after workspace identity changes during asynchronous preparation',async()=>{
  const {a,plan,run}=await setup();let current=true
  expect(await run(a,'initial',async check=>{current=false;return check()},()=>current)).toBe(false)
  expect((await a.reminderPlan(plan.profileId))?.lastNotifiedDate).toBeUndefined()
})
it('stops followup after initial delivery fails',async()=>{
  const {a,plan,run}=await setup()
  expect(await run(a,'initial',async()=>{throw new Error('OS failure')})).toBe(false)
  const saved=(await a.reminderPlan(plan.profileId))!
  expect(saved.notificationEnabled).toBe(false);expect(saved.lastNotifiedDate).toBeUndefined()
  expect(reminderKindDue({...saved,notificationEnabled:true},new Date(2026,8,25,18))).toBeNull()
})
it('does not disable a new window when a previous notification fails late',async()=>{
  const {a,plan,run}=await setup()
  expect(await run(a,'initial',async()=>{await a.putPlan({...plan,nextDate:'2026-10-15'});throw new Error('late failure')})).toBe(false)
  expect(await a.reminderPlan(plan.profileId)).toMatchObject({nextDate:'2026-10-15',notificationEnabled:true,lastNotifiedWindow:undefined,lastNotifiedDate:undefined,lastFollowupWindow:undefined})
})
