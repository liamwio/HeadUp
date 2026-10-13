import {afterEach,expect,it,vi} from 'vitest'
import {createLiveCaptureCoach,reviewCapturedFrame} from './liveCaptureReview'
import {liveGuidance,type LiveInspection} from './liveCamera'
const good:LiveInspection={pose:{status:'pass',estimatedPose:'left_profile',detectedFaces:1,flags:[],faceBounds:{x:.29,y:.25,width:.42,height:.5}},quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]}}
const file=new File(['selected-frame'],'frame.png',{type:'image/png'})
function decoder(){const bitmap={close:vi.fn()} as unknown as ImageBitmap;return {bitmap,decode:vi.fn().mockResolvedValue(bitmap)}}
afterEach(()=>vi.useRealTimers())
it('inspects the selected file and releases its bitmap after successful inspection',async()=>{
  const {bitmap,decode}=decoder(),inspect=vi.fn().mockResolvedValue(good)
  const result=await reviewCapturedFrame(file,'profile','left_profile',inspect,decode)
  expect(decode).toHaveBeenCalledWith(file);expect(inspect).toHaveBeenCalledWith('profile',bitmap)
  expect(result.ready).toBe(true);expect(bitmap.close).toHaveBeenCalledOnce()
})
it.each([
  {...good,pose:{...good.pose,estimatedPose:'right_profile' as const}},
  {...good,quality:{...good.quality,flags:['画面模糊']}},
  {...good,pose:{...good.pose,faceBounds:{x:.29,y:0,width:.42,height:.5}}},
])('requires review when the selected frame loses direction, clarity or framing',async selected=>{
  expect(liveGuidance('profile',good,'left_profile').ready).toBe(true)
  const {decode}=decoder()
  expect((await reviewCapturedFrame(file,'profile','left_profile',async()=>selected,decode)).ready).toBe(false)
})
it('keeps inspection outages distinct from a passing photo and closes failed bitmaps',async()=>{
  const {bitmap,decode}=decoder()
  const r=await reviewCapturedFrame(file,'profile','left_profile',async()=>{throw Error('offline')},decode)
  expect(r.ready).toBe(false);expect(r.message).toContain('检查未完成');expect(bitmap.close).toHaveBeenCalledOnce()
})
it('times out without closing a bitmap still in use, then releases it when inference settles',async()=>{
  vi.useFakeTimers();const {bitmap,decode}=decoder();let resolve!:(r:LiveInspection)=>void
  const result=reviewCapturedFrame(file,'profile','left_profile',()=>new Promise(r=>{resolve=r}),decode,100)
  await vi.advanceTimersByTimeAsync(100)
  expect((await result).ready).toBe(false);expect(bitmap.close).not.toHaveBeenCalled()
  resolve(good);await vi.advanceTimersByTimeAsync(0);expect(bitmap.close).toHaveBeenCalledOnce()
})
it('changes persistent uncertain-side coaching without treating it as a pass or overriding framing advice',()=>{
  const r={...good,pose:{...good.pose,status:'reject' as const,roll:23.1,flags:['头部横向倾斜过大']}}
  const message=liveGuidance('profile',r,'left_profile').message,coach=createLiveCaptureCoach()
  for(const t of [0,1500,3000,4500])expect(coach.observe('profile',r,message,t)).toBe(message)
  expect(coach.observe('profile',r,message,6000)).toContain('不要继续扭头')
  expect(liveGuidance('profile',r,'left_profile').ready).toBe(false)
  expect(coach.observe('profile',r,'请退后一点',6500)).toBe('请退后一点')
  expect(coach.observe('profile',r,message,7000)).toBe(message)
  coach.reset();expect(coach.observe('profile',r,message,12000)).toBe(message)
})
