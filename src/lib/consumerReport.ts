import {profileMeasurementFailure} from './profileMeasurementFailure'
import {reportedFaceCount} from './reportedFaceCount'
import type { Capture, Measurement } from '../types'
import { analyzeCaptures, buildVisibleFrontTendency } from './faceMeasurements'
import { buildNativeProfilePresentation } from './nativeProfilePresentation'
import { analyzeVisibleProfilePhoto } from './profilePhotoAnalysis'
import { frontReportCoverage } from './frontReportCoverage'
import { absoluteP95 } from './errorEvidence'
import { summarizeMetricValue } from './metricUncertainty'
import { FACE_SHAPE_CLASSIFICATION_VALIDATED, SYMMETRY_MEASUREMENT_VALIDATED } from './measurementValidity'
import { straighteningMessage } from './photoStraightening'

export type ConsumerReading = Measurement & { view:'front'|'profile'; available:boolean; origin:'measurement'|'experimental'|'demo' }
import {READING_COPY} from './readingCopy'
export {READING_COPY} from './readingCopy'

function boundedEvidenceReading(reading:ConsumerReading):ConsumerReading{
  const e=reading.evidence
  if(!e||!reading.available)return reading
  if(e.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=e.width&&p.y>=0&&p.y<=e.height))return reading
  return {...reading,evidence:undefined,available:false,value:'关键点或参考线超出照片',errors:[],note:'需要完整包含该项关键点的照片，暂不提供本项读数。'}
}

const demoFront = ():ConsumerReading[] => {
  const rows:[string,string,number][] = [
    ['FRONT-RATIO-01','1.262',.104],['FRONT-RATIO-02','46.99%',4.95],
    ['FRONT-RATIO-03','1.062',.412],['FRONT-ANGLE-01','3.50°',0],['FRONT-RATIO-04','80.22%',7.45],
    ['FRONT-RATIO-05','39.12%',12.06],['FRONT-RATIO-06','29.05%',4.06],['FRONT-RATIO-07','40.11%',5.79],
    ['FRONT-RATIO-08','0.580',.287],['FRONT-RATIO-09','25.28%',6.77],['FRONT-RATIO-10','0.309',.018],
  ]
  return rows.map(([code,value,error])=>({code,label:READING_COPY[code][0],value,score:0,note:READING_COPY[code][1],group:'比例',view:'front',origin:'demo',available:true,errors:code==='FRONT-ANGLE-01'?[]:[absoluteP95('演示数据','示例误差',error,value.includes('%')?'percentage_points':value.includes('°')?'degrees':'ratio')]}))
}
const demoProfile = ():ConsumerReading[] => [['PROFILE-ANGLE-01','168.20°',18.07],['PROFILE-ANGLE-03','102.40°',15.29],['PROFILE-ANGLE-04','125.00°',17.0]].map(([id,value,error])=>({code:String(id),label:READING_COPY[String(id)][0],value:String(value),score:0,note:READING_COPY[String(id)][1],group:'侧貌',view:'profile',origin:'demo',available:true,errors:[absoluteP95('演示数据','示例误差',Number(error),'degrees')]}))

export function readingUncertainty(reading:ConsumerReading) {
  if(!reading.available||!reading.errors?.length)return null
  return summarizeMetricValue(reading.value,reading.errors,reading.code==='FRONT-ANGLE-01'?[10]:reading.code==='PROFILE-LINE-02'?[5,5]:undefined)
}
export function captureResult(capture:Capture|undefined) {
  if(!capture)return {title:'未添加照片',facts:[] as string[],issues:['本次未添加此视角的照片。']}
  if(capture.inputError)return {title:'文件读取失败',facts:[] as string[],issues:[capture.inputError]}
  const facts:string[]=[]
  if(capture.analysisError)facts.push('原图已保留；本次模型检测未完整完成。')
  if(capture.straightening) {
    facts.push(straighteningMessage(capture.straightening))
    if(capture.straightening.status==='applied'&&capture.straightening.originalFlags.length)facts.push(`扶正前检测提示：${capture.straightening.originalFlags.join('、')}`)
  }
  const pose=capture.poseValidation
  const faceCount=pose?reportedFaceCount(pose,capture.id==='profile'||capture.id==='right_profile'):undefined
  if(faceCount!==undefined)facts.push(`检测到 ${faceCount} 张人脸`)
  const hasSingleFace=faceCount===1&&pose&&pose.estimatedPose!=='no_face'&&pose.estimatedPose!=='multiple_faces'
  if(hasSingleFace&&(pose.estimatedPose==='left_profile'||pose.estimatedPose==='right_profile'))facts.push(`识别视角：${pose.estimatedPose==='left_profile'?'左':'右'}侧面`)
  if(hasSingleFace&&pose?.yaw!==undefined&&Number.isFinite(pose.yaw))facts.push(`水平转头 ${pose.yaw.toFixed(2)}°`)
  if(hasSingleFace&&pose?.pitch!==undefined&&Number.isFinite(pose.pitch))facts.push(`上下俯仰 ${pose.pitch.toFixed(2)}°`)
  if(hasSingleFace&&pose?.roll!==undefined&&Number.isFinite(pose.roll))facts.push(`模型估计横向倾斜 ${pose.roll.toFixed(2)}°`)
  if(pose?.landmarkImageWidth&&pose.landmarkImageHeight)facts.push(`分析尺寸 ${pose.landmarkImageWidth} × ${pose.landmarkImageHeight}`)
  const sideFailure=(capture.id==='profile'||capture.id==='right_profile')&&capture.url?profileMeasurementFailure(pose,capture.quality):undefined
  const issues=[...new Set([...((capture.analysisError||sideFailure)?[capture.analysisError||sideFailure!]:[]),...(pose?.flags??[]),...(capture.quality?.flags??[])])]
  if(!capture.url&&!issues.length)issues.push('本次未添加此视角的照片。')
  if(capture.url&&!pose&&!issues.length)issues.push('照片已接收，本次没有生成关键点记录。')
  return {title:sideFailure?'侧面测量未完成':faceCount!==undefined?`检测到 ${faceCount} 张人脸`:capture.analysisError?'照片已保留，检测未完成':capture.url?'照片已接收':'未添加照片',facts,issues}
}

