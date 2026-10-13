import {it,expect} from 'vitest'
import {inQuietTime,reminderDue,reminderKindDue,reminderWindow,planCalendar,advanceCompletedPlan} from './reminders'
import {defaultPlan,createSession,defaultProtocol} from './model'
const plan={...defaultPlan('p','2026-08-20'),enabled:true,notificationEnabled:true,intervalDays:28,windowDays:7,nextDate:'2026-09-17',time:'18:00'}
const delivered={...plan,followupEnabled:true,lastNotifiedWindow:plan.nextDate,lastNotifiedDate:plan.nextDate}
it('allows an opted-in followup only two to four days after the window, outside quiet hours',()=>{
  for(const [day,hour,result] of [[24,18,null],[25,17,null],[25,18,'followup'],[25,22,null],[27,18,'followup'],[28,18,null]] as const)expect(reminderKindDue(delivered,new Date(2026,8,day,hour))).toBe(result)
  for(const patch of [{followupEnabled:false},{lastNotifiedDate:undefined},{lastNotifiedDate:'2026-09-17bad'},{lastNotifiedDate:'2026-09-24'},{lastNotifiedWindow:'2026-08-20'},{lastFollowupWindow:plan.nextDate},{enabled:false},{notificationEnabled:false},{lastCompleted:{windowStart:plan.nextDate,recordedOn:plan.nextDate,sessionId:'s'}}])expect(reminderKindDue({...delivered,...patch},new Date(2026,8,25,18))).toBeNull()
})
it('respects overnight quiet periods, local time and inclusive recording window',()=>{
  expect(inQuietTime('23:00','21:00','08:00')).toBe(true);expect(inQuietTime('07:59','21:00','08:00')).toBe(true);expect(inQuietTime('08:00','21:00','08:00')).toBe(false)
  expect(inQuietTime('18:00','18:00','18:00')).toBe(false)
  for(const [day,hour,result] of [[16,18,false],[17,17,false],[17,18,true],[17,22,false],[23,18,true],[24,18,false]] as const)expect(reminderDue(plan,new Date(2026,8,day,hour))).toBe(result)
  expect(reminderDue({...plan,lastNotifiedWindow:reminderWindow(plan)},new Date(2026,8,17,18))).toBe(false)
  expect(reminderDue({...plan,time:'17:30',lastNotifiedWindow:reminderWindow(plan)},new Date(2026,8,17,18))).toBe(false)
  expect(reminderDue({...plan,enabled:false},new Date(2026,8,17,18))).toBe(false)
})
it('generates valid folded ICS with no personal profile ID and blocks quiet-time exports',()=>{
  const ics=planCalendar(plan,new Date('2026-09-17T01:00:00Z'))
  expect(ics).toContain('DTSTART:20260917T180000');expect(ics).toContain('RRULE:FREQ=DAILY;INTERVAL=28');expect(ics).toContain('TRIGGER:PT0S')
  expect(ics.split('\r\n').every(line=>new TextEncoder().encode(line).length<=75)).toBe(true)
  expect(()=>planCalendar({...plan,time:'22:00'})).toThrow('安静时段');expect(()=>planCalendar({...plan,enabled:false})).toThrow('启用')
})
it('advances only current, complete passing observations and never memories or historical imports',()=>{
  const session=createSession({profileId:'p',recordedOn:'2026-09-17',kind:'measurement',recordedBy:'together',note:'',protocol:defaultProtocol()},(['front','profile'] as const).map(id=>({id,label:id,eyebrow:'',hint:'',url:'blob:test',quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:id==='front'?'front':'left_profile',detectedFaces:1,flags:[]}})),new Date(2026,8,17,18))
  expect(advanceCompletedPlan(plan,session,'2026-09-17').nextDate).toBe('2026-10-15')
  expect(advanceCompletedPlan(plan,session,'2026-09-17').lastCompleted).toEqual({windowStart:'2026-09-17',recordedOn:'2026-09-17',sessionId:session.id})
  expect(advanceCompletedPlan({...delivered,lastFollowupWindow:plan.nextDate},session,'2026-09-17')).toMatchObject({followupEnabled:true,lastNotifiedWindow:undefined,lastNotifiedDate:undefined,lastFollowupWindow:undefined})
  for(const s of [{...session,kind:'memory' as const},{...session,recordedOn:'2026-09-16'},{...session,captures:session.captures.slice(0,1)}])expect(advanceCompletedPlan(plan,s,'2026-09-17')).toBe(plan)
})
