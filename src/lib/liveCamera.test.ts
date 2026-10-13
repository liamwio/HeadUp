import {describe,it,expect,vi} from 'vitest'
import {createCameraSession,createStableCaptureGate,liveGuidance,type LiveInspection} from './liveCamera'
import {retryableLoad} from './retryableLoad'

function media(){const stop=vi.fn();return {stream:{getTracks:()=>[{stop}]} as unknown as MediaStream,stop}}
const good:LiveInspection={pose:{status:'pass',estimatedPose:'front',detectedFaces:1,flags:[],faceBounds:{x:.29,y:.25,width:.42,height:.5}},quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]}}
describe('camera resource ownership',()=>{
  it('releases a permission result that arrives after the modal closes',async()=>{
    let resolve!:(s:MediaStream)=>void
    const camera=createCameraSession(()=>new Promise(r=>{resolve=r})),m=media()
    const opening=camera.open('environment');camera.stop();resolve(m.stream)
    expect(await opening).toBeNull();expect(m.stop).toHaveBeenCalledOnce()
  })
  it('keeps the newer camera when requests resolve out of order and never requests audio',async()=>{
    const pending:Array<(s:MediaStream)=>void>=[],get=vi.fn(()=>new Promise<MediaStream>(r=>pending.push(r)))
    const camera=createCameraSession(get),old=media(),latest=media()
    const a=camera.open('environment'),b=camera.open('user')
    pending[1](latest.stream);expect(await b).toBe(latest.stream)
    pending[0](old.stream);expect(await a).toBeNull();expect(old.stop).toHaveBeenCalledOnce()
    expect(get.mock.calls.every(args=>(args as unknown as [MediaStreamConstraints])[0].audio===false)).toBe(true)
    camera.stop();camera.stop();expect(latest.stop).toHaveBeenCalledOnce()
  })
})
describe('stable capture',()=>{
  it('restarts on lost quality and fires only once per cycle',()=>{
    const gate=createStableCaptureGate()
    gate.observe(true,0);expect(gate.observe(true,1000).countdown).toBe(2)
    gate.observe(false,1500);gate.observe(true,2000);gate.observe(true,3000)
    expect(gate.observe(true,4000).capture).toBe(false)
    expect(gate.observe(true,5000).capture).toBe(true)
    expect(gate.observe(true,6000).capture).toBe(false)
  })
  it('cannot use a stalled or hidden interval as continuous good observations',()=>{
    const gate=createStableCaptureGate();gate.observe(true,0);gate.observe(true,1000)
    expect(gate.observe(true,5000)).toEqual({capture:false,countdown:null})
    expect(gate.observe(true,5500).capture).toBe(false)
  })
})
describe('single live guidance',()=>{
  it('prioritizes multiple faces and prevents auto capture on wrong side',()=>{
    expect(liveGuidance('front',{...good,pose:{...good.pose,detectedFaces:2}}).message).toContain('一个人')
    const side={...good,pose:{...good.pose,estimatedPose:'left_profile' as const}}
    expect(liveGuidance('profile',side,'right_profile').ready).toBe(false)
    expect(liveGuidance('profile',side,'left_profile').ready).toBe(true)
  })
  it('blocks bad pixels even when pose passes',()=>{
    expect(liveGuidance('front',{...good,quality:{...good.quality,flags:['光线不足']}})).toEqual({ready:false,message:'面向柔和光源，让面部更明亮。'})
  })
})
it('shares model loads and retries failed loads',async()=>{
  const load=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('model'),get=retryableLoad(load)
  const first=get();expect(get()).toBe(first);await expect(first).rejects.toThrow('offline')
  expect(await get()).toBe('model');expect(await get()).toBe('model');expect(load).toHaveBeenCalledTimes(2)
})

it('requires complete framing for automatic capture and cancels countdown when the face reaches an edge',()=>{
  const cropped={...good,pose:{...good.pose,faceBounds:{x:.29,y:.01,width:.42,height:.5}}}
  expect(liveGuidance('front',cropped).ready).toBe(false)
  expect(liveGuidance('front',cropped).message).toContain('顶部')
  expect(liveGuidance('front',{...good,pose:{...good.pose,faceBounds:undefined}}).ready).toBe(false)
  const gate=createStableCaptureGate()
  gate.observe(liveGuidance('front',good).ready,0);expect(gate.observe(true,1000).countdown).toBe(2)
  expect(gate.observe(liveGuidance('front',cropped).ready,1500).countdown).toBeNull()
  expect(gate.observe(liveGuidance('front',good).ready,2000).capture).toBe(false)
})
