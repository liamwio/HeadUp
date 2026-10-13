import {expect,it} from 'vitest'
import {alignedBurstMedian,BURST_EXPERIMENT_RELEASE_ENABLED,type BurstFrame} from './alignedBurstMedian'
const points=Array.from({length:39},(_,i)=>({x:100+(i%7)*20,y:100+Math.floor(i/7)*30}))
function frames():BurstFrame[]{return Array.from({length:5},(_,i)=>({id:'f'+i,sha256:i.toString(16).padStart(64,'0'),width:500,height:500,points:points.map(p=>({x:p.x+i*3,y:p.y-i*2})),source:'test-source',view:'left_profile',qualityPassed:true,posePassed:true,sharpness:100-i}))}
it('aligns translated observations before taking medians, retaining exact contributor points and transforms',()=>{
 const input=frames(),before=JSON.stringify(input),r=alignedBurstMedian(input)
 expect(r.releaseEligible).toBe(false);expect(BURST_EXPERIMENT_RELEASE_ENABLED).toBe(false)
 expect(r.contributors).toHaveLength(5);expect(r.referenceFrameId).toBe('f0')
 r.points.forEach((p,i)=>{expect(p.x).toBeCloseTo(points[i].x,8);expect(p.y).toBeCloseTo(points[i].y,8)})
 expect(JSON.stringify(input)).toBe(before);expect(r.contributors[2].transform.tx).toBeCloseTo(-6,8)
})
it('rejects duplicate, mixed-source and insufficient passing frames',()=>{
 const a=frames();a[1].sha256=a[0].sha256;expect(()=>alignedBurstMedian(a)).toThrow('duplicate')
 const b=frames();b[1].source='different';expect(()=>alignedBurstMedian(b)).toThrow('incompatible')
 const c=frames();c[1].posePassed=false;expect(()=>alignedBurstMedian(c)).toThrow('qualified')
})
it('rejects non-rigid anchor changes instead of forcing registration',()=>{
 const a=frames();a[0].points[17].x+=55
 expect(()=>alignedBurstMedian(a)).toThrow('aligned')
})
