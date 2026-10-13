import type { LandmarkPoint, PhotoQuality, PoseValidation } from '../types'

export const STRAIGHTENING_VERSION = 'HEADUP-ROLL-1.0'
export const STRAIGHTENING_LIMITS = {
  minimumDegrees: 2,
  maximumDegrees: 25,
  maximumAxisDisagreement: 4,
  maximumResidualDegrees: 1.5,
  maximumAlignmentRms: .02,
  maximumInputPixels: 16_000_000,
} as const

export type StraighteningRecord = {
  version: string
  status: 'applied' | 'not_needed' | 'not_applied' | 'disabled'
  reason: string
  estimatedTiltDegrees?: number
  rotationDegrees?: number
  residualTiltDegrees?: number
  originalFlags: string[]
}

export type TiltEstimate = { degrees: number; spread: number }
type Point = { x: number; y: number }
const median = (values:number[]) => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]
const lineAngle = (degrees:number) => ((degrees+90)%180+180)%180-90
const angle = (a:Point,b:Point) => lineAngle(Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI)

/** Three image-plane axes must agree; this is not a 3D pose correction. */
export function estimateFrontTilt(points:readonly LandmarkPoint[]|undefined,width:number,height:number):TiltEstimate|null {
  if(!points||points.length!==478||!Number.isFinite(width+height)||Math.min(width,height)<=0)return null
  const at=(i:number)=>({x:points[i].x*width,y:points[i].y*height})
  const indices=[10,168,6,1,2,152,33,133,362,263,234,454,...Array.from({length:10},(_,i)=>468+i)]
  if(indices.some(i=>!Number.isFinite(points[i]?.x)||!Number.isFinite(points[i]?.y)))return null
  const mean=(ids:number[])=>{const ps=ids.map(at);return{x:ps.reduce((s,p)=>s+p.x,0)/ps.length,y:ps.reduce((s,p)=>s+p.y,0)/ps.length}}
  const eyeLeft=mean([468,469,470,471,472]),eyeRight=mean([473,474,475,476,477])
  const faceWidth=Math.hypot(at(454).x-at(234).x,at(454).y-at(234).y)
  const pupilDistance=Math.hypot(eyeRight.x-eyeLeft.x,eyeRight.y-eyeLeft.y)
  if(faceWidth<Math.min(width,height)*.15||pupilDistance<faceWidth*.3||pupilDistance>faceWidth*.75)return null
  const mid=[10,168,6,1,2,152].map(at),center=mean([10,168,6,1,2,152])
  let xx=0,xy=0,yy=0
  for(const p of mid){const x=p.x-center.x,y=p.y-center.y;xx+=x*x;xy+=x*y;yy+=y*y}
  if(xx+yy<1e-8)return null
  const a=.5*Math.atan2(2*xy,xx-yy)
  const midlineHorizontal=lineAngle((a-Math.PI/2)*180/Math.PI)
  const estimates=[angle(eyeLeft,eyeRight),angle(mean([33,133]),mean([362,263])),midlineHorizontal]
  const degrees=median(estimates),spread=Math.max(...estimates.map(v=>Math.abs(lineAngle(v-degrees))))
  if(spread>STRAIGHTENING_LIMITS.maximumAxisDisagreement)return null
  return {degrees,spread}
}

export function uprightEligibility(pose:PoseValidation,quality:PhotoQuality):string|null {
  if(pose.detectedFaces!==1||pose.estimatedPose!=='front'||(pose.faceDetectorScore??0)<.9)return '未获得可靠的单人正面关键点，保留原图。'
  if(!Number.isFinite(pose.yaw)||!Number.isFinite(pose.pitch)||Math.abs(pose.yaw!)>12||Math.abs(pose.pitch!)>9)return '照片还有转头或俯仰偏差，平面扶正不能消除，保留原图并建议重拍。'
  if(quality.score<60||pose.flags.some(flag=>flag!=='头部横向倾斜过大'))return '照片还有遮挡或取景问题，保留原图并建议重拍。'
  return null
}

/** Expanded canvas preserves every original pixel; no face cropping or scaling. */
export function rotationLayout(width:number,height:number,degrees:number) {
  const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a)
  return {width:Math.ceil(Math.abs(width*c)+Math.abs(height*s)),height:Math.ceil(Math.abs(width*s)+Math.abs(height*c)),c,s}
}

/** Keep the analysis canvas size fixed so synthetic borders do not change the
 * face-area denominator or quality sampling scale. Refuse any rotation that
 * could crop the full landmark bounding rectangle plus an 8% safety margin. */
export function rotatedFaceFits(points:readonly LandmarkPoint[],width:number,height:number,degrees:number) {
  if(points.length!==478||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return false
  const xs=points.map(p=>p.x*width),ys=points.map(p=>p.y*height)
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys)
  if(maxX-minX<=0||maxY-minY<=0)return false
  const marginX=(maxX-minX)*.08,marginY=(maxY-minY)*.08,a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a)
  return [[minX-marginX,minY-marginY],[minX-marginX,maxY+marginY],[maxX+marginX,minY-marginY],[maxX+marginX,maxY+marginY]].every(([x,y])=>{
    const xx=c*(x-width/2)-s*(y-height/2)+width/2,yy=s*(x-width/2)+c*(y-height/2)+height/2
    return xx>=1&&xx<=width-1&&yy>=1&&yy<=height-1
  })
}

const ALIGNMENT_POINTS=[10,168,6,1,2,152,33,133,362,263,61,291,234,454,172,397]
export function straighteningAlignmentRms(before:readonly LandmarkPoint[],after:readonly LandmarkPoint[],width:number,height:number,outWidth:number,outHeight:number,rotationDegrees:number) {
  if(before.length!==478||after.length!==478)return Infinity
  const a=rotationDegrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a)
  const faceWidth=Math.hypot((before[454].x-before[234].x)*width,(before[454].y-before[234].y)*height)
  if(faceWidth<=0)return Infinity
  const squared=ALIGNMENT_POINTS.map(i=>{
    const x=after[i].x*outWidth-outWidth/2,y=after[i].y*outHeight-outHeight/2
    const originalX=c*x+s*y+width/2,originalY=-s*x+c*y+height/2
    return (originalX-before[i].x*width)**2+(originalY-before[i].y*height)**2
  })
  const rms=Math.sqrt(squared.reduce((a,b)=>a+b,0)/squared.length)/faceWidth
  return Number.isFinite(rms)?rms:Infinity
}

export function straighteningMessage(record:StraighteningRecord):string {
  if(record.status==='applied')return `已自动扶正 ${Math.abs(record.rotationDegrees??0).toFixed(1)}°；重新检测通过。仅修正平面歪头，不校正俯仰或透视。`
  return record.reason
}
