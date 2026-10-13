import {describe,expect,it} from 'vitest'
import type {MeasurementEvidence} from '../lib/measurementEvidence'
import type {ConsumerReading} from '../lib/consumerReport'
import {archiveFixture} from './backupVolumes.fixture'
import {compareSessions,type FamilySession} from './model'
import {compareReadings} from './readingComparison'
import {COMPARISON_REASONS} from './comparisonReasons'
import {sideSession} from './captureViews'

const evidence=(view:'front'|'profile'):MeasurementEvidence=>({version:'HEADUP-POINT-LINE-1',source:view==='front'?'saved_front_landmarks':'saved_profile_landmarks',width:500,height:600,points:[{id:'a',label:'a',x:100,y:200},{id:'b',label:'b',x:200,y:300}],segments:[{id:'ab',label:'ab',from:'a',to:'b',role:'measure'}],formula:'distance(a,b)'})
function pair(view:'front'|'profile'='front') {
  const a=structuredClone(archiveFixture().sessions[0]);a.kind='measurement';a.report.front=[];a.report.profile=[];a.report.extended=[];a.report.native=null
  a.protocol={...a.protocol,device:'same-device',camera:'rear',distanceCm:100,light:'daylight'}
  a.captures=[{...a.captures[0],id:view,poseValidation:{status:'pass',estimatedPose:view==='front'?'front':'left_profile',detectedFaces:1,flags:[]},quality:{score:90,resolution:100,brightness:90,contrast:90,sharpness:90,flags:[]}}]
  a.report[view]=[{code:view==='front'?'FRONT-RATIO-07':'PROFILE-ANGLE-01',value:view==='front'?'39.0%':'140.00°',label:'测试指标',note:'',score:0,group:'比例',view,origin:'measurement',available:true,errors:[]}]
  const b:FamilySession={...structuredClone(a),id:'later',recordedOn:'2026-09-18',contentKey:undefined,revision:undefined}
  b.report[view][0].value=view==='front'?'39.6%':'142.00°'
  return {a,b}
}
const native=(source:'direct_geometry_head'|'landmark_derived')=>({geometrySource:source,width:500,height:600,paths:[]}) as unknown as NonNullable<FamilySession['report']['native']>

describe('reading provenance comparison gate',()=>{
  it.each(['front','profile'] as const)('blocks new versus legacy %s evidence despite matching global versions',view=>{
    const {a,b}=pair(view);b.report[view][0].evidence=evidence(view)
    expect(a.version).toEqual(b.version)
    expect(compareSessions(a,b,view).reasons).toContain(COMPARISON_REASONS.reading_source)
    expect(compareReadings(a,b,view)[0].difference).toContain('不计算差值')
  })
  it.each(['formula','source','version'] as const)('blocks an evidence %s mismatch',key=>{
    const {a,b}=pair();a.report.front[0].evidence=evidence('front');b.report.front[0].evidence=evidence('front')
    ;(b.report.front[0].evidence as unknown as Record<string,string>)[key]='different'
    expect(compareSessions(a,b,'front').status).toBe('visual_only')
    expect(compareReadings(a,b,'front')[0].difference).toContain('不计算差值')
  })
  it('retains arithmetic for matching point sources and for matching legacy formulas',()=>{
    const {a,b}=pair();a.report.front[0].formula=b.report.front[0].formula='same formula'
    expect(compareReadings(a,b,'front')[0].difference).toBe('+0.60 个百分点')
    a.report.front[0].evidence=evidence('front');b.report.front[0].evidence=evidence('front')
    b.report.front[0].evidence.points[0].x=120
    expect(compareReadings(a,b,'front')[0].difference).toBe('+0.60 个百分点')
    b.report.front[0].formula='changed formula'
    expect(compareReadings(a,b,'front')[0].difference).toContain('不计算差值')
  })
  it('blocks direct versus point-derived profile readings even with equal metric codes/formulas',()=>{
    const {a,b}=pair('profile');a.report.native=native('direct_geometry_head');b.report.native=native('landmark_derived')
    expect(compareSessions(a,b,'profile').status).toBe('visual_only')
    expect(compareReadings(a,b,'profile')[0].difference).toContain('不计算差值')
  })
  it('does not interpret missing profile provenance as a point-derived source',()=>{
    const {a,b}=pair('profile');b.report.native=native('landmark_derived')
    expect(compareSessions(a,b,'profile').reasons).toContain(COMPARISON_REASONS.reading_source)
  })
  it('prefers the frozen reading source over the raw capture source',()=>{
    const {a,b}=pair('profile');a.report.native=native('landmark_derived');b.report.native=native('landmark_derived')
    a.captures[0].poseValidation!.nativeProfile={status:'measured',geometrySource:'direct_geometry_head'}
    b.captures[0].poseValidation!.nativeProfile={status:'measured',geometrySource:'landmark_derived'}
    expect(compareSessions(a,b,'profile').status).toBe('conditions_close')
  })
  it.each(['modelVersion','cropVersion','refinerVersion','geometryModelVersion'] as const)('blocks changed native %s',key=>{
    const {a,b}=pair('profile');a.report.native=native('direct_geometry_head');b.report.native=native('direct_geometry_head')
    a.captures[0].poseValidation!.nativeProfile={status:'measured',[key]:'old'}
    b.captures[0].poseValidation!.nativeProfile={status:'measured',[key]:'new'}
    expect(compareSessions(a,b,'profile').reasons).toContain(COMPARISON_REASONS.reading_source)
  })
  it('checks the selected right report without borrowing the left source',()=>{
    const {a,b}=pair('profile')
    for(const s of [a,b]){
      s.recordedBy='user';s.report.native=native('landmark_derived')
      s.captures.push({...s.captures[0],id:'right_profile',poseValidation:{...s.captures[0].poseValidation!,estimatedPose:'right_profile'}})
      s.rightProfileReport={...structuredClone(s.report),native:native(s===a?'direct_geometry_head':'landmark_derived')}
    }
    expect(compareSessions(sideSession(a,'left_profile'),sideSession(b,'left_profile'),'profile').status).toBe('conditions_close')
    expect(compareSessions(sideSession(a,'right_profile'),sideSession(b,'right_profile'),'profile').status).toBe('visual_only')
  })
  it('blocks a changed point geometry version as well as a changed direct model version',()=>{
    const {a,b}=pair('profile');a.report.native=native('landmark_derived');b.report.native=native('landmark_derived')
    a.captures[0].poseValidation!.nativeProfile={status:'measured',geometryModelVersion:'point-formula-v1'}
    b.captures[0].poseValidation!.nativeProfile={status:'measured',geometryModelVersion:'point-formula-v2'}
    expect(compareSessions(a,b,'profile').reasons).toContain(COMPARISON_REASONS.reading_source)
  })
  it('applies provenance checks to shared extended metrics as well',()=>{
    const {a,b}=pair('profile'),extended={...a.report.profile[0],code:'PROFILE-ANGLE-09'} as ConsumerReading
    a.report.extended=[{...extended,evidence:evidence('profile')}];b.report.extended=[extended]
    expect(compareReadings(a,b,'profile').find(r=>r.code==='PROFILE-ANGLE-09')?.difference).toContain('不计算差值')
  })
})
