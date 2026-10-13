import { describe,expect,it } from 'vitest'
import { traceProfileNeckEdge } from './profileNeckEdge'

function fixture(slope=0){
  const width=240,height=300,data=new Uint8Array(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const inside=x<130+slope*(y-180),i=(y*width+x)*4
    data.set(inside?[160,100,75,255]:[220,225,225,255],i)
  }
  const points=Array.from({length:39},()=>({x:.5,y:.5}))
  for(let i=0;i<7;i++)points[4+i]={x:(90+i*10)/(width-1),y:(155+i*3)/(height-1)}
  points[10].y=160/(height-1)
  points[14]={x:150/(width-1),y:75/(height-1)}
  return {image:{width,height,data},points}
}
describe('image-conditioned automatic neck',()=>{
  it('follows a horizontal chin underside into the neck without a straight gap',()=>{
    const {image,points}=fixture()
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
      const boundary=y<175?150:y<181?150-(y-175):y<191?105-(y-181)*.5:100-(y-191)*.2
      image.data.set(x<boundary?[160,100,75,255]:[220,225,225,255],(y*image.width+x)*4)
    }
    points[8]={x:135/239,y:176/299};points[9]={x:145/239,y:180/299};points[10]={x:150/239,y:173/299}
    const result=traceProfileNeckEdge(image,points,'right'),pixels=result.points.map(p=>({x:p.x*239,y:p.y*299}))
    expect(result.status).toBe('traced')
    expect(pixels[0].x).toBeGreaterThan(135)
    expect(pixels.some(p=>p.x>115&&p.x<130&&Math.abs(p.y-180)<4)).toBe(true)
    expect(Math.max(...pixels.slice(1).map((p,i)=>Math.hypot(p.x-pixels[i].x,p.y-pixels[i].y)))).toBeLessThan(7)
    expect(result.directionPoints![0].x).toBeLessThan(result.points[0].x)
  })
  it('tracks the visible boundary, not a fixed template',()=>{
    const {image,points}=fixture(), r=traceProfileNeckEdge(image,points,'right')
    expect(r.status).toBe('traced')
    expect(r.points.every(p=>Math.abs(p.x*239-130)<4)).toBe(true)
    const second=fixture(.5), other=traceProfileNeckEdge(second.image,second.points,'right')
    expect(other.status).toBe('traced')
    expect(Math.abs(r.angleDegrees!-other.angleDegrees!)).toBeGreaterThan(15)
  })
  it('does not claim an angle on a uniform image',()=>{
    const {image,points}=fixture();image.data.fill(180)
    expect(traceProfileNeckEdge(image,points,'right')).toMatchObject({status:'weak',angleDegrees:null,edgeSupport:0})
  })
  it('reflects left/right with no coordinate drift',()=>{
    const {image,points}=fixture(.3), flipped=new Uint8Array(image.data.length)
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)flipped.set(image.data.slice((y*image.width+x)*4,(y*image.width+x)*4+4),(y*image.width+image.width-1-x)*4)
    const r=traceProfileNeckEdge(image,points,'right'),l=traceProfileNeckEdge({...image,data:flipped},points.map(p=>({x:1-p.x,y:p.y})),'left')
    expect(l.angleDegrees).toBeCloseTo(r.angleDegrees!,8)
    l.points.forEach((p,i)=>expect(p.x).toBeCloseTo(1-r.points[i].x,8))
  })
  it('returns a concrete detection record for invalid or cropped regions',()=>{
    const {image,points}=fixture()
    expect(traceProfileNeckEdge(image,[],'right').status).toBe('missing')
    expect(traceProfileNeckEdge(image,points.map(p=>({...p,y:p.y+.35})),'right').reason).toContain('裁切')
  })
})
