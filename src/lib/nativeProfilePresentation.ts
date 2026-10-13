import {computeProfileGeometry} from './profileGeometry'
import type {MeasurementEvidence} from './measurementEvidence'
import {resolveProfileDisplayPaths} from './profileDisplayPolicy'
import type { NativeProfileGeometry,NativeProfileGeometryDisagreement,NativeProfileResult } from '../types'
import { PROFILE_JAW_REFINEMENT_ENABLED } from './productFeatures'
import{absoluteP95,evidenceForComponent}from'./errorEvidence'
import type{MetricErrorEvidence}from'./errorEvidence'
import{summarizeMetricValue,twoLevelRssUncertainty}from'./metricUncertainty'
import{profileMeasurementContract}from'./profileLandmarkContract'
import{DIRECT_PROFILE_DISAGREEMENT_LIMITS,DIRECT_PROFILE_UNCERTAINTY,OVERLAY_PROFILE_UNCERTAINTY}from'./profileUncertaintyContract'
import{jawNeckLineAngleDegrees}from'./profileNeckLine'
import { PROFILE_AXIS_PENDING, PROFILE_HEAD_AXIS_VALIDATED, PROFILE_DIRECTION_VALIDATED, PHOTO_REFERENCE_PENDING } from './measurementValidity'

export type NativeProfilePath = { code:string;label:string;category:'contour'|'evidence'|'region';points:Array<{x:number;y:number}>;provisional?:boolean;repeatabilityP95VisibleProfileHeightRatio?:number }
export type ProfileRenderablePath=NativeProfilePath|Omit<NativeProfilePath,'category'|'code'>&{code:string;category:'repeatability-band';repeatabilityBandStrokeWidth:number}
export type NativeProfileReading = { evidence?:MeasurementEvidence; code:string;label:string;value:string;interpretation:string;formula:string;availability:'measured'|'unavailable';reliability:'moderate'|'capture_sensitive'|'experimental'|'unavailable';errors:MetricErrorEvidence[];validationNote?:string }
export type NativeProfileRegionReading = { evidence?:MeasurementEvidence; code:string;pathCode:string;label:string;value:string;interpretation:string;reliability:'moderate'|'capture_sensitive'|'experimental';errors:MetricErrorEvidence[];validationNote?:string }
export type ProfileAestheticReference = { code:string;label:string;reference:string;basis:string;result:string;status:'within'|'outside'|'mixed'|'indeterminate'|'unavailable';interpretation:string;errors:MetricErrorEvidence[];validationNote?:string }
export type NativeProfileAuxiliaryReading = { evidence?:MeasurementEvidence; code:string;label:string;value:string;interpretation:string;formula:string;reliability:'moderate'|'capture_sensitive'|'experimental';errors:MetricErrorEvidence[];validationNote?:string }
export type NativeProfileReadingGrade='comparable'|'recordable'|'reference_only'|'unavailable'
export function nativeProfileReadingGrade(reading:NativeProfileReading):NativeProfileReadingGrade{
  if(reading.availability==='unavailable')return'unavailable'
  return summarizeMetricValue(reading.value,reading.errors,reading.code==='PROFILE-LINE-02'?[5,5]:undefined).grade
}
export function orderNativeProfileReadings(readings:readonly NativeProfileReading[]):NativeProfileReading[]{const rank:Record<NativeProfileReadingGrade,number>={comparable:0,recordable:1,reference_only:2,unavailable:3};return[...readings].sort((left,right)=>rank[nativeProfileReadingGrade(left)]-rank[nativeProfileReadingGrade(right)])}
export function summarizeNativeProfileReadingConfidence(readings:readonly NativeProfileReading[]){
  const counts={comparable:0,recordable:0,referenceOnly:0,unavailable:0}
  for(const reading of readings){const grade=nativeProfileReadingGrade(reading);if(grade==='unavailable')counts.unavailable++;else if(grade==='comparable')counts.comparable++;else if(grade==='recordable')counts.recordable++;else counts.referenceOnly++}
  return{...counts,measured:counts.comparable+counts.recordable+counts.referenceOnly,total:readings.length}
}
export type VisibleProfileTendency = {
  label: string
  shortLabel: string
  description: string
  evidence: Array<{ label: string; value: string }>
  confidenceLabel: string
  disclosure: string
}
const PROFILE_GEOMETRY_DISAGREEMENT_LIMITS:Record<keyof NativeProfileGeometryDisagreement,{label:string;maximum:number}>={
  softTissueConvexityAngleDegrees:{label:'面凸角',maximum:DIRECT_PROFILE_DISAGREEMENT_LIMITS.softTissueConvexityAngleDegrees},eLinePercentagePoints:{label:'E-Line',maximum:DIRECT_PROFILE_DISAGREEMENT_LIMITS.eLinePercentagePoints},nasolabialAngleDegrees:{label:'鼻唇角',maximum:DIRECT_PROFILE_DISAGREEMENT_LIMITS.nasolabialAngleDegrees},mentolabialAngleDegrees:{label:'颏唇沟',maximum:DIRECT_PROFILE_DISAGREEMENT_LIMITS.mentolabialAngleDegrees},chinProjectionPercentagePoints:{label:'颏投影',maximum:DIRECT_PROFILE_DISAGREEMENT_LIMITS.chinProjectionPercentagePoints},mandibularInclinationDegrees:{label:'下颌缘',maximum:DIRECT_PROFILE_DISAGREEMENT_LIMITS.mandibularInclinationDegrees},verticalPercentagePoints:{label:'纵向比例',maximum:DIRECT_PROFILE_DISAGREEMENT_LIMITS.verticalPercentagePoints},
}
export function profileGeometryDisagreementReviewMetrics(disagreement:NativeProfileGeometryDisagreement|undefined){
  if(!disagreement)return[]
  return(Object.keys(PROFILE_GEOMETRY_DISAGREEMENT_LIMITS)as Array<keyof NativeProfileGeometryDisagreement>).flatMap(key=>disagreement[key]>PROFILE_GEOMETRY_DISAGREEMENT_LIMITS[key].maximum?[{key,label:PROFILE_GEOMETRY_DISAGREEMENT_LIMITS[key].label,value:disagreement[key],maximum:PROFILE_GEOMETRY_DISAGREEMENT_LIMITS[key].maximum}]:[])
}
const PROFILE_GEOMETRY_REVIEW_PATHS:Partial<Record<keyof NativeProfileGeometryDisagreement,string[]>>={
  eLinePercentagePoints:['maxillary_support_line'],nasolabialAngleDegrees:['nasal_dorsum_line'],mentolabialAngleDegrees:['mandibular_aesthetic_line'],chinProjectionPercentagePoints:['mandibular_aesthetic_line'],mandibularInclinationDegrees:['mandibular_aesthetic_line'],verticalPercentagePoints:['maxillary_support_line'],
}
export function profileGeometryDisagreementReviewPathCodes(reviewMetrics:ReturnType<typeof profileGeometryDisagreementReviewMetrics>){return[...new Set(reviewMetrics.flatMap(item=>PROFILE_GEOMETRY_REVIEW_PATHS[item.key]??[]))]}
export type ProfileGeometryReviewComparison={key:keyof NativeProfileGeometryDisagreement;label:string;pathCodes:string[];coreValue:number;overlayValue:number;difference:number;maximum:number;unit:'°'|'pp'}
export function profileGeometryReviewComparisons(core:NativeProfileGeometry,overlay:NativeProfileGeometry,reviewMetrics:ReturnType<typeof profileGeometryDisagreementReviewMetrics>):ProfileGeometryReviewComparison[]{
  return reviewMetrics.map(metric=>{
    let coreValue=0,overlayValue=0,unit:'°'|'pp'='°'
    if(metric.key==='softTissueConvexityAngleDegrees'){coreValue=core.softTissueConvexityAngleDegrees;overlayValue=overlay.softTissueConvexityAngleDegrees}
    else if(metric.key==='eLinePercentagePoints'){unit='pp';const upper=Math.abs(core.eLineUpperLipDistanceFaceHeightRatio-overlay.eLineUpperLipDistanceFaceHeightRatio),lower=Math.abs(core.eLineLowerLipDistanceFaceHeightRatio-overlay.eLineLowerLipDistanceFaceHeightRatio),useUpper=upper>=lower;coreValue=(useUpper?core.eLineUpperLipDistanceFaceHeightRatio:core.eLineLowerLipDistanceFaceHeightRatio)*100;overlayValue=(useUpper?overlay.eLineUpperLipDistanceFaceHeightRatio:overlay.eLineLowerLipDistanceFaceHeightRatio)*100}
    else if(metric.key==='nasolabialAngleDegrees'){coreValue=core.nasolabialAngleDegrees;overlayValue=overlay.nasolabialAngleDegrees}
    else if(metric.key==='mentolabialAngleDegrees'){coreValue=core.mentolabialAngleDegrees;overlayValue=overlay.mentolabialAngleDegrees}
    else if(metric.key==='chinProjectionPercentagePoints'){unit='pp';coreValue=core.softTissueChinProjectionFaceHeightRatio*100;overlayValue=overlay.softTissueChinProjectionFaceHeightRatio*100}
    else if(metric.key==='mandibularInclinationDegrees'){coreValue=core.mandibularPlaneInclinationDegrees;overlayValue=overlay.mandibularPlaneInclinationDegrees}
    else{unit='pp';const mid=Math.abs(core.verticalMidfaceShare-overlay.verticalMidfaceShare),lower=Math.abs(core.verticalLowerFaceShare-overlay.verticalLowerFaceShare),useMid=mid>=lower;coreValue=(useMid?core.verticalMidfaceShare:core.verticalLowerFaceShare)*100;overlayValue=(useMid?overlay.verticalMidfaceShare:overlay.verticalLowerFaceShare)*100}
    return{key:metric.key,label:metric.label,pathCodes:PROFILE_GEOMETRY_REVIEW_PATHS[metric.key]??[],coreValue,overlayValue,difference:metric.value,maximum:metric.maximum,unit}
  })
}

