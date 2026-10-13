import type {PhotoQuality,CaptureSelection} from '../types'
import {isPhotoQualityAcceptable} from './photoQualityAcceptance'
type Candidate={quality?:PhotoQuality}
function rank(candidate:Candidate){const q=candidate.quality;if(!q||!Number.isFinite(q.score)||!Number.isFinite(q.sharpness))return[-1,-1];return[isPhotoQualityAcceptable(q)?1:0,q.sharpness]}
function better(a:Candidate,b:Candidate){const x=rank(a),y=rank(b);return x[0]>y[0]||x[0]===y[0]&&x[1]>y[1]}
/** Keep one unmodified frame. Time budget limits starting more work, not an in-flight encoder. */
export async function captureShortBurst<T extends Candidate>({take,current,enabled=true,now=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}:{take:()=>Promise<T>;current:()=>boolean;enabled?:boolean;now?:()=>number;wait?:(ms:number)=>Promise<void>}):Promise<{frame:T;selection:CaptureSelection}>{
  const start=now(),check=()=>{if(!current())throw new DOMException('拍摄已停止','AbortError')}
  let best:T|undefined,frames=0,selectedIndex=0,firstError:unknown
  for(let i=0;i<(enabled?3:1);i++){
    check()
    if(i){if(now()-start>=650)break;await wait(80);check();if(now()-start>=650)break}
    try{const candidate=await take();check();frames++;if(!best||better(candidate,best)){best=candidate;selectedIndex=frames-1}}
    catch(e){check();firstError??=e;if(best)break}
  }
  check();if(!best)throw firstError??new Error('未能保留相机画面，请重试')
  return {frame:best,selection:{method:'burst-sharpness-v1',frames:frames as 1|2|3,selectedIndex}}
}
