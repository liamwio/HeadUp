import {expect,it} from 'vitest'
import type {Capture,PoseValidation} from '../types'
import {reportedFaceCount} from './reportedFaceCount'
import {buildConsumerReport,captureResult} from './consumerReport'

const old:PoseValidation={status:'reject',estimatedPose:'left_profile',detectedFaces:0,faceDetectorScore:.93,roll:22,yaw:81,pitch:2,flags:['头部横向倾斜过大']}
it('explains a saved zero-mesh rejection without overwriting it or inventing measurements',()=>{
  const capture:Capture={id:'profile',label:'侧面',hint:'',eyebrow:'',url:'photo',poseValidation:old}
  const before=JSON.stringify(capture)
  const result=captureResult(capture)
  expect(result.facts).toContain('检测到 1 张人脸')
  expect(result.facts).toContain('模型估计横向倾斜 22.00°')
  expect(result.issues[0]).toContain('尚未进行关键点定位和测量')
  expect(result.issues[0]).toContain('22.0°')
  expect(result.issues[0]).toContain('18°')
  expect(buildConsumerReport([capture]).measuredCount).toBe(0)
  expect(JSON.stringify(capture)).toBe(before)
})
it('does not infer a face count without independent evidence or contradict no-face/multiple-face results',()=>{
  expect(reportedFaceCount({...old,faceDetectorScore:undefined},true)).toBeUndefined()
  expect(reportedFaceCount({...old,faceDetectorScore:.8},true)).toBeUndefined()
  expect(reportedFaceCount({...old,estimatedPose:'no_face'},true)).toBe(0)
  expect(reportedFaceCount({...old,estimatedPose:'multiple_faces',detectedFaces:2},true)).toBe(2)
  expect(reportedFaceCount(old,false)).toBe(0)
})
