import type { LandmarkPoint, PoseValidation } from '../types'

type Point = { x: number; y: number }
export type ProfilePhotoPath = { code: string; label: string; points: Point[]; category: 'contour' | 'evidence' }
export type ProfilePhotoMetric = {
  code: string
  label: string
  value: string
  interpretation: string
  formula: string
  reliability: 'experimental_capture_sensitive'
}
export type ProfilePhotoAnalysis = {
  status: 'experimental'
  width: number
  height: number
  points: Array<{ index: number; x: number; y: number }>
  paths: ProfilePhotoPath[]
  metrics: ProfilePhotoMetric[]
  limitation: string
}

const ANTERIOR_CONTOUR = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 0, 17, 18, 200, 199, 175, 152] as const
const RIGHT_JAW_CONTOUR = [152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454] as const
const LEFT_JAW_CONTOUR = [152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234] as const
const EVIDENCE_POINTS = [168, 1, 2, 0, 17, 152] as const
const EPSILON = 1e-8

function finiteLandmark(point: LandmarkPoint | undefined) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= -0.25 && point.x <= 1.25 && point.y >= -0.25 && point.y <= 1.25)
}

function pixel(point: LandmarkPoint, width: number, height: number): Point { return { x: point.x * width, y: point.y * height } }
function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) }
function angleAt(vertex: Point, first: Point, second: Point) {
  const a = { x: first.x - vertex.x, y: first.y - vertex.y }
  const b = { x: second.x - vertex.x, y: second.y - vertex.y }
  const denominator = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)
  if (denominator <= EPSILON) return null
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / denominator))) * 180 / Math.PI
}
function lineDistance(point: Point, start: Point, end: Point) {
  const length = distance(start, end)
  if (length <= EPSILON) return null
  return Math.abs((end.x - start.x) * (start.y - point.y) - (start.x - point.x) * (end.y - start.y)) / length
}
function rotate(point: Point, origin: Point, degrees: number): Point {
  const angle = -degrees * Math.PI / 180
  const x = point.x - origin.x
  const y = point.y - origin.y
  return { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) }
}

export function analyzeVisibleProfilePhoto(pose: PoseValidation | undefined): ProfilePhotoAnalysis | null {
  const landmarks = pose?.landmarks
  const width = pose?.landmarkImageWidth
  const height = pose?.landmarkImageHeight
  if (pose?.status !== 'pass' || !['right_profile','left_profile'].includes(pose.estimatedPose) || !landmarks || landmarks.length < 478 || !width || !height) return null
  const isLeft = pose.estimatedPose === 'left_profile'
  const jawContour = isLeft ? LEFT_JAW_CONTOUR : RIGHT_JAW_CONTOUR
  const required = [...new Set([...ANTERIOR_CONTOUR, ...jawContour, ...EVIDENCE_POINTS])]
  if (!required.every((index) => finiteLandmark(landmarks[index]))) return null
  const at = (index: number) => pixel(landmarks[index], width, height)
  const root = at(168), noseTip = at(1), subnasale = at(2), upperLip = at(0), lowerLip = at(17), chin = at(152)
  const faceHeight = distance(root, chin)
  if (faceHeight < Math.min(width, height) * 0.05) return null
  const convexity = angleAt(subnasale, root, chin)
  const noseProjection = lineDistance(noseTip, root, chin)
  const upperELine = lineDistance(upperLip, noseTip, chin)
  const lowerELine = lineDistance(lowerLip, noseTip, chin)
  if ([convexity, noseProjection, upperELine, lowerELine].some((value) => value === null || !Number.isFinite(value))) return null
  const roll = Number.isFinite(pose.roll) ? pose.roll! : 0
  const canonicalRoot = rotate(root, root, roll)
  const canonicalSubnasale = rotate(subnasale, root, roll)
  const canonicalChin = rotate(chin, root, roll)
  const verticalTotal = Math.abs(canonicalChin.y - canonicalRoot.y)
  const lowerShare = verticalTotal > EPSILON ? Math.abs(canonicalChin.y - canonicalSubnasale.y) / verticalTotal : null
  if (lowerShare === null || !Number.isFinite(lowerShare)) return null
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const paths: ProfilePhotoPath[] = [
    { code: 'anterior_contour', label: '额—鼻—唇—颏可见轮廓代理', points: ANTERIOR_CONTOUR.map(at), category: 'contour' },
    { code: isLeft ? 'left_jaw_contour' : 'right_jaw_contour', label: `${isLeft?'左':'右'}侧可见下颌轮廓代理`, points: jawContour.map(at), category: 'contour' },
    { code: 'convexity_root_subnasale', label: '鼻根代理至鼻下代理', points: [root, subnasale], category: 'evidence' },
    { code: 'convexity_subnasale_chin', label: '鼻下代理至下颏最低点', points: [subnasale, chin], category: 'evidence' },
    { code: 'eline_proxy', label: '鼻尖—下颏可见线代理', points: [noseTip, chin], category: 'evidence' },
  ]
  return {
    status: 'experimental', width, height,
    points: EVIDENCE_POINTS.map((index) => ({ index, ...at(index) })),
    paths,
    metrics: [
      { code: 'PROFILE-PHOTO-01', label: '鼻根—鼻下—下颏可见角代理', value: `${convexity!.toFixed(1)}°`, interpretation: '仅描述本张侧面照片的可见折线开合，不等同于原生39点软组织面凸角。', formula: 'angle(MediaPipe 168, 2, 152)', reliability: 'experimental_capture_sensitive' },
      { code: 'PROFILE-PHOTO-02', label: '鼻尖突出可见代理', value: percent(noseProjection! / faceHeight), interpretation: '鼻尖到鼻根—下颏线的2D距离，占可见侧脸高的比例。', formula: 'distance(point 1, line 168–152) ÷ distance(168,152)', reliability: 'experimental_capture_sensitive' },
      { code: 'PROFILE-PHOTO-03', label: '上唇至鼻尖—下颏线距离', value: percent(upperELine! / faceHeight), interpretation: '只报告绝对距离，不判断唇部前突、内收或治疗需要。', formula: 'distance(point 0, line 1–152) ÷ distance(168,152)', reliability: 'experimental_capture_sensitive' },
      { code: 'PROFILE-PHOTO-04', label: '下唇至鼻尖—下颏线距离', value: percent(lowerELine! / faceHeight), interpretation: '只报告绝对距离，不判断唇部前突、内收或治疗需要。', formula: 'distance(point 17, line 1–152) ÷ distance(168,152)', reliability: 'experimental_capture_sensitive' },
      { code: 'PROFILE-PHOTO-05', label: '可见下面部高度占比代理', value: percent(lowerShare), interpretation: '鼻下代理至下颏最低点的垂直份额，受俯仰、下颏点与软组织影响。', formula: '|y(152)−y(2)| ÷ |y(152)−y(168)| after roll correction', reliability: 'experimental_capture_sensitive' },
    ],
    limitation: 'MediaPipe 478点并非经HeadUp验证的原生侧貌39点语义。当前结果只用于轮廓可视化与同条件照片记录，不进入美学总分、骨性倾向或正式侧貌报告。',
  }
}
