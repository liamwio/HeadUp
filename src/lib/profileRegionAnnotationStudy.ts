export const PROFILE_REGION_ANNOTATION_POLICY='HEADUP-PROFILE-REGION-MANUAL-1.1' as const
export const PROFILE_REGION_INTER_RATER_POLICY='HEADUP-PROFILE-REGION-INTER-RATER-1.0' as const

export const profileRegionAnnotationDefinitions={
  forehead:{label:'额部—鼻根线',pathCode:'forehead_aesthetic_line',pointCount:6,instruction:'端点之间按可见皮肤弧长近似等分；不要沿头发外缘。',pointLabels:['可见额部软组织最上端（不是发丝）','额部皮肤弧长20%','额部皮肤弧长40%','额部皮肤弧长60%','额部皮肤弧长80%','鼻根最深可见转折点']},
  nasalDorsum:{label:'鼻背线',pathCode:'nasal_dorsum_line',pointCount:3,instruction:'三点均落在真实皮肤外轮廓。',pointLabels:['鼻根最深可见转折点','鼻根至鼻尖皮肤弧长50%','鼻尖最前点']},
  maxillarySupport:{label:'鼻基底—上唇支撑线',pathCode:'maxillary_support_line',pointCount:7,instruction:'端点之间沿可见上唇皮肤弧近似六等分；不推断上颌骨边界。',pointLabels:['鼻下点/鼻基底与上唇连接点','弧长1/6','弧长2/6','弧长3/6','弧长4/6','弧长5/6','上唇最前点']},
  mandibularChin:{label:'下颌—颏部线',pathCode:'mandibular_aesthetic_line',pointCount:7,instruction:'端点之间沿可见下颌—下颏皮肤弧近似六等分；不要沿脖颈。',pointLabels:['耳下可见下颌缘后端（被头发遮挡则标不可见）','弧长1/6','弧长2/6','弧长3/6','弧长4/6','弧长5/6','软组织颏前点']},
}as const

export type ProfileRegionName=keyof typeof profileRegionAnnotationDefinitions
export type NormalizedAnnotationPoint={x:number;y:number}
export type ProfileRegionAnnotation={status:'annotated'|'occluded'|'not_reviewed';points:NormalizedAnnotationPoint[];note?:string}
export type ProfileRegionAnnotationCase={reviewId:string;width:number;height:number;regions:Record<ProfileRegionName,ProfileRegionAnnotation>}
export type ProfileRegionAnnotationExport={policyVersion:typeof PROFILE_REGION_ANNOTATION_POLICY;createdAt:string;session:'A'|'B'|'C';annotatorHash:string;blindToModel:true;cases:ProfileRegionAnnotationCase[]}
export type ProfileRegionPredictionCase={reviewId:string;visibleProfileHeightRatio:number;regions:Partial<Record<ProfileRegionName,NormalizedAnnotationPoint[]>>}
export const PROFILE_REGION_MODEL_EVALUATION_POLICY='HEADUP-PROFILE-REGION-MODEL-VS-MANUAL-1.0' as const
export const PROFILE_REGION_CANONICAL_POLICY='HEADUP-PROFILE-REGION-CANONICAL-1.0' as const
export type ProfileRegionCanonicalCase={reviewId:string;width:number;height:number;regions:Record<ProfileRegionName,ProfileRegionAnnotation&{method:'ab_mean_within_threshold'|'ab_both_occluded'|'c_adjudication'|'unresolved'}>}
export type ProfileRegionCanonicalExport={policyVersion:typeof PROFILE_REGION_CANONICAL_POLICY;createdAt:string;sourceSessions:['A','B','C'];cases:ProfileRegionCanonicalCase[];summary:{resolved:number;unresolved:number;abConsensus:number;cAdjudicated:number}}

const names=Object.keys(profileRegionAnnotationDefinitions)as ProfileRegionName[]
export function resolveProfileRegionAnnotationStart(reviewIds:readonly string[],search:string):{caseIndex:number;region:ProfileRegionName;session:'A'|'B'|'C'}{
  const params=new URLSearchParams(search),requestedCase=params.get('case'),requestedRegion=params.get('region'),requestedSession=params.get('session')
  const caseIndex=Math.max(0,requestedCase?reviewIds.indexOf(requestedCase):-1)
  const region=names.includes(requestedRegion as ProfileRegionName)?requestedRegion as ProfileRegionName:'forehead'
  const session=requestedSession==='B'||requestedSession==='C'?requestedSession:'A'
  return{caseIndex,region,session}
}
const finitePoint=(point:NormalizedAnnotationPoint)=>Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1

