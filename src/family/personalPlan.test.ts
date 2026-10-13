import {it,expect} from 'vitest'
import {defaultPlan,validatePlan,type FamilySession} from './model'
import {defaultPersonalPlan,withPlanInterval,advancePersonalPlan} from './personalPlan'
import {archiveFixture} from './backupVolumes.fixture'
const record=(date:string,id='photo'):FamilySession=>({...archiveFixture().sessions[0],id,profileId:'p',recordedOn:date,kind:'memory',recordedBy:'user'})
it('defaults to thirty days after the latest photo with a one-day window and 18:00 time',()=>{
  expect(defaultPersonalPlan('p',[record('2026-09-10'),record('2026-09-20','new')],'2026-09-21')).toMatchObject({enabled:true,nextDate:'2026-10-20',intervalDays:30,windowDays:1,time:'18:00'})
  expect(defaultPersonalPlan('empty',[record('2026-09-20')],'2026-09-21').nextDate).toBe('2026-10-21')
})
it('recalculates selected cycles from the photograph date, including year boundaries and custom days',()=>{
  const plan=defaultPlan('p')
  expect(withPlanInterval(plan,14,[record('2026-12-25')]).nextDate).toBe('2027-01-08')
  expect(withPlanInterval(plan,30,[record('2026-12-25')]).nextDate).toBe('2027-01-24')
  expect(withPlanInterval(plan,3,[record('2026-12-25')]).nextDate).toBe('2026-12-28')
  expect(()=>validatePlan(withPlanInterval(plan,3,[]))).not.toThrow()
  expect(()=>validatePlan(withPlanInterval(plan,0,[]))).toThrow()
})
it('moves enabled plans after a new photo even outside the old window without claiming a measurement completion',()=>{
  const plan={...defaultPlan('p'),intervalDays:7,enabled:true,nextDate:'2026-09-10',lastNotifiedWindow:'2026-09-10'}
  const next=advancePersonalPlan(plan,record('2026-09-21','new'),[record('2026-09-01')])
  expect(next.nextDate).toBe('2026-09-28');expect(next.lastNotifiedWindow).toBeUndefined();expect(next.lastCompleted).toBeUndefined()
  expect(advancePersonalPlan({...plan,enabled:false},record('2026-09-21'),[]).nextDate).toBe(plan.nextDate)
  expect(advancePersonalPlan(plan,record('2026-08-01'),[record('2026-09-01')])).toBe(plan)
  expect(advancePersonalPlan(plan,{...record('2026-09-21'),revision:{rootId:'photo',parentId:'photo',number:1,operation:'reanalyze',views:['front']}},[])).toBe(plan)
})
