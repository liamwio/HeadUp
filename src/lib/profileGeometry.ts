import type {MeasurementEvidence,EvidencePoint,EvidenceSegment} from './measurementEvidence'
import {
  PROFILE_LANDMARK_COUNT,
  profileContourSegments,
  profileLandmarks,
  type ProfileMeasurementName,
} from './profileLandmarkContract'

export type ProfilePoint = { x: number; y: number }
export type ProfileOrientation = 'left' | 'right'

export type ProfileNeckLandmarks = {
  /** Visible junction between the submental contour and the anterior neck. */
  cervicomentalPoint: ProfilePoint
  /** A second inferior point defining the visible anterior-neck tangent. */
  lowerNeckPoint: ProfilePoint
}

export type ProfileGeometryInput = {
  landmarks: readonly ProfilePoint[]
  orientation: ProfileOrientation
  /** Clockwise angle of the image's head-horizontal axis in image coordinates. */
  imageWidth?:number
  imageHeight?:number
  headAxisAngleDegrees?: number
  neckLandmarks?: ProfileNeckLandmarks
}

export type ProfileGeometry = {
  softTissueConvexityAngleDegrees: number
  eLineUpperLipDistanceFaceHeightRatio: number
  eLineLowerLipDistanceFaceHeightRatio: number
  nasolabialAngleDegrees: number
  mentolabialAngleDegrees: number
  softTissueChinProjectionFaceHeightRatio: number
  mandibularPlaneInclinationDegrees: number
  cervicomentalAngleDegrees: number | null
  verticalMidfaceShare: number
  verticalLowerFaceShare: number
}
export type ProfileGeometryDisagreement={
  softTissueConvexityAngleDegrees:number
  eLinePercentagePoints:number
  nasolabialAngleDegrees:number
  mentolabialAngleDegrees:number
  chinProjectionPercentagePoints:number
  mandibularInclinationDegrees:number
  verticalPercentagePoints:number
}

export function compareProfileGeometry(primary:ProfileGeometry,landmarkDerived:ProfileGeometry):ProfileGeometryDisagreement{
  return{
    softTissueConvexityAngleDegrees:Math.abs(primary.softTissueConvexityAngleDegrees-landmarkDerived.softTissueConvexityAngleDegrees),
    eLinePercentagePoints:Math.max(Math.abs(primary.eLineUpperLipDistanceFaceHeightRatio-landmarkDerived.eLineUpperLipDistanceFaceHeightRatio),Math.abs(primary.eLineLowerLipDistanceFaceHeightRatio-landmarkDerived.eLineLowerLipDistanceFaceHeightRatio))*100,
    nasolabialAngleDegrees:Math.abs(primary.nasolabialAngleDegrees-landmarkDerived.nasolabialAngleDegrees),
    mentolabialAngleDegrees:Math.abs(primary.mentolabialAngleDegrees-landmarkDerived.mentolabialAngleDegrees),
    chinProjectionPercentagePoints:Math.abs(primary.softTissueChinProjectionFaceHeightRatio-landmarkDerived.softTissueChinProjectionFaceHeightRatio)*100,
    mandibularInclinationDegrees:Math.abs(primary.mandibularPlaneInclinationDegrees-landmarkDerived.mandibularPlaneInclinationDegrees),
    verticalPercentagePoints:Math.max(Math.abs(primary.verticalMidfaceShare-landmarkDerived.verticalMidfaceShare),Math.abs(primary.verticalLowerFaceShare-landmarkDerived.verticalLowerFaceShare))*100,
  }
}

export type ProfileGeometryResult = {
  status: 'measured'
  evidence:Record<string,MeasurementEvidence>
  geometry: ProfileGeometry
  measuredMetricCount: number
  unavailableMetrics: Partial<Record<ProfileMeasurementName, string>>
  normalization: 'brow-to-menton projected face height'
  limitations: readonly string[]
} | {
  status: 'insufficient'
  reason: string
  measuredMetricCount: 0
  unavailableMetrics: Partial<Record<ProfileMeasurementName, string>>
}

const EPSILON = 1e-8

