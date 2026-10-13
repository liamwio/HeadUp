import{describe,expect,it}from'vitest'
import{PROFILE_REGION_ANNOTATION_POLICY,canonicalizeProfileRegionAnnotations,compareProfileRegionAnnotationSessions,emptyProfileRegionAnnotations,evaluateProfileRegionModelError,firstIncompleteProfileRegionCell,nextIncompleteProfileRegionCell,normalizedPolylineRms,profileRegionAnnotationCoverage,profileRegionAnnotationGeometryIssues,resampleNormalizedPolyline,resolveProfileRegionAnnotationStart,validateProfileRegionAnnotationExport}from'./profileRegionAnnotationStudy'

const hashA='a'.repeat(64),hashB='b'.repeat(64)
const validPoints=(name:'forehead'|'nasalDorsum'|'maxillarySupport'|'mandibularChin',shift=0)=>Array.from({length:name==='forehead'?6:name==='nasalDorsum'?3:7},(_,index)=>({x:.4+shift+(name==='forehead'?0:index*.01),y:.35+(name==='forehead'?index*.01:0)}))

describe('profile region manual annotation contract',()=>{
  it('opens a requested blind case and region without requiring model metadata',()=>{
    const ids=['PROFILE-REGION-01','PROFILE-REGION-02','PROFILE-REGION-03']
    expect(resolveProfileRegionAnnotationStart(ids,'?case=PROFILE-REGION-02&region=mandibularChin&session=B')).toEqual({caseIndex:1,region:'mandibularChin',session:'B'})
    expect(resolveProfileRegionAnnotationStart(ids,'?case=UNKNOWN&region=modelPrediction&session=MODEL')).toEqual({caseIndex:0,region:'forehead',session:'A'})
  })
  it('requires every annotated region to contain its frozen point count',()=>{
    const regions=emptyProfileRegionAnnotations()
    regions.nasalDorsum={status:'annotated',points:[{x:.2,y:.3}]}
    const output={policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session:'A' as const,annotatorHash:hashA,blindToModel:true as const,cases:[{reviewId:'R1',width:1000,height:1000,regions}]}
    expect(validateProfileRegionAnnotationExport(output)).toContain('case 0 nasalDorsum requires 3 points')
  })

  it('counts annotated, occluded and pending cells without treating occlusion as coordinates',()=>{
    const regions=emptyProfileRegionAnnotations()
    regions.forehead={status:'occluded',points:[],note:'hair'}
    const output={policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session:'A' as const,annotatorHash:hashA,blindToModel:true as const,cases:[{reviewId:'R1',width:1000,height:1000,regions}]}
    expect(profileRegionAnnotationCoverage(output)).toEqual({cases:1,total:4,annotated:0,occluded:1,notReviewed:3,complete:false})
    expect(firstIncompleteProfileRegionCell(output)).toEqual({caseIndex:0,region:'nasalDorsum'})
    expect(validateProfileRegionAnnotationExport(output)).toEqual([])
  })

  it('advances to the next pending region and wraps without skipping cases',()=>{
    const first=emptyProfileRegionAnnotations(),second=emptyProfileRegionAnnotations()
    first.forehead={status:'annotated',points:validPoints('forehead')};first.nasalDorsum={status:'occluded',points:[]};first.maxillarySupport={status:'annotated',points:validPoints('maxillarySupport')}
    const output={cases:[{reviewId:'R1',width:1000,height:1000,regions:first},{reviewId:'R2',width:1000,height:1000,regions:second}]}
    expect(nextIncompleteProfileRegionCell(output,0,'maxillarySupport')).toEqual({caseIndex:0,region:'mandibularChin'})
    first.mandibularChin={status:'occluded',points:[]}
    expect(nextIncompleteProfileRegionCell(output,0,'mandibularChin')).toEqual({caseIndex:1,region:'forehead'})
    for(const name of Object.keys(second)as Array<keyof typeof second>)second[name]={status:'occluded',points:[]}
    expect(nextIncompleteProfileRegionCell(output,1,'mandibularChin')).toBeNull()
  })

  it('computes pointwise normalized polyline RMS',()=>{
    expect(normalizedPolylineRms([{x:0,y:0},{x:1,y:1}],[{x:.1,y:0},{x:.9,y:1}])).toBeCloseTo(.1,10)
    expect(normalizedPolylineRms([{x:0,y:0}],[{x:0,y:0},{x:1,y:1}])).toBeNull()
  })

  it('resamples curves by arc length before comparison',()=>{
    expect(resampleNormalizedPolyline([{x:0,y:0},{x:.2,y:0},{x:1,y:0}],3)).toEqual([{x:0,y:0},{x:.5,y:0},{x:1,y:0}])
  })

  it('rejects manual sessions that were not blind to the model',()=>{
    const regions=emptyProfileRegionAnnotations(),output={policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session:'A' as const,annotatorHash:hashA,blindToModel:false as const,cases:[{reviewId:'R1',width:1000,height:1000,regions}]}
    expect(validateProfileRegionAnnotationExport(output)).toContain('blindToModel must be true')
  })

  it('blocks reversed/self-intersecting curves and warns about uneven spacing',()=>{
    expect(profileRegionAnnotationGeometryIssues('nasalDorsum',{status:'annotated',points:[{x:.5,y:.4},{x:.45,y:.4},{x:.4,y:.4}]}).errors).toContain('右侧面鼻背点序应从鼻根走向画面右侧鼻尖')
    expect(profileRegionAnnotationGeometryIssues('maxillarySupport',{status:'annotated',points:[{x:.2,y:.2},{x:.8,y:.8},{x:.2,y:.8},{x:.8,y:.2},{x:.82,y:.21},{x:.84,y:.22},{x:.86,y:.23}]}).errors).toContain('曲线存在自交')
    expect(profileRegionAnnotationGeometryIssues('forehead',{status:'annotated',points:[{x:.4,y:.3},{x:.4,y:.301},{x:.4,y:.302},{x:.4,y:.303},{x:.4,y:.304},{x:.4,y:.5}]}).warnings[0]).toContain('弧长差异较大')
    const regions=emptyProfileRegionAnnotations();regions.nasalDorsum={status:'annotated',points:[{x:.5,y:.4},{x:.45,y:.4},{x:.4,y:.4}]};const output={policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session:'A' as const,annotatorHash:hashA,blindToModel:true as const,cases:[{reviewId:'R1',width:1000,height:1000,regions}]}
    expect(validateProfileRegionAnnotationExport(output).some(error=>error.includes('鼻背点序'))).toBe(true)
  })

  it('aggregates model-to-manual RMS by visible profile height without retaining identities',()=>{
    const cases=Array.from({length:6},(_,index)=>{const regions=emptyProfileRegionAnnotations();for(const name of Object.keys(regions)as Array<keyof typeof regions>)regions[name]={status:'annotated',points:validPoints(name)};return{reviewId:`R${index}`,width:1000,height:1000,regions}})
    const manual={policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session:'A' as const,annotatorHash:hashA,blindToModel:true as const,cases}
    const predictions=cases.map(item=>({reviewId:item.reviewId,visibleProfileHeightRatio:.5,regions:Object.fromEntries(Object.entries(item.regions).map(([name,region])=>[name,region.points.map(point=>({x:point.x+.01,y:point.y}))]))}))
    const result=evaluateProfileRegionModelError(manual,predictions)
    expect(result.perRegion.forehead.rmsVisibleProfileHeight.p95).toBeCloseTo(.02,10)
    expect(result.perRegion.forehead.engineeringGate.pass).toBe(true)
    expect(result.perRegion.forehead.confirmationGate.pass).toBe(false)
    expect(result.gates).toEqual({allRegionsAtLeast6Engineering:true,allRegionsAtLeast24Confirmation:false,allRegionsP95AtMost5Percent:true})
    expect(JSON.stringify(result)).not.toContain('R0')
  })

  it('compares independent A/B sessions and routes >2% disagreements to adjudication',()=>{
    const make=(session:'A'|'B',annotatorHash:string,shift:number)=>{const cases=Array.from({length:6},(_,index)=>{const regions=emptyProfileRegionAnnotations();for(const name of Object.keys(regions)as Array<keyof typeof regions>)regions[name]={status:'annotated',points:validPoints(name,shift)};return{reviewId:`R${index}`,width:1000,height:1000,regions}});return{policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session,annotatorHash,blindToModel:true as const,cases}}
    const result=compareProfileRegionAnnotationSessions(make('A',hashA,0),make('B',hashB,.03))
    expect(result.perRegion.forehead.rmsNormalizedImage.p95).toBeCloseTo(.03,10)
    expect(result.adjudicationCases).toHaveLength(6)
    expect(result.gates).toEqual({sameCaseCoverage:true,differentAnnotators:true,allRegionsAtLeast6ComparableEngineering:true,allRegionsAtLeast24ComparableConfirmation:false})
    expect(result.retention.coordinatesIncluded).toBe(false)
  })

  it('uses A/B mean within threshold and C only for disputed regions',()=>{
    const make=(session:'A'|'B'|'C',annotatorHash:string,foreheadShift:number,nasalShift:number)=>{const regions=emptyProfileRegionAnnotations();for(const name of Object.keys(regions)as Array<keyof typeof regions>){const shift=name==='nasalDorsum'?nasalShift:foreheadShift;regions[name]={status:'annotated',points:validPoints(name,shift)}}return{policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session,annotatorHash,blindToModel:true as const,cases:[{reviewId:'R1',width:1000,height:1000,regions}]}}
    const result=canonicalizeProfileRegionAnnotations(make('A',hashA,0,0),make('B',hashB,.01,.04),make('C','c'.repeat(64),.3,.02))
    expect(result.cases[0].regions.forehead).toMatchObject({method:'ab_mean_within_threshold',status:'annotated'})
    expect(result.cases[0].regions.forehead.points[0].x).toBeCloseTo(.405,10)
    expect(result.cases[0].regions.nasalDorsum).toMatchObject({method:'c_adjudication',status:'annotated'})
    expect(result.cases[0].regions.nasalDorsum.points[0].x).toBeCloseTo(.42,10)
    expect(result.summary).toEqual({resolved:4,unresolved:0,abConsensus:3,cAdjudicated:1})
  })
})
