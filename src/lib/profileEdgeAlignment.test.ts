import{describe,expect,it}from'vitest'
import{evaluateProfilePathEdgeAlignment}from'./profileEdgeAlignment'

const verticalEdge=(edgeX:number,flat=false)=>{
  const width=100,height=100,data=new Uint8ClampedArray(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const value=flat?128:x<edgeX?20:235,index=(y*width+x)*4
    data[index]=data[index+1]=data[index+2]=value;data[index+3]=255
  }
  return{width,height,data}
}

describe('profile edge alignment screening',()=>{
  it('finds a visible boundary close to a correctly placed path',()=>{
    const result=evaluateProfilePathEdgeAlignment(verticalEdge(50),[{x:50,y:10},{x:50,y:90}],80)
    expect(result.status).toBe('screening_pass')
    expect(result.supportRatio).toBeGreaterThan(.9)
    expect(result.p95OffsetPx).toBeLessThanOrEqual(1)
  })

  it('flags a path displaced from the visible boundary',()=>{
    const result=evaluateProfilePathEdgeAlignment(verticalEdge(50),[{x:57,y:10},{x:57,y:90}],80,{searchRadiusRatio:.1})
    expect(result.status).toBe('screening_review')
    expect(result.medianOffsetPx).toBeGreaterThanOrEqual(6)
  })

  it('does not convert a flat image into false alignment evidence',()=>{
    const result=evaluateProfilePathEdgeAlignment(verticalEdge(50,true),[{x:50,y:10},{x:50,y:90}],80)
    expect(result.status).toBe('insufficient_signal')
    expect(result.supportedSampleCount).toBe(0)
    expect(result.p95OffsetPx).toBeNull()
  })
})