function finitePoint(point: ProfilePoint | undefined): point is ProfilePoint {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

function canonicalPoint(point: ProfilePoint, orientation: ProfileOrientation, axisDegrees: number): ProfilePoint {
  const radians = axisDegrees * Math.PI / 180
  const horizontal = { x: Math.cos(radians), y: Math.sin(radians) }
  const vertical = { x: -Math.sin(radians), y: Math.cos(radians) }
  const direction = orientation === 'right' ? 1 : -1
  return {
    x: direction * (point.x * horizontal.x + point.y * horizontal.y),
    y: point.x * vertical.x + point.y * vertical.y,
  }
}

function distance(left: ProfilePoint, right: ProfilePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function angleAt(vertex: ProfilePoint, first: ProfilePoint, second: ProfilePoint): number | null {
  const left = { x: first.x - vertex.x, y: first.y - vertex.y }
  const right = { x: second.x - vertex.x, y: second.y - vertex.y }
  const denominator = Math.hypot(left.x, left.y) * Math.hypot(right.x, right.y)
  if (denominator <= EPSILON) return null
  const cosine = Math.max(-1, Math.min(1, (left.x * right.x + left.y * right.y) / denominator))
  return Math.acos(cosine) * 180 / Math.PI
}

/** Signed perpendicular distance, positive toward the visible anterior face. */
function forwardDistanceToLine(point: ProfilePoint, lineStart: ProfilePoint, lineEnd: ProfilePoint): number | null {
  const line = { x: lineEnd.x - lineStart.x, y: lineEnd.y - lineStart.y }
  const length = Math.hypot(line.x, line.y)
  if (length <= EPSILON) return null
  let normal = { x: line.y / length, y: -line.x / length }
  if (normal.x < 0) normal = { x: -normal.x, y: -normal.y }
  if (normal.x <= 1e-4) return null
  return (point.x - lineStart.x) * normal.x + (point.y - lineStart.y) * normal.y
}

function fittedLineInclination(points: readonly ProfilePoint[]): number | null {
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
  const covariance = points.reduce((value, point) => {
    const x = point.x - center.x
    const y = point.y - center.y
    value.xx += x * x
    value.xy += x * y
    value.yy += y * y
    return value
  }, { xx: 0, xy: 0, yy: 0 })
  const spread = covariance.xx + covariance.yy
  if (spread <= EPSILON) return null
  const angle = 0.5 * Math.atan2(2 * covariance.xy, covariance.xx - covariance.yy)
  return Math.atan2(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle))) * 180 / Math.PI
}

