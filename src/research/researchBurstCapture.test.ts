import {expect,it,vi} from 'vitest'
import {captureResearchBurst} from './researchBurstCapture'
import type {readCapture} from '../lib/readCapture'
it('captures originals before analysis, disables image correction and records per-frame identity',async()=>{
 let taken=0
 const take=vi.fn(async()=>new File(['frame-'+(++taken)],'frame.png',{type:'image/png'}))
 const analyze=vi.fn<typeof readCapture>(async(_id,file,auto)=>{
   expect(taken).toBe(5);expect(auto).toBe(false)
   return {file,width:500,height:500,quality:{score:90,sharpness:100,resolution:100,brightness:128,contrast:40,flags:[]},pose:{status:'pass',estimatedPose:'front',detectedFaces:1,flags:[],landmarks:Array.from({length:478},(_,i)=>({x:.2+(i%20)*.02,y:.2+Math.floor(i/20)*.02,z:0}))}}
 })
 const result=await captureResearchBurst({view:'front',take,current:()=>true,count:5,wait:async()=>{},analyze})
 expect(result.originals).toHaveLength(5);expect(new Set(result.frames.map(f=>f.sha256)).size).toBe(5)
 expect(result.aggregate.contributors).toHaveLength(5);expect(result.releaseEligible).toBe(false)
})
it('stops acquisition before analysis when cancelled',async()=>{
 let n=0;const analyze=vi.fn()
 await expect(captureResearchBurst({view:'front',count:5,take:async()=>{n++;return new File(['frame'],'frame')},current:()=>n<2,wait:async()=>{},analyze})).rejects.toMatchObject({name:'AbortError'})
 expect(analyze).not.toHaveBeenCalled()
})