// Frozen legacy topology for research comparisons only. Its forehead and
// nose-to-lip labels cross Menpo feature groups; product output replaces these
// through profileDisplayContract/profileDisplayPolicy before rendering.
const pathDefinitions = [
  ['visible_soft_tissue_contour','研究用0–21点序连线（非颈部）',Array.from({length:22},(_,index)=>index),'contour'],
  ['lower_mandibular_border','可见下颌下缘', [4,5,6,7,8], 'contour'],
  ['upper_lip_contour','上唇可见轮廓',[22,23,24,25,26,27],'contour'],
  ['lower_lip_contour','下唇可见轮廓',[28,29,30,31,32,33],'contour'],
  ['convexity_lines','鼻根—鼻下—颏前点',[17,21,10],'evidence'],
  ['eline','鼻尖—颏前点E-Line',[19,10],'evidence'],
  ['nasolabial','鼻小柱—鼻下—上唇',[20,21,27],'evidence'],
  ['mentolabial','下唇—颏唇沟—颏前点',[33,11,10],'evidence'],
  ['vertical_profile','眉弓—鼻下—颏前点—menton',[14,21,10,8],'evidence'],
  ['forehead_aesthetic_line','额部可见软组织轮廓',[12,13,14,15,16,17],'region'],
  ['nasal_dorsum_line','鼻根—鼻背—鼻尖外观线',[17,18,19],'region'],
  ['maxillary_support_line','鼻基底—上唇可见支撑线',[21,22,23,24,25,26,27],'region'],
  ['mandibular_aesthetic_line','耳下可见下颌缘—颏前点（非颈部）',[4,5,6,7,8,9,10],'region'],
] as const
const REGION_PATH_REPEATABILITY_P95:Record<string,number>={forehead_aesthetic_line:.0376,nasal_dorsum_line:.0414,maxillary_support_line:.032,mandibular_aesthetic_line:.0306}
/** Conservative visualization only: radius equals the observed left/right paired-difference P95. It is not a confidence interval. */
export const profileRepeatabilityBandTotalWidth=(pairedDifferenceP95VisibleProfileHeightRatio:number,visibleProfileHeight:number)=>2*pairedDifferenceP95VisibleProfileHeightRatio*visibleProfileHeight
export function buildProfileRenderablePaths(paths:readonly NativeProfilePath[],visibleProfileHeight:number,showRepeatabilityBands:boolean):ProfileRenderablePath[]{return paths.flatMap(path=>showRepeatabilityBands&&path.category==='region'&&path.repeatabilityP95VisibleProfileHeightRatio?[{...path,code:`${path.code}_repeatability_band`,label:`${path.label} · 左右配对差P95保守带（半径=配对差P95；非置信区间）`,category:'repeatability-band' as const,repeatabilityBandStrokeWidth:profileRepeatabilityBandTotalWidth(path.repeatabilityP95VisibleProfileHeightRatio,visibleProfileHeight)},path]:[path])}
export function buildProfileRegionLabelAnchors(paths:readonly NativeProfilePath[],readings:readonly NativeProfileRegionReading[]){
  return readings.flatMap(reading=>{const path=paths.find(item=>item.code===reading.pathCode),anchor=path?.points[Math.floor(((path?.points.length??1)-1)/2)];return anchor?[{...reading,anchor}]:[]})
}
export function summarizeNativeProfileRegionPrimary(reading:NativeProfileRegionReading){
  const primaryValue=reading.value.split('·')[0].trim(),primaryErrors=reading.errors.filter(error=>error.componentIndex===undefined||error.componentIndex===0)
  return{primaryValue,...summarizeMetricValue(primaryValue,primaryErrors)}
}

/**
 * Interpolating cubic path for product semantic contours. Every measured point
 * remains on the curve. Control points are clamped to the current segment box,
 * preventing smoothing from inventing an excursion beyond adjacent landmarks.
 */
