import {describe,expect,it} from 'vitest'
import type {LandmarkPoint} from '../types'
import type {ConsumerReading} from './consumerReport'
import {measureFrontLandmarks} from './faceMeasurements'
import {buildNativeProfilePresentation} from './nativeProfilePresentation'
import {computeProfileGeometry} from './profileGeometry'
import {auditReadingEvidence} from './measurementEvidenceAudit'

function front(){
  const p=Array.from({length:478},()=>({x:.5,y:.5,z:0}))
  for(const [i,x,y]of [[10,.5,.1],[168,.5,.3],[6,.5,.36],[1,.5,.45],[2,.5,.6],[152,.5,.9],[234,.1,.5],[454,.9,.5],[172,.2,.78],[397,.8,.78],[61,.35,.7],[291,.65,.7],[33,.2,.39],[133,.35,.4],[362,.65,.4],[263,.8,.38],[98,.43,.55],[327,.57,.55],[37,.47,.67],[84,.47,.73],[0,.5,.69],[17,.5,.71],[267,.53,.66],[314,.53,.74]])p[i]={x,y,z:0}
  for(let i=468;i<478;i++)p[i]={x:i<473?.3:.7,y:.4,z:0}
  return p
}
function frontReadings(width=1200,height=800,points:LandmarkPoint[]=front()):ConsumerReading[]{return measureFrontLandmarks(points,90,width,height).filter(r=>r.code!=='FRONT-SYM-01').map(r=>({...r,view:'front',available:true,origin:'measurement'}))}
function profile(width:number,height:number,orientation:'left'|'right'){
  const points=Array.from({length:39},()=>({x:.55,y:.5,z:0}))
  for(const [i,x,y]of [[14,.4,.2],[17,.65,.35],[19,.8,.42],[20,.73,.46],[21,.65,.5],[27,.69,.55],[33,.7,.62],[11,.64,.68],[10,.72,.76],[8,.58,.82],[4,.3,.64],[5,.36,.71],[6,.45,.78],[7,.51,.81],[9,.66,.79]])points[i]={x:orientation==='left'?1-x:x,y,z:0}
  const result=computeProfileGeometry({landmarks:points.map(p=>({x:p.x*width,y:p.y*height})),orientation,headAxisAngleDegrees:orientation==='left'?-8:8,imageWidth:width,imageHeight:height})
  if(result.status!=='measured')throw Error('invalid fixture')
  const g=result.geometry,values:Record<string,string>={
    'PROFILE-ANGLE-01':g.softTissueConvexityAngleDegrees.toFixed(2)+'°','PROFILE-ANGLE-03':g.nasolabialAngleDegrees.toFixed(2)+'°','PROFILE-ANGLE-04':g.mentolabialAngleDegrees.toFixed(2)+'°',
    'PROFILE-LINE-02':`上唇 ${(g.eLineUpperLipDistanceFaceHeightRatio*100).toFixed(2)}% · 下唇 ${(g.eLineLowerLipDistanceFaceHeightRatio*100).toFixed(2)}%`,
    'PROFILE-RATIO-05':(g.softTissueChinProjectionFaceHeightRatio*100).toFixed(2)+'%',
    'PROFILE-RATIO-07':`中面 ${(g.verticalMidfaceShare*100).toFixed(2)}% · 下面 ${(g.verticalLowerFaceShare*100).toFixed(2)}%`,
  }
  return Object.entries(values).map(([code,value]):ConsumerReading=>({code,value,label:code,note:'',score:0,group:'侧貌',view:'profile',available:true,origin:'measurement',evidence:result.evidence[code]}))
}