function cross(a:NormalizedAnnotationPoint,b:NormalizedAnnotationPoint,c:NormalizedAnnotationPoint){return(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)}
function segmentsIntersect(a:NormalizedAnnotationPoint,b:NormalizedAnnotationPoint,c:NormalizedAnnotationPoint,d:NormalizedAnnotationPoint){const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);return abC*abD<0&&cdA*cdB<0}
export function profileRegionAnnotationGeometryIssues(name:ProfileRegionName,region:ProfileRegionAnnotation):{errors:string[];warnings:string[]}{
  if(region.status!=='annotated')return{errors:[],warnings:[]}
  const errors:string[]=[],warnings:string[]=[],points=region.points,segments=points.slice(1).map((point,index)=>Math.hypot(point.x-points[index].x,point.y-points[index].y)),length=segments.reduce((sum,value)=>sum+value,0)
  if(length<.005)errors.push('曲线总长度过短')
  if(segments.some(value=>value<.0005))errors.push('存在重复或几乎重合的相邻点')
  for(let left=0;left<points.length-1;left++)for(let right=left+2;right<points.length-1;right++)if(segmentsIntersect(points[left],points[left+1],points[right],points[right+1]))errors.push('曲线存在自交')
  const start=points[0],end=points.at(-1)
  if(start&&end&&name==='forehead'&&end.y<=start.y)errors.push('额部点序应从上方额部走向下方鼻根')
  if(start&&end&&name==='nasalDorsum'&&end.x<=start.x)errors.push('右侧面鼻背点序应从鼻根走向画面右侧鼻尖')
  if(start&&end&&name==='mandibularChin'&&end.x<=start.x)errors.push('右侧面下颌点序应从耳下后端走向画面右侧颏前点')
  if(segments.length){const mean=length/segments.length,variance=segments.reduce((sum,value)=>sum+(value-mean)**2,0)/segments.length,cv=Math.sqrt(variance)/Math.max(mean,1e-8);if(cv>.75)warnings.push(`相邻分段弧长差异较大（CV ${cv.toFixed(2)}）`)}
  return{errors:[...new Set(errors)],warnings:[...new Set(warnings)]}
}

export function emptyProfileRegionAnnotations():Record<ProfileRegionName,ProfileRegionAnnotation>{
  return Object.fromEntries(names.map(name=>[name,{status:'not_reviewed',points:[]}]))as unknown as Record<ProfileRegionName,ProfileRegionAnnotation>
}

export function validateProfileRegionAnnotationExport(value:unknown):string[]{
  const errors:string[]=[]
  if(!value||typeof value!=='object')return['export must be an object']
  const output=value as Partial<ProfileRegionAnnotationExport>
  if(output.policyVersion!==PROFILE_REGION_ANNOTATION_POLICY)errors.push('unexpected policyVersion')
  if(output.session!=='A'&&output.session!=='B'&&output.session!=='C')errors.push('session must be A, B or C')
  if(typeof output.annotatorHash!=='string'||!/^[a-f0-9]{64}$/.test(output.annotatorHash))errors.push('annotatorHash must be a SHA-256 hex string')
  if(output.blindToModel!==true)errors.push('blindToModel must be true')
  if(!Array.isArray(output.cases)||output.cases.length===0)return[...errors,'cases must be non-empty']
  const ids=new Set<string>()
  output.cases.forEach((item,index)=>{
    if(!item?.reviewId||ids.has(item.reviewId))errors.push(`case ${index} has missing or duplicate reviewId`);else ids.add(item.reviewId)
    if(!Number.isFinite(item?.width)||!Number.isFinite(item?.height)||item.width<=0||item.height<=0)errors.push(`case ${index} has invalid dimensions`)
    for(const name of names){
      const region=item?.regions?.[name]
      if(!region){errors.push(`case ${index} missing ${name}`);continue}
      if(!['annotated','occluded','not_reviewed'].includes(region.status))errors.push(`case ${index} ${name} invalid status`)
      const expected=profileRegionAnnotationDefinitions[name].pointCount
      if(region.status==='annotated'&&region.points.length!==expected)errors.push(`case ${index} ${name} requires ${expected} points`)
      if(region.status!=='annotated'&&region.points.length!==0)errors.push(`case ${index} ${name} must have no points unless annotated`)
      if(!region.points.every(finitePoint))errors.push(`case ${index} ${name} has invalid point`)
      for(const issue of profileRegionAnnotationGeometryIssues(name,region).errors)errors.push(`case ${index} ${name}: ${issue}`)
    }
  })
  return errors
}