export function computeProfileGeometry(input: ProfileGeometryInput): ProfileGeometryResult {
  const { landmarks, orientation, neckLandmarks } = input
  const axisDegrees = input.headAxisAngleDegrees ?? 0
  const unavailableMetrics: Partial<Record<ProfileMeasurementName, string>> = {}
  if (landmarks.length < PROFILE_LANDMARK_COUNT) {
    return { status: 'insufficient', reason: 'native_39_landmarks_required', measuredMetricCount: 0, unavailableMetrics }
  }
  if (!Number.isFinite(axisDegrees) || !landmarks.slice(0, PROFILE_LANDMARK_COUNT).every(finitePoint)) {
    return { status: 'insufficient', reason: 'non_finite_profile_geometry', measuredMetricCount: 0, unavailableMetrics }
  }

  const points = landmarks.slice(0, PROFILE_LANDMARK_COUNT)
    .map((point) => canonicalPoint(point, orientation, axisDegrees))
  const at = (name: keyof typeof profileLandmarks) => points[profileLandmarks[name].index]
  const brow = at('browCenterProxy')
  const nasalRoot = at('nasalRootProxy')
  const noseTip = at('noseTip')
  const columella = at('columella')
  const subnasale = at('subnasale')
  const upperLip = at('upperLip')
  const lowerLip = at('lowerLip')
  const fold = at('mentolabialFold')
  const pogonion = at('softTissuePogonion')
  const menton = at('menton')
  const faceHeight = Math.abs(menton.y - brow.y)
  if (faceHeight <= EPSILON) {
    return { status: 'insufficient', reason: 'degenerate_profile_face_height', measuredMetricCount: 0, unavailableMetrics }
  }

  const minimumSegment = faceHeight * 0.005
  const requiredSegments = [
    [nasalRoot, subnasale], [subnasale, pogonion], [noseTip, pogonion],
    [columella, subnasale], [subnasale, upperLip], [lowerLip, fold], [fold, pogonion],
  ] as const
  if (requiredSegments.some(([left, right]) => distance(left, right) < minimumSegment)) {
    return { status: 'insufficient', reason: 'collapsed_required_profile_landmarks', measuredMetricCount: 0, unavailableMetrics }
  }
  const midfaceHeight = subnasale.y - brow.y
  const lowerFaceHeight = pogonion.y - subnasale.y
  if (midfaceHeight <= minimumSegment || lowerFaceHeight <= minimumSegment) {
    return { status: 'insufficient', reason: 'vertical_landmark_order_invalid', measuredMetricCount: 0, unavailableMetrics }
  }

  const convexity = angleAt(subnasale, nasalRoot, pogonion)
  const nasolabial = angleAt(subnasale, columella, upperLip)
  const mentolabial = angleAt(fold, lowerLip, pogonion)
  const upperELine = forwardDistanceToLine(upperLip, noseTip, pogonion)
  const lowerELine = forwardDistanceToLine(lowerLip, noseTip, pogonion)
  const chinProjection = forwardDistanceToLine(pogonion, nasalRoot, subnasale)
  const jawPoints = profileContourSegments.lowerMandibularBorder.map((index) => points[index])
  const mandibularInclination = fittedLineInclination(jawPoints)
  if ([convexity, nasolabial, mentolabial, upperELine, lowerELine, chinProjection, mandibularInclination]
    .some((value) => value === null || !Number.isFinite(value))) {
    return { status: 'insufficient', reason: 'degenerate_profile_measurement_line', measuredMetricCount: 0, unavailableMetrics }
  }

  let cervicomentalAngle: number | null = null
  if (neckLandmarks && finitePoint(neckLandmarks.cervicomentalPoint) && finitePoint(neckLandmarks.lowerNeckPoint)) {
    const cervical = canonicalPoint(neckLandmarks.cervicomentalPoint, orientation, axisDegrees)
    const lowerNeck = canonicalPoint(neckLandmarks.lowerNeckPoint, orientation, axisDegrees)
    cervicomentalAngle = angleAt(cervical, menton, lowerNeck)
    if (cervicomentalAngle === null || distance(cervical, lowerNeck) < minimumSegment) {
      cervicomentalAngle = null
      unavailableMetrics.cervicomentalAngle = 'neck_tangent_is_degenerate'
    }
  } else {
    unavailableMetrics.cervicomentalAngle = 'native_39_markup_has_no_neck_tangent'
  }

  const verticalTotal = midfaceHeight + lowerFaceHeight
  const evidence:Record<string,MeasurementEvidence>={}
  if(input.imageWidth&&input.imageHeight){
    const width=input.imageWidth,height=input.imageHeight,rad=axisDegrees*Math.PI/180,sign=orientation==='right'?1:-1
    const toPixel=(p:ProfilePoint)=>({x:sign*p.x*Math.cos(rad)-p.y*Math.sin(rad),y:sign*p.x*Math.sin(rad)+p.y*Math.cos(rad)})
    const names:Record<number,string>={8:'下颌下缘',10:'颏前点',11:'唇下凹点',14:'眉部',17:'鼻梁代理',19:'鼻尖',20:'鼻部下缘',21:'鼻基底代理',27:'上唇',33:'下唇'}
    const foot=(p:ProfilePoint,a:ProfilePoint,b:ProfilePoint)=>{const dx=b.x-a.x,dy=b.y-a.y,t=((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy);return{x:a.x+t*dx,y:a.y+t*dy}}
    const heightPoint={id:'height-end',label:'参考高终点',...toPixel({x:brow.x,y:menton.y})}
    const add=(code:string,indices:number[],extra:EvidencePoint[],segments:EvidenceSegment[],formula:string)=>{evidence[code]={version:'HEADUP-POINT-LINE-1',source:'saved_profile_landmarks',width,height,points:[...indices.map(i=>({id:'p'+i,label:names[i]??'点'+i,x:landmarks[i].x,y:landmarks[i].y})),...extra],segments,formula}}
    const seg=(id:string,label:string,from:string,to:string,role:EvidenceSegment['role']='measure'):EvidenceSegment=>({id,label,from,to,role})
    const refHeight=seg('height','面部参考高','p14','height-end','reference')
    add('PROFILE-ANGLE-01',[17,21,10],[],[seg('a','鼻梁至鼻基底','p21','p17'),seg('b','鼻基底至颏点','p21','p10')],'两条线在鼻基底代理点处的夹角')
    add('PROFILE-ANGLE-03',[20,21,27],[],[seg('a','鼻部下缘线','p21','p20'),seg('b','上唇参考线','p21','p27')],'鼻部下缘线与上唇参考线的夹角（照片三点代理）')
    add('PROFILE-ANGLE-04',[33,11,10],[],[seg('a','下唇至凹点','p11','p33'),seg('b','凹点至颏点','p11','p10')],'两条线在唇下凹点处的夹角')
    add('PROFILE-LINE-02',[19,10,27,33,14,8],[heightPoint,{id:'upper-foot',label:'上唇垂足',...toPixel(foot(upperLip,noseTip,pogonion))},{id:'lower-foot',label:'下唇垂足',...toPixel(foot(lowerLip,noseTip,pogonion))}],[seg('eline','鼻尖—颏点参考线','p19','p10','reference'),seg('upper','上唇垂距','p27','upper-foot'),seg('lower','下唇垂距','p33','lower-foot'),refHeight],'上/下唇到参考线的带方向垂距 ÷ 面部参考高 × 100%')
    add('PROFILE-RATIO-05',[17,21,10,14,8],[heightPoint,{id:'chin-foot',label:'颏点垂足',...toPixel(foot(pogonion,nasalRoot,subnasale))}],[seg('baseline','鼻梁—鼻基底参考线','p17','p21','reference'),seg('chin-distance','颏点垂距','p10','chin-foot'),refHeight],'颏点到参考线的带方向垂距 ÷ 面部参考高 × 100%')
    add('PROFILE-RATIO-07',[14,21,10],[{id:'middle-end',label:'中段投影',...toPixel({x:brow.x,y:subnasale.y})},{id:'lower-end',label:'下段投影',...toPixel({x:brow.x,y:pogonion.y})}],[seg('mid','中段高度','p14','middle-end'),seg('lower','下段高度','middle-end','lower-end'),seg('total','总参考高','p14','lower-end','reference'),seg('mid-projection','中段投影线','p21','middle-end','projection'),seg('lower-projection','下段投影线','p10','lower-end','projection')],'中段或下段投影高度 ÷ 两段总高度 × 100%')
    const diagonalReference=seg('height','眉部至下颌下缘参考长','p14','p8','reference')
    add('PROFILE-AUX-01',[14,17,19],[],[seg('a','眉部至鼻梁','p17','p14'),seg('b','鼻梁至鼻尖','p17','p19')],'两条线在鼻梁代理点处的夹角')
    add('PROFILE-AUX-02',[17,19,14,8],[heightPoint],[seg('nose-length','鼻梁至鼻尖长度','p17','p19'),diagonalReference],'鼻梁至鼻尖直线长度 ÷ 眉部至下颌下缘参考长 × 100%')
    add('PROFILE-AUX-03',[17,21,19,14,8],[heightPoint,{id:'nose-foot',label:'鼻尖垂足',...toPixel(foot(noseTip,nasalRoot,subnasale))}],[seg('base','鼻梁—鼻基底线','p17','p21','reference'),seg('projection','鼻尖垂距','p19','nose-foot'),diagonalReference],'鼻尖到鼻梁—鼻基底线的垂距 ÷ 眉部至下颌下缘参考长 × 100%')
    evidence['PROFILE-AUX-04']={...evidence['PROFILE-LINE-02'],formula:'上唇带方向距离减下唇带方向距离，除以面部参考高 × 100%'}
    add('PROFILE-AUX-05',[33,11,10,14,8],[heightPoint,{id:'fold-foot',label:'凹点垂足',...toPixel(foot(fold,lowerLip,pogonion))}],[seg('base','下唇—颏点线','p33','p10','reference'),seg('fold-depth','凹点垂距','p11','fold-foot'),diagonalReference],'唇下凹点到下唇—颏点线的垂距 ÷ 眉部至下颌下缘参考长 × 100%')
    add('PROFILE-AUX-06',[10,8,21],[],[seg('chin','颏点至下颌下缘','p10','p8'),seg('lower','鼻基底至下颌下缘','p21','p8','reference')],'颏点至下颌下缘长度 ÷ 鼻基底至下颌下缘长度 × 100%')
    add('PROFILE-AUX-07',[14,19,10],[],[seg('a','鼻尖至眉部','p19','p14'),seg('b','鼻尖至颏点','p19','p10')],'眉部—鼻尖—颏点两条线的夹角')

  }
  return {
    status: 'measured',
    evidence,
    geometry: {
      softTissueConvexityAngleDegrees: convexity as number,
      eLineUpperLipDistanceFaceHeightRatio: (upperELine as number) / faceHeight,
      eLineLowerLipDistanceFaceHeightRatio: (lowerELine as number) / faceHeight,
      nasolabialAngleDegrees: nasolabial as number,
      mentolabialAngleDegrees: mentolabial as number,
      softTissueChinProjectionFaceHeightRatio: (chinProjection as number) / faceHeight,
      mandibularPlaneInclinationDegrees: mandibularInclination as number,
      cervicomentalAngleDegrees: cervicomentalAngle,
      verticalMidfaceShare: midfaceHeight / verticalTotal,
      verticalLowerFaceShare: lowerFaceHeight / verticalTotal,
    },
    measuredMetricCount: cervicomentalAngle === null ? 7 : 8,
    unavailableMetrics,
    normalization: 'brow-to-menton projected face height',
    limitations: [
      'All values describe visible soft tissue in one standardized profile photograph.',
      'The mandibular inclination is a visible-contour proxy and cannot replace FMA or MP-SN.',
      'No value establishes maxillary or mandibular skeletal diagnosis.',
    ],
  }
}
