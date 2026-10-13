import { describe, expect, it, vi } from 'vitest'
import type { LandmarkPoint } from '../types'
import { estimateFrontTilt, rotationLayout, rotatedFaceFits, straighteningAlignmentRms } from './photoStraightening'
import { prepareCaptureFile, type CaptureInspection } from './prepareCaptureFile'
import { revokeCaptureImages } from './captureImageUrls'
import { captureResult } from './consumerReport'

function fixture():LandmarkPoint[] {
  const p=Array.from({length:478},()=>({x:.5,y:.5,z:0}))
  for(const [i,x,y] of [[10,.5,.1],[168,.5,.3],[6,.5,.35],[1,.5,.4],[2,.5,.55],[152,.5,.9],[234,.1,.5],[454,.9,.5],[33,.2,.35],[133,.4,.35],[362,.6,.35],[263,.8,.35],[61,.35,.7],[291,.65,.7],[172,.2,.8],[397,.8,.8]])p[i]={x,y,z:0}
  for(let i=468;i<478;i++)p[i]={x:i<473?.3:.7,y:.35,z:0}
  return p
}
function rotated(points:LandmarkPoint[],width:number,height:number,degrees:number) {
  const l=rotationLayout(width,height,degrees)
  return {width:l.width,height:l.height,landmarks:points.map(p=>{const x=p.x*width-width/2,y=p.y*height-height/2;return{x:(x*l.c-y*l.s+l.width/2)/l.width,y:(x*l.s+y*l.c+l.height/2)/l.height,z:0}})}
}
function inspection(degrees=0):CaptureInspection {
  const r=rotated(fixture(),1600,1200,degrees)
  return {width:r.width,height:r.height,quality:{score:95,resolution:100,brightness:90,contrast:95,sharpness:95,flags:[]},pose:{status:degrees>12?'reject':'pass',estimatedPose:'front',detectedFaces:1,faceDetectorScore:.98,yaw:0,pitch:0,roll:degrees,flags:degrees>12?['头部横向倾斜过大']:[],landmarks:r.landmarks,landmarkImageWidth:r.width,landmarkImageHeight:r.height}}
}
function corrected(original:CaptureInspection,degrees:number):CaptureInspection {
  const r=rotated(original.pose.landmarks!,original.width,original.height,-degrees)
  return {...original,width:r.width,height:r.height,quality:{...original.quality},pose:{...original.pose,status:'pass',roll:0,flags:[],landmarks:r.landmarks,landmarkImageWidth:r.width,landmarkImageHeight:r.height}}
}

describe('image-plane straightening geometry',()=>{
  it.each([-25,-15,-5,0,5,15,25])('estimates %s degrees with rectangular-image coordinates',degrees=>{
    const r=inspection(degrees)
    expect(estimateFrontTilt(r.pose.landmarks,r.width,r.height)?.degrees).toBeCloseTo(degrees,8)
    const q=corrected(r,degrees)
    expect(estimateFrontTilt(q.pose.landmarks,q.width,q.height)?.degrees).toBeCloseTo(0,8)
    expect(straighteningAlignmentRms(r.pose.landmarks!,q.pose.landmarks!,r.width,r.height,q.width,q.height,-degrees)).toBeLessThan(1e-12)
  })
  it('declines conflicting eye and midline axes, missing points and degenerate scale',()=>{
    const p=fixture()
    for(let i=473;i<478;i++)p[i].y+=.16
    expect(estimateFrontTilt(p,1600,1200)).toBeNull()
    expect(estimateFrontTilt([],1600,1200)).toBeNull()
    expect(estimateFrontTilt(fixture(),0,1200)).toBeNull()
  })
  it('retains every original image corner without cropping',()=>{
    for(const angle of [-25,-12,12,25]) {
      const r=rotated([{x:0,y:0,z:0},{x:0,y:1,z:0},{x:1,y:0,z:0},{x:1,y:1,z:0}],1600,1200,angle)
      expect(r.landmarks.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1)).toBe(true)
    }
  })
  it('rejects rotation near a frame boundary while retaining a safely framed face',()=>{
    expect(rotatedFaceFits(fixture().map(p=>({...p,x:.5+(p.x-.5)*.7,y:.5+(p.y-.5)*.7})),1600,1200,5)).toBe(true)
    expect(rotatedFaceFits(fixture().map(p=>({...p,x:p.x+.15})),1600,1200,15)).toBe(false)
    expect(rotatedFaceFits([],1600,1200,5)).toBe(false)
  })
})

