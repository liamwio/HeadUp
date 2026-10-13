import {isPhotoQualityAcceptable} from './photoQualityAcceptance'
import type { Capture, LandmarkPoint, Measurement } from '../types'
import{absoluteP95,relativeP95}from'./errorEvidence'
import { EYE_TILT_CALIBRATION_PENDING } from './measurementValidity'
import { buildFrontPointMeasurements, buildFrontEyeAngleEvidence, validFrontMeasurementInput } from './frontMeasurementEvidence'

export type LocalFaceAnalysis = {
  status: 'measured' | 'insufficient'
  dataQuality: number
  measurements: Measurement[]
  summary: string
  limitation: string
}

export type FrontGeometry = {
  mirrorResidual: number
  visibleFaceLengthWidthRatio: number
  pupilDistanceFaceWidthRatio: number
  interEyeRatio: number
  eyeCanthalTiltDegrees: number
  visibleForeheadWidthRatio: number
  jawWidthRatio: number
  mouthWidthRatio: number
  midfaceHeightRatio: number
  browPeakMidfaceHeightRatio: number
  lowerFaceHeightRatio: number
  midLowerFaceHeightRatio: number
  noseMouthWidthRatio: number
  noseLengthFaceHeightRatio: number
  lipHeightMouthWidthRatio: number
}

export type VisibleFrontTendency = {
  label: string
  description: string
  evidence: Array<{ label: string; value: string }>
  shapeLabel: string
  alternateShapeLabel: string
  disclosure: string
}

type PlanePoint = { x: number; y: number }

function planePoint(point: LandmarkPoint, aspectRatio: number): PlanePoint {
  return { x: point.x * aspectRatio, y: point.y }
}