export function profileSemanticPathD(points:readonly PixelPoint[]):string{
  if(points.length===0)return''
  if(points.length===1)return`M ${points[0].x} ${points[0].y}`
  const clamp=(value:number,left:number,right:number)=>Math.max(Math.min(left,right),Math.min(Math.max(left,right),value))
  const commands=[`M ${points[0].x} ${points[0].y}`]
  for(let index=0;index<points.length-1;index++){
    const p0=points[Math.max(0,index-1)],p1=points[index],p2=points[index+1],p3=points[Math.min(points.length-1,index+2)]
    const c1={x:clamp(p1.x+(p2.x-p0.x)/6,p1.x,p2.x),y:clamp(p1.y+(p2.y-p0.y)/6,p1.y,p2.y)}
    const c2={x:clamp(p2.x-(p3.x-p1.x)/6,p1.x,p2.x),y:clamp(p2.y-(p3.y-p1.y)/6,p1.y,p2.y)}
    commands.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`)
  }
  return commands.join(' ')
}

const percentage=(value:number)=>`${(value*100).toFixed(2)}%`
const PROFILE_TENDENCY_ERRORS={
  convexity:[absoluteP95('Menpo450','软组织面凸角',DIRECT_PROFILE_UNCERTAINTY.convexityDegrees.manualP95,'degrees'),absoluteP95('London 101组直接几何左右配对','软组织面凸角',DIRECT_PROFILE_UNCERTAINTY.convexityDegrees.pairedDifferenceP95,'degrees','difference')],
  chin:[absoluteP95('Menpo450','颏突出度',DIRECT_PROFILE_UNCERTAINTY.chinProjectionPercentagePoints.manualP95,'percentage_points'),absoluteP95('London 101组直接几何左右配对','颏突出度',DIRECT_PROFILE_UNCERTAINTY.chinProjectionPercentagePoints.pairedDifferenceP95,'percentage_points','difference')],
  lowerVertical:[absoluteP95('Menpo450','下面份额',DIRECT_PROFILE_UNCERTAINTY.verticalLowerFacePercentagePoints.manualP95,'percentage_points'),absoluteP95('London 101组直接几何左右配对','下面份额',DIRECT_PROFILE_UNCERTAINTY.verticalLowerFacePercentagePoints.pairedDifferenceP95,'percentage_points','difference')],
}as const
type IntervalBandState='below'|'above'|'indeterminate'
function intervalBandState(value:number,uncertainty:number,minimum:number,maximum:number):IntervalBandState{
  if(value+uncertainty<minimum)return'below'
  if(value-uncertainty>maximum)return'above'
  return'indeterminate'
}
type ReferenceBandState='below'|'above'|'within'|'overlap'
export function referenceBandState(value:number,uncertainty:number,minimum:number,maximum:number):ReferenceBandState{
  const low=value-uncertainty,high=value+uncertainty
  if(high<minimum)return'below'
  if(low>maximum)return'above'
  if(low>=minimum&&high<=maximum)return'within'
  return'overlap'
}
type PixelPoint={x:number;y:number}
const distance=(left:PixelPoint,right:PixelPoint)=>Math.hypot(left.x-right.x,left.y-right.y)
function angleAt(vertex:PixelPoint,first:PixelPoint,second:PixelPoint){const left={x:first.x-vertex.x,y:first.y-vertex.y},right={x:second.x-vertex.x,y:second.y-vertex.y},denominator=Math.hypot(left.x,left.y)*Math.hypot(right.x,right.y);if(denominator<1e-8)return null;return Math.acos(Math.max(-1,Math.min(1,(left.x*right.x+left.y*right.y)/denominator)))*180/Math.PI}
function pointLineDistance(point:PixelPoint,start:PixelPoint,end:PixelPoint){const length=distance(start,end);return length<1e-8?null:Math.abs((end.y-start.y)*point.x-(end.x-start.x)*point.y+end.x*start.y-end.y*start.x)/length}

// These are presentation bands for a single standardized photograph. They deliberately
// describe visible appearance rather than mapping a photo to a cephalometric class.
export function buildResearchProfileTendency(result:NativeProfileResult|undefined):VisibleProfileTendency|null{
  if(result?.status!=='measured'||!result.geometry)return null
  const geometry=result.geometry
  const convexity=geometry.softTissueConvexityAngleDegrees
  const chin=geometry.softTissueChinProjectionFaceHeightRatio
  const vertical=geometry.verticalLowerFaceShare
  const convexityUncertainty=twoLevelRssUncertainty(convexity,PROFILE_TENDENCY_ERRORS.convexity,'degrees')??PROFILE_TENDENCY_ERRORS.convexity[0].value
  const chinUncertainty=(twoLevelRssUncertainty(chin*100,PROFILE_TENDENCY_ERRORS.chin,'percent')??PROFILE_TENDENCY_ERRORS.chin[0].value)/100
  const verticalUncertainty=(twoLevelRssUncertainty(vertical*100,PROFILE_TENDENCY_ERRORS.lowerVertical,'percent')??PROFILE_TENDENCY_ERRORS.lowerVertical[0].value)/100
  const convexityState=intervalBandState(convexity,convexityUncertainty,165,175)
  const chinState=intervalBandState(chin,chinUncertainty,-.03,.06)
  const verticalState=intervalBandState(vertical,verticalUncertainty,.44,.56)
  const contour=convexityState==='below'?'较凸的可见侧貌轮廓':convexityState==='above'?'较直/偏凹的可见侧貌轮廓':'面凸方向本张照片无法区分'
  const support=chinState==='below'?'颏部前向支撑偏弱':chinState==='above'?'颏部前向支撑较明显':'颏部支撑方向本张照片无法区分'
  const verticalCue=verticalState==='above'?'下面部可见高度偏长':verticalState==='below'?'下面部可见高度偏短':'下面部高度方向本张照片无法区分'
  const shortLabel=convexityState==='below'?'凸面外观倾向':convexityState==='above'?'直/凹面外观倾向':'侧貌方向无法区分'
  return {
    label:`${contour} · ${support}`,
    shortLabel,
    description:`面凸角 ${convexity.toFixed(2)}° ± ${convexityUncertainty.toFixed(2)}°：${contour}；颏部投影 ${percentage(chin)} ± ${(chinUncertainty*100).toFixed(2)} 个百分点：${support}；${verticalCue}。`,
    evidence:[
      {label:'面凸角',value:`${convexity.toFixed(2)}° ± ${convexityUncertainty.toFixed(2)}°`},
      {label:'颏部投影',value:`${percentage(chin)} ± ${(chinUncertainty*100).toFixed(2)}pp`},
      {label:'下面部占比',value:`${percentage(vertical)} ± ${(verticalUncertainty*100).toFixed(2)}pp`},
    ],
    confidenceLabel:convexityState==='indeterminate'||chinState==='indeterminate'?'误差区间跨越方向带 · 本张照片不输出对应方向':'误差区间未跨越方向带 · 仍建议同规范复拍确认',
    disclosure:'这是由标准侧貌照片得出的骨性相关外观倾向，不等同于骨性Ⅰ/Ⅱ/Ⅲ类、颌位诊断或治疗建议。',
  }
}

/** Frozen legacy rendering calculations for research comparison only. */
export function buildResearchNativeProfilePresentation(result:NativeProfileResult|undefined,width:number|undefined,height:number|undefined){
  if(result?.status!=='measured'||!result.landmarks||result.landmarks.length!==39||!result.geometry||!width||!height)return null
  const point=(index:number)=>({x:result.landmarks![index].x*width,y:result.landmarks![index].y*height})
  const paths:NativeProfilePath[]=pathDefinitions.map(([code,label,indices,category])=>({code,label,category,points:indices.map(point)}))
  const refinedJaw=PROFILE_JAW_REFINEMENT_ENABLED?result.jawRefinement:undefined
  if(refinedJaw&&refinedJaw.status!=='missing'&&refinedJaw.points.length>=7){
    const displayJaw=paths.find(p=>p.code==='mandibular_aesthetic_line')!
    displayJaw.points=refinedJaw.points.map(p=>({x:p.x*width,y:p.y*height}))
    displayJaw.label=refinedJaw.reason
  }
  const neck=result.neckEdge
  const neckPixels=neck?.points.map(p=>({x:p.x*width,y:p.y*height}))??[]
  const neckDirectionPixels=(neck?.directionPoints??neck?.points??[]).map(p=>({x:p.x*width,y:p.y*height}))
  const jawNeckAngle=neck?.status==='traced'?jawNeckLineAngleDegrees(result.landmarks.slice(4,11).map(p=>({x:p.x*width,y:p.y*height})),neckDirectionPixels):null
  if(neckPixels.length>=2)paths.push({code:'neck_aesthetic_line',label:neck?.reason??'自动颈线',category:'region',points:neckPixels,provisional:neck?.status!=='traced'})
  const geometry=result.geometry
  const overlayGeometry=result.landmarkDerivedGeometry??geometry
  const faceHeight=Math.max(1,distance(point(14),point(8)))
  for(const path of paths)if(REGION_PATH_REPEATABILITY_P95[path.code]!==undefined&&!(path.code==='mandibular_aesthetic_line'&&refinedJaw&&refinedJaw.status!=='missing'))path.repeatabilityP95VisibleProfileHeightRatio=REGION_PATH_REPEATABILITY_P95[path.code]
  const foreheadTurn=angleAt(point(14),point(12),point(17))
  const nasalDorsumDeviation=pointLineDistance(point(18),point(17),point(19))
  const foreheadState=foreheadTurn===null?null:intervalBandState(foreheadTurn,13.1,145,170)
  const nasalDeviationRatio=nasalDorsumDeviation===null?null:nasalDorsumDeviation/faceHeight
  const nasalState=nasalDeviationRatio===null?null:intervalBandState(nasalDeviationRatio,.0148,.008,.018)
  const nasolabialState=intervalBandState(geometry.nasolabialAngleDegrees,24.2,90,110)
  const upperLipState=intervalBandState(geometry.eLineUpperLipDistanceFaceHeightRatio,.0171,-.02,.02)
  const midfaceState=intervalBandState(geometry.verticalMidfaceShare,.0273,.45,.55)
  const jawState=intervalBandState(geometry.mandibularPlaneInclinationDegrees,5.37,20,30)
  const chinState=intervalBandState(geometry.softTissueChinProjectionFaceHeightRatio,.0553,-.03,.06)
  const overlayNasolabialUncertainty=OVERLAY_PROFILE_UNCERTAINTY.nasolabialDegrees.rss,overlayUpperLipUncertainty=OVERLAY_PROFILE_UNCERTAINTY.upperLipELinePercentagePoints.rss/100,overlayVerticalUncertainty=OVERLAY_PROFILE_UNCERTAINTY.verticalPercentagePoints.rss/100,overlayJawUncertainty=OVERLAY_PROFILE_UNCERTAINTY.mandibularInclinationDegrees.rss,overlayChinUncertainty=OVERLAY_PROFILE_UNCERTAINTY.chinProjectionPercentagePoints.rss/100
  const overlayNasolabialState=intervalBandState(overlayGeometry.nasolabialAngleDegrees,overlayNasolabialUncertainty,90,110)
  const overlayUpperLipState=intervalBandState(overlayGeometry.eLineUpperLipDistanceFaceHeightRatio,overlayUpperLipUncertainty,-.02,.02)
  const overlayMidfaceState=intervalBandState(overlayGeometry.verticalMidfaceShare,overlayVerticalUncertainty,.45,.55)
  const overlayJawState=intervalBandState(overlayGeometry.mandibularPlaneInclinationDegrees,overlayJawUncertainty,20,30)
  const overlayChinState=intervalBandState(overlayGeometry.softTissueChinProjectionFaceHeightRatio,overlayChinUncertainty,-.03,.06)
  const foreheadCue=foreheadState===null?'额部转折不可用':foreheadState==='below'?'额部—鼻根转折较明显':foreheadState==='above'?'额部—鼻根衔接较平直':'额部转折方向本张照片无法区分'
  const nasalCue=nasalState===null?'鼻背曲线不可用':nasalState==='below'?'鼻背外观线较直':nasalState==='above'?'鼻背外观线曲率较明显':'鼻背曲率方向本张照片无法区分'
  const nasolabialCue=nasolabialState==='below'?'鼻唇夹角相对偏收':nasolabialState==='above'?'鼻唇夹角相对偏开':'鼻唇夹角方向本张照片无法区分'
  const upperLipCue=upperLipState==='below'?'上唇位于E-Line相对后方':upperLipState==='above'?'上唇位于E-Line相对前方':'上唇相对E-Line方向本张照片无法区分'
  const midfaceCue=midfaceState==='below'?'中面可见份额相对较短':midfaceState==='above'?'中面可见份额相对较长':'中面高度方向本张照片无法区分'
  const jawCue=jawState==='below'?'下颌下缘外观较平':jawState==='above'?'下颌下缘外观较陡':'下颌缘倾斜方向本张照片无法区分'
  const chinCue=chinState==='below'?'颏部前向支撑偏弱':chinState==='above'?'颏部前向支撑较明显':'颏部支撑方向本张照片无法区分'
  const overlayNasolabialCue=overlayNasolabialState==='below'?'鼻唇夹角相对偏收':overlayNasolabialState==='above'?'鼻唇夹角相对偏开':'鼻唇夹角方向本张照片无法区分'
  const overlayUpperLipCue=overlayUpperLipState==='below'?'上唇位于E-Line相对后方':overlayUpperLipState==='above'?'上唇位于E-Line相对前方':'上唇相对E-Line方向本张照片无法区分'
  const overlayMidfaceCue=overlayMidfaceState==='below'?'中面可见份额相对较短':overlayMidfaceState==='above'?'中面可见份额相对较长':'中面高度方向本张照片无法区分'
  const overlayJawCue=overlayJawState==='below'?'下颌下缘外观较平':overlayJawState==='above'?'下颌下缘外观较陡':'下颌缘倾斜方向本张照片无法区分'
  const overlayChinCue=overlayChinState==='below'?'颏部前向支撑偏弱':overlayChinState==='above'?'颏部前向支撑较明显':'颏部支撑方向本张照片无法区分'
  const upperELine=geometry.eLineUpperLipDistanceFaceHeightRatio,lowerELine=geometry.eLineLowerLipDistanceFaceHeightRatio
  const foreheadNoseChinAngle=angleAt(point(19),point(14),point(10))
  const eLineVector={x:point(19).x-point(10).x,y:point(19).y-point(10).y}
  const eLineInclination=Math.atan2(Math.abs(eLineVector.y),Math.max(Math.abs(eLineVector.x),1e-8))*180/Math.PI
  const upperLipELineAngle=angleAt(point(27),point(19),point(10)),lowerLipELineAngle=angleAt(point(33),point(19),point(10))
  const upperElineReferenceState=referenceBandState(upperELine,.0171,-.04,.01)
  const lowerElineReferenceState=referenceBandState(lowerELine,.0171,-.03,.01)
  const eLineIndeterminate=upperElineReferenceState==='overlap'||lowerElineReferenceState==='overlap'
  const eLineWithin=upperElineReferenceState==='within'&&lowerElineReferenceState==='within'
  const eLineAhead=upperElineReferenceState==='above'||lowerElineReferenceState==='above',eLineBehind=upperElineReferenceState==='below'&&lowerElineReferenceState==='below'
  const eLineResult=eLineIndeterminate?'E-Line区间与参考带边界重叠，本张照片无法区分':eLineWithin?'上下唇完整误差区间均落入照片参考带':eLineAhead?'至少一个唇点区间整体位于E-Line参考带前方':eLineBehind?'双唇区间整体位于E-Line参考带后方':'上下唇区间分处参考带或一项落入带内'
  const chinReferenceState=referenceBandState(geometry.softTissueChinProjectionFaceHeightRatio,.0553,0,.06)
  const jawReferenceState=referenceBandState(geometry.mandibularPlaneInclinationDegrees,5.37,20,30)
  const convexityReferenceUncertainty=twoLevelRssUncertainty(geometry.softTissueConvexityAngleDegrees,PROFILE_TENDENCY_ERRORS.convexity,'degrees')??16.3
  const convexityReferenceState=referenceBandState(geometry.softTissueConvexityAngleDegrees,convexityReferenceUncertainty,165,175)
  const nasofrontalAngle=angleAt(point(17),point(14),point(19))
  const nasalDorsumLength=distance(point(17),point(19))/faceHeight
  const nasalProjection=(pointLineDistance(point(19),point(17),point(21))??0)/faceHeight
  const lipProjectionDifference=upperELine-lowerELine
  const mentolabialFoldDepth=(pointLineDistance(point(11),point(33),point(10))??0)/faceHeight
  const visibleLowerFaceHeight=Math.max(1,distance(point(21),point(8)))
  const chinHeightShare=distance(point(10),point(8))/visibleLowerFaceHeight
  const readings:NativeProfileReading[]=[
    {code:'PROFILE-ANGLE-01',label:'软组织面凸角',value:`${geometry.softTissueConvexityAngleDegrees.toFixed(2)}°`,interpretation:'鼻根代理—鼻下点—软组织颏前点的可见角；只描述本张标准侧面照片。',formula:profileMeasurementContract.softTissueConvexityAngle.formula,availability:'measured',reliability:'capture_sensitive',errors:[...PROFILE_TENDENCY_ERRORS.convexity]},
    {code:'PROFILE-LINE-02',label:'E-Line唇部距离',value:`上唇 ${percentage(geometry.eLineUpperLipDistanceFaceHeightRatio)} · 下唇 ${percentage(geometry.eLineLowerLipDistanceFaceHeightRatio)}`,interpretation:'正值表示唇点位于鼻尖—颏前点线的可见前方，负值表示后方；不等于治疗需要。',formula:profileMeasurementContract.eLine.formula,availability:'measured',reliability:'moderate',errors:[evidenceForComponent(absoluteP95('Menpo450','上唇',DIRECT_PROFILE_UNCERTAINTY.eLineUpperPercentagePoints.manualP95,'percentage_points'),0),evidenceForComponent(absoluteP95('London 101组直接几何左右配对','上唇',DIRECT_PROFILE_UNCERTAINTY.eLineUpperPercentagePoints.pairedDifferenceP95,'percentage_points','difference'),0),evidenceForComponent(absoluteP95('Menpo450','下唇',DIRECT_PROFILE_UNCERTAINTY.eLineLowerPercentagePoints.manualP95,'percentage_points'),1),evidenceForComponent(absoluteP95('London 101组直接几何左右配对','下唇',DIRECT_PROFILE_UNCERTAINTY.eLineLowerPercentagePoints.pairedDifferenceP95,'percentage_points','difference'),1)]},
    {code:'PROFILE-ANGLE-03',label:'鼻唇角',value:`${geometry.nasolabialAngleDegrees.toFixed(2)}°`,interpretation:'鼻小柱下缘—鼻下点—上唇前点的可见夹角。',formula:profileMeasurementContract.nasolabialAngle.formula,availability:'measured',reliability:'experimental',errors:[absoluteP95('Menpo450','鼻唇角',DIRECT_PROFILE_UNCERTAINTY.nasolabialDegrees.manualP95,'degrees'),absoluteP95('London 101组直接几何左右配对','鼻唇角',DIRECT_PROFILE_UNCERTAINTY.nasolabialDegrees.pairedDifferenceP95,'degrees','difference')]},
    {code:'PROFILE-ANGLE-04',label:'颏唇沟角',value:`${geometry.mentolabialAngleDegrees.toFixed(2)}°`,interpretation:'下唇前点—颏唇沟—软组织颏前点的可见夹角。',formula:profileMeasurementContract.mentolabialAngle.formula,availability:'measured',reliability:'experimental',errors:[absoluteP95('Menpo450','颏唇沟角',DIRECT_PROFILE_UNCERTAINTY.mentolabialDegrees.manualP95,'degrees'),absoluteP95('London 101组直接几何左右配对','颏唇沟角',DIRECT_PROFILE_UNCERTAINTY.mentolabialDegrees.pairedDifferenceP95,'degrees','difference')]},
    {code:'PROFILE-RATIO-05',label:'软组织颏突出度代理',value:percentage(geometry.softTissueChinProjectionFaceHeightRatio),interpretation:'颏前点到鼻根—鼻下线的有向距离，占侧貌可见高度。',formula:profileMeasurementContract.softTissueChinProjection.formula,availability:'measured',reliability:'experimental',errors:[...PROFILE_TENDENCY_ERRORS.chin]},
    {code:'PROFILE-ANGLE-06',label:'下颌缘倾斜代理',value:`${geometry.mandibularPlaneInclinationDegrees.toFixed(2)}°`,interpretation:'对可见下颌下缘点4–8拟合的照片角度；不替代FMA或MP-SN。',formula:profileMeasurementContract.mandibularPlaneInclinationProxy.formula,availability:'measured',reliability:'capture_sensitive',errors:[absoluteP95('Menpo450','下颌缘倾斜',DIRECT_PROFILE_UNCERTAINTY.mandibularInclinationDegrees.manualP95,'degrees'),absoluteP95('London 101组直接几何左右配对','下颌缘倾斜',DIRECT_PROFILE_UNCERTAINTY.mandibularInclinationDegrees.pairedDifferenceP95,'degrees','difference')]},
    {code:'PROFILE-RATIO-07',label:'侧貌纵向比例',value:`中面 ${percentage(geometry.verticalMidfaceShare)} · 下面 ${percentage(geometry.verticalLowerFaceShare)}`,interpretation:'眉弓代理—鼻下—颏前点的可见纵向分配。',formula:profileMeasurementContract.profileVerticalProportion.formula,availability:'measured',reliability:'moderate',errors:[evidenceForComponent(absoluteP95('Menpo450','中面份额',DIRECT_PROFILE_UNCERTAINTY.verticalMidfacePercentagePoints.manualP95,'percentage_points'),0),evidenceForComponent(absoluteP95('London 101组直接几何左右配对','中面份额',DIRECT_PROFILE_UNCERTAINTY.verticalMidfacePercentagePoints.pairedDifferenceP95,'percentage_points','difference'),0),evidenceForComponent(absoluteP95('Menpo450','下面份额',DIRECT_PROFILE_UNCERTAINTY.verticalLowerFacePercentagePoints.manualP95,'percentage_points'),1),evidenceForComponent(absoluteP95('London 101组直接几何左右配对','下面份额',DIRECT_PROFILE_UNCERTAINTY.verticalLowerFacePercentagePoints.pairedDifferenceP95,'percentage_points','difference'),1)]},
    {code:'PROFILE-ANGLE-08',label:'颈颏角',value:'不可用',interpretation:'原生39点不含颈颏交界点和下颈切线，因此不生成角度。',formula:profileMeasurementContract.cervicomentalAngle.formula,availability:'unavailable',reliability:'unavailable',errors:[],validationNote:'无颈部真值，不评分'},
    {code:'PROFILE-ANGLE-09',label:'下颌线—颈线照片夹角',value:jawNeckAngle===null?(neck?.status==='weak'?'颈线候选待确认':'颈部检测未完成'):`${jawNeckAngle.toFixed(2)}°`,interpretation:'当前照片自动颈部边缘与下颌—颏部首尾方向的锐角；统一像素坐标计算，不等于下颌骨角或标准颈颏角。',formula:'acute angle(pixel endpoint direction points4–10, image-traced neck endpoint direction)',availability:jawNeckAngle===null?'unavailable':'measured',reliability:jawNeckAngle===null?'unavailable':'experimental',errors:[],validationNote:neck?.reason??'请重新分析照片以启用图像颈线；不再使用固定模板'},
  ]
  const regionReadings:NativeProfileRegionReading[]=[
    {code:'PROFILE-REGION-FOREHEAD',pathCode:'forehead_aesthetic_line',label:'额部轮廓',value:foreheadTurn===null?'不可用':`转折 ${foreheadTurn.toFixed(1)}°`,interpretation:`${foreheadCue}。该角仅取额部可见点12、眉弓代理14与鼻根17，不等于额骨倾斜或真实发际线。`,reliability:'experimental',errors:[absoluteP95('London 101组左右配对','额部转折',13.1,'degrees','difference'),absoluteP95('London 101组左右配对','额部路径',3.76,'visible_profile_height_percent','repeatability')],validationNote:'路径数值是左右重复性，不是人工描线真值；误差区间跨带时不输出方向'},
    {code:'PROFILE-REGION-NASAL',pathCode:'nasal_dorsum_line',label:'鼻背与鼻基底',value:`鼻背偏离 ${nasalDorsumDeviation===null?'—':percentage(nasalDorsumDeviation/faceHeight)} · 鼻唇 ${overlayGeometry.nasolabialAngleDegrees.toFixed(1)}°`,interpretation:`${nasalCue}；${overlayNasolabialCue}。两项均由当前彩线39点派生；鼻背偏离是点18到鼻根17—鼻尖19连线的照片距离。`,reliability:'experimental',errors:[evidenceForComponent(absoluteP95('London 101组refiner后39点左右配对','鼻背偏离',1.48,'percentage_points','difference'),0),evidenceForComponent(absoluteP95('Menpo378产品裁切refiner后39点','鼻唇角',OVERLAY_PROFILE_UNCERTAINTY.nasolabialDegrees.manualP95,'degrees'),1),evidenceForComponent(absoluteP95('London 101组refiner后39点左右配对','鼻唇角',OVERLAY_PROFILE_UNCERTAINTY.nasolabialDegrees.pairedDifferenceP95,'degrees','difference'),1),absoluteP95('London 101组关键点路径','鼻背路径',4.14,'visible_profile_height_percent','repeatability')],validationNote:'彩线读数；路径重复性不是人工描线真值'},
    {code:'PROFILE-REGION-MAXILLA',pathCode:'maxillary_support_line',label:'上颌相关软组织支撑',value:`上唇E-Line ${percentage(overlayGeometry.eLineUpperLipDistanceFaceHeightRatio)} · 中面 ${percentage(overlayGeometry.verticalMidfaceShare)}`,interpretation:`${overlayUpperLipCue}；${overlayMidfaceCue}。两项由当前彩线39点派生，可从显示点复算；这是软组织外观，不直接测量上颌骨。`,reliability:'moderate',errors:[evidenceForComponent(absoluteP95('Menpo378产品裁切refiner后39点','上唇E-Line',OVERLAY_PROFILE_UNCERTAINTY.upperLipELinePercentagePoints.manualP95,'percentage_points'),0),evidenceForComponent(absoluteP95('London 101组refiner后39点左右配对','上唇E-Line',OVERLAY_PROFILE_UNCERTAINTY.upperLipELinePercentagePoints.pairedDifferenceP95,'percentage_points','difference'),0),evidenceForComponent(absoluteP95('Menpo378产品裁切refiner后39点','中面份额',OVERLAY_PROFILE_UNCERTAINTY.verticalPercentagePoints.manualP95,'percentage_points'),1),evidenceForComponent(absoluteP95('London 101组refiner后39点左右配对','中面份额',OVERLAY_PROFILE_UNCERTAINTY.verticalPercentagePoints.pairedDifferenceP95,'percentage_points','difference'),1),absoluteP95('London 101组关键点路径','上颌支撑路径',3.20,'visible_profile_height_percent','repeatability')],validationNote:'彩线读数；路径重复性不是人工描线真值'},
    {code:'PROFILE-REGION-MANDIBLE',pathCode:'mandibular_aesthetic_line',label:'下颌下缘与颏部（非颈部）',value:`下颌缘 ${overlayGeometry.mandibularPlaneInclinationDegrees.toFixed(1)}° · 颏投影 ${percentage(overlayGeometry.softTissueChinProjectionFaceHeightRatio)}`,interpretation:`${overlayJawCue}；${overlayChinCue}。两项由当前彩线39点派生，可从显示点复算；彩线从耳下可见下颌缘后端，经点4–8到下颏最低点，再接点9–10颏前点，不得沿脖颈。`,reliability:'capture_sensitive',errors:[evidenceForComponent(absoluteP95('Menpo378产品裁切refiner后39点','下颌缘',OVERLAY_PROFILE_UNCERTAINTY.mandibularInclinationDegrees.manualP95,'degrees'),0),evidenceForComponent(absoluteP95('London 101组refiner后39点左右配对','下颌缘',OVERLAY_PROFILE_UNCERTAINTY.mandibularInclinationDegrees.pairedDifferenceP95,'degrees','difference'),0),evidenceForComponent(absoluteP95('Menpo378产品裁切refiner后39点','颏投影',OVERLAY_PROFILE_UNCERTAINTY.chinProjectionPercentagePoints.manualP95,'percentage_points'),1),evidenceForComponent(absoluteP95('London 101组refiner后39点左右配对','颏投影',OVERLAY_PROFILE_UNCERTAINTY.chinProjectionPercentagePoints.pairedDifferenceP95,'percentage_points','difference'),1),absoluteP95('London 101组关键点路径','下颌—颏部路径',3.06,'visible_profile_height_percent','repeatability')],validationNote:'彩线读数；路径重复性不是人工描线真值'},
    ...(jawNeckAngle===null?[]:[{code:'PROFILE-REGION-NECK',pathCode:'neck_aesthetic_line',label:'颈线与下颌线关系',value:`夹角 ${jawNeckAngle.toFixed(2)}°`,interpretation:'由当前图像边缘自动追踪，不拟合旧人工修正线。数值仅描述所绘两条线的方向关系。',reliability:'experimental' as const,errors:[],validationNote:'新图像算法尚无独立误差校准，不沿用旧模板P95，不做美观方向判定'}]),
  ]
  const aestheticReferences:ProfileAestheticReference[]=[
    {code:'PROFILE-AESTHETIC-CONVEXITY',label:'软组织面凸角参考',reference:'165°–175°（用户指定照片偏好带）',basis:'原始技术方案4.2同构点位＋用户偏好带；不是The Face Report公开指标',result:`${geometry.softTissueConvexityAngleDegrees.toFixed(1)}° · ${convexityReferenceState==='below'?'区间整体低于参考带':convexityReferenceState==='above'?'区间整体高于参考带':convexityReferenceState==='within'?'完整误差区间落入参考带':'区间与参考带边界重叠，本张照片无法区分'}`,status:convexityReferenceState==='within'?'within':convexityReferenceState==='overlap'?'indeterminate':'outside',interpretation:'使用鼻根区代理17—鼻下点21—软组织颏前点10，并以鼻下点为角顶点；这与原始需求中的软组织面凸角同构。鼻尖19不参与该角。',errors:[...PROFILE_TENDENCY_ERRORS.convexity],validationNote:'误差较大；区间跨带时不输出方向'},
    {code:'PROFILE-AESTHETIC-ELINE',label:'E-Line侧貌参考',reference:'鼻尖19—颏前点10构成E-Line；上唇27、下唇33在线上或轻度内收',basis:'HeadUp侧貌照片几何；The Face Report未公开同构侧貌带',result:`${eLineResult} · 上唇 ${percentage(upperELine)} · 下唇 ${percentage(lowerELine)} · 线倾斜 ${eLineInclination.toFixed(1)}°`,status:eLineIndeterminate?'indeterminate':eLineWithin?'within':eLineAhead||eLineBehind?'outside':'mixed',interpretation:`唇点夹角：上唇 ${upperLipELineAngle===null?'—':`${upperLipELineAngle.toFixed(1)}°`}；下唇 ${lowerLipELineAngle===null?'—':`${lowerLipELineAngle.toFixed(1)}°`}。E-Line没有独立通用“理想倾斜角”，有向距离仍是主判据。`,errors:[absoluteP95('London 101组左右配对','E-Line距离',1.71,'percentage_points','difference'),absoluteP95('London 101组左右配对','E-Line倾斜',3.80,'degrees','difference'),absoluteP95('London 101组左右配对','上唇夹角',7.04,'degrees','difference'),absoluteP95('London 101组左右配对','下唇夹角',7.49,'degrees','difference')]},
    {code:'PROFILE-AESTHETIC-GONIAL',label:'可见下颌角参考',reference:'110°–120°（用户指定偏好带）',basis:'用户偏好带；The Face Report的118°–126°是正面2D角，禁止移植',result:'当前39点不可可靠测量真实下颌角',status:'unavailable',interpretation:'110°–120°需要耳后/升支切线与下颌体切线。当前模型只验证了下颌下缘倾斜代理，不能替代该角。',errors:[],validationNote:'缺少升支后缘与gonion人工真值；不评分'},
    {code:'PROFILE-AESTHETIC-CHIN',label:'颏部与下颌线衔接',reference:'适度前向支撑，并与清晰下颌下缘连续',basis:'HeadUp定性照片参考；无The Face Report同构数值带',result:`${chinCue}；${jawCue}`,status:chinReferenceState==='overlap'||jawReferenceState==='overlap'?'indeterminate':chinReferenceState==='within'&&jawReferenceState==='within'?'within':'mixed',interpretation:'颏投影和下颌缘倾斜可描述轮廓关系；皮肤紧致度、脂肪与真正骨性衔接不由39点确定。',errors:[absoluteP95('London 101组左右配对','下颌缘',5.37,'degrees','difference'),absoluteP95('London 101组左右配对','颏投影',5.53,'percentage_points','difference')]},
    // The old accepted template-angle band is not valid for image-traced necks.
  ]
  const auxiliaryReadings:NativeProfileAuxiliaryReading[]=[
    {code:'PROFILE-AUX-01',label:'鼻额角照片代理',value:nasofrontalAngle===null?'不可用':`${nasofrontalAngle.toFixed(1)}°`,interpretation:'眉弓/额部代理14—鼻根17—鼻尖19的夹角；角度更小表示额鼻转折更收，更大表示衔接更开。',formula:'angle(point14, vertex17, point19)',reliability:'experimental',errors:[absoluteP95('London左右一致性','鼻额角',10.23,'degrees','difference')],validationNote:'非人工真值误差'},
    {code:'PROFILE-AUX-02',label:'鼻背可见长度占比',value:percentage(nasalDorsumLength),interpretation:'鼻根17到鼻尖19的照片距离，占眉弓14—menton8可见高度。',formula:'distance(17,19) ÷ distance(14,8)',reliability:'moderate',errors:[absoluteP95('London左右一致性','鼻背长度',1.93,'percentage_points','difference')]},
    {code:'PROFILE-AUX-03',label:'鼻尖突出度代理',value:percentage(nasalProjection),interpretation:'鼻尖19到鼻根17—鼻下点21连线的垂距，占可见侧脸高度。',formula:'distance(point19, line17–21) ÷ face height',reliability:'experimental',errors:[absoluteP95('London左右一致性','鼻尖突出度',1.81,'percentage_points','difference')]},
    {code:'PROFILE-AUX-04',label:'上下唇前后差',value:percentage(lipProjectionDifference),interpretation:lipProjectionDifference>.01?'上唇相对下唇更靠前':lipProjectionDifference<-.01?'下唇相对上唇更靠前':'上下唇相对E-Line前后位置接近',formula:'upper-lip E-Line distance − lower-lip E-Line distance',reliability:'moderate',errors:[absoluteP95('London左右一致性','上下唇前后',1.73,'percentage_points','difference')]},
    {code:'PROFILE-AUX-05',label:'颏唇沟可见深度',value:percentage(mentolabialFoldDepth),interpretation:'颏唇沟11到下唇33—颏前点10连线的照片垂距。数值越高表示本图沟部转折越明显。',formula:'distance(point11, line33–10) ÷ face height',reliability:'experimental',errors:[absoluteP95('London左右一致性','颏唇沟深度',1.37,'percentage_points','difference')]},
    {code:'PROFILE-AUX-06',label:'下巴可见高度份额',value:percentage(chinHeightShare),interpretation:'颏前点10到menton8的距离，占鼻下点21到menton8的可见下面部距离。',formula:'distance(10,8) ÷ distance(21,8)',reliability:'capture_sensitive',errors:[absoluteP95('London左右一致性','下巴高度份额',4.04,'percentage_points','difference')]},
    {code:'PROFILE-AUX-07',label:'额部—鼻尖—颏前点折线角',value:foreheadNoseChinAngle===null?'不可用':`${foreheadNoseChinAngle.toFixed(1)}°`,interpretation:'眉弓/额部代理14—鼻尖19—颏前点10，以鼻尖为角顶点。该字面三点角与软组织面凸角不是同一公式，因此只记录数值，不套用165°–175°带。',formula:'angle(point14, vertex19, point10)',reliability:'capture_sensitive',errors:[absoluteP95('London 101组左右配对','额—鼻尖—颏折线角',5.54,'degrees','difference')],validationNote:'用户指定点位；无同构外部参考带'},
  ]
  const geometryDisagreementReviewMetrics=profileGeometryDisagreementReviewMetrics(result.geometryDisagreement)
  // Image refinement changes the display path, not the calibrated model readouts.
  if(refinedJaw&&refinedJaw.status!=='missing'){
    const region=regionReadings.find(r=>r.code==='PROFILE-REGION-MANDIBLE')!
    region.interpretation='下颌描线已按图像局部细化；此处角度及投影仍来自原39点模型，不从显示细化线复算。下颌线与颈线分开。'
    region.validationNote='原39点模型读数；图像细化路径误差尚未独立校准'
    region.errors=region.errors.filter(e=>e.measure!=='repeatability')
    const core=readings.find(r=>r.code==='PROFILE-ANGLE-06')!
    core.validationNote='原模型下颌缘读数；图像细化只更新描线，不沿用原误差评价细化路径'
  }
  return {width,height,geometrySource:result.geometrySource??'landmark_derived',regionGeometrySource:'landmark_derived' as const,geometryDisagreement:result.geometryDisagreement??null,geometryDisagreementReviewMetrics,geometryDisagreementReviewPathCodes:profileGeometryDisagreementReviewPathCodes(geometryDisagreementReviewMetrics),geometryReviewComparisons:profileGeometryReviewComparisons(geometry,overlayGeometry,geometryDisagreementReviewMetrics),points:result.landmarks.map((landmark,index)=>({index,x:landmark.x*width,y:landmark.y*height,confidence:result.pointConfidence?.[index]??null})),paths,readings,regionReadings,aestheticReferences,auxiliaryReadings}
}

/** Do not infer convexity from an unsigned angle or from unverified point semantics. */
export function buildVisibleProfileTendency(result:NativeProfileResult|undefined):VisibleProfileTendency|null {
  if(!PROFILE_DIRECTION_VALIDATED)return null
  return buildResearchProfileTendency(result)
}

/** Product boundary. Models and research outputs retain their original definitions;
 * unsupported anatomical interpretations cannot reach product callers. */
export function buildNativeProfilePresentation(result:NativeProfileResult|undefined,width:number|undefined,height:number|undefined) {
  const pointCalculation=result?.geometrySource==='landmark_derived'&&result.landmarks&&width&&height?computeProfileGeometry({landmarks:result.landmarks.map(p=>({x:p.x*width,y:p.y*height})),orientation:result.orientation??'right',headAxisAngleDegrees:result.headAxisAngleDegrees??0,imageWidth:width,imageHeight:height}):undefined
  if(pointCalculation?.status==='insufficient')return null
  const pointResult=pointCalculation?.status==='measured'?{...result!,geometry:pointCalculation.geometry,landmarkDerivedGeometry:pointCalculation.geometry,geometrySource:'landmark_derived' as const,geometryDisagreement:undefined}:result
  const output=buildResearchNativeProfilePresentation(pointResult,width,height)
  if(!output)return null
  if(pointCalculation?.status==='measured'){
    for(const row of output.readings){row.errors=[];row.validationNote='由当前保存点位的像素几何计算；本公式的误差尚待校准。';row.evidence=pointCalculation.evidence[row.code];if(row.availability==='measured'){row.reliability='experimental';if(!row.evidence&&row.code==='PROFILE-ANGLE-09'){row.value='待点线依据完善';row.availability='unavailable'}}}
    for(const row of [...output.regionReadings,...output.auxiliaryReadings]){row.errors=[];row.evidence=pointCalculation.evidence[row.code];row.validationNote='当前保存点位几何；不沿用旧直接预测模型的误差。'}
    output.regionReadings=output.regionReadings.map(r=>({...r,value:'待点线依据完善'}))
  }
  const visibleJaw=output.paths.find(p=>p.code==='lower_mandibular_border')
  output.paths=resolveProfileDisplayPaths(output)
  if(visibleJaw)output.paths.push(visibleJaw)
  output.geometryDisagreementReviewPathCodes=output.geometryDisagreementReviewPathCodes.map(code=>code==='maxillary_support_line'?'upper_lip_contour':code)
  output.geometryReviewComparisons=output.geometryReviewComparisons.map(row=>({...row,pathCodes:row.pathCodes.map(code=>code==='maxillary_support_line'?'upper_lip_contour':code)}))
  output.regionReadings=output.regionReadings.filter(r=>r.code!=='PROFILE-REGION-FOREHEAD')
  for(const r of output.regionReadings){
    r.errors=r.errors.filter(e=>e.measure!=='repeatability')
    if(r.code==='PROFILE-REGION-MAXILLA'){r.pathCode='upper_lip_contour';r.label='上唇位置与纵向代理'}
  }
  if(!PROFILE_DIRECTION_VALIDATED) {
    output.aestheticReferences=[]
    for(const reading of output.readings) {
      if(reading.availability==='unavailable')continue
      reading.interpretation='仅记录本张照片的模型读数。'+PHOTO_REFERENCE_PENDING
      if(reading.code==='PROFILE-ANGLE-01') {
        reading.label='侧面三点内角'
        reading.interpretation='当前17—21—10三点的无符号内角；17号点的解剖语义待复核，不能据此判定凸凹。'
        reading.reliability='experimental'
      }
      if(reading.code==='PROFILE-ANGLE-03') {
        reading.label='鼻唇三点夹角'
        reading.interpretation='当前20—21—27三点夹角；尚未验证与标准切线定义一致，不套用90°–110°范围。'
        reading.reliability='experimental'
      }
      if(reading.code==='PROFILE-RATIO-05') {
        reading.label='颏点到17—21线的距离'
        reading.interpretation='相对当前模型参照线的有向距离，不解释为颏部支撑强弱；参照点语义待验证。'
        reading.reliability='experimental'
      }
    }
    for(const reading of output.regionReadings)reading.interpretation='照片轮廓的几何记录。'+PHOTO_REFERENCE_PENDING
    for(const reading of output.auxiliaryReadings)reading.interpretation='按所列点位公式记录，不输出解剖或优劣判断。'
  }
  for(const row of output.auxiliaryReadings){if(row.code==='PROFILE-AUX-01')row.label='眉部—鼻梁—鼻尖夹角';if(row.code==='PROFILE-AUX-07')row.label='眉部—鼻尖—颏点折线角'}
  if(!PROFILE_HEAD_AXIS_VALIDATED) {
    const inclination=output.readings.find(r=>r.code==='PROFILE-ANGLE-06')!
    Object.assign(inclination,{value:'待头位验证',availability:'unavailable',reliability:'unavailable',errors:[],interpretation:PROFILE_AXIS_PENDING,validationNote:PROFILE_AXIS_PENDING})
    const mandible=output.regionReadings.find(r=>r.code==='PROFILE-REGION-MANDIBLE')!
    Object.assign(mandible,{value:'待头位验证',errors:[],reliability:'experimental',interpretation:PROFILE_AXIS_PENDING,validationNote:PROFILE_AXIS_PENDING})
  }
  return output
}