describe('independent saved point-line numerical audit',()=>{
  it.each([[1200,800],[800,1200]])('reconstructs all 10 front ratios and eye angle in %i×%i pixels',(w,h)=>{
    const readings=frontReadings(w,h);expect(readings).toHaveLength(11)
    for(const reading of readings)expect(auditReadingEvidence(reading),reading.code).toMatchObject({status:'pass'})
  })
  it('uses the displayed fitted axis on a tilted face',()=>{
    const theta=7*Math.PI/180,points=front().map(p=>({...p,x:.5+(p.x-.5)*Math.cos(theta)-(p.y-.5)*Math.sin(theta),y:.5+(p.x-.5)*Math.sin(theta)+(p.y-.5)*Math.cos(theta)}))
    expect(auditReadingEvidence(frontReadings(1000,1000,points).find(r=>r.code==='FRONT-ANGLE-01')!).status).toBe('pass')
  })
  it.each([[1200,800,'left'],[800,1200,'left'],[1200,800,'right'],[800,1200,'right']] as const)('reconstructs side angles, signed distances and vertical ratios at %i×%i %s',(w,h,orientation)=>{
    for(const reading of profile(w,h,orientation))expect(auditReadingEvidence(reading,orientation),reading.code).toMatchObject({status:'pass'})
  })
  it('detects changed line endpoints without consulting the original model',()=>{
    const original=frontReadings()[0],changed=structuredClone(original)
    expect(auditReadingEvidence(original).status).toBe('pass')
    const segment=changed.evidence!.segments.find(s=>s.id==='numerator')!
    changed.evidence!.points.find(p=>p.id===segment.to)!.y-=40
    const audited=auditReadingEvidence(changed)
    expect(audited.status).toBe('fail');expect(audited.maxDifference).toBeGreaterThan(.001)
    expect(auditReadingEvidence(original).status).toBe('pass')
  })
  it('honors the provided side for signed distances and does not guess it',()=>{
    const line=profile(1200,800,'left').find(r=>r.code==='PROFILE-LINE-02')!
    expect(auditReadingEvidence(line,'left').status).toBe('pass')
    expect(auditReadingEvidence(line,'right').status).toBe('fail')
    expect(auditReadingEvidence(line)).toMatchObject({status:'not_applicable',reason:'signed_distance_requires_orientation'})
  })
  it('rejects a displaced projection even if its displayed value is unchanged',()=>{
    const line=profile(1200,800,'right').find(r=>r.code==='PROFILE-LINE-02')!
    line.evidence!.points.find(p=>p.id==='upper-foot')!.y+=15
    expect(auditReadingEvidence(line,'right')).toMatchObject({status:'fail',reason:'inconsistent_perpendicular_projection'})
  })
  it('accepts display rounding but rejects a one-unit change in the last displayed decimal',()=>{
    for(const code of ['FRONT-RATIO-01','FRONT-RATIO-02','FRONT-ANGLE-01']){
      const r=frontReadings().find(r=>r.code===code)!,initial=auditReadingEvidence(r)
      expect(initial.status).toBe('pass');expect(initial.maxDifference).toBeLessThanOrEqual(code==='FRONT-RATIO-01'?.0005:.005)
      const precision=code==='FRONT-RATIO-01'?3:2,suffix=r.value.endsWith('%')?'%':r.value.endsWith('°')?'°':''
      r.value=(Number.parseFloat(r.value)+10**-precision).toFixed(precision)+suffix
      expect(auditReadingEvidence(r).status).toBe('fail')
    }
  })
  it('reports unavailable, missing or unsupported proofs honestly',()=>{
    const r=frontReadings()[0]
    expect(auditReadingEvidence({...r,available:false}).status).toBe('not_applicable')
    expect(auditReadingEvidence({...r,evidence:undefined}).status).toBe('not_applicable')
    expect(auditReadingEvidence({...r,code:'PROFILE-AUX-99'}).reason).toBe('unsupported_metric')
    const missing=structuredClone(r);missing.evidence!.segments=[]
    expect(auditReadingEvidence(missing).status).toBe('not_applicable')
  })
  it('fails nonfinite points, broken references and mismatched evidence source',()=>{
    const r=frontReadings()[0],nan=structuredClone(r),broken=structuredClone(r)
    nan.evidence!.points[0].x=NaN;broken.evidence!.segments[0].to='absent'
    expect(auditReadingEvidence(nan).status).toBe('fail');expect(auditReadingEvidence(broken).status).toBe('fail')
    r.evidence!.source='saved_profile_landmarks';expect(auditReadingEvidence(r).status).toBe('fail')
  })
})

it.each(['left','right'] as const)('recomputes all seven auxiliary side readings at their real display precision (%s)',orientation=>{
 const points=Array.from({length:39},()=>({x:.55,y:.5,z:0}))
 for(const [i,x,y] of [[14,.4,.2],[17,.65,.35],[19,.8,.42],[20,.73,.46],[21,.65,.5],[27,.69,.55],[33,.7,.62],[11,.64,.68],[10,.72,.76],[8,.58,.82],[4,.3,.64],[5,.36,.71],[6,.45,.78],[7,.51,.81],[9,.66,.79]])points[i]={x:orientation==='left'?1-x:x,y,z:0}
 const g=computeProfileGeometry({landmarks:points.map(p=>({x:p.x*1200,y:p.y*800})),orientation})
 if(g.status!=='measured')throw Error('fixture')
 const o=buildNativeProfilePresentation({status:'measured',orientation,landmarks:points,geometry:g.geometry,geometrySource:'landmark_derived'},1200,800)!
 for(const r of o.auxiliaryReadings){const reading:ConsumerReading={code:r.code,label:r.label,value:r.value,note:'',score:0,group:'侧貌',view:'profile',origin:'experimental',available:true,evidence:r.evidence};expect(auditReadingEvidence(reading,orientation),r.code).toMatchObject({status:'pass'})}
 const r=o.auxiliaryReadings.find(r=>r.code==='PROFILE-AUX-03')!,evidence=structuredClone(r.evidence!)
 evidence.points.find(p=>p.id==='nose-foot')!.x+=10
 expect(auditReadingEvidence({code:r.code,label:r.label,value:r.value,note:'',score:0,group:'侧貌',view:'profile',origin:'experimental',available:true,evidence},orientation).status).toBe('fail')
})
