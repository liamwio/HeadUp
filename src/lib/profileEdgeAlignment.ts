export type ProfilePixelBuffer={width:number;height:number;data:Uint8ClampedArray}
export type ProfileEdgePoint={x:number;y:number}
export type ProfileEdgeAlignmentStatus='screening_pass'|'screening_review'|'insufficient_signal'
export type ProfileEdgeAlignmentResult={
  status:ProfileEdgeAlignmentStatus
  sampleCount:number
  supportedSampleCount:number
  supportRatio:number
  medianOffsetPx:number|null
  p95OffsetPx:number|null
  medianOffsetVisibleHeightRatio:number|null
  p95OffsetVisibleHeightRatio:number|null
  medianGradient:number|null
  searchRadiusPx:number
}

const quantile=(values:readonly number[],q:number)=>{
  if(values.length===0)return null
  const sorted=[...values].sort((a,b)=>a-b),position=(sorted.length-1)*q,left=Math.floor(position),right=Math.ceil(position)
  return sorted[left]+(sorted[right]-sorted[left])*(position-left)
}

const luminance=(image:ProfilePixelBuffer,x:number,y:number)=>{
  const xx=Math.max(0,Math.min(image.width-1,Math.round(x))),yy=Math.max(0,Math.min(image.height-1,Math.round(y))),index=(yy*image.width+xx)*4
  return image.data[index]*.2126+image.data[index+1]*.7152+image.data[index+2]*.0722
}

const sobel=(image:ProfilePixelBuffer,x:number,y:number)=>{
  if(x<1||y<1||x>=image.width-1||y>=image.height-1)return 0
  const a=luminance(image,x-1,y-1),b=luminance(image,x,y-1),c=luminance(image,x+1,y-1)
  const d=luminance(image,x-1,y),f=luminance(image,x+1,y)
  const g=luminance(image,x-1,y+1),h=luminance(image,x,y+1),i=luminance(image,x+1,y+1)
  return Math.hypot(-a+c-2*d+2*f-g+i,-a-2*b-c+g+2*h+i)/4
}

function samplePolyline(points:readonly ProfileEdgePoint[],spacing:number){
  const samples:Array<{point:ProfileEdgePoint;normal:ProfileEdgePoint}>=[]
  for(let index=0;index<points.length-1;index++){
    const start=points[index],end=points[index+1],dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy)
    if(length<1e-6)continue
    const count=Math.max(1,Math.ceil(length/spacing)),normal={x:-dy/length,y:dx/length}
    for(let step=index===0?0:1;step<=count;step++){
      const t=step/count
      samples.push({point:{x:start.x+dx*t,y:start.y+dy*t},normal})
    }
  }
  return samples
}

/**
 * Screening diagnostic only. It searches for the strongest local luminance
 * gradient along each path normal and reports its distance from the model line.
 * Hair, shadows and makeup can create gradients, so this cannot replace manual
 * contour truth and must never be presented as landmark accuracy.
 */
export function evaluateProfilePathEdgeAlignment(
  image:ProfilePixelBuffer,
  points:readonly ProfileEdgePoint[],
  visibleProfileHeight:number,
  options:{searchRadiusRatio?:number;sampleSpacingRatio?:number;minimumGradient?:number}={},
):ProfileEdgeAlignmentResult{
  const searchRadiusPx=Math.max(3,Math.min(24,Math.round(visibleProfileHeight*(options.searchRadiusRatio??.015))))
  const spacing=Math.max(2,visibleProfileHeight*(options.sampleSpacingRatio??.006))
  const minimumGradient=options.minimumGradient??18
  const samples=samplePolyline(points,spacing),offsets:number[]=[],gradients:number[]=[]
  for(const sample of samples){
    const candidates:Array<{offset:number;gradient:number}>=[]
    for(let offset=-searchRadiusPx;offset<=searchRadiusPx;offset++){
      const gradient=sobel(image,sample.point.x+sample.normal.x*offset,sample.point.y+sample.normal.y*offset)
      candidates.push({offset,gradient})
    }
    const peak=Math.max(...candidates.map(candidate=>candidate.gradient))
    if(peak<minimumGradient)continue
    const nearPeak=candidates.filter(candidate=>candidate.gradient>=peak*.95).sort((left,right)=>Math.abs(left.offset)-Math.abs(right.offset))
    offsets.push(Math.abs(nearPeak[0].offset));gradients.push(peak)
  }
  const supportRatio=samples.length===0?0:offsets.length/samples.length
  const medianOffsetPx=quantile(offsets,.5),p95OffsetPx=quantile(offsets,.95),medianGradient=quantile(gradients,.5)
  const normalized=(value:number|null)=>value===null||visibleProfileHeight<=0?null:value/visibleProfileHeight
  const p95Ratio=normalized(p95OffsetPx)
  const status:ProfileEdgeAlignmentStatus=supportRatio<.5||p95Ratio===null?'insufficient_signal':p95Ratio<=.012?'screening_pass':'screening_review'
  return{status,sampleCount:samples.length,supportedSampleCount:offsets.length,supportRatio,medianOffsetPx,p95OffsetPx,medianOffsetVisibleHeightRatio:normalized(medianOffsetPx),p95OffsetVisibleHeightRatio:p95Ratio,medianGradient,searchRadiusPx}
}
