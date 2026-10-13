import { describe, expect, it } from 'vitest'
import type { FaceDetection } from './faceDetector'
import { nativeProfileCropFromDetection,nativeProfileLocalCrop } from './nativeProfileInference'

const detection: FaceDetection = { score:.95,x:64,y:48,width:96,height:128,areaRatio:.12,centerDistance:.01 }

describe('native Menpo39 browser crop contract',()=>{
  it('maps YuNet detector coordinates back to the original image with orientation-specific calibration',()=>{
    const right=nativeProfileCropFromDetection(detection,1280,960,'right')
    const left=nativeProfileCropFromDetection(detection,1280,960,'left')
    expect(right.side).toBeCloseTo(128/0.25*1.1504958141994608,8)
    expect(left.side).toBeCloseTo(128/0.25*1.138812414528869,8)
    expect(left.orientation).toBe('left')
    expect(right.x).not.toBeCloseTo(left.x,6)
    expect(right.y).toBeGreaterThan(0)
    expect(right.side).toBeGreaterThan(500)
  })
  it('builds deterministic local ROI from predicted landmarks without ground-truth points',()=>{const points=Array.from({length:39},(_,index)=>({x:index*10,y:index*5}));const crop=nativeProfileLocalCrop(points,[4,5,6,7,8],.9,2);expect(crop.side).toBeGreaterThan(300);expect(Number.isFinite(crop.x)).toBe(true)})
})
