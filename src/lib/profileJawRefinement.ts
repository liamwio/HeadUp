import type { ProfilePoint } from './profileNeckLine'

export type JawRefinement = {
  version:'HEADUP-JAW-IMAGE-REFINEMENT-1.0'
  status:'refined'|'conservative'|'missing'
  points:ProfilePoint[]
  supportedFraction:number
  maxDisplacementPixels:number
  reason:string
}
type Raster={width:number;height:number;data:Uint8Array|Uint8ClampedArray}
const version='HEADUP-JAW-IMAGE-REFINEMENT-1.0' as const
const empty=():JawRefinement=>({version,status:'missing',points:[],supportedFraction:0,maxDisplacementPixels:0,reason:'下颌定位不足，保留其他测量'})

/** Restricted normal-strip optimization around the predicted jaw, not silhouette
 * segmentation. Endpoints remain fixed and neither neck pixels nor neck labels
 * are used as target coordinates. Weak local evidence stays near the prior.
 */
export function refineProfileJaw(image:Raster,landmarks:readonly ProfilePoint[],orientation:'left'|'right'):JawRefinement{
  const {width:w,height:h,data}=image,right=orientation==='right'
  if(w<32||h<32||data.length!==w*h*4||landmarks.length!==39||!landmarks.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))return empty()
  const pixel=(p:ProfilePoint)=>({x:(right?p.x:1-p.x)*(w-1),y:p.y*(h-1)})
  const jaw=landmarks.slice(4,11).map(pixel),brow=pixel(landmarks[14]),faceHeight=Math.hypot(brow.x-jaw[4].x,brow.y-jaw[4].y)
  const lengths=jaw.slice(1).map((p,i)=>Math.hypot(p.x-jaw[i].x,p.y-jaw[i].y)),length=lengths.reduce((a,b)=>a+b,0)
  if(length<20||faceHeight<24||faceHeight>h*.85||jaw.some(p=>p.x<2||p.y<2||p.x>w-3||p.y>h-3))return empty()
  const count=65,radius=Math.max(2,Math.round(faceHeight*.045)),cols=radius*2+1
  const sample=(fraction:number)=>{
    let rest=fraction*length,index=0
    while(index<lengths.length-1&&rest>lengths[index]){rest-=lengths[index];index++}
    const t=lengths[index]>0?rest/lengths[index]:0,a=jaw[index],b=jaw[index+1]
    return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}
  }
  const base=Array.from({length:count},(_,i)=>sample(i/(count-1)))
  const normals=base.map((p,i)=>{const a=base[Math.max(0,i-2)],b=base[Math.min(count-1,i+2)],d=Math.hypot(b.x-a.x,b.y-a.y);return d?{x:-(b.y-a.y)/d,y:(b.x-a.x)/d}:{x:0,y:1}})
  const luma=(x:number,y:number)=>{
    const px=Math.max(0,Math.min(w-1,Math.round(right?x:w-1-x))),py=Math.max(0,Math.min(h-1,Math.round(y))),i=(py*w+px)*4
    return .2126*data[i]+.7152*data[i+1]+.0722*data[i+2]
  }
  const mean=(x:number,y:number)=>{let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)sum+=luma(x+dx,y+dy);return sum/9}
  const gap=Math.max(2,faceHeight*.015),scores=new Float32Array(count*cols),back=new Int16Array(count*cols)
  let previous=new Float64Array(cols).fill(Infinity),next=new Float64Array(cols)
  for(let i=0;i<count;i++){
    const p=base[i],n=normals[i],t=i/(count-1),limit=Math.min(radius,i, count-1-i)
    for(let c=0;c<cols;c++){
      const offset=c-radius
      if(Math.abs(offset)>limit){next[c]=Infinity;continue}
      const x=p.x+offset*n.x,y=p.y+offset*n.y
      const inside=mean(x-gap*n.x,y-gap*n.y),outside=mean(x+gap*n.x,y+gap*n.y)
      // Cheek-to-neck usually darkens; at the anterior chin, either contrast
      // polarity is possible because the exterior is the photograph background.
      const contrast=t>.8?Math.abs(inside-outside):Math.max(0,inside-outside)
      scores[i*cols+c]=contrast
      const local=-Math.min(18,contrast)+.14*offset*offset
      let best=i===0&&offset===0?0:Infinity,from=c
      if(i)for(let k=Math.max(0,c-2);k<=Math.min(cols-1,c+2);k++){
        const cost=previous[k]+.9*(k-c)**2
        if(cost<best){best=cost;from=k}
      }
      next[c]=best+local;back[i*cols+c]=from
    }
    ;[previous,next]=[next,previous]
  }
  const offsets=new Array<number>(count);let c=radius,supported=0
  for(let i=count-1;i>=0;i--){offsets[i]=c-radius;if(scores[i*cols+c]>=4)supported++;c=back[i*cols+c]}
  // Smooth local corrections rather than replacing the anatomical prior with
  // an unconstrained best-looking arc. Preserve endpoint coordinates exactly.
  const adjusted=base.map((p,i)=>{
    let sum=0,weight=0
    for(let j=-4;j<=4;j++){const k=Math.max(0,Math.min(count-1,i+j)),a=5-Math.abs(j);sum+=offsets[k]*a;weight+=a}
    const offset=i===0||i===count-1?0:sum/weight
    const x=p.x+offset*normals[i].x,y=p.y+offset*normals[i].y
    return{x,y}
  })
  const points=adjusted.map((p,i)=>{
    if(i===0||i===count-1)return{x:(right?p.x:w-1-p.x)/(w-1),y:p.y/(h-1)}
    let x=0,y=0,weight=0
    for(let j=-2;j<=2;j++){const q=adjusted[Math.max(0,Math.min(count-1,i+j))],a=3-Math.abs(j);x+=q.x*a;y+=q.y*a;weight+=a}
    return{x:(right?x/weight:w-1-x/weight)/(w-1),y:y/weight/(h-1)}
  })
  const supportedFraction=supported/count,status=supportedFraction>=.55?'refined':'conservative'
  return{version,status,points,supportedFraction,maxDisplacementPixels:Math.max(...offsets.map(Math.abs)),reason:status==='refined'?'下颌图像局部细化 · 非骨性边界':'下颌边界较淡，保留模型附近的保守描线'}
}

export function refineProfileJawBitmap(bitmap:ImageBitmap,landmarks:readonly ProfilePoint[],orientation:'left'|'right'):JawRefinement{
  try{
    const scale=Math.min(1,720/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas')
    canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale)
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return empty()
    context.drawImage(bitmap,0,0,canvas.width,canvas.height)
    return refineProfileJaw(context.getImageData(0,0,canvas.width,canvas.height),landmarks,orientation)
  }catch{return empty()}
}
