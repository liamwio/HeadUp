import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReportPageV2 } from '../ReportPageV2'
import type { Capture, NativeProfileResult } from '../types'
import { computeProfileGeometry } from './profileGeometry'
import { buildNativeProfilePresentation, buildVisibleProfileTendency } from './nativeProfilePresentation'
import { buildConsumerReport } from './consumerReport'
import { evaluateMeasurementAgainstPhotoReference, evaluateResearchPhotoReference } from './photoReferenceEvaluation'

function profile():NativeProfileResult {
  const points=Array.from({length:39},(_,i)=>({x:i*.01,y:i*.02,z:0}))
  for(const [i,x,y] of [[4,-3,8],[5,-2,9],[6,-1,10],[7,0,11],[8,1,12],[10,2.5,10],[11,1.5,9],[14,0,0],[17,0,2],[19,3,4],[20,2,5],[21,1,6],[27,2,7],[33,2.2,8]])points[i]={x,y,z:0}
  const computed=computeProfileGeometry({landmarks:points,orientation:'right'})
  if(computed.status!=='measured')throw new Error('invalid fixture')
  return {status:'measured',orientation:'right',landmarks:points,geometry:computed.geometry,landmarkDerivedGeometry:computed.geometry,geometrySource:'landmark_derived'}
}

describe('correctness release boundaries',()=>{
  it('does not turn opposite-side chin positions into a convexity direction',()=>{
    const a=profile(),b=profile(),s=a.landmarks![17],t=a.landmarks![21],q=a.landmarks![10]
    const dx=t.x-s.x,dy=t.y-s.y,u=((q.x-s.x)*dx+(q.y-s.y)*dy)/(dx*dx+dy*dy)
    b.landmarks![10]={x:2*(s.x+u*dx)-q.x,y:2*(s.y+u*dy)-q.y,z:0}
    const r=computeProfileGeometry({landmarks:b.landmarks!,orientation:'right'})
    expect(r.status).toBe('measured');if(r.status!=='measured')return
    b.geometry=r.geometry
    expect(a.geometry!.softTissueConvexityAngleDegrees).toBeCloseTo(b.geometry!.softTissueConvexityAngleDegrees,8)
    expect(a.geometry!.softTissueChinProjectionFaceHeightRatio*b.geometry!.softTissueChinProjectionFaceHeightRatio).toBeLessThan(0)
    for(const result of [a,b]) {
      expect(buildVisibleProfileTendency(result)).toBeNull()
      const output=buildNativeProfilePresentation(result,1,1)!
      expect(output.aestheticReferences).toEqual([])
      expect(output.readings[0]).toMatchObject({label:'侧面三点内角',reliability:'experimental'})
      expect(output.readings[0].interpretation).toContain('不能据此判定凸凹')
    }
  })

  it('withholds head-axis inclination even when a model produces a finite value',()=>{
    const source=profile(),original=structuredClone(source)
    const output=buildNativeProfilePresentation(source,1,1)!
    expect(output.readings.find(r=>r.code==='PROFILE-ANGLE-06')).toMatchObject({availability:'unavailable',errors:[],value:'待头位验证'})
    expect(output.regionReadings.find(r=>r.code==='PROFILE-REGION-MANDIBLE')?.value).toBe('待头位验证')
    expect(source).toEqual(original)
  })

  it('does not promote legacy bands to product references when uncertainty is absent or tiny',()=>{
    for(const value of ['0.5','1.23','2.0']) {
      const reading={code:'FRONT-RATIO-01',label:'脸长宽比',value,score:0,note:'',group:'比例' as const,errors:[]}
      expect(evaluateResearchPhotoReference(reading)).not.toBeNull()
      expect(evaluateMeasurementAgainstPhotoReference(reading)).toBeNull()
    }
  })

  it.each(['left_profile','right_profile'] as const)('keeps %s product reports free of unsupported conclusions and labels their direction',estimatedPose=>{
    const source=profile()
    const captures:Capture[]=[{id:'profile',label:'侧面',eyebrow:'',hint:'',url:'blob:fixture',poseValidation:{status:'pass',estimatedPose,detectedFaces:1,flags:[],nativeProfile:source,landmarkImageWidth:1,landmarkImageHeight:1}}]
    for(const isExample of [false,true]) {
      const report=buildConsumerReport(captures,isExample)
      expect(report.front.some(r=>r.code==='FRONT-SYM-01')).toBe(false)
      expect(report.frontTendency).toBeNull()
      if(!isExample)expect(report.profileDetection.facts).toContain(`识别视角：${estimatedPose==='left_profile'?'左':'右'}侧面`)
      expect(report.summaries[0].value).not.toMatch(/椭圆|心形|菱形|方形|圆形|长形/)
      const html=renderToStaticMarkup(<ReportPageV2 captures={captures} isExample={isExample} mode="adult" onStart={()=>{}} onRetake={()=>{}} onPrivacy={()=>{}} />)
      expect(html).not.toMatch(/读数低于参考|读数高于参考|较凸的|凸面外观倾向|对称偏差|类别示意/)
      expect(html).toContain('侧面三点内角')
    }
  })
})