export function profileRegionAnnotationCoverage(output:{cases:ProfileRegionAnnotationCase[]}){
  const total=output.cases.length*names.length
  const annotated=output.cases.flatMap(item=>names.map(name=>item.regions[name])).filter(item=>item.status==='annotated').length
  const occluded=output.cases.flatMap(item=>names.map(name=>item.regions[name])).filter(item=>item.status==='occluded').length
  return{cases:output.cases.length,total,annotated,occluded,notReviewed:total-annotated-occluded,complete:annotated+occluded===total}
}

export function firstIncompleteProfileRegionCell(output:{cases:ProfileRegionAnnotationCase[]}):{caseIndex:number;region:ProfileRegionName}|null{
  for(const[caseIndex,item]of output.cases.entries())for(const region of names)if(item.regions[region].status==='not_reviewed')return{caseIndex,region}
  return null
}

export function nextIncompleteProfileRegionCell(output:{cases:ProfileRegionAnnotationCase[]},currentCaseIndex:number,currentRegion:ProfileRegionName):{caseIndex:number;region:ProfileRegionName}|null{
  const cells=output.cases.flatMap((item,caseIndex)=>names.map(region=>({caseIndex,region,status:item.regions[region].status})))
  const currentFlatIndex=currentCaseIndex*names.length+Math.max(0,names.indexOf(currentRegion))
  const ordered=[...cells.slice(currentFlatIndex+1),...cells.slice(0,currentFlatIndex+1)]
  const pending=ordered.find(cell=>cell.status==='not_reviewed')
  return pending?{caseIndex:pending.caseIndex,region:pending.region}:null
}

export function normalizedPolylineRms(manual:readonly NormalizedAnnotationPoint[],prediction:readonly NormalizedAnnotationPoint[]):number|null{
  if(manual.length===0||manual.length!==prediction.length||!manual.every(finitePoint)||!prediction.every(finitePoint))return null
  return Math.sqrt(manual.reduce((sum,point,index)=>sum+(point.x-prediction[index].x)**2+(point.y-prediction[index].y)**2,0)/manual.length)
}

export function resampleNormalizedPolyline(points:readonly NormalizedAnnotationPoint[],count:number):NormalizedAnnotationPoint[]|null{
  if(points.length<2||count<2||!points.every(finitePoint))return null
  const lengths=[0];for(let index=1;index<points.length;index++)lengths.push(lengths[index-1]+Math.hypot(points[index].x-points[index-1].x,points[index].y-points[index-1].y))
  const total=lengths.at(-1)!;if(total<=1e-8)return null
  return Array.from({length:count},(_,sample)=>{const target=total*sample/(count-1);let segment=1;while(segment<lengths.length-1&&lengths[segment]<target)segment++;const start=points[segment-1],end=points[segment],span=Math.max(lengths[segment]-lengths[segment-1],1e-8),alpha=(target-lengths[segment-1])/span;return{x:start.x+(end.x-start.x)*alpha,y:start.y+(end.y-start.y)*alpha}})
}

function distribution(values:number[]){
  const sorted=[...values].sort((left,right)=>left-right),at=(quantile:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*quantile)-1))]:null
  return{count:sorted.length,min:sorted[0]??null,median:at(.5),p95:at(.95),max:sorted.at(-1)??null}
}

export function validateProfileRegionCanonicalExport(value:unknown):string[]{
  if(!value||typeof value!=='object')return['canonical export must be an object']
  const output=value as Partial<ProfileRegionCanonicalExport>,errors:string[]=[]
  if(output.policyVersion!==PROFILE_REGION_CANONICAL_POLICY)errors.push('unexpected canonical policyVersion')
  if(!Array.isArray(output.cases)||output.cases.length===0)return[...errors,'canonical cases must be non-empty']
  for(const[index,item]of output.cases.entries())for(const name of names){const region=item.regions?.[name],expected=profileRegionAnnotationDefinitions[name].pointCount;if(!region){errors.push(`canonical case ${index} missing ${name}`);continue}if(region.status==='annotated'&&region.points.length!==expected)errors.push(`canonical case ${index} ${name} requires ${expected} points`);if(region.status!=='annotated'&&region.points.length!==0)errors.push(`canonical case ${index} ${name} must have no points unless annotated`);if(!region.points.every(finitePoint))errors.push(`canonical case ${index} ${name} has invalid point`);for(const issue of profileRegionAnnotationGeometryIssues(name,region).errors)errors.push(`canonical case ${index} ${name}: ${issue}`)}
  return errors
}

