import {it,expect} from 'vitest'
import {computeProfileGeometry} from './profileGeometry'
import {buildNativeProfilePresentation} from './nativeProfilePresentation'
import {buildConsumerReport} from './consumerReport'
import {parseReportRecord,serializeReportRecord} from './reportRecord'
import type {NativeProfileResult} from '../types'
import type {MeasurementEvidence} from './measurementEvidence'
function sample(){
 const points=Array.from({length:39},()=>({x:.55,y:.5,z:0}))
 for(const [i,x,y] of [[14,.4,.2],[17,.65,.35],[19,.8,.42],[20,.73,.46],[21,.65,.5],[27,.69,.55],[33,.7,.62],[11,.64,.68],[10,.72,.76],[8,.58,.82],[4,.3,.64],[5,.36,.71],[6,.45,.78],[7,.51,.81],[9,.66,.79]])points[i]={x,y,z:0}
 return points
}
const length=(e:MeasurementEvidence,id:string)=>{const s=e.segments.find(s=>s.id===id)!,a=e.points.find(p=>p.id===s.from)!,b=e.points.find(p=>p.id===s.to)!;return Math.hypot(a.x-b.x,a.y-b.y)}
it.each([[1000,800],[800,1200]])('reconstructs profile ratios from drawn lines on %i×%i images',(width,height)=>{
 const points=sample(),r=computeProfileGeometry({landmarks:points.map(p=>({x:p.x*width,y:p.y*height})),orientation:'right',headAxisAngleDegrees:8,imageWidth:width,imageHeight:height})
 expect(r.status).toBe('measured');if(r.status!=='measured')return
 const e=r.evidence['PROFILE-RATIO-07'],lip=r.evidence['PROFILE-LINE-02']
 expect(length(e,'mid')/length(e,'total')).toBeCloseTo(r.geometry.verticalMidfaceShare,12)
 expect(length(e,'lower')/length(e,'total')).toBeCloseTo(r.geometry.verticalLowerFaceShare,12)
 expect(length(lip,'upper')/length(lip,'height')).toBeCloseTo(Math.abs(r.geometry.eLineUpperLipDistanceFaceHeightRatio),12)
 expect(length(lip,'lower')/length(lip,'height')).toBeCloseTo(Math.abs(r.geometry.eLineLowerLipDistanceFaceHeightRatio),12)
})
it('product point source never substitutes cached neural-head values and preserves evidence in exports',()=>{
 const landmarks=sample(),computed=computeProfileGeometry({landmarks:landmarks.map(p=>({x:p.x*1000,y:p.y*800})),orientation:'right'})
 if(computed.status!=='measured')throw Error('fixture')
 const source:NativeProfileResult={status:'measured',orientation:'right',landmarks,geometry:{...computed.geometry,softTissueConvexityAngleDegrees:1},geometrySource:'landmark_derived',modelVersion:'test',headAxisAngleDegrees:0}
 const report=buildNativeProfilePresentation(source,1000,800)!,angle=report.readings.find(r=>r.code==='PROFILE-ANGLE-01')!
 expect(Number.parseFloat(angle.value)).toBeCloseTo(computed.geometry.softTissueConvexityAngleDegrees,2);expect(angle.evidence).toBeDefined();expect(angle.errors).toEqual([])
 const captures=[{id:'profile' as const,label:'侧面',hint:'',eyebrow:'',url:'blob:fixture',poseValidation:{status:'pass' as const,estimatedPose:'right_profile' as const,detectedFaces:1,flags:[],nativeProfile:source,landmarkImageWidth:1000,landmarkImageHeight:800}}]
 const current=buildConsumerReport(captures),saved=parseReportRecord(serializeReportRecord(current,'youth'))
 expect(saved.measurements.find(r=>r.code==='PROFILE-ANGLE-01')?.evidence).toEqual(angle.evidence)
 expect(current.profile.filter(r=>r.available).every(r=>r.evidence)).toBe(true)
 expect(current.extended.filter(r=>r.available).every(r=>r.evidence)).toBe(true)
 const auxiliary=current.extended.find(r=>r.code==='PROFILE-AUX-02')!
 expect(Number.parseFloat(auxiliary.value)/100).toBeCloseTo(length(auxiliary.evidence!,'nose-length')/length(auxiliary.evidence!,'height'),4)
})
