import {readCapture} from '../lib/readCapture'
import {isPhotoQualityAcceptable} from '../lib/photoQualityAcceptance'
import {reportVersion} from '../data/report'
import {alignedBurstMedian,type BurstFrame} from './alignedBurstMedian'
import {computeProfileGeometry} from '../lib/profileGeometry'

/** Isolated research acquisition: capture originals first, then run existing
 * models. No product flag enables this and nothing writes to user history.
 */
export async function captureResearchBurst({view,take,current,count=7,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),analyze=readCapture}:{view:BurstFrame['view'];take:()=>Promise<File>;current:()=>boolean;count?:number;wait?:(ms:number)=>Promise<void>;analyze?:typeof readCapture}){
 if(!Number.isInteger(count)||count<5||count>10)throw Error('requires_5_to_10_frames')
 const check=()=>{if(!current())throw new DOMException('研究采集已停止','AbortError')},originals:Array<{id:string;file:File;capturedAt:string}>=[]
 let bytes=0
 for(let i=0;i<count;i++){check();if(i)await wait(100);check();const file=await take();check();bytes+=file.size;if(bytes>64*1024*1024)throw Error('research_burst_exceeds_64mb');originals.push({id:crypto.randomUUID(),file,capturedAt:new Date().toISOString()})}
 const frames:BurstFrame[]=[],axes=new Map<string,number>()
 for(const original of originals){
   check();const result=await analyze(view==='front'?'front':'profile',original.file,false);check()
   const pose=result.pose,native=pose?.nativeProfile,landmarks=view==='front'?pose?.landmarks:native?.landmarks
   if(Number.isFinite(native?.headAxisAngleDegrees))axes.set(original.id,native!.headAxisAngleDegrees!)
   const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await original.file.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('')
   frames.push({id:original.id,sha256,width:result.width,height:result.height,points:(landmarks??[]).map(p=>({x:p.x*result.width,y:p.y*result.height})),source:view==='front'?reportVersion.algorithm:[native?.modelVersion,native?.cropVersion,native?.refinerVersion,native?.geometryModelVersion].join('|'),view,qualityPassed:isPhotoQualityAcceptable(result.quality),posePassed:!result.analysisError&&pose?.status==='pass'&&pose.estimatedPose===view&&(view==='front'||native?.status==='measured'),sharpness:result.quality.sharpness})
 }
 const aggregate=alignedBurstMedian(frames);check()
 const axis=axes.get(aggregate.referenceFrameId)
 const profileGeometry=view!=='front'&&axis!==undefined?computeProfileGeometry({landmarks:aggregate.points,orientation:view==='left_profile'?'left':'right',headAxisAngleDegrees:axis,imageWidth:aggregate.width,imageHeight:aggregate.height}):undefined
 // This is diagnostic geometry under the outer experimental source, not a
 // production report; even finite values have no validated repeatability.
 return {aggregate,frames,originals,profileGeometry,releaseEligible:false as const}
}