export function evaluateProfileRegionModelError(manual:ProfileRegionAnnotationExport|ProfileRegionCanonicalExport,predictions:readonly ProfileRegionPredictionCase[]){
  const predictionById=new Map(predictions.map(item=>[item.reviewId,item]))
  const perRegion=Object.fromEntries(names.map(name=>{
    const values:number[]=[];let annotated=0,missingPrediction=0
    for(const item of manual.cases){
      const region=item.regions[name]
      if(region.status!=='annotated')continue
      annotated++
      const prediction=predictionById.get(item.reviewId),points=prediction?.regions[name]
      const manualCurve=resampleNormalizedPolyline(region.points,64),predictionCurve=points?resampleNormalizedPolyline(points,64):null,raw=manualCurve&&predictionCurve?normalizedPolylineRms(manualCurve,predictionCurve):null
      if(raw===null||!prediction||!Number.isFinite(prediction.visibleProfileHeightRatio)||prediction.visibleProfileHeightRatio<=0){missingPrediction++;continue}
      values.push(raw/prediction.visibleProfileHeightRatio)
    }
    const rms=distribution(values),p95Pass=rms.p95!==null&&rms.p95<=.05
    return[name,{annotated,evaluated:values.length,missingPrediction,rmsVisibleProfileHeight:rms,engineeringGate:{minimumEvaluated:6,p95Maximum:.05,pass:values.length>=6&&p95Pass},confirmationGate:{minimumEvaluated:24,p95Maximum:.05,pass:values.length>=24&&p95Pass}}]
  }))as Record<ProfileRegionName,{annotated:number;evaluated:number;missingPrediction:number;rmsVisibleProfileHeight:ReturnType<typeof distribution>;engineeringGate:{minimumEvaluated:number;p95Maximum:number;pass:boolean};confirmationGate:{minimumEvaluated:number;p95Maximum:number;pass:boolean}}>
  return{policyVersion:PROFILE_REGION_MODEL_EVALUATION_POLICY,manualPolicyVersion:manual.policyVersion,manualSession:'session'in manual?manual.session:'canonical',createdAt:new Date().toISOString(),coverage:profileRegionAnnotationCoverage(manual),perRegion,gates:{allRegionsAtLeast6Engineering:Object.values(perRegion).every(item=>item.evaluated>=6),allRegionsAtLeast24Confirmation:Object.values(perRegion).every(item=>item.evaluated>=24),allRegionsP95AtMost5Percent:Object.values(perRegion).every(item=>item.rmsVisibleProfileHeight.p95!==null&&item.rmsVisibleProfileHeight.p95<=.05)},retention:{individualCoordinatesIncluded:false,reviewIdsIncluded:false,imagesIncluded:false}}
}

export function compareProfileRegionAnnotationSessions(left:ProfileRegionAnnotationExport,right:ProfileRegionAnnotationExport){
  const errors=[...validateProfileRegionAnnotationExport(left),...validateProfileRegionAnnotationExport(right)]
  if(errors.length)throw new Error(errors.join('；'))
  if(new Set([left.session,right.session]).size!==2||![left.session,right.session].every(session=>session==='A'||session==='B'))throw new Error('comparison requires one A session and one B session')
  if(left.annotatorHash===right.annotatorHash)throw new Error('A/B files must use different annotators')
  const rightById=new Map(right.cases.map(item=>[item.reviewId,item])),adjudication=new Map<string,ProfileRegionName[]>(),statusMismatches:{reviewId:string;region:ProfileRegionName}[]=[]
  const perRegion=Object.fromEntries(names.map(name=>{
    const values:number[]=[];let comparable=0
    for(const item of left.cases){
      const other=rightById.get(item.reviewId);if(!other)continue
      const a=item.regions[name],b=other.regions[name]
      if(a.status!==b.status){statusMismatches.push({reviewId:item.reviewId,region:name});continue}
      if(a.status!=='annotated')continue
      comparable++;const leftCurve=resampleNormalizedPolyline(a.points,64),rightCurve=resampleNormalizedPolyline(b.points,64),rms=leftCurve&&rightCurve?normalizedPolylineRms(leftCurve,rightCurve):null;if(rms===null)continue;values.push(rms)
      if(rms>.02){const regions=adjudication.get(item.reviewId)??[];regions.push(name);adjudication.set(item.reviewId,regions)}
    }
    const rms=distribution(values)
    return[name,{comparable,rmsNormalizedImage:rms,predeclaredAdjudicationThreshold:.02,aboveThreshold:values.filter(value=>value>.02).length}]
  }))as Record<ProfileRegionName,{comparable:number;rmsNormalizedImage:ReturnType<typeof distribution>;predeclaredAdjudicationThreshold:number;aboveThreshold:number}>
  for(const mismatch of statusMismatches){const regions=adjudication.get(mismatch.reviewId)??[];if(!regions.includes(mismatch.region))regions.push(mismatch.region);adjudication.set(mismatch.reviewId,regions)}
  return{policyVersion:PROFILE_REGION_INTER_RATER_POLICY,createdAt:new Date().toISOString(),sessions:[left.session,right.session].sort(),casesA:left.cases.length,casesB:right.cases.length,perRegion,statusMismatchCount:statusMismatches.length,adjudicationCases:[...adjudication].map(([reviewId,regions])=>({reviewId,regions})),gates:{sameCaseCoverage:left.cases.length===right.cases.length&&left.cases.every(item=>rightById.has(item.reviewId)),differentAnnotators:left.annotatorHash!==right.annotatorHash,allRegionsAtLeast6ComparableEngineering:Object.values(perRegion).every(item=>item.comparable>=6),allRegionsAtLeast24ComparableConfirmation:Object.values(perRegion).every(item=>item.comparable>=24)},retention:{coordinatesIncluded:false,imagesIncluded:false,reviewIdsIncludedOnlyForAdjudication:true}}
}

