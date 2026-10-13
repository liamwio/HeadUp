import {beforeEach,expect,it,vi} from 'vitest'
const mocks=vi.hoisted(()=>({mesh:vi.fn(),pose:vi.fn(),faces:vi.fn()}))
vi.mock('@mediapipe/tasks-vision',()=>({FilesetResolver:{forVisionTasks:mocks.mesh},FaceLandmarker:{createFromOptions:vi.fn()}}))
vi.mock('./wideHeadPose',()=>({estimateWideHeadPoseFromBitmap:mocks.pose}))
vi.mock('./faceDetector',()=>({detectFacesFromBitmap:mocks.faces}))
import {inspectCapturePoseBitmap} from './facePose'
const detection={score:.95,x:80,y:50,width:100,height:110,areaRatio:.107,centerDistance:.14}
beforeEach(()=>{
  vi.clearAllMocks()
  mocks.mesh.mockRejectedValue(new Error('frontal model unavailable'))
  mocks.pose.mockResolvedValue({yaw:80,pitch:0,roll:0})
  mocks.faces.mockResolvedValue({inputWidth:320,inputHeight:320,contentWidth:320,contentHeight:320,detections:[detection]})
})
it.each([80,-80])('measures profile pose without loading the unavailable frontal model, yaw %s',async yaw=>{
  mocks.pose.mockResolvedValue({yaw,pitch:0,roll:0})
  const pose=await inspectCapturePoseBitmap('profile',{} as ImageBitmap)
  expect(pose.status).toBe('pass')
  expect(pose.estimatedPose).toBe(yaw>0?'left_profile':'right_profile')
  expect(pose.detectedFaces).toBe(1)
  expect(mocks.mesh).not.toHaveBeenCalled()
})
it('still rejects multiple independently detected faces',async()=>{
  mocks.faces.mockResolvedValue({detections:[detection,{...detection,score:.8}]})
  expect((await inspectCapturePoseBitmap('profile',{} as ImageBitmap)).estimatedPose).toBe('multiple_faces')
})
it('still requires the frontal mesh for frontal measurement',async()=>{
  await expect(inspectCapturePoseBitmap('front',{} as ImageBitmap)).rejects.toThrow('frontal model unavailable')
})
