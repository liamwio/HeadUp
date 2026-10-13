import {afterEach,expect,it,vi} from 'vitest'
const mocks=vi.hoisted(()=>({create:vi.fn(),trace:vi.fn()}))
vi.mock('onnxruntime-web/wasm',()=>({InferenceSession:{create:mocks.create},Tensor:class{}}))
vi.mock('./faceDetector',()=>({detectFacesFromBitmap:async()=>({detections:[{score:.95,x:80,y:40,width:120,height:180}]})}))
vi.mock('./profileNeckEdge',()=>({traceProfileNeckBitmap:mocks.trace}))
import {inferNativeProfileFromBitmap} from './nativeProfileInference'
import {computeProfileGeometry} from './profileGeometry'

afterEach(()=>vi.unstubAllGlobals())
it('retains facial landmarks and their real geometry when optional neck tracing throws',async()=>{
  const points=Array.from({length:39},(_,i)=>({x:i*.01,y:i*.02}))
  for(const [index,x,y] of [[4,-3,8],[5,-2,9],[6,-1,10],[7,0,11],[8,1,12],[10,2.5,10],[11,1.5,9],[14,0,0],[17,0,2],[19,3,4],[20,2,5],[21,1,6],[27,2,7],[33,2.2,8]])points[index]={x,y}
  const coordinates=points.flatMap(p=>[(p.x+5)/20,(p.y+3)/20])
  mocks.create.mockImplementation(async(path:string)=>({inputNames:['input'],run:async()=>path.includes('refiner')?{coordinates:{data:Array(path.includes('mandibular')?10:path.includes('mentolabial')?6:10).fill(.5)}}:{coordinates:{data:coordinates},confidence:{data:Array(39).fill(.9)}}}))
  vi.stubGlobal('document',{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(256*256*4)})})})})
  mocks.trace.mockImplementation(()=>{throw new Error('neck canvas unavailable')})
  const result=await inferNativeProfileFromBitmap({width:1000,height:1000} as ImageBitmap,{status:'pass',estimatedPose:'right_profile',detectedFaces:1,flags:[],roll:0})
  expect(result.status).toBe('measured')
  expect(mocks.trace).toHaveBeenCalledOnce()
  expect(result.neckEdge).toBeUndefined()
  expect(result.landmarks).toHaveLength(39)
  const recalculated=computeProfileGeometry({landmarks:result.landmarks!.map(p=>({x:p.x*1000,y:p.y*1000})),orientation:'right',headAxisAngleDegrees:0})
  expect(recalculated.status).toBe('measured')
  if(recalculated.status==='measured')expect(result.geometry).toEqual(recalculated.geometry)
  expect(result.geometrySource).toBe('landmark_derived')
})