function meanPoints(left:readonly NormalizedAnnotationPoint[],right:readonly NormalizedAnnotationPoint[],count:number){const a=resampleNormalizedPolyline(left,count),b=resampleNormalizedPolyline(right,count);if(!a||!b)return[];return a.map((point,index)=>({x:(point.x+b[index].x)/2,y:(point.y+b[index].y)/2}))}

export function canonicalizeProfileRegionAnnotations(a:ProfileRegionAnnotationExport,b:ProfileRegionAnnotationExport,c:ProfileRegionAnnotationExport):ProfileRegionCanonicalExport{
  const errors=[...validateProfileRegionAnnotationExport(a),...validateProfileRegionAnnotationExport(b),...validateProfileRegionAnnotationExport(c)]
  if(errors.length)throw new Error(errors.join('；'))
  const bySession=new Map([a,b,c].map(item=>[item.session,item]));if(!bySession.has('A')||!bySession.has('B')||!bySession.has('C'))throw new Error('canonicalization requires A, B and C sessions')
  if(new Set([a.annotatorHash,b.annotatorHash,c.annotatorHash]).size!==3)throw new Error('A, B and C must use different annotators')
  const A=bySession.get('A')!,B=bySession.get('B')!,C=bySession.get('C')!,bById=new Map(B.cases.map(item=>[item.reviewId,item])),cById=new Map(C.cases.map(item=>[item.reviewId,item]))
  let resolved=0,unresolved=0,abConsensus=0,cAdjudicated=0
  const cases:ProfileRegionCanonicalCase[]=A.cases.map(item=>{
    const other=bById.get(item.reviewId),third=cById.get(item.reviewId)
    const regions=Object.fromEntries(names.map(name=>{
      const left=item.regions[name],right=other?.regions[name],adjudication=third?.regions[name]
      if(right&&left.status==='annotated'&&right.status==='annotated'){
        const aCurve=resampleNormalizedPolyline(left.points,64),bCurve=resampleNormalizedPolyline(right.points,64),rms=aCurve&&bCurve?normalizedPolylineRms(aCurve,bCurve):null
        if(rms!==null&&rms<=.02){resolved++;abConsensus++;return[name,{status:'annotated',points:meanPoints(left.points,right.points,profileRegionAnnotationDefinitions[name].pointCount),method:'ab_mean_within_threshold' as const}]}
      }
      if(right&&left.status==='occluded'&&right.status==='occluded'){resolved++;abConsensus++;return[name,{status:'occluded',points:[],method:'ab_both_occluded' as const}]}
      if(adjudication&&(adjudication.status==='annotated'||adjudication.status==='occluded')){resolved++;cAdjudicated++;return[name,{status:adjudication.status,points:adjudication.points.map(point=>({...point})),note:adjudication.note,method:'c_adjudication' as const}]}
      unresolved++;return[name,{status:'not_reviewed',points:[],note:'C adjudication required',method:'unresolved' as const}]
    }))as Record<ProfileRegionName,ProfileRegionAnnotation&{method:'ab_mean_within_threshold'|'ab_both_occluded'|'c_adjudication'|'unresolved'}>
    return{reviewId:item.reviewId,width:item.width,height:item.height,regions}
  })
  return{policyVersion:PROFILE_REGION_CANONICAL_POLICY,createdAt:new Date().toISOString(),sourceSessions:['A','B','C'],cases,summary:{resolved,unresolved,abConsensus,cAdjudicated}}
}
