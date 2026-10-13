import { describe, expect, it } from 'vitest'
import { buildConsumerReport } from './consumerReport'
import type { Capture } from '../types'

const failed:Capture={id:'profile',label:'侧面',eyebrow:'',hint:'',poseValidation:{status:'reject',estimatedPose:'no_face',detectedFaces:0,flags:['未检测到清晰人脸']}}
describe('consumer report output for every attempt',()=>{
  it('produces a result record for missing photos, without filling measurements',()=>{
    const r=buildConsumerReport([])
    expect(r.summaries).toHaveLength(3)
    expect(r.measuredCount).toBe(0)
    expect(r.front).toEqual([])
    expect(r.profile).toEqual([])
    expect(r.profileDetection.issues).toContain('本次未添加此视角的照片。')
  })
  it('reports a failed detection explicitly instead of returning null or demo angles',()=>{
    const r=buildConsumerReport([failed])
    expect(r.summaries[2].value).toBe('检测到 0 张人脸')
    expect(r.summaries[2].note).toBe('未检测到清晰人脸')
    expect(r.profile).toEqual([])
    expect(r.profileDetection.facts).toContain('检测到 0 张人脸')
    expect(JSON.stringify(r.summaries)).not.toMatch(/无法判断|无法区分/)
  })
  it('keeps demo values isolated from prior user captures',()=>{
    const r=buildConsumerReport([failed],true)
    expect(r.front).toHaveLength(11)
    expect(r.profile).toHaveLength(3)
    expect(r.summaries[2].value).toContain('168.20°')
    expect(r.front.every(x=>x.origin==='demo')).toBe(true)
    expect(r.native).toBeNull()
  })
  it('does not expose pose-model angles as face measurements when no face was detected',()=>{
    const r=buildConsumerReport([{...failed,poseValidation:{...failed.poseValidation!,yaw:12,pitch:8}}])
    expect(r.profileDetection.facts).toEqual(['检测到 0 张人脸'])
    expect(r.summaries[1].value).toBe('已检查 1 张照片')
  })
  it('provides no nominal score or directional verdict in the summary',()=>{
    const r=buildConsumerReport([],true)
    expect(r.summaries[1].value).toBe('下半脸占比 40.11%')
    expect(JSON.stringify(r.summaries)).not.toMatch(/无法判断|无法区分|暂不判断|颜值/)
  })
})