function distance(a: LandmarkPoint, b: LandmarkPoint, aspectRatio: number): number {
  const left = planePoint(a, aspectRatio)
  const right = planePoint(b, aspectRatio)
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function average(points: LandmarkPoint[], aspectRatio: number): PlanePoint {
  return {
    x: points.reduce((sum, point) => sum + point.x * aspectRatio, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function fitFaceAxes(landmarks: LandmarkPoint[], aspectRatio: number) {
  const points = [10, 168, 6, 1, 2, 152].map((index) => planePoint(landmarks[index], aspectRatio))
  const origin = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
  const covariance = points.reduce((value, point) => {
    const x = point.x - origin.x
    const y = point.y - origin.y
    value.xx += x * x
    value.xy += x * y
    value.yy += y * y
    return value
  }, { xx: 0, xy: 0, yy: 0 })
  const angle = 0.5 * Math.atan2(2 * covariance.xy, covariance.xx - covariance.yy)
  let vertical = { x: Math.cos(angle), y: Math.sin(angle) }
  if (Math.abs(vertical.x) > Math.abs(vertical.y)) vertical = { x: -vertical.y, y: vertical.x }
  if (vertical.y < 0) vertical = { x: -vertical.x, y: -vertical.y }
  const horizontal = { x: vertical.y, y: -vertical.x }
  return { origin, vertical, horizontal }
}

function robustMirrorResidual(landmarks: LandmarkPoint[], aspectRatio: number, pupilDistance: number, faceWidth: number): number {
  const axes = fitFaceAxes(landmarks, aspectRatio)
  const pairs = [[33, 263], [133, 362], [70, 300], [105, 334], [61, 291], [98, 327], [234, 454], [172, 397], [93, 323], [58, 288], [127, 356], [21, 251]]
  const normalizer = Math.max(pupilDistance, faceWidth * 0.25, 0.001)
  const residuals = pairs.map(([leftIndex, rightIndex]) => {
    const left = planePoint(landmarks[leftIndex], aspectRatio)
    const right = planePoint(landmarks[rightIndex], aspectRatio)
    const offset = (left.x - axes.origin.x) * axes.horizontal.x + (left.y - axes.origin.y) * axes.horizontal.y
    const reflected = { x: left.x - 2 * offset * axes.horizontal.x, y: left.y - 2 * offset * axes.horizontal.y }
    return Math.hypot(reflected.x - right.x, reflected.y - right.y) / normalizer
  })
  return median(residuals)
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function ratio(value: number): string {
  return value.toFixed(3)
}

function captureQuality(quality: number): number {
  return Math.max(0, Math.min(99, Math.round(quality)))
}

const FRONT_MEASUREMENT_EVIDENCE = {
  symmetry: { code: 'FRONT-SYM-01', formula: 'median(||reflect(Lᵢ, fitted midline) − Rᵢ||) ÷ max(IPD, 0.25 × face width)', landmarkIndices: '中轴 10/168/6/1/2/152；镜像对 33–263、133–362、70–300、105–334、61–291、98–327、234–454、172–397、93–323、58–288、127–356、21–251' },
  faceRatio: { code: 'FRONT-RATIO-01', formula: 'distance(10, 152) ÷ distance(234, 454)', landmarkIndices: '额部可见点10、颏点152、左右脸宽点234/454' },
  pupilWidth: { code: 'FRONT-RATIO-02', formula: 'distance(mean(468…472), mean(473…477)) ÷ distance(234, 454)', landmarkIndices: '双侧虹膜468–477、脸宽234/454' },
  interEye: { code: 'FRONT-RATIO-03', formula: 'distance(133, 362) ÷ mean(distance(33,133), distance(362,263))', landmarkIndices: '内眼角133/362、外眼角33/263' },
  eyeTilt: { code: 'FRONT-ANGLE-01', formula: '(angle(33→133) − angle(362→263)) / 2 relative to fitted horizontal axis; positive = outer canthi higher', landmarkIndices: '眼角33/133/362/263；拟合轴10/168/6/1/2/152' },
  jawWidth: { code: 'FRONT-RATIO-04', formula: 'distance(172, 397) ÷ distance(234, 454)', landmarkIndices: '下颌轮廓172/397、脸宽234/454' },
  mouthWidth: { code: 'FRONT-RATIO-05', formula: 'distance(61, 291) ÷ distance(234, 454)', landmarkIndices: '口角61/291、脸宽234/454' },
  midface: { code: 'FRONT-RATIO-06', formula: 'distance(168, 2) ÷ distance(10, 152)', landmarkIndices: '眉间代理168、鼻下代理2、额部10、颏点152' },
  lowerFace: { code: 'FRONT-RATIO-07', formula: 'distance(2, 152) ÷ distance(10, 152)', landmarkIndices: '鼻下代理2、颏点152、额部10' },
  noseMouth: { code: 'FRONT-RATIO-08', formula: 'distance(98, 327) ÷ distance(61, 291)', landmarkIndices: '鼻翼代理98/327、口角61/291' },
  noseLength: { code: 'FRONT-RATIO-09', formula: 'distance(168, 1) ÷ distance(10, 152)', landmarkIndices: '鼻根代理168、鼻尖代理1、额部10、颏点152' },
  lipMouth: { code: 'FRONT-RATIO-10', formula: 'median(distance(37,84), distance(0,17), distance(267,314)) ÷ distance(61,291), from the same saved landmarks', landmarkIndices: '同一张已保存照片：外唇37/84、0/17、267/314；口角61/291' },
} as const

const CONFIDENCE_BASIS = '置信档由两级RSS不确定度与领域尺度计算；不是解剖准确率、颜值分、模型概率或人群百分位。'

export function computeTriMedianLipHeightMouthWidthRatio(landmarks: LandmarkPoint[], imageWidth = 1, imageHeight = 1): number | null {
  if (landmarks.length < 315 || !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) return null
  const aspectRatio = imageWidth / imageHeight
  const mouthWidth = distance(landmarks[61], landmarks[291], aspectRatio)
  if (mouthWidth < 0.001) return null
  return median([[37, 84], [0, 17], [267, 314]].map(([upper, lower]) => distance(landmarks[upper], landmarks[lower], aspectRatio) / mouthWidth))
}

/** Research-only candidate matching a brow-peak-midpoint-to-nose-base definition. Production FRONT-RATIO-06 still uses landmark 168 until this candidate is recalibrated. */
export function computeBrowPeakMidfaceHeightRatio(landmarks:LandmarkPoint[],imageWidth=1,imageHeight=1):number|null{
  if(landmarks.length<335||!Number.isFinite(imageWidth)||!Number.isFinite(imageHeight)||imageWidth<=0||imageHeight<=0)return null
  const aspectRatio=imageWidth/imageHeight,faceHeight=distance(landmarks[10],landmarks[152],aspectRatio)
  if(faceHeight<.01)return null
  const browMidpoint:LandmarkPoint={x:(landmarks[105].x+landmarks[334].x)/2,y:(landmarks[105].y+landmarks[334].y)/2,z:(landmarks[105].z+landmarks[334].z)/2}
  return distance(browMidpoint,landmarks[2],aspectRatio)/faceHeight
}

export function computeFrontGeometry(landmarks: LandmarkPoint[], imageWidth = 1, imageHeight = 1, _legacyRobustLipRatio?: number): FrontGeometry | null {
  if (!validFrontMeasurementInput(landmarks, imageWidth, imageHeight)) return null
  const pointMeasurements = buildFrontPointMeasurements(landmarks, imageWidth, imageHeight)
  if (!pointMeasurements) return null
  const aspectRatio = imageWidth / imageHeight
  const faceWidth = distance(landmarks[234], landmarks[454], aspectRatio)
  const faceHeight = distance(landmarks[10], landmarks[152], aspectRatio)
  if (faceWidth < 0.01 || faceHeight < 0.01) return null

  const leftIrisCenter = average(landmarks.slice(468, 473), aspectRatio)
  const rightIrisCenter = average(landmarks.slice(473, 478), aspectRatio)
  const pupilDistance = Math.hypot(leftIrisCenter.x - rightIrisCenter.x, leftIrisCenter.y - rightIrisCenter.y)
  const leftEyeWidth = distance(landmarks[33], landmarks[133], aspectRatio)
  const rightEyeWidth = distance(landmarks[362], landmarks[263], aspectRatio)
  const averageEyeWidth = (leftEyeWidth + rightEyeWidth) / 2
  const foreheadWidth = distance(landmarks[54], landmarks[284], aspectRatio)
  const mouthWidth = distance(landmarks[61], landmarks[291], aspectRatio)
  const midfaceHeight = distance(landmarks[168], landmarks[2], aspectRatio)
  const browPeakMidpoint=average([landmarks[105],landmarks[334]],aspectRatio),noseBase=planePoint(landmarks[2],aspectRatio),browPeakMidfaceHeight=Math.hypot(browPeakMidpoint.x-noseBase.x,browPeakMidpoint.y-noseBase.y)
  const lowerFaceHeight = distance(landmarks[2], landmarks[152], aspectRatio)
  if (averageEyeWidth < 0.001 || mouthWidth < 0.001 || pupilDistance < 0.001) return null
  const axes = fitFaceAxes(landmarks, aspectRatio)
  const eyeEvidence = buildFrontEyeAngleEvidence(landmarks, imageWidth, imageHeight, axes)
  if (!eyeEvidence || !Number.isFinite(eyeEvidence.value)) return null
  const eyeCanthalTiltDegrees = eyeEvidence.value

  return {
    mirrorResidual: robustMirrorResidual(landmarks, aspectRatio, pupilDistance, faceWidth),
    visibleFaceLengthWidthRatio: pointMeasurements['FRONT-RATIO-01'].value,
    pupilDistanceFaceWidthRatio: pointMeasurements['FRONT-RATIO-02'].value,
    interEyeRatio: pointMeasurements['FRONT-RATIO-03'].value,
    eyeCanthalTiltDegrees,
    visibleForeheadWidthRatio: foreheadWidth / faceWidth,
    jawWidthRatio: pointMeasurements['FRONT-RATIO-04'].value,
    mouthWidthRatio: pointMeasurements['FRONT-RATIO-05'].value,
    midfaceHeightRatio: pointMeasurements['FRONT-RATIO-06'].value,
    browPeakMidfaceHeightRatio:browPeakMidfaceHeight/faceHeight,
    lowerFaceHeightRatio: pointMeasurements['FRONT-RATIO-07'].value,
    midLowerFaceHeightRatio: midfaceHeight / Math.max(lowerFaceHeight, 0.001),
    noseMouthWidthRatio: pointMeasurements['FRONT-RATIO-08'].value,
    noseLengthFaceHeightRatio: pointMeasurements['FRONT-RATIO-09'].value,
    lipHeightMouthWidthRatio: pointMeasurements['FRONT-RATIO-10'].value,
  }
}

type FaceShapeProfile = { label: string; lengthWidth: number; foreheadWidth: number; jawWidth: number }
const FACE_SHAPE_PROFILES: FaceShapeProfile[] = [
  { label: '椭圆', lengthWidth: 1.18, foreheadWidth: .92, jawWidth: .78 },
  { label: '圆形', lengthWidth: 1.02, foreheadWidth: .9, jawWidth: .76 },
  { label: '方形', lengthWidth: 1.04, foreheadWidth: .98, jawWidth: .9 },
  { label: '心形', lengthWidth: 1.16, foreheadWidth: 1.03, jawWidth: .7 },
  { label: '菱形', lengthWidth: 1.16, foreheadWidth: .84, jawWidth: .7 },
  { label: '长形', lengthWidth: 1.34, foreheadWidth: .96, jawWidth: .88 },
]

function closestFaceShapes(geometry: FrontGeometry) {
  const score = (profile: FaceShapeProfile) => Math.hypot(
    (geometry.visibleFaceLengthWidthRatio - profile.lengthWidth) / .18,
    (geometry.visibleForeheadWidthRatio - profile.foreheadWidth) / .14,
    (geometry.jawWidthRatio - profile.jawWidth) / .15,
  )
  return [...FACE_SHAPE_PROFILES].sort((left, right) => score(left) - score(right)).slice(0, 2).map((profile) => profile.label)
}

// Presentation bands keep the result legible on the image. They are not a population
// ranking and intentionally do not infer bone morphology from a 2D photograph.
export function buildVisibleFrontTendency(landmarks: LandmarkPoint[], imageWidth = 1, imageHeight = 1, robustLipHeightMouthWidthRatio?: number): VisibleFrontTendency | null {
  const geometry = computeFrontGeometry(landmarks, imageWidth, imageHeight, robustLipHeightMouthWidthRatio)
  if (!geometry) return null
  const jaw = geometry.jawWidthRatio
  const lower = geometry.lowerFaceHeightRatio
  const mirror = geometry.mirrorResidual
  const jawCue = jaw < .73 ? '下颌轮廓相对收窄' : jaw > .82 ? '下颌轮廓相对展开' : '下颌轮廓比例居中'
  const lowerCue = lower < .36 ? '下面部可见高度相对较短' : lower > .42 ? '下面部可见高度相对较长' : '下面部可见高度居中'
  const symmetryCue = mirror < .06 ? '镜像残差较低' : mirror < .1 ? '镜像残差中等' : '镜像残差较高'
  const [shapeLabel, alternateShapeLabel] = closestFaceShapes(geometry)
  return {
    label: `${shapeLabel}轮廓近似 · ${jawCue}`,
    description: `本图的可见轮廓最接近${shapeLabel}，次接近${alternateShapeLabel}；${lowerCue}，12组关键点${symmetryCue}。`,
    evidence: [
      { label: '可见额宽/颧宽', value: percentage(geometry.visibleForeheadWidthRatio) },
      { label: '下颌宽占比', value: percentage(jaw) },
      { label: '下面部占比', value: percentage(lower) },
      { label: '镜像残差', value: percentage(mirror) },
    ],
    shapeLabel,
    alternateShapeLabel,
    disclosure: '脸型近似基于可见额部、颧部、下颌和长度的2D照片比例；不等同于真实发际线、颅骨形状、骨性分类或医疗结论。',
  }
}

export function measureFrontLandmarks(landmarks: LandmarkPoint[], quality: number, imageWidth = 1, imageHeight = 1, _legacyRobustLipRatio?: number): Measurement[] {
  // Historical callers may still supply the old ensemble scalar. New readings
  // always use the saved mesh, which is also the source of their evidence.
  const geometry = computeFrontGeometry(landmarks, imageWidth, imageHeight)
  if (!geometry) return []
  const pointMeasurements = buildFrontPointMeasurements(landmarks, imageWidth, imageHeight)!
  const eyeEvidence = buildFrontEyeAngleEvidence(landmarks, imageWidth, imageHeight, fitFaceAxes(landmarks, imageWidth / imageHeight))
  if (eyeEvidence) pointMeasurements['FRONT-ANGLE-01'] = eyeEvidence
  const score = captureQuality(quality)

  const measurements: Measurement[] = [
    { ...FRONT_MEASUREMENT_EVIDENCE.symmetry, confidenceBasis: CONFIDENCE_BASIS, label: '12 点镜像残差', value: percentage(geometry.mirrorResidual), score, reliability: 'capture_sensitive', note: '拟合面中轴后取12组左右点反射残差的中位数；不能用于细微趋势。', errors:[absoluteP95('MUCT','机位',5.16,'percentage_points','drift'),absoluteP95('MUCT','光照',16.23,'percentage_points','drift')], group: '对称' },
    { ...FRONT_MEASUREMENT_EVIDENCE.faceRatio, confidenceBasis: CONFIDENCE_BASIS, label: '可见脸长宽比', value: ratio(geometry.visibleFaceLengthWidthRatio), score, reliability: 'moderate', note: '额部可见点至颏点 ÷ 两侧可见脸宽。', errors:[relativeP95('MUCT','机位',6.90),relativeP95('MUCT','光照',4.52)], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.pupilWidth, confidenceBasis: CONFIDENCE_BASIS, label: '瞳距脸宽占比', value: percentage(geometry.pupilDistanceFaceWidthRatio), score, reliability: 'comparatively_stable', note: '双侧虹膜中心距 ÷ 可见脸宽；不得当作配镜瞳距。', errors:[relativeP95('MUCT','机位',3.34),relativeP95('MUCT','光照',3.26),relativeP95('WFLW','路径隔离留出',9.44,'error')], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.interEye, confidenceBasis: CONFIDENCE_BASIS, label: '眼间距比', value: ratio(geometry.interEyeRatio), score, reliability: 'capture_sensitive', note: '内眼角距离 ÷ 左右平均眼宽。', errors:[relativeP95('MUCT','机位',13.12),relativeP95('MUCT','光照',10.48),relativeP95('WFLW','路径隔离留出',34.99,'error')], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.eyeTilt, confidenceBasis: EYE_TILT_CALIBRATION_PENDING, label: '眼角倾斜代理', value: `${geometry.eyeCanthalTiltDegrees.toFixed(2)}°`, score, reliability: 'capture_sensitive', note: '双眼外眼角同时高于内眼角为正；仅记录当前照片角度。', errors:[], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.jawWidth, confidenceBasis: CONFIDENCE_BASIS, label: '下颌宽占比', value: percentage(geometry.jawWidthRatio), score, reliability: 'comparatively_stable', note: '可见下颌两侧宽度 ÷ 可见脸宽；仅代表软组织轮廓。', errors:[relativeP95('MUCT','机位',4.51),relativeP95('MUCT','光照',2.94),relativeP95('WFLW','路径隔离留出',7.56,'error')], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.mouthWidth, confidenceBasis: CONFIDENCE_BASIS, label: '口宽占比', value: percentage(geometry.mouthWidthRatio), score, reliability: 'capture_sensitive', note: '两侧口角距离 ÷ 可见脸宽；只作当前照片记录。', errors:[relativeP95('MUCT','机位',7.42),relativeP95('MUCT','光照',24.31),relativeP95('WFLW','路径隔离留出',17.43,'error')], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.midface, confidenceBasis: CONFIDENCE_BASIS, label: '中面部高度占比', value: percentage(geometry.midfaceHeightRatio), score, reliability: 'capture_sensitive', note: '眉间代理至鼻下代理 ÷ 可见脸高。', errors:[relativeP95('MUCT','机位',10.32),relativeP95('MUCT','光照',9.43)], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.lowerFace, confidenceBasis: CONFIDENCE_BASIS, label: '下面部高度占比', value: percentage(geometry.lowerFaceHeightRatio), score, reliability: 'capture_sensitive', note: '鼻下代理至软组织颏点 ÷ 可见脸高。', errors:[relativeP95('MUCT','机位',11.42),relativeP95('MUCT','光照',8.83)], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.noseMouth, confidenceBasis: CONFIDENCE_BASIS, label: '鼻嘴宽度比', value: ratio(geometry.noseMouthWidthRatio), score, reliability: 'capture_sensitive', note: '鼻翼宽代理 ÷ 嘴宽。', errors:[relativeP95('MUCT','机位',12.09),relativeP95('MUCT','光照',12.39),relativeP95('WFLW','路径隔离留出',46.37,'error')], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.noseLength, confidenceBasis: CONFIDENCE_BASIS, label: '鼻长脸高占比', value: percentage(geometry.noseLengthFaceHeightRatio), score, reliability: 'capture_sensitive', note: '鼻根至鼻尖代理 ÷ 可见脸高。', errors:[relativeP95('MUCT','机位',17.79),relativeP95('MUCT','光照',11.93),absoluteP95('Menpo','鼻尖定位',4.06,'face_box_diagonal_percent','error')], group: '比例' },
    { ...FRONT_MEASUREMENT_EVIDENCE.lipMouth, confidenceBasis: '依据同一张保存照片的三组外唇关键点；旧多图微移算法的误差证据不再适用，待重新校准。不是解剖准确率、模型概率或人群百分位。', label: '唇高嘴宽比', value: ratio(geometry.lipHeightMouthWidthRatio), score, reliability: 'capture_sensitive', note: '当前照片三组外唇直线高度取中位数，再除以嘴宽；不使用其他检测画面的数值。', errors:[], group: '比例' },
  ]
  return measurements.map(measurement => ({ ...measurement, ...(measurement.code && pointMeasurements[measurement.code] ? { evidence: {...pointMeasurements[measurement.code].evidence,formula:pointMeasurements[measurement.code].evidence.formula+(measurement.value.includes('%')?' × 100%':'')} } : {}) }))
}

export function analyzeCaptures(captures: Capture[]): LocalFaceAnalysis {
  const availableQuality = captures.flatMap((capture) => capture.quality ? [capture.quality.score] : [])
  const dataQuality = availableQuality.length > 0
    ? Math.round(availableQuality.reduce((sum, score) => sum + score, 0) / availableQuality.length)
    : 0
  const front = captures.find((capture) => capture.id === 'front')
  const usable=front?.poseValidation?.status==='pass'&&!front.inputError&&!front.analysisError&&!front.acceptedWithBias&&(!front.quality||isPhotoQualityAcceptable(front.quality))
  const landmarks = usable?front?.poseValidation?.landmarks:undefined
  const measurements = landmarks ? measureFrontLandmarks(
    landmarks,
    front?.quality?.score ?? dataQuality,
    front?.poseValidation?.landmarkImageWidth,
    front?.poseValidation?.landmarkImageHeight,
  ) : []
  if (measurements.length === 0) {
    return {
      status: 'insufficient',
      dataQuality,
      measurements: [],
      summary: '尚未获得可复核的正面关键点。',
      limitation: '不会使用演示常量代替真人测量。',
    }
  }
  return {
    status: 'measured',
    dataQuality,
    measurements,
    summary: '已生成 12 项正面几何候选；其中 2 项为较稳定代理、2 项为中等稳定，其余仅作拍摄敏感记录。',
    limitation: '稳定性等级来自 120 名真人的多机位/多光照代理，不等于标准手机跨时段重拍验证；侧貌关键点与头顶轮廓尚未达到发布门槛。',
  }
}
