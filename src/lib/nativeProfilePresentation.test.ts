import{describe,expect,it}from'vitest'
import type{NativeProfileResult}from'../types'
// These fixtures verify the frozen legacy research calculations. Product output
// restrictions are tested separately in measurementValidity.test.tsx.
import{buildResearchNativeProfilePresentation as buildNativeProfilePresentation,buildProfileRegionLabelAnchors,buildResearchProfileTendency as buildVisibleProfileTendency,nativeProfileReadingGrade,orderNativeProfileReadings,profileGeometryDisagreementReviewMetrics,profileGeometryDisagreementReviewPathCodes,profileGeometryReviewComparisons,referenceBandState,summarizeNativeProfileReadingConfidence,summarizeNativeProfileRegionPrimary}from'./nativeProfilePresentation'
import{profileMeasurementContract}from'./profileLandmarkContract'

const result:NativeProfileResult={
  status:'measured',
  neckEdge:{version:'HEADUP-NECK-EDGE-2.0',status:'traced',points:[{x:.15,y:.2},{x:.12,y:.25},{x:.13,y:.3}],angleDegrees:12,edgeSupport:1,reason:'图像边缘自动追踪 · 误差待独立校准'},
  landmarks:Array.from({length:39},(_,index)=>({x:index/50,y:index/60,z:0})),
  pointConfidence:Array(39).fill(.9),
  geometry:{softTissueConvexityAngleDegrees:168,eLineUpperLipDistanceFaceHeightRatio:-.02,eLineLowerLipDistanceFaceHeightRatio:.01,nasolabialAngleDegrees:102,mentolabialAngleDegrees:125,softTissueChinProjectionFaceHeightRatio:.04,mandibularPlaneInclinationDegrees:25,cervicomentalAngleDegrees:null,verticalMidfaceShare:.48,verticalLowerFaceShare:.52},
  measuredMetricCount:7,
  geometrySource:'direct_geometry_head',
  landmarkDerivedGeometry:{softTissueConvexityAngleDegrees:166,eLineUpperLipDistanceFaceHeightRatio:-.01,eLineLowerLipDistanceFaceHeightRatio:.02,nasolabialAngleDegrees:100,mentolabialAngleDegrees:122,softTissueChinProjectionFaceHeightRatio:.03,mandibularPlaneInclinationDegrees:28,cervicomentalAngleDegrees:null,verticalMidfaceShare:.47,verticalLowerFaceShare:.53},
  geometryDisagreement:{softTissueConvexityAngleDegrees:2,eLinePercentagePoints:1,nasolabialAngleDegrees:2,mentolabialAngleDegrees:3,chinProjectionPercentagePoints:1,mandibularInclinationDegrees:3,verticalPercentagePoints:1},
}

