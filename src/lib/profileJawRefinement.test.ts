import {describe,it,expect} from 'vitest'
import {refineProfileJaw} from './profileJawRefinement'
function fixture(){
  const width=260,height=260,data=new Uint8Array(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(y<135+.3*x?[200,160,130,255]:[100,75,60,255],(y*width+x)*4)
  const points=Array.from({length:39},()=>({x:.5,y:.5}))
  for(let i=0;i<7;i++){const x=60+i*20;points[4+i]={x:x/259,y:(132+.3*x)/259}}
  points[14]={x:140/259,y:60/259}
  return{image:{width,height,data},points}
}
describe('jaw-local image refinement',()=>{
  it('moves toward visible jaw contrast and keeps endpoints and input landmarks fixed',()=>{
    const{image,points}=fixture(),before=JSON.stringify(points),r=refineProfileJaw(image,points,'right')
    expect(r.status).toBe('refined');expect(r.points).toHaveLength(65)
    expect(r.points[0]).toEqual(points[4]);expect(r.points.at(-1)).toEqual(points[10]);expect(JSON.stringify(points)).toBe(before)
    const interior=r.points.slice(10,-10),error=interior.reduce((sum,p)=>sum+Math.abs(p.y*259-(135+.3*p.x*259)),0)/interior.length
    expect(error).toBeLessThan(2.8)
  })
  it('stays conservative on a blank image instead of claiming accurate edges',()=>{
    const{image,points}=fixture();image.data.fill(180)
    const r=refineProfileJaw(image,points,'right')
    expect(r.status).toBe('conservative');expect(r.supportedFraction).toBe(0);expect(r.maxDisplacementPixels).toBe(0)
  })
  it('cannot jump down to a strong distant neck boundary',()=>{
    const{image,points}=fixture()
    for(let y=0;y<260;y++)for(let x=0;x<260;x++)image.data.set(y<210?[220,220,220,255]:[0,0,0,255],(y*260+x)*4)
    const r=refineProfileJaw(image,points,'right')
    expect(Math.max(...r.points.map(p=>p.y*259))).toBeLessThan(190)
    expect(r.maxDisplacementPixels).toBe(0)
  })
  it('has left/right mirror parity',()=>{
    const{image,points}=fixture(),data=new Uint8Array(image.data.length)
    for(let y=0;y<260;y++)for(let x=0;x<260;x++)data.set(image.data.slice((y*260+x)*4,(y*260+x)*4+4),(y*260+259-x)*4)
    const r=refineProfileJaw(image,points,'right'),l=refineProfileJaw({...image,data},points.map(p=>({x:1-p.x,y:p.y})),'left')
    l.points.forEach((p,i)=>{expect(p.x).toBeCloseTo(1-r.points[i].x,10);expect(p.y).toBeCloseTo(r.points[i].y,10)})
  })
  it('rejects missing and invalid model locations',()=>{
    const{image,points}=fixture()
    expect(refineProfileJaw(image,[],'right').status).toBe('missing')
    points[4].x=NaN;expect(refineProfileJaw(image,points,'right').status).toBe('missing')
  })
})
