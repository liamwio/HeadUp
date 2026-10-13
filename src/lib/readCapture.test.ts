import {afterEach,it,expect,vi} from 'vitest'
import {readCapture,MODEL_UNAVAILABLE_COPY} from './readCapture'
import type {PreparedCapture} from './prepareCaptureFile'

const file=new File(['pixels'],'photo.png',{type:'image/png'})
const image={width:1080,height:1440,quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]}}
afterEach(()=>vi.useRealTimers())
it('retains readable image and genuine pixel quality after model failure',async()=>{
  const read=vi.fn().mockResolvedValue(image)
  const result=await readCapture('front',file,true,{prepare:vi.fn().mockRejectedValue(new Error('offline')),read,timeoutMs:100})
  expect(result).toEqual({...image,file,analysisError:MODEL_UNAVAILABLE_COPY})
  expect(result.pose).toBeUndefined();expect(read).toHaveBeenCalledWith(file)
})
it('does not turn a corrupt file into a saved photo',async()=>{
  await expect(readCapture('front',file,true,{prepare:vi.fn().mockRejectedValue(new Error('decode')),read:vi.fn().mockRejectedValue(new Error('corrupt image')),timeoutMs:100})).rejects.toThrow('corrupt image')
})
it('retains a readable photo when the model never finishes',async()=>{
  vi.useFakeTimers()
  const task=readCapture('profile',file,true,{prepare:()=>new Promise(()=>{}),read:vi.fn().mockResolvedValue(image),timeoutMs:100})
  await vi.advanceTimersByTimeAsync(100)
  expect((await task).analysisError).toBe(MODEL_UNAVAILABLE_COPY)
})
it('preserves partial checks and makes native model outage retryable',async()=>{
  const prepared:PreparedCapture={...image,file,straightening:{version:'test',status:'not_applied',reason:'side',originalFlags:[]},pose:{status:'pass',estimatedPose:'left_profile',detectedFaces:1,flags:[],nativeProfile:{status:'unavailable',reason:'native39_runtime:offline'}}}
  const result=await readCapture('profile',file,true,{prepare:async()=>prepared,read:vi.fn(),timeoutMs:100})
  expect(result.pose).toBe(prepared.pose);expect(result.analysisError).toContain('重试')
})