describe('native profile presentation',()=>{
  it('maps 39 points into structured error evidence without ambiguous units',()=>{
    const output=buildNativeProfilePresentation(result,1000,1200)!
    expect(output.points).toHaveLength(39)
    expect(output).toMatchObject({geometrySource:'direct_geometry_head',regionGeometrySource:'landmark_derived',geometryDisagreement:{mandibularInclinationDegrees:3}})
    expect(output.geometryDisagreementReviewMetrics).toEqual([])
    expect(output.paths).toHaveLength(14)
    expect(output.paths.filter(item=>item.category==='region').map(item=>item.code)).toEqual(['forehead_aesthetic_line','nasal_dorsum_line','maxillary_support_line','mandibular_aesthetic_line','neck_aesthetic_line'])
    expect(output.regionReadings).toHaveLength(5)
    expect(output.regionReadings.map(item=>item.pathCode)).toEqual(['forehead_aesthetic_line','nasal_dorsum_line','maxillary_support_line','mandibular_aesthetic_line','neck_aesthetic_line'])
    const labelAnchors=buildProfileRegionLabelAnchors(output.paths,output.regionReadings)
    expect(labelAnchors.map(item=>item.pathCode)).toEqual(output.regionReadings.map(item=>item.pathCode))
    expect(labelAnchors.map(item=>item.anchor)).toEqual(output.paths.filter(item=>item.category==='region').map(item=>item.points[Math.floor((item.points.length-1)/2)]))
    const primaryLabels=output.regionReadings.map(summarizeNativeProfileRegionPrimary)
    expect(primaryLabels[0].display).toContain('± 13.10°')
    expect(primaryLabels[1].display).toContain('± 1.48 个百分点')
    expect(primaryLabels[2].display).toContain('上唇E-Line -1.00% ± 5.46 个百分点')
    expect(primaryLabels[3].display).toContain('下颌缘 28.0° ± 11.70°')
    expect(primaryLabels[4].display).toContain('夹角')
    expect(primaryLabels[2].gradeLabel).toBe('仅参考')
    expect(primaryLabels[3].gradeLabel).toBe('仅参考')
    expect(primaryLabels.map(item=>item.gradeLabel).every(Boolean)).toBe(true)
    expect(output.regionReadings[0].errors[0]).toMatchObject({kind:'absolute',unit:'degrees',value:13.1,use:'conservative_radius'})
    expect(output.regionReadings.slice(0,4).map(item=>item.errors.at(-1))).toEqual([
      expect.objectContaining({measure:'repeatability',unit:'visible_profile_height_percent',value:3.76,use:'descriptive_repeatability'}),
      expect.objectContaining({measure:'repeatability',unit:'visible_profile_height_percent',value:4.14,use:'descriptive_repeatability'}),
      expect.objectContaining({measure:'repeatability',unit:'visible_profile_height_percent',value:3.2,use:'descriptive_repeatability'}),
      expect.objectContaining({measure:'repeatability',unit:'visible_profile_height_percent',value:3.06,use:'descriptive_repeatability'}),
    ])
    expect(output.regionReadings.slice(0,4).every(item=>item.validationNote?.includes('不是人工描线真值'))).toBe(true)
    expect(output.regionReadings[4].validationNote).toContain('不沿用旧模板P95')
    expect(output.aestheticReferences).toHaveLength(4)
    expect(output.aestheticReferences[0]).toMatchObject({code:'PROFILE-AESTHETIC-CONVEXITY',label:'软组织面凸角参考',status:'indeterminate'})
    expect(output.aestheticReferences[0].interpretation).toContain('鼻尖19不参与')
    expect(output.aestheticReferences[1]).toMatchObject({label:'E-Line侧貌参考',status:'indeterminate'})
    expect(output.aestheticReferences[1].basis).toContain('The Face Report未公开')
    expect(output.aestheticReferences[1].result).toContain('线倾斜')
    expect(output.aestheticReferences[2]).toMatchObject({label:'可见下颌角参考',status:'unavailable'})
    expect(output.aestheticReferences[2].basis).toContain('禁止移植')
    expect(output.aestheticReferences[3]).toMatchObject({label:'颏部与下颌线衔接',status:'indeterminate'})
    expect(output.aestheticReferences.some(r=>r.code==='PROFILE-AESTHETIC-JAW-NECK')).toBe(false)
    expect(output.auxiliaryReadings).toHaveLength(7)
    expect(output.auxiliaryReadings.map(item=>item.code)).toEqual(['PROFILE-AUX-01','PROFILE-AUX-02','PROFILE-AUX-03','PROFILE-AUX-04','PROFILE-AUX-05','PROFILE-AUX-06','PROFILE-AUX-07'])
    expect(output.auxiliaryReadings[6]).toMatchObject({label:'额部—鼻尖—颏前点折线角'})
    expect(output.auxiliaryReadings[6].interpretation).toContain('不套用165°–175°带')
    expect(output.regionReadings[0].value).toContain('转折')
    expect(output.regionReadings[1].value).toContain('鼻背偏离')
    expect(output.regionReadings[2].interpretation).toContain('上唇')
    expect(output.regionReadings[3]).toMatchObject({label:'下颌下缘与颏部（非颈部）'})
    expect(output.regionReadings[3].interpretation).toContain('不得沿脖颈')
    expect(output.regionReadings.slice(0,4).every(item=>item.interpretation.includes('无法区分'))).toBe(true)
    expect(output.regionReadings[4].interpretation).toContain('当前图像边缘')
    expect(output.readings.filter(item=>item.availability==='measured')).toHaveLength(8)
    expect(output.readings.map(item=>item.formula)).toEqual([
      profileMeasurementContract.softTissueConvexityAngle.formula,
      profileMeasurementContract.eLine.formula,
      profileMeasurementContract.nasolabialAngle.formula,
      profileMeasurementContract.mentolabialAngle.formula,
      profileMeasurementContract.softTissueChinProjection.formula,
      profileMeasurementContract.mandibularPlaneInclinationProxy.formula,
      profileMeasurementContract.profileVerticalProportion.formula,
      profileMeasurementContract.cervicomentalAngle.formula,
      'acute angle(pixel endpoint direction points4–10, image-traced neck endpoint direction)',
    ])
    expect(output.readings[0].errors[0]).toMatchObject({kind:'absolute',unit:'degrees',value:16.3})
    expect(output.readings.find(item=>item.code==='PROFILE-ANGLE-08')).toMatchObject({label:'颈颏角',availability:'unavailable',value:'不可用'})
    expect(output.readings.find(item=>item.code==='PROFILE-ANGLE-09')).toMatchObject({label:'下颌线—颈线照片夹角',availability:'measured',reliability:'experimental'})
    expect(summarizeNativeProfileReadingConfidence(output.readings)).toEqual({comparable:0,recordable:3,referenceOnly:5,unavailable:1,measured:8,total:9})
    expect(Object.fromEntries(output.readings.map(reading=>[reading.code,nativeProfileReadingGrade(reading)]))).toEqual({'PROFILE-ANGLE-01':'recordable','PROFILE-LINE-02':'reference_only','PROFILE-ANGLE-03':'reference_only','PROFILE-ANGLE-04':'recordable','PROFILE-RATIO-05':'reference_only','PROFILE-ANGLE-06':'reference_only','PROFILE-RATIO-07':'recordable','PROFILE-ANGLE-08':'unavailable','PROFILE-ANGLE-09':'reference_only'})
    expect(orderNativeProfileReadings(output.readings).map(reading=>reading.code)).toEqual(['PROFILE-ANGLE-01','PROFILE-ANGLE-04','PROFILE-RATIO-07','PROFILE-LINE-02','PROFILE-ANGLE-03','PROFILE-RATIO-05','PROFILE-ANGLE-06','PROFILE-ANGLE-09','PROFILE-ANGLE-08'])
  })

  it('withdraws side-profile direction when the uncertainty interval crosses bands',()=>{
    const tendency=buildVisibleProfileTendency(result)!
    expect(tendency.shortLabel).toBe('侧貌方向无法区分')
    expect(tendency.evidence[0]).toEqual({label:'面凸角',value:'168.00° ± 18.07°'})
    expect(tendency.confidenceLabel).toContain('误差区间跨越方向带')
    expect(tendency.description).toContain('本张照片无法区分')
  })

  it('uses the native convexity formula for the 165–175 band and keeps the literal nose-tip angle separate',()=>{
    const output=buildNativeProfilePresentation(result,1000,1000)!
    expect(output.aestheticReferences[0].result).toContain('168.0°')
    expect(output.aestheticReferences[0].result).toContain('无法区分')
    expect(output.aestheticReferences[0].errors[0]).toMatchObject({value:16.3,unit:'degrees'})
    expect(output.aestheticReferences[0].errors[1]).toMatchObject({value:7.8,unit:'degrees',use:'conservative_radius'})
    expect(output.auxiliaryReadings[6].formula).toBe('angle(point14, vertex19, point10)')
  })

  it('distinguishes an interval fully inside a reference band from a boundary overlap',()=>{
    expect(referenceBandState(170,4,165,175)).toBe('within')
    expect(referenceBandState(170,6,165,175)).toBe('overlap')
    expect(referenceBandState(150,5,165,175)).toBe('below')
    expect(referenceBandState(190,5,165,175)).toBe('above')
    const eLineWithin={...result,geometry:{...result.geometry!,eLineUpperLipDistanceFaceHeightRatio:-.015,eLineLowerLipDistanceFaceHeightRatio:-.01}}
    const output=buildNativeProfilePresentation(eLineWithin,1000,1000)!
    expect(output.aestheticReferences[1]).toMatchObject({status:'within'})
    expect(output.aestheticReferences[1].result).toContain('完整误差区间均落入')
  })

  it('keeps a direction only when the full uncertainty interval clears the neutral band',()=>{
    const clear={...result,geometry:{...result.geometry!,softTissueConvexityAngleDegrees:140,softTissueChinProjectionFaceHeightRatio:.25,verticalLowerFaceShare:.7}}
    const tendency=buildVisibleProfileTendency(clear)!
    expect(tendency.shortLabel).toBe('凸面外观倾向')
    expect(tendency.description).toContain('颏部前向支撑较明显')
    expect(tendency.description).toContain('下面部可见高度偏长')
  })

  it('flags only same-image model-layer disagreements that exceed the current RSS',()=>{
    const review=profileGeometryDisagreementReviewMetrics({softTissueConvexityAngleDegrees:10,eLinePercentagePoints:5,nasolabialAngleDegrees:2,mentolabialAngleDegrees:3,chinProjectionPercentagePoints:4,mandibularInclinationDegrees:11,verticalPercentagePoints:2})
    expect(review.map(item=>item.label)).toEqual(['E-Line','下颌缘'])
    expect(review[0]).toMatchObject({value:5})
    expect(review[0].maximum).toBeCloseTo(4.6487,3)
    expect(profileGeometryDisagreementReviewPathCodes(review)).toEqual(['maxillary_support_line','mandibular_aesthetic_line'])
    const comparisons=profileGeometryReviewComparisons(result.geometry!,result.landmarkDerivedGeometry!,review)
    expect(comparisons[0]).toMatchObject({label:'E-Line',pathCodes:['maxillary_support_line'],coreValue:-2,overlayValue:-1,difference:5,unit:'pp'})
    expect(comparisons[0].maximum).toBeCloseTo(4.6487,3)
    expect(comparisons[1]).toMatchObject({label:'下颌缘',pathCodes:['mandibular_aesthetic_line'],coreValue:25,overlayValue:28,difference:11,unit:'°'})
    expect(comparisons[1].maximum).toBeCloseTo(10.235,3)
  })
})
