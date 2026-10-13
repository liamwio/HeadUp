import type { ProfilePoint } from './profileNeckLine'
import { jawNeckLineAngleDegrees } from './profileNeckLine'

export type NeckEdgeResult = {
  version: 'HEADUP-NECK-EDGE-2.0' | 'HEADUP-NECK-EDGE-3.0'
  status: 'traced' | 'weak' | 'missing'
  points: ProfilePoint[]
  /** Front-neck segment only. Do not use the entire chin-to-neck chord as its direction. */
  directionPoints?: ProfilePoint[]
  angleDegrees: number | null
  edgeSupport: number
  reason: string
}
type Raster = { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
const version = 'HEADUP-NECK-EDGE-3.0' as const
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
const missing = (reason: string): NeckEdgeResult => ({ version, status: 'missing', points: [], angleDegrees: null, edgeSupport: 0, reason })

/** Image-conditioned path optimization, not a trained neck landmark network.
 * Model landmarks only locate the search area. No human neck labels or template
 * coordinates enter this function. Input/output coordinates are normalized;
 * all distances and angles are calculated in isotropic image pixels.
 */
export function traceProfileNeckEdge(image: Raster, landmarks: readonly ProfilePoint[], orientation: 'left' | 'right'): NeckEdgeResult {
  const { width: w, height: h, data } = image
  if (w < 32 || h < 32 || data.length !== w*h*4 || landmarks.length !== 39 || !landmarks.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))) return missing('颈部定位数据不足')
  const right = orientation === 'right'
  // Reflect the search coordinate system, not the source image, for exact parity.
  const pixel = (p: ProfilePoint) => ({ x: (right ? p.x : 1-p.x)*(w-1), y: p.y*(h-1) })
  const jaw = landmarks.slice(4,11).map(pixel), chin = pixel(landmarks[10]), brow = pixel(landmarks[14])
  const fh = Math.hypot(brow.x-jaw[4].x,brow.y-jaw[4].y)
  if (fh < 24 || fh > h*.85) return missing('侧貌定位范围异常')
  const y0 = Math.round(Math.max(chin.y,jaw[4].y)+fh*.05), y1 = Math.round(Math.min(h-5,y0+fh*.5))
  const x0 = Math.round(Math.max(4, Math.min(...jaw.map(p=>p.x))-fh*.12))
  const x1 = Math.round(Math.min(w-5, chin.x+fh*.12))
  if (y1-y0 < fh*.25 || x1-x0 < 12) return missing('颈部被裁切，请将下巴至锁骨上方纳入照片')
  const rgb = (x: number,y: number) => {
    const sx = clamp(Math.round(right ? x : w-1-x),0,w-1), sy=clamp(Math.round(y),0,h-1), i=(sy*w+sx)*4
    return [data[i],data[i+1],data[i+2]]
  }
  const colorDistance = (a: number[], b: number[]) => Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])/Math.sqrt(3)
  const average = (x:number,y:number,r:number) => {
    const c=[0,0,0]; let n=0
    for(let dy=-1;dy<=1;dy++)for(let dx=-r;dx<=r;dx++){const q=rgb(x+dx,y+dy);for(let k=0;k<3;k++)c[k]+=q[k];n++}
    return c.map(v=>v/n)
  }
  const rows=Math.min(64,y1-y0+1), cols=x1-x0+1, offset=Math.max(2,Math.round(fh*.018))
  const evidence=new Float32Array(rows*cols), back=new Int16Array(rows*cols)
  let prev=new Float64Array(cols), next=new Float64Array(cols)
  const step=Math.max(2,Math.ceil((y1-y0)/(rows-1)*2)), sampleYs:number[]=[]
  for(let row=0;row<rows;row++){
    const y=y0+(y1-y0)*row/(rows-1);sampleYs.push(y)
    const bg=average(Math.min(w-3,x1+fh*.16),y,2)
    for(let col=0;col<cols;col++){
      const x=x0+col, inside=average(x-offset,y,1), outside=average(x+offset,y,1)
      const contrast=colorDistance(inside,outside)
      // Prefer the outer subject boundary over an internal shadow/hair edge.
      const outsideMismatch=colorDistance(outside,bg)
      const support=Math.max(0,contrast-.7*outsideMismatch)
      evidence[row*cols+col]=support
      const local=-Math.min(90,support)
      let best=Infinity, from=col
      if(!row){best=0}else for(let k=Math.max(0,col-step);k<=Math.min(cols-1,col+step);k++){
        const cost=prev[k]+1.5*(k-col)**2
        if(cost<best){best=cost;from=k}
      }
      next[col]=best+local;back[row*cols+col]=from
    }
    ;[prev,next]=[next,prev]
  }
  let end=0;for(let c=1;c<cols;c++)if(prev[c]<prev[end])end=c
  const raw:ProfilePoint[]=Array(rows), supports:number[]=[]
  for(let row=rows-1;row>=0;row--){raw[row]={x:x0+end,y:sampleYs[row]};supports.push(evidence[row*cols+end]);end=back[row*cols+end]}
  // A local median suppresses isolated pixel jumps without imposing a template.
  const smooth=raw.map((p,i)=>({x:raw.slice(Math.max(0,i-2),Math.min(rows,i+3)).map(q=>q.x).sort((a,b)=>a-b)[Math.floor((Math.min(rows,i+3)-Math.max(0,i-2))/2)],y:p.y}))
  // Recover the near-horizontal submental boundary with a true 8-connected
  // image path. The row-wise neck search above supplies a destination, not a
  // fabricated straight bridge across the missing chin-to-neck section.
  const chinSeed=jaw.slice(4).reduce((a,b)=>b.y>a.y?b:a)
  const top=Math.max(3,Math.floor(chinSeed.y-fh*.16)), bottom=Math.min(h-4,Math.ceil(smooth[12].y+fh*.06))
  const gw=x1-x0+1,gh=bottom-top+1, strength=new Float32Array(gw*gh)
  const bg=average(Math.min(w-3,x1+fh*.16),chinSeed.y,2)
  const directions=[[1,0],[0,1],[Math.SQRT1_2,Math.SQRT1_2]]
  for(let y=top;y<=bottom;y++)for(let x=x0;x<=x1;x++){
    let best=0
    for(const [dx,dy]of directions){
      const inside=average(x-offset*dx,y-offset*dy,1),outside=average(x+offset*dx,y+offset*dy,1)
      best=Math.max(best,colorDistance(inside,outside)-.7*colorDistance(outside,bg))
    }
    strength[(y-top)*gw+x-x0]=Math.max(0,best)
  }
  let start=-1,startScore=-Infinity
  for(let y=top;y<=bottom;y++)for(let x=x0;x<=x1;x++){
    const d=Math.hypot(x-chinSeed.x,y-chinSeed.y)
    if(d>fh*.16)continue
    const i=(y-top)*gw+x-x0,score=Math.min(70,strength[i])-d*1.2
    if(score>startScore){startScore=score;start=i}
  }
  const target=(Math.round(smooth[12].y)-top)*gw+Math.round(smooth[12].x)-x0
  const bridge=start>=0?minimumEdgePath(strength,gw,gh,start,target):[]
  const joined=[...bridge.map(i=>({x:x0+i%gw,y:top+Math.floor(i/gw)})),...smooth.slice(13)]
  const connectionSupport=bridge.length?bridge.filter(i=>strength[i]>=10).length/bridge.length:0
  const support=Math.min(supports.filter(v=>v>=10).length/rows,connectionSupport)
  const boundaryHit=smooth.filter(p=>p.x<=x0+2||p.x>=x1-2).length/rows
  const status=support>=.75&&boundaryHit<.15?'traced':'weak'
  const normalize=(p:ProfilePoint)=>({x:(right?p.x:w-1-p.x)/(w-1),y:p.y/(h-1)})
  const points=joined.filter((_,i)=>i%2===0||i===joined.length-1).map(normalize)
  const directionPoints=smooth.map(normalize)
  const angle=status==='traced'?jawNeckLineAngleDegrees(jaw,smooth):null
  return { version, status, points, directionPoints, angleDegrees:angle, edgeSupport:support, reason:status==='traced'?'颏下至前颈连续追踪 · 误差待独立校准':'颏下或颈部边缘较弱，虚线为自动候选；请使用轮廓与背景分离的照片' }
}

