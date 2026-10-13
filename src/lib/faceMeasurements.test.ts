import { describe, expect, it } from 'vitest'
import type { LandmarkPoint } from '../types'
import { analyzeCaptures, buildVisibleFrontTendency, computeFrontGeometry, computeBrowPeakMidfaceHeightRatio, measureFrontLandmarks } from './faceMeasurements'

function fixtureLandmarks(): LandmarkPoint[] {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  const set = (index: number, x: number, y: number) => { points[index] = { x, y, z: 0 } }
  set(10, 0.5, 0.1); set(1, 0.5, 0.45); set(2, 0.5, 0.6); set(152, 0.5, 0.9); set(168, 0.5, 0.3)
  set(6, 0.5, 0.36); set(0, 0.5, 0.68); set(17, 0.5, 0.72)
  set(37, 0.47, 0.68); set(84, 0.47, 0.72); set(267, 0.53, 0.68); set(314, 0.53, 0.72)
  set(234, 0.1, 0.5); set(454, 0.9, 0.5); set(172, 0.2, 0.78); set(397, 0.8, 0.78)
  set(54, 0.14, 0.22); set(284, 0.86, 0.22)
  set(33, 0.2, 0.4); set(133, 0.35, 0.4); set(362, 0.65, 0.4); set(263, 0.8, 0.4)
  set(61, 0.35, 0.7); set(291, 0.65, 0.7)
  set(98, 0.43, 0.55); set(327, 0.57, 0.55)
  set(70, 0.24, 0.32); set(300, 0.76, 0.32); set(105, 0.36, 0.31); set(334, 0.64, 0.31)
  set(93, 0.18, 0.58); set(323, 0.82, 0.58); set(58, 0.25, 0.72); set(288, 0.75, 0.72); set(127, 0.14, 0.35); set(356, 0.86, 0.35)
  set(21, 0.3, 0.26); set(251, 0.7, 0.26)
  for (let index = 468; index < 473; index++) set(index, 0.3, 0.4)
  for (let index = 473; index < 478; index++) set(index, 0.7, 0.4)
  return points
}

