import { describe, expect, it } from 'vitest'
import { decodeYuNetDetections, nonMaximumSuppression, type FaceDetection } from './faceDetector'

function detection(overrides: Partial<FaceDetection>): FaceDetection {
  return {
    score: 0.9,
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    areaRatio: 0.1,
    centerDistance: 0.05,
    ...overrides,
  }
}

describe('YuNet face-detector post-processing', () => {
  it.each([[240,320,256,320],[320,240,320,256],[320,320,320,320]])('normalizes framing to %sx%s content while decoding the padded grid', (w,h,pw,ph) => {
    const outputs:Record<string,{data:Float32Array}> = {}
    for (const stride of [8,16,32]) {
      const count=pw/stride*ph/stride
      outputs[`cls_${stride}`]={data:new Float32Array(count)}
      outputs[`obj_${stride}`]={data:new Float32Array(count)}
      outputs[`bbox_${stride}`]={data:new Float32Array(count*4)}
    }
    const index=(h/2/8)*(pw/8)+w/2/8
    outputs.cls_8.data[index]=1;outputs.obj_8.data[index]=1
    outputs.bbox_8.data[index*4+2]=Math.log(80/8)
    outputs.bbox_8.data[index*4+3]=Math.log(100/8)
    const [box]=decodeYuNetDetections(outputs,pw,ph,w,h)
    expect(box.centerDistance).toBeCloseTo(0,10)
    expect(box.areaRatio).toBeCloseTo(8000/(w*h),6)
    expect(box.x).toBeCloseTo(w/2-40,5)
    expect(box.y).toBeCloseTo(h/2-50,5)
  })
  it('keeps the higher-confidence box when detections overlap', () => {
    const retained = nonMaximumSuppression([
      detection({ score: 0.8, x: 12, y: 12 }),
      detection({ score: 0.95 }),
    ])
    expect(retained).toHaveLength(1)
    expect(retained[0].score).toBe(0.95)
  })

  it('retains separate faces for the multiple-person gate', () => {
    const retained = nonMaximumSuppression([
      detection({ score: 0.95 }),
      detection({ score: 0.9, x: 180, y: 20 }),
    ])
    expect(retained).toHaveLength(2)
  })
})