/** Positive-cost Dijkstra on the pixel grid; can turn horizontally and upwards. */
function minimumEdgePath(strength:Float32Array,width:number,height:number,start:number,target:number):number[]{
  if(target<0||target>=strength.length)return[]
  const cost=new Float64Array(strength.length).fill(Infinity),previous=new Int32Array(strength.length).fill(-1)
  const heap:Array<{i:number;cost:number}>=[]
  const push=(entry:{i:number;cost:number})=>{heap.push(entry);let k=heap.length-1;while(k){const p=(k-1)>>1;if(heap[p].cost<=entry.cost)break;heap[k]=heap[p];k=p}heap[k]=entry}
  const pop=()=>{const first=heap[0],last=heap.pop()!;if(heap.length){let k=0;while(k*2+1<heap.length){let c=k*2+1;if(c+1<heap.length&&heap[c+1].cost<heap[c].cost)c++;if(heap[c].cost>=last.cost)break;heap[k]=heap[c];k=c}heap[k]=last}return first}
  cost[start]=0;push({i:start,cost:0})
  while(heap.length){
    const current=pop();if(current.cost!==cost[current.i])continue;if(current.i===target)break
    const x=current.i%width,y=Math.floor(current.i/width)
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dx&&!dy||x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue
      const next=(y+dy)*width+x+dx,s=Math.min(strength[current.i],strength[next])
      const nextCost=current.cost+Math.hypot(dx,dy)*(1+25/(1+s/5)**2)
      if(nextCost<cost[next]){cost[next]=nextCost;previous[next]=current.i;push({i:next,cost:nextCost})}
    }
  }
  if(!Number.isFinite(cost[target]))return[]
  const path:number[]=[];for(let i=target;i!==-1;i=previous[i]){path.push(i);if(i===start)break}
  return path.reverse()
}

export function traceProfileNeckBitmap(bitmap: ImageBitmap, landmarks: readonly ProfilePoint[], orientation:'left'|'right'): NeckEdgeResult {
  try {
    const scale=Math.min(1,720/Math.max(bitmap.width,bitmap.height)), canvas=document.createElement('canvas')
    canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale)
    const context=canvas.getContext('2d',{willReadFrequently:true})
    if(!context)return missing('颈部图像读取失败')
    context.drawImage(bitmap,0,0,canvas.width,canvas.height)
    return traceProfileNeckEdge(context.getImageData(0,0,canvas.width,canvas.height),landmarks,orientation)
  }catch{return missing('颈部图像读取失败，其他侧貌测量保留')}
}