describe('face measurements', () => {
  it.each([5,-5,0])('keeps bilateral anatomical eye tilt at %s degrees through rotation and mirroring', tilt => {
    const points=fixtureLandmarks(),dy=.15*Math.tan(tilt*Math.PI/180)
    points[33].y=.4-dy;points[133].y=.4;points[362].y=.4;points[263].y=.4-dy
    for(const rotation of [-12,0,12]) {
      const a=rotation*Math.PI/180
      const rotated=points.map(p=>({...p,x:.5+(p.x-.5)*Math.cos(a)-(p.y-.5)*Math.sin(a),y:.5+(p.x-.5)*Math.sin(a)+(p.y-.5)*Math.cos(a)}))
      expect(computeFrontGeometry(rotated)!.eyeCanthalTiltDegrees).toBeCloseTo(tilt,8)
    }
    // Mirror image and swap the two eye semantics as a detector would.
    const mirrored=points.map(p=>({...p,x:1-p.x}))
    for(const [l,r] of [[33,263],[133,362]]) [mirrored[l],mirrored[r]]=[mirrored[r],mirrored[l]]
    expect(computeFrontGeometry(mirrored)!.eyeCanthalTiltDegrees).toBeCloseTo(tilt,8)
    const wide=points.map(p=>({...p,x:p.x/2}))
    expect(computeFrontGeometry(wide,2,1)!.eyeCanthalTiltDegrees).toBeCloseTo(tilt,8)
  })

  it('averages opposite anatomical eye tilts without inventing a bilateral tilt',()=>{
    const points=fixtureLandmarks(),dy=.15*Math.tan(5*Math.PI/180)
    points[33].y=.4-dy;points[263].y=.4+dy
    expect(computeFrontGeometry(points)!.eyeCanthalTiltDegrees).toBeCloseTo(0,8)
  })
  it('derives deterministic ratios from normalized landmarks', () => {
    const measurements = measureFrontLandmarks(fixtureLandmarks(), 90)
    expect(measurements).toHaveLength(12)
    expect(measurements.find((item) => item.label === '可见脸长宽比')?.value).toBe('1.000')
    expect(measurements.find((item) => item.label === '眼间距比')?.value).toBe('2.000')
    expect(measurements.find((item) => item.label === '12 点镜像残差')?.value).toBe('0.00%')
    expect(measurements.filter((item) => item.reliability === 'comparatively_stable')).toHaveLength(2)
    expect(new Set(measurements.map((item) => item.score))).toEqual(new Set([90]))
    expect(new Set(measurements.map((item) => item.code)).size).toBe(12)
    expect(measurements.every((item) => item.formula && item.landmarkIndices && item.confidenceBasis)).toBe(true)
    expect(measurements.filter(item=>item.code!=='FRONT-ANGLE-01').every((item) => item.confidenceBasis?.includes('不是解剖准确率'))).toBe(true)
    expect(measurements.every((item) => !/P95|漂移|误差/.test(item.note))).toBe(true)
    expect(measurements.filter(item=>item.code!=='FRONT-ANGLE-01'&&item.code!=='FRONT-RATIO-10').every((item) => item.errors?.length)).toBe(true)
    expect(measurements.find(item=>item.code==='FRONT-ANGLE-01')).toMatchObject({errors:[],reliability:'capture_sensitive'})
    expect(measurements.find((item) => item.code === 'FRONT-SYM-01')?.errors?.[1]).toMatchObject({ kind: 'absolute', unit: 'percentage_points', value: 16.23 })
    expect(measurements.find((item) => item.code === 'FRONT-RATIO-02')?.errors?.[0]).toMatchObject({ kind: 'relative', unit: 'percent', value: 3.34 })
    const tendency = buildVisibleFrontTendency(fixtureLandmarks())!
    expect(tendency.label).toContain('下颌轮廓比例居中')
    expect(['椭圆', '圆形', '方形', '心形', '菱形', '长形']).toContain(tendency.shapeLabel)
    expect(tendency.evidence).toEqual(expect.arrayContaining([{ label: '镜像残差', value: '0.00%' }]))
    expect(tendency.disclosure).toContain('不等同于真实发际线')
  })

  it('computes the complete geometry candidates required by the V1 specification', async () => {
    const { computeFrontGeometry } = await import('./faceMeasurements')
    const geometry = computeFrontGeometry(fixtureLandmarks())
    expect(geometry?.mirrorResidual).toBeCloseTo(0, 10)
    expect(geometry?.visibleFaceLengthWidthRatio).toBeCloseTo(1, 10)
    expect(geometry?.pupilDistanceFaceWidthRatio).toBeCloseTo(0.5, 10)
    expect(geometry?.interEyeRatio).toBeCloseTo(2, 10)
    expect(geometry?.eyeCanthalTiltDegrees).toBeCloseTo(0, 10)
    expect(geometry?.visibleForeheadWidthRatio).toBeCloseTo(0.9, 10)
    expect(geometry?.jawWidthRatio).toBeCloseTo(0.75, 10)
    expect(geometry?.mouthWidthRatio).toBeCloseTo(0.375, 10)
    expect(geometry?.midfaceHeightRatio).toBeCloseTo(0.375, 10)
    expect(geometry?.lowerFaceHeightRatio).toBeCloseTo(0.375, 10)
    expect(geometry?.midLowerFaceHeightRatio).toBeCloseTo(1, 10)
    expect(geometry?.noseMouthWidthRatio).toBeCloseTo(0.466667, 5)
    expect(geometry?.noseLengthFaceHeightRatio).toBeCloseTo(0.1875, 5)
    expect(geometry?.lipHeightMouthWidthRatio).toBeCloseTo(0.133333, 5)
  })

  it('fits the face axis and resists one landmark-pair outlier in the symmetry proxy', async () => {
    const { computeFrontGeometry } = await import('./faceMeasurements')
    const angle = 4 * Math.PI / 180
    const rotated = fixtureLandmarks().map((point) => {
      const x = point.x - 0.5
      const y = point.y - 0.5
      return { ...point, x: 0.5 + x * Math.cos(angle) - y * Math.sin(angle), y: 0.5 + x * Math.sin(angle) + y * Math.cos(angle) }
    })
    expect(computeFrontGeometry(rotated)?.mirrorResidual).toBeCloseTo(0, 10)
    expect(computeFrontGeometry(rotated)?.eyeCanthalTiltDegrees).toBeCloseTo(0, 10)

    const withOutlier = fixtureLandmarks()
    withOutlier[70] = { ...withOutlier[70], x: withOutlier[70].x - 0.12 }
    expect(computeFrontGeometry(withOutlier)?.mirrorResidual).toBeCloseTo(0, 10)
  })

  it('does not fabricate measurements when landmarks are absent', () => {
    const result = analyzeCaptures([{ id: 'front', label: '正面', eyebrow: '', hint: '' }])
    expect(result.status).toBe('insufficient')
    expect(result.measurements).toEqual([])
  })

  it('restores normalized landmarks to a common image-plane scale', () => {
    const square = measureFrontLandmarks(fixtureLandmarks(), 90, 1000, 1000)
    const wide = measureFrontLandmarks(fixtureLandmarks(), 90, 2000, 1000)
    expect(square.find((item) => item.label === '可见脸长宽比')?.value).toBe('1.000')
    expect(wide.find((item) => item.label === '可见脸长宽比')?.value).toBe('0.500')
    expect(wide.find((item) => item.label === '眼间距比')?.value).toBe('2.000')
  })

  it('rejects invalid landmark image dimensions', () => {
    expect(measureFrontLandmarks(fixtureLandmarks(), 90, 0, 1000)).toEqual([])
  })

  it('uses the saved mesh lip heights even when historical callers pass a different ensemble scalar', async () => {
    const { computeFrontGeometry, computeTriMedianLipHeightMouthWidthRatio } = await import('./faceMeasurements')
    const landmarks = fixtureLandmarks()
    const candidate = computeTriMedianLipHeightMouthWidthRatio(landmarks)
    expect(candidate).toBeCloseTo(0.133333, 5)
    const baseline = computeFrontGeometry(landmarks)
    const overridden = computeFrontGeometry(landmarks, 1, 1, 0.2)
    expect(overridden?.lipHeightMouthWidthRatio).toBeCloseTo(candidate!, 10)
    expect(overridden?.visibleFaceLengthWidthRatio).toBeCloseTo(baseline!.visibleFaceLengthWidthRatio, 10)
    expect(measureFrontLandmarks(landmarks, 90, 1, 1, 0.2).find((item) => item.code === 'FRONT-RATIO-10')).toMatchObject({value:'0.133',errors:[],evidence:{source:'saved_front_landmarks'}})
  })

  it('keeps the brow-peak midpoint midface formula research-only until recalibrated',()=>{
    const landmarks=fixtureLandmarks();landmarks[105]={x:.35,y:.25,z:0};landmarks[334]={x:.65,y:.25,z:0};landmarks[2]={x:.5,y:.55,z:0}
    expect(computeBrowPeakMidfaceHeightRatio(landmarks,1000,1000)).toBeCloseTo(.375,10)
    expect(measureFrontLandmarks(landmarks,90,1000,1000).find(item=>item.code==='FRONT-RATIO-06')?.formula).toContain('distance(168, 2)')
  })
})

it('withholds front readouts when capture posture or image quality is rejected even if points exist',()=>{
 const base={id:'front' as const,label:'正面',hint:'',eyebrow:'',url:'blob:test',poseValidation:{status:'pass' as const,estimatedPose:'front' as const,detectedFaces:1,flags:[],landmarks:fixtureLandmarks(),landmarkImageWidth:1000,landmarkImageHeight:1000},quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]}}
 expect(analyzeCaptures([base]).measurements.length).toBeGreaterThan(0)
 expect(analyzeCaptures([{...base,poseValidation:{...base.poseValidation,status:'reject',flags:['头部角度偏差']}}]).measurements).toEqual([])
 expect(analyzeCaptures([{...base,quality:{...base.quality,score:20,flags:['光线不足']}}]).measurements).toEqual([])
 expect(analyzeCaptures([{...base,acceptedWithBias:true}]).measurements).toEqual([])
})