/** Every attempt returns a record. Missing measurements stay explicitly missing;
 * output never substitutes a demo value or a categorical direction for uncertainty. */
export function buildConsumerReport(captures:Capture[],isExample=false) {
  const frontCapture=captures.find(c=>c.id==='front'),profileCapture=captures.find(c=>c.id==='profile')
  const issues:string[]=[]
  let front:ConsumerReading[]=[],profile:ConsumerReading[]=[]
  let frontTendency:ReturnType<typeof buildVisibleFrontTendency>=null
  let native:ReturnType<typeof buildNativeProfilePresentation>=null
  let proxy:ReturnType<typeof analyzeVisibleProfilePhoto>=null
  if(isExample){front=demoFront();profile=demoProfile()}
  else {
    try {
      const result=analyzeCaptures(captures)
      front=result.measurements.filter(m=>m.code?.startsWith('FRONT-')&&(SYMMETRY_MEASUREMENT_VALIDATED||m.code!=='FRONT-SYM-01')).map(m=>({...m,view:'front',origin:m.code==='FRONT-ANGLE-01'?'experimental':'measurement',available:Number.isFinite(Number.parseFloat(m.value)),label:READING_COPY[m.code!]?.[0]??m.label,note:READING_COPY[m.code!]?.[1]??m.note}))
      const pose=frontCapture?.poseValidation
      if(FACE_SHAPE_CLASSIFICATION_VALIDATED&&pose?.landmarks&&pose.landmarkImageWidth&&pose.landmarkImageHeight)frontTendency=buildVisibleFrontTendency(pose.landmarks,pose.landmarkImageWidth,pose.landmarkImageHeight,pose.robustLipHeightMouthWidthRatio)
    } catch { issues.push('正面几何计算本次未完成；照片检测记录已保留。') }
    try {
      const pose=profileCapture?.poseValidation
      native=buildNativeProfilePresentation(pose?.nativeProfile,pose?.landmarkImageWidth,pose?.landmarkImageHeight)
      if(native)profile=native.readings.map(m=>({code:m.code,label:m.label,value:m.value,score:0,note:m.interpretation,formula:m.formula,errors:m.errors,confidenceBasis:m.validationNote,evidence:m.evidence,group:'侧貌',view:'profile',origin:m.reliability==='experimental'?'experimental':'measurement',available:m.availability==='measured'&&!/NaN|Infinity/.test(m.value)}))
      else {
        proxy=pose?.nativeProfile?.status==='unavailable'?null:analyzeVisibleProfilePhoto(pose)
        // A fallback mesh is not a validated replacement for the profile schema.
        // Keep its contour preview, but do not promote its proxy angles to readings.
      }
    } catch { issues.push('侧面几何计算本次未完成；照片检测记录已保留。') }
  }
  front=front.map(boundedEvidenceReading);profile=profile.map(boundedEvidenceReading)
  const frontDetection=captureResult(frontCapture),profileDetection=captureResult(profileCapture)
  const extended:ConsumerReading[]=native?[...native.regionReadings,...native.auxiliaryReadings].map((r):ConsumerReading=>({
    code:r.code,label:r.label,value:r.value,score:0,note:'根据本次照片轮廓线计算的扩展读数。与核心模型读数分开记录。',
    formula:'formula'in r?r.formula:undefined,confidenceBasis:r.validationNote,evidence:r.evidence,errors:r.errors,
    group:'侧貌',view:'profile',origin:'experimental',available:/\d/.test(r.value)&&!/NaN|Infinity/.test(r.value),
  })).map(boundedEvidenceReading):[]
  const coverage=frontReportCoverage(front)
  const measuredProfile=profile.filter(m=>m.available)
  const lower=front.find(m=>m.code==='FRONT-RATIO-07'&&m.available)
  const side=measuredProfile.find(m=>m.code==='PROFILE-ANGLE-01')??measuredProfile[0]
  const summaries=[
    {label:'脸部轮廓',value:isExample||front.length?'本图轮廓':frontDetection.title,note:isExample||front.length?'查看照片中的轮廓线；脸型类别待复拍验证。':frontDetection.issues[0]??'已记录本次照片检测结果。'},
    {label:lower?'正面比例':'检测进度',value:lower?`下半脸占比 ${lower.value}`:`已检查 ${captures.filter(c=>c.quality||c.poseValidation).length} 张照片`,note:lower?'鼻底到下巴，占可见脸高的比例。':'人脸数量、图像尺寸与质量记录列于照片下方。'},
    {label:'侧面测量',value:side?`${side.label} ${side.value}`:profileDetection.title,note:side?`已记录 ${measuredProfile.length} 项侧面读数，角度与距离见下方。`:profileDetection.issues[0]??'本次关键点记录不完整，已有检测信息见下方。'},
  ]
  return {createdAt:new Date().toISOString(),isExample,front,profile,extended,frontTendency,native,proxy,coverage,frontDetection,profileDetection,summaries,issues,measuredCount:front.filter(m=>m.available).length+measuredProfile.length}
}