describe('candidate reinspection and fallback',()=>{
  const originalFile=new File(['original'],'original.jpg',{type:'image/jpeg'}),candidateFile=new File(['candidate'],'upright.png',{type:'image/png'})
  function dependencies(a:CaptureInspection,b?:CaptureInspection) {
    return {inspect:vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b),rotate:vi.fn().mockResolvedValue(candidateFile)}
  }
  it('adopts only a re-detected candidate and leaves the original inspection unchanged',async()=>{
    const a=inspection(15),snapshot=structuredClone(a),b=corrected(a,15),deps=dependencies(a,b)
    const result=await prepareCaptureFile('front',originalFile,true,deps)
    expect(result.file).toBe(candidateFile)
    expect(result.pose).toBe(b.pose)
    expect(result.straightening).toMatchObject({status:'applied',rotationDegrees:-15,originalFlags:['头部横向倾斜过大']})
    expect(deps.inspect.mock.calls.map(c=>c[1])).toEqual([originalFile,candidateFile])
    expect(a).toEqual(snapshot)
    const record=captureResult({id:'front',label:'正面',eyebrow:'',hint:'',straightening:result.straightening,quality:result.quality,poseValidation:result.pose})
    expect(record.facts.join(' ')).toContain('扶正前检测提示：头部横向倾斜过大')
  })
  it.each(['front','profile','top'] as const)('does not rotate when disabled for %s',async id=>{
    const a=inspection(15),deps=dependencies(a)
    expect((await prepareCaptureFile(id,originalFile,false,deps)).straightening.status).toBe('disabled')
    expect(deps.rotate).not.toHaveBeenCalled()
  })
  it.each(['left_profile','right_profile'] as const)('does not trust the unsupported roll of %s',async estimatedPose=>{
    const a=inspection(15);a.pose.estimatedPose=estimatedPose;a.pose.roll=30
    const deps=dependencies(a),r=await prepareCaptureFile('profile',originalFile,true,deps)
    expect(r.file).toBe(originalFile)
    expect(r.straightening.reason).toContain('侧面水平参照尚未验证')
    expect(deps.rotate).not.toHaveBeenCalled()
  })
  it.each(['pitch','yaw','quality','multiple','angle','size'] as const)('does not hide an original %s problem',async issue=>{
    const a=inspection(issue==='angle'?30:15)
    if(issue==='pitch')a.pose.pitch=15
    if(issue==='yaw')a.pose.yaw=25
    if(issue==='quality')a.quality.flags=['画面模糊']
    if(issue==='multiple')a.pose.detectedFaces=2
    if(issue==='size'){a.width=8000;a.height=8000}
    const deps=dependencies(a),r=await prepareCaptureFile('front',originalFile,true,deps)
    expect(r.file).toBe(originalFile);expect(r.straightening.status).toBe('not_applied')
    expect(deps.rotate).not.toHaveBeenCalled()
  })
  it.each(['pose','quality','residual','alignment','missing'] as const)('discards candidates that fail %s verification',async issue=>{
    const a=inspection(15),b=corrected(a,15)
    if(issue==='pose')b.pose.status='reject'
    if(issue==='quality')b.quality.flags=['画面过曝']
    if(issue==='residual'){const p=rotated(b.pose.landmarks!,b.width,b.height,5);b.pose.landmarks=p.landmarks;b.width=p.width;b.height=p.height}
    if(issue==='alignment')b.pose.landmarks=b.pose.landmarks!.map(p=>({...p,x:p.x+.1}))
    if(issue==='missing')b.pose.landmarks=undefined
    const r=await prepareCaptureFile('front',originalFile,true,dependencies(a,b))
    expect(r.file).toBe(originalFile);expect(r.pose).toBe(a.pose);expect(r.straightening.status).toBe('not_applied')
  })
  it('keeps the original when candidate rendering or reinspection throws',async()=>{
    const a=inspection(15),deps=dependencies(a)
    deps.rotate.mockRejectedValue(new Error('canvas failure'))
    expect((await prepareCaptureFile('front',originalFile,true,deps)).file).toBe(originalFile)
    const d2=dependencies(a);d2.inspect.mockReset().mockResolvedValueOnce(a).mockRejectedValueOnce(new Error('decode failure'))
    expect((await prepareCaptureFile('front',originalFile,true,d2)).pose).toBe(a.pose)
  })
  it('does not rotate already level photos',async()=>{
    const deps=dependencies(inspection(0))
    expect((await prepareCaptureFile('front',originalFile,true,deps)).straightening.status).toBe('not_needed')
    expect(deps.rotate).not.toHaveBeenCalled()
  })
  it('does not swallow original input failures',async()=>{
    const deps=dependencies(inspection());deps.inspect.mockReset().mockRejectedValue(new Error('bad input'))
    await expect(prepareCaptureFile('front',originalFile,true,deps)).rejects.toThrow('bad input')
  })
  it('releases both previews once, including when their URLs happen to match',()=>{
    const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
    try {
      revokeCaptureImages({url:'blob:after',originalUrl:'blob:before'})
      expect(revoke.mock.calls.flat()).toEqual(['blob:after','blob:before'])
      revoke.mockClear();revokeCaptureImages({url:'blob:same',originalUrl:'blob:same'})
      expect(revoke).toHaveBeenCalledTimes(1)
    } finally {revoke.mockRestore()}
  })
})
