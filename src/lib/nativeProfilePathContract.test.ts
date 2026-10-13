import{describe,expect,it}from'vitest'
import type{NativeProfileResult}from'../types'
import{buildNativeProfilePresentation,buildProfileRenderablePaths,profileRepeatabilityBandTotalWidth,profileSemanticPathD}from'./nativeProfilePresentation'

const result:NativeProfileResult={
  status:'measured',
  neckEdge:{version:'HEADUP-NECK-EDGE-2.0',status:'traced',points:[{x:.15,y:.2},{x:.12,y:.25},{x:.13,y:.3}],angleDegrees:12,edgeSupport:1,reason:'图像边缘自动追踪'},
  landmarks:Array.from({length:39},(_,index)=>({x:index/100,y:index/200,z:0})),
  pointConfidence:Array(39).fill(.9),
  geometry:{softTissueConvexityAngleDegrees:168,eLineUpperLipDistanceFaceHeightRatio:-.02,eLineLowerLipDistanceFaceHeightRatio:.01,nasolabialAngleDegrees:102,mentolabialAngleDegrees:125,softTissueChinProjectionFaceHeightRatio:.04,mandibularPlaneInclinationDegrees:25,cervicomentalAngleDegrees:null,verticalMidfaceShare:.48,verticalLowerFaceShare:.52},
  measuredMetricCount:7,
}

describe('native profile path semantics',()=>{
  it('ignores rejected cached jaw refinement and restores the original jaw without changing neck or metrics',()=>{
    const before=buildNativeProfilePresentation(result,1000,1000)!
    const jawRefinement={version:'HEADUP-JAW-IMAGE-REFINEMENT-1.0' as const,status:'refined' as const,points:Array.from({length:65},(_,i)=>({x:.04+i*.001,y:.02+i*.0004})),supportedFraction:.9,maxDisplacementPixels:3,reason:'图像细化'}
    const after=buildNativeProfilePresentation({...result,jawRefinement},1000,1000)!
    expect(after.paths.find(p=>p.code==='mandibular_aesthetic_line')).toEqual(before.paths.find(p=>p.code==='mandibular_aesthetic_line'))
    expect(after.paths.find(p=>p.code==='mandibular_aesthetic_line')!.points).toHaveLength(7)
    expect(after.regionReadings).toEqual(before.regionReadings)
    expect(after.paths.find(p=>p.code==='neck_aesthetic_line')).toEqual(before.paths.find(p=>p.code==='neck_aesthetic_line'))
    expect(after.readings.map(r=>r.value)).toEqual(before.readings.map(r=>r.value))
    expect(after.points).toEqual(before.points)
  })
  it('keeps mandibular points separate and displays only image-derived neck data',()=>{
    const output=buildNativeProfilePresentation(result,1000,1000)!
    const jaw=output.paths.find(path=>path.code==='lower_mandibular_border')!
    const productJaw=output.paths.find(path=>path.code==='mandibular_aesthetic_line')!
    expect(jaw.points.map(point=>point.x)).toEqual([40,50,60,70,80])
    expect(productJaw.label).toBe('可见下颌—颏部')
    expect(output.paths.find(path=>path.code==='neck_aesthetic_line')).toMatchObject({label:'图像边缘自动追踪',category:'region',provisional:false})
    expect(output.readings.find(item=>item.label==='颈颏角')).toMatchObject({availability:'unavailable',value:'不可用'})
    expect(output.readings.find(item=>item.code==='PROFILE-ANGLE-09')).toMatchObject({availability:'measured',reliability:'experimental'})
    expect(output.paths.filter(path=>path.category==='region').map(path=>path.repeatabilityP95VisibleProfileHeightRatio)).toEqual(Array(6).fill(undefined))
    expect(profileRepeatabilityBandTotalWidth(.0376,700)).toBeCloseTo(52.64,10)
    const regions=output.paths.filter(path=>path.category==='region')
    expect(buildProfileRenderablePaths(regions,700,true).filter(path=>path.category==='repeatability-band')).toHaveLength(0)
    expect(buildProfileRenderablePaths(regions,700,false)).toHaveLength(6)
  })

  it('does not regenerate template data for saved reports or weak edges',()=>{
    for(const neckEdge of [undefined,{...result.neckEdge!,status:'weak' as const,angleDegrees:null}]){
      const output=buildNativeProfilePresentation({...result,neckEdge},1000,700)!
      expect(output.readings.find(r=>r.code==='PROFILE-ANGLE-09')?.availability).toBe('unavailable')
      expect(output.regionReadings.some(r=>r.code==='PROFILE-REGION-NECK')).toBe(false)
      if(!neckEdge)expect(output.paths.some(p=>p.code==='neck_aesthetic_line')).toBe(false)
      else expect(output.paths.some(p=>p.code==='neck_aesthetic_line')).toBe(false)
    }
  })

  it('calculates the displayed angle from the displayed non-square pixel geometry',()=>{
    const a=buildNativeProfilePresentation(result,1000,700)!, b=buildNativeProfilePresentation(result,700,1000)!
    const value=(o:typeof a)=>o.readings.find(r=>r.code==='PROFILE-ANGLE-09')!.value
    expect(value(a)).not.toBe(value(b))
    expect(value(a)).not.toBe('12.00°') // do not trust a stale cached angle
    expect(a.readings.find(r=>r.code==='PROFILE-ANGLE-09')!.errors).toEqual([])
  })

  it('does not substitute the full chin-to-neck chord for the front-neck direction',()=>{
    const extended={...result,neckEdge:{...result.neckEdge!,points:[{x:.25,y:.15},...result.neckEdge!.points],directionPoints:result.neckEdge!.points}}
    const reading=(r:NativeProfileResult)=>buildNativeProfilePresentation(r,1000,700)!.readings.find(p=>p.code==='PROFILE-ANGLE-09')!.value
    expect(reading(extended)).toBe(reading(result))
  })

  it('does not expose the legacy cross-feature contour or unsupported forehead measurement',()=>{
    const output=buildNativeProfilePresentation(result,1000,1000)!
    expect(output.paths.some(path=>['visible_soft_tissue_contour','forehead_aesthetic_line','maxillary_support_line'].includes(path.code))).toBe(false)
    expect(output.regionReadings.some(r=>r.code==='PROFILE-REGION-FOREHEAD')).toBe(false)
    expect(output.paths.find(p=>p.code==='upper_lip_contour')!.points.map(p=>p.x)).toEqual([270,280,290,300])
  })

  it('builds a smooth semantic curve that passes through every landmark without segment overshoot',()=>{
    const points=[{x:0,y:0},{x:10,y:20},{x:30,y:10},{x:40,y:30}]
    const path=profileSemanticPathD(points)
    expect(path).toMatch(/^M 0 0 C /)
    expect(path).toContain(' 10 20 C ')
    expect(path).toContain(' 30 10 C ')
    expect(path).toMatch(/ 40 30$/)
    const numbers=path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    expect(numbers.every(Number.isFinite)).toBe(true)
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...numbers)).toBeLessThanOrEqual(40)
  })
})
