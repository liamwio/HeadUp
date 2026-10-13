import { describe, expect, it } from 'vitest'
import type { LandmarkPoint, PoseValidation } from '../types'
import { analyzeVisibleProfilePhoto } from './profilePhotoAnalysis'

function fixture(): PoseValidation {
  const landmarks: LandmarkPoint[] = Array.from({ length: 478 }, (_, index) => ({ x: 0.25 + index / 4000, y: 0.1 + index / 1000, z: 0 }))
  const set = (index: number, x: number, y: number) => { landmarks[index] = { x, y, z: 0 } }
  ;[10,151,9,8,168,6,197,195,5,4].forEach((index, order) => set(index, 0.52 + order * .003, 0.12 + order * .025))
  set(168,.55,.30);set(1,.72,.43);set(19,.68,.46);set(94,.64,.49);set(2,.58,.52);set(0,.63,.58);set(17,.62,.64);set(18,.60,.67);set(200,.58,.70);set(199,.57,.73);set(175,.56,.76);set(152,.54,.82)
  ;[377,400,378,379,365,397,288,361,323,454].forEach((index, order) => set(index,.54+order*.018,.82-order*.025))
  return { status:'pass',estimatedPose:'right_profile',detectedFaces:1,yaw:-90,pitch:0,roll:0,landmarkImageWidth:1200,landmarkImageHeight:1200,landmarks,flags:[] }
}

describe('experimental visible profile photo analysis',()=>{
  it('builds right-profile contours and five explicitly experimental photo metrics',()=>{
    const result=analyzeVisibleProfilePhoto(fixture())
    expect(result?.status).toBe('experimental')
    expect(result?.paths.filter(path=>path.category==='contour')).toHaveLength(2)
    expect(result?.metrics).toHaveLength(5)
    expect(result?.metrics.every(metric=>metric.reliability==='experimental_capture_sensitive')).toBe(true)
    expect(result?.limitation).toContain('不进入美学总分')
  })
  it('uses mirrored left-jaw semantics while keeping overlays in original image coordinates',()=>{
    const right=fixture(),left={...right,estimatedPose:'left_profile' as const,yaw:90,landmarks:right.landmarks!.map(p=>({...p,x:1-p.x}))}
    for(const [r,l] of [[377,148],[400,176],[378,149],[379,150],[365,136],[397,172],[288,58],[361,132],[323,93],[454,234]])left.landmarks[l]={...right.landmarks![r],x:1-right.landmarks![r].x}
    const a=analyzeVisibleProfilePhoto(right)!,b=analyzeVisibleProfilePhoto(left)!
    expect(b.metrics.map(m=>m.value)).toEqual(a.metrics.map(m=>m.value))
    const ap=a.paths.find(p=>p.code==='right_jaw_contour')!.points,bp=b.paths.find(p=>p.code==='left_jaw_contour')!.points
    bp.forEach((p,i)=>{expect(p.x).toBeCloseTo(1200-ap[i].x,8);expect(p.y).toBeCloseTo(ap[i].y,8)})
  })
  it('refuses rejected, non-profile and incomplete profile landmark outputs',()=>{
    expect(analyzeVisibleProfilePhoto({...fixture(),status:'reject'})).toBeNull()
    expect(analyzeVisibleProfilePhoto({...fixture(),estimatedPose:'front'})).toBeNull()
    expect(analyzeVisibleProfilePhoto({...fixture(),landmarks:fixture().landmarks!.slice(0,477)})).toBeNull()
  })
})
