import type { LandmarkPoint } from '../types'

export type FrontOverlayPoint = { index: number; x: number; y: number }
export type FrontOverlayLine = {
  code: string
  label: string
  category: 'measurement' | 'symmetry'
  x1: number
  y1: number
  x2: number
  y2: number
}
export type FrontOverlayContour = {
  code: string
  label: string
  points: Array<{ x: number; y: number }>
}

export type FrontLandmarkOverlay = {
  width: number
  height: number
  points: FrontOverlayPoint[]
  lines: FrontOverlayLine[]
  contours: FrontOverlayContour[]
}

const CONTOUR_PATHS = [
  ['face_oval', '可见脸部轮廓', [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10]],
  ['left_brow', '左眉可见轮廓', [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]],
  ['right_brow', '右眉可见轮廓', [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]],
  ['left_eye', '左眼可见轮廓', [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33]],
  ['right_eye', '右眼可见轮廓', [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 263]],
  ['nose_bridge', '鼻部中轴轮廓', [168, 6, 197, 195, 5, 4, 1, 19, 94, 2]],
  ['outer_lips', '外唇可见轮廓', [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]],
] as const

const MEASUREMENT_PAIRS = [
  ['visible_face_width', '可见脸宽 234–454', 234, 454],
  ['visible_face_height', '可见脸高 10–152', 10, 152],
  ['inner_eye_distance', '内眼角距 133–362', 133, 362],
  ['left_eye_tilt', '左眼角线 33–133', 33, 133],
  ['right_eye_tilt', '右眼角线 362–263', 362, 263],
  ['jaw_width', '下颌宽 172–397', 172, 397],
  ['mouth_width', '嘴宽 61–291', 61, 291],
  ['nose_width', '鼻翼宽代理 98–327', 98, 327],
  ['nose_length', '鼻长代理 168–1', 168, 1],
  ['lip_height_left', '外唇左侧高度 37–84', 37, 84],
  ['lip_height_center', '外唇中央高度 0–17', 0, 17],
  ['lip_height_right', '外唇右侧高度 267–314', 267, 314],
  ['midface_height', '中面部高 168–2', 168, 2],
  ['lower_face_height', '下面部高 2–152', 2, 152],
] as const

const SYMMETRY_PAIRS = [
  [33, 263], [133, 362], [70, 300], [105, 334], [61, 291], [98, 327],
  [234, 454], [172, 397], [93, 323], [58, 288], [127, 356], [21, 251],
] as const

function finiteLandmark(point: LandmarkPoint) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
    && point.x >= -0.25 && point.x <= 1.25 && point.y >= -0.25 && point.y <= 1.25
}

function pixel(point: LandmarkPoint, width: number, height: number) {
  return { x: point.x * width, y: point.y * height }
}

function line(
  landmarks: LandmarkPoint[], width: number, height: number,
  code: string, label: string, category: FrontOverlayLine['category'], leftIndex: number, rightIndex: number,
): FrontOverlayLine {
  const left = pixel(landmarks[leftIndex], width, height)
  const right = pixel(landmarks[rightIndex], width, height)
  return { code, label, category, x1: left.x, y1: left.y, x2: right.x, y2: right.y }
}

function irisCenter(landmarks: LandmarkPoint[], start: number, width: number, height: number) {
  const points = landmarks.slice(start, start + 5).map((point) => pixel(point, width, height))
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
}

export function buildFrontLandmarkOverlay(
  landmarks: LandmarkPoint[], width: number, height: number,
): FrontLandmarkOverlay | null {
  if (landmarks.length < 478 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const source = landmarks.slice(0, 478)
  if (!source.every(finiteLandmark)) return null
  const points = source.map((point, index) => ({ index, ...pixel(point, width, height) }))
  const lines: FrontOverlayLine[] = MEASUREMENT_PAIRS.map(([code, label, left, right]) => (
    line(source, width, height, code, label, 'measurement', left, right)
  ))
  const leftIris = irisCenter(source, 468, width, height)
  const rightIris = irisCenter(source, 473, width, height)
  lines.push({
    code: 'pupil_distance', label: '双侧虹膜中心距 468–477', category: 'measurement',
    x1: leftIris.x, y1: leftIris.y, x2: rightIris.x, y2: rightIris.y,
  })
  SYMMETRY_PAIRS.forEach(([left, right], index) => lines.push(line(
    source, width, height, `symmetry_pair_${String(index + 1).padStart(2, '0')}`,
    `镜像对 ${left}–${right}`, 'symmetry', left, right,
  )))
  const contours = CONTOUR_PATHS.map(([code, label, indices]) => ({
    code,
    label,
    points: indices.map((index) => pixel(source[index], width, height)),
  }))
  return { width, height, points, lines, contours }
}

export const frontOverlayLineContract = {
  measurementLines: MEASUREMENT_PAIRS.length + 1,
  symmetryLines: SYMMETRY_PAIRS.length,
  pointCount: 478,
  contourCount: CONTOUR_PATHS.length,
} as const
