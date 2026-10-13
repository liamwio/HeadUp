import type { LandmarkPoint } from '../types'
import type { EvidencePoint, EvidenceSegment, MeasurementEvidence } from './measurementEvidence'

export type FrontPointMeasurement = { value: number; evidence: MeasurementEvidence }
export type FrontEvidenceAxes = {
  origin: { x: number; y: number }
  horizontal: { x: number; y: number }
  vertical: { x: number; y: number }
}

/** Use the same complete image/point contract for both numerical and visual evidence. */
export function validFrontMeasurementInput(landmarks: readonly LandmarkPoint[], width: number, height: number) {
  return landmarks.length === 478 && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    && landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
      && point.x >= -.25 && point.x <= 1.25 && point.y >= -.25 && point.y <= 1.25
      && Number.isFinite(point.x * width) && Number.isFinite(point.y * height))
}

const names: Record<number, string> = {
  10: '额部可见点', 152: '下巴下缘点', 234: '脸宽左端', 454: '脸宽右端',
  172: '下颌左端', 397: '下颌右端', 61: '左嘴角', 291: '右嘴角',
  168: '眉间代理点', 2: '鼻底代理点', 98: '鼻翼左侧代理点', 327: '鼻翼右侧代理点', 1: '鼻尖代理点',
  33: '左外眼角', 133: '左内眼角', 362: '右内眼角', 263: '右外眼角',
  37: '左侧上唇点', 84: '左侧下唇点', 0: '中央上唇点', 17: '中央下唇点', 267: '右侧上唇点', 314: '右侧下唇点',
}

function builder(landmarks: readonly LandmarkPoint[], width: number, height: number) {
  const points: EvidencePoint[] = [], segments: EvidenceSegment[] = []
  const point = (index: number) => {
    const id = `mp-${index}`
    if (!points.some(p => p.id === id)) points.push({ id, label: names[index] ?? `关键点${index}`, x: landmarks[index].x * width, y: landmarks[index].y * height })
    return id
  }
  const derived = (id: string, label: string, x: number, y: number) => { points.push({ id, label, x, y }); return id }
  const segment = (id: string, label: string, from: number | string, to: number | string, role: EvidenceSegment['role']) => {
    const fromId = typeof from === 'number' ? point(from) : from, toId = typeof to === 'number' ? point(to) : to
    segments.push({ id, label, from: fromId, to: toId, role })
    const a = points.find(p => p.id === fromId)!, b = points.find(p => p.id === toId)!
    return Math.hypot(b.x - a.x, b.y - a.y)
  }
  const complete = (formula: string): MeasurementEvidence => ({ version: 'HEADUP-POINT-LINE-1', source: 'saved_front_landmarks', width, height, points, segments, formula })
  return { points, point, derived, segment, complete }
}

