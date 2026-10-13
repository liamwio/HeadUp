import {it,expect,vi} from 'vitest'
import {captureShortBurst} from './shortBurst'
import type {PhotoQuality} from '../types'
const quality=(sharpness:number,flags:string[]=[]):PhotoQuality=>({score:90,resolution:100,brightness:90,contrast:90,sharpness,flags})
it('selects a single unmodified candidate, prioritizing acceptable quality before sharpness',async()=>{
  const frames=[{quality:quality(100,['画面过曝']),time:'first',blob:new Blob(['first'])},{quality:quality(70),time:'second',blob:new Blob(['second'])},{quality:quality(80),time:'third',blob:new Blob(['third'])}],take=vi.fn(async()=>frames[take.mock.calls.length-1]),wait=vi.fn(async()=>{})
  const result=await captureShortBurst({take,wait,current:()=>true,now:()=>0})
  expect(result.frame).toBe(frames[2]);expect(result.selection).toEqual({method:'burst-sharpness-v1',frames:3,selectedIndex:2});expect(take).toHaveBeenCalledTimes(3);expect(wait).toHaveBeenCalledTimes(2)
})
it('keeps the earliest equally clear frame and still preserves manual photos without quality inspection',async()=>{
  const first={quality:quality(80),name:'first'},take=vi.fn().mockResolvedValueOnce(first).mockResolvedValue({quality:quality(80),name:'later'})
  expect((await captureShortBurst({take,current:()=>true,wait:async()=>{},now:()=>0})).frame).toBe(first)
  const unscored={quality:undefined,name:'manual'};expect((await captureShortBurst({take:async()=>unscored,current:()=>true,wait:async()=>{},now:()=>0})).frame).toBe(unscored)
})
it('captures exactly one frame when the user disables burst mode',async()=>{
  const take=vi.fn(async()=>({quality:quality(80)})),wait=vi.fn(async()=>{})
  expect((await captureShortBurst({take,wait,current:()=>true,enabled:false})).selection.frames).toBe(1);expect(take).toHaveBeenCalledOnce();expect(wait).not.toHaveBeenCalled()
})
it('does not start more encodes after the short sampling budget is exhausted',async()=>{
  let now=0;const take=vi.fn(async()=>{now+=800;return{quality:quality(80)}})
  expect((await captureShortBurst({take,current:()=>true,now:()=>now,wait:async()=>{}})).selection.frames).toBe(1);expect(take).toHaveBeenCalledOnce()
})
it('keeps a captured frame if a later sample fails, but fails when no frame was obtained',async()=>{
  const first={quality:quality(80)},take=vi.fn().mockResolvedValueOnce(first).mockRejectedValue(new Error('encoder failed'))
  expect((await captureShortBurst({take,current:()=>true,wait:async()=>{},now:()=>0})).frame).toBe(first)
  await expect(captureShortBurst({take:async()=>{throw new Error('no picture')},current:()=>true,wait:async()=>{},now:()=>0})).rejects.toThrow('no picture')
})
it('discards late encoded frames after the camera closes or goes into the background',async()=>{
  let active=true,resolve!:(frame:{quality:PhotoQuality})=>void
  const take=vi.fn(()=>new Promise<{quality:PhotoQuality}>(done=>{resolve=done})),run=captureShortBurst({take,current:()=>active,wait:async()=>{},now:()=>0})
  active=false;resolve({quality:quality(80)});await expect(run).rejects.toMatchObject({name:'AbortError'});expect(take).toHaveBeenCalledOnce()
})
it('does not sample again when cancellation occurs between frames',async()=>{
  let active=true;const take=vi.fn(async()=>({quality:quality(80)}))
  await expect(captureShortBurst({take,current:()=>active,wait:async()=>{active=false},now:()=>0})).rejects.toMatchObject({name:'AbortError'});expect(take).toHaveBeenCalledOnce()
})
