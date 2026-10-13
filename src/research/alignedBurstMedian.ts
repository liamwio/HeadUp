/** OFFLINE EXPERIMENT ONLY. No capture/report entry point imports this module.
 * A median point set is meaningful only after mapping every frame into one
 * reference image. It must never be mixed with single-frame production history.
 */
export type BurstPoint={x:number;y:number}
export type BurstFrame={id:string;sha256:string;width:number;height:number;points:BurstPoint[];source:string;view:'front'|'left_profile'|'right_profile';posePassed:boolean;qualityPassed:boolean;sharpness:number}
export const BURST_EXPERIMENT_SOURCE='ALIGNED-BURST-MEDIAN-EXPERIMENT-1'
export const BURST_EXPERIMENT_RELEASE_ENABLED=false
const median=(values:number[])=>{const s=[...values].sort((a,b)=>a-b),mid=Math.floor(s.length/2);return s.length%2?s[mid]:(s[mid-1]+s[mid])/2}
function align(frame:BurstFrame,reference:BurstFrame,anchors:number[]){
 const center=(f:BurstFrame)=>({x:anchors.reduce((v,i)=>v+f.points[i].x,0)/anchors.length,y:anchors.reduce((v,i)=>v+f.points[i].y,0)/anchors.length})
 const from=center(frame),to=center(reference);let dot=0,cross=0,energy=0
 for(const i of anchors){const x=frame.points[i].x-from.x,y=frame.points[i].y-from.y,u=reference.points[i].x-to.x,v=reference.points[i].y-to.y;dot+=x*u+y*v;cross+=x*v-y*u;energy+=x*x+y*y}
 if(energy<1e-8)throw Error('degenerate_alignment_anchors')
 const a=dot/energy,b=cross/energy,tx=to.x-a*from.x+b*from.y,ty=to.y-b*from.x-a*from.y,scale=Math.hypot(a,b),degrees=Math.atan2(b,a)*180/Math.PI
 const map=(p:BurstPoint)=>({x:a*p.x-b*p.y+tx,y:b*p.x+a*p.y+ty})
 const anchorSpan=Math.sqrt(anchors.reduce((v,i)=>v+(reference.points[i].x-to.x)**2+(reference.points[i].y-to.y)**2,0)/anchors.length)
 if(anchorSpan<1)throw Error('degenerate_alignment_anchors')
 const rms=Math.sqrt(anchors.reduce((v,i)=>{const p=map(frame.points[i]);return v+(p.x-reference.points[i].x)**2+(p.y-reference.points[i].y)**2},0)/anchors.length)/anchorSpan
 return {points:frame.points.map(map),transform:{a,b,tx,ty},scale,degrees,rms}
}
export function alignedBurstMedian(frames:BurstFrame[]){
 if(frames.length<5||frames.length>10)throw Error('requires_5_to_10_frames')
 if(new Set(frames.map(f=>f.id)).size!==frames.length||new Set(frames.map(f=>f.sha256)).size!==frames.length)throw Error('duplicate_frames')
 const qualified=frames.filter(f=>f.posePassed&&f.qualityPassed)
 if(qualified.length<5)throw Error('fewer_than_5_qualified_frames')
 const reference=[...qualified].sort((a,b)=>b.sharpness-a.sharpness)[0],length=reference.view==='front'?478:39,anchors=reference.view==='front'?[33,133,362,263,168]:[14,16,17,19]
 for(const f of qualified){
   if(f.view!==reference.view||f.source!==reference.source||!f.source||f.width!==reference.width||f.height!==reference.height)throw Error('incompatible_frame_sources')
   if(!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isFinite(f.sharpness)||!Number.isFinite(f.width+f.height)||f.width<=0||f.height<=0||f.points.length!==length||f.points.some(p=>!Number.isFinite(p.x+p.y)||p.x<0||p.x>f.width||p.y<0||p.y>f.height))throw Error('invalid_frame_geometry')
 }
 // Research screening constants; not clinically calibrated acceptance limits.
 const aligned=qualified.map(frame=>({frame,...align(frame,reference,anchors)})).filter(r=>r.rms<=.02&&r.scale>=.9&&r.scale<=1.1&&Math.abs(r.degrees)<=5)
 if(aligned.length<5)throw Error('fewer_than_5_aligned_frames')
 const points=Array.from({length},(_,i)=>({x:median(aligned.map(r=>r.points[i].x)),y:median(aligned.map(r=>r.points[i].y))}))
 if(points.some(p=>p.x<0||p.x>reference.width||p.y<0||p.y>reference.height))throw Error('median_outside_reference_image')
 return {source:BURST_EXPERIMENT_SOURCE,releaseEligible:false as const,referenceFrameId:reference.id,width:reference.width,height:reference.height,view:reference.view,points,anchors,contributors:aligned.map(r=>({id:r.frame.id,sha256:r.frame.sha256,originalPoints:r.frame.points.map(p=>({...p})),transform:r.transform,residual:r.rms})),excluded:frames.filter(f=>!aligned.some(r=>r.frame.id===f.id)).map(f=>f.id)}
}