/** Every ratio below is calculated from the exact endpoints emitted in its evidence. */
export function buildFrontPointMeasurements(landmarks: readonly LandmarkPoint[], width: number, height: number): Record<string, FrontPointMeasurement> | null {
  if (!validFrontMeasurementInput(landmarks, width, height)) return null
  const output: Record<string, FrontPointMeasurement> = {}
  const pairs = [
    ['FRONT-RATIO-01', '可见脸高', 10, 152, '可见脸宽', 234, 454],
    ['FRONT-RATIO-04', '下颌宽度', 172, 397, '可见脸宽', 234, 454],
    ['FRONT-RATIO-05', '嘴巴宽度', 61, 291, '可见脸宽', 234, 454],
    ['FRONT-RATIO-06', '中面部直线长度', 168, 2, '可见脸高', 10, 152],
    ['FRONT-RATIO-07', '下半脸直线长度', 2, 152, '可见脸高', 10, 152],
    ['FRONT-RATIO-08', '鼻翼代理宽度', 98, 327, '嘴巴宽度', 61, 291],
    ['FRONT-RATIO-09', '鼻根—鼻尖直线长度', 168, 1, '可见脸高', 10, 152],
  ] as const
  for (const [code, numeratorLabel, a, b, denominatorLabel, c, d] of pairs) {
    const evidence = builder(landmarks, width, height)
    const numerator = evidence.segment('numerator', numeratorLabel, a, b, 'measure')
    const denominator = evidence.segment('denominator', denominatorLabel, c, d, 'reference')
    if (!(denominator > height * .001)) return null
    output[code] = { value: numerator / denominator, evidence: evidence.complete(`${numeratorLabel} ÷ ${denominatorLabel}`) }
  }
  {
    const evidence = builder(landmarks, width, height)
    const center = (start: number, id: string, label: string) => {
      const ids = Array.from({ length: 5 }, (_, index) => evidence.point(start + index))
      const source = ids.map(id => evidence.points.find(p => p.id === id)!)
      return evidence.derived(id, label, source.reduce((sum, p) => sum + p.x, 0) / 5, source.reduce((sum, p) => sum + p.y, 0) / 5)
    }
    const left = center(468, 'iris-left-center', '左虹膜平均中心'), right = center(473, 'iris-right-center', '右虹膜平均中心')
    const pupil = evidence.segment('numerator', '两眼虹膜中心距', left, right, 'measure')
    const face = evidence.segment('denominator', '可见脸宽', 234, 454, 'reference')
    if (!(face > height * .001)) return null
    output['FRONT-RATIO-02'] = { value: pupil / face, evidence: evidence.complete('两眼虹膜平均中心距 ÷ 可见脸宽') }
  }
  {
    const evidence = builder(landmarks, width, height)
    const gap = evidence.segment('numerator', '内眼角距离', 133, 362, 'measure')
    const left = evidence.segment('denominator-left', '左眼宽度', 33, 133, 'reference')
    const right = evidence.segment('denominator-right', '右眼宽度', 362, 263, 'reference')
    const denominator = (left + right) / 2
    if (!(denominator > height * .001)) return null
    output['FRONT-RATIO-03'] = { value: gap / denominator, evidence: evidence.complete('内眼角距离 ÷（左眼宽度与右眼宽度的平均值）') }
  }
  {
    const evidence = builder(landmarks, width, height)
    const heights = [
      evidence.segment('lip-height-left', '左侧外唇高度', 37, 84, 'measure'),
      evidence.segment('lip-height-center', '中央外唇高度', 0, 17, 'measure'),
      evidence.segment('lip-height-right', '右侧外唇高度', 267, 314, 'measure'),
    ].sort((a, b) => a - b)
    const mouth = evidence.segment('denominator', '嘴巴宽度', 61, 291, 'reference')
    if (!(mouth > height * .001)) return null
    output['FRONT-RATIO-10'] = { value: heights[1] / mouth, evidence: evidence.complete('本张照片三组外唇高度的中位数 ÷ 嘴巴宽度') }
  }
  return Object.values(output).every(result => Number.isFinite(result.value)) ? output : null
}

/** Axes use the same height-normalized image plane as fitFaceAxes. */
export function buildFrontEyeAngleEvidence(landmarks: readonly LandmarkPoint[], width: number, height: number, axes: FrontEvidenceAxes): FrontPointMeasurement | null {
  if (!validFrontMeasurementInput(landmarks, width, height)
    || [axes.origin, axes.horizontal, axes.vertical].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null
  const evidence = builder(landmarks, width, height)
  for (const index of [10, 168, 6, 1, 2, 152]) evidence.point(index)
  const start = evidence.derived('horizontal-start', '拟合水平轴起点', (axes.origin.x - axes.horizontal.x * .25) * height, (axes.origin.y - axes.horizontal.y * .25) * height)
  const end = evidence.derived('horizontal-end', '拟合水平轴终点', (axes.origin.x + axes.horizontal.x * .25) * height, (axes.origin.y + axes.horizontal.y * .25) * height)
  evidence.segment('horizontal-axis', '面部拟合水平轴', start, end, 'reference')
  evidence.segment('left-eye', '左外眼角→内眼角', 33, 133, 'measure')
  evidence.segment('right-eye', '右内眼角→外眼角', 362, 263, 'measure')
  const angle = (from: number, to: number) => {
    const a = evidence.points.find(p => p.id === `mp-${from}`)!, b = evidence.points.find(p => p.id === `mp-${to}`)!
    const x = b.x - a.x, y = b.y - a.y
    return Math.atan2(x * axes.vertical.x + y * axes.vertical.y, x * axes.horizontal.x + y * axes.horizontal.y) * 180 / Math.PI
  }
  return { value: (angle(33, 133) - angle(362, 263)) / 2, evidence: evidence.complete('（左眼角线相对拟合水平轴的有向角 − 右眼角线对应有向角）÷ 2') }
}
