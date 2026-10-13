import {expect,it,vi} from 'vitest'
import type {PoseValidation} from '../types'
import {profileMeasurementFailure} from './profileMeasurementFailure'
import {readCapture} from './readCapture'
import {captureResult,buildConsumerReport} from './consumerReport'

const pose:PoseValidation={status:'pass',estimatedPose:'left_profile',detectedFaces:1,flags:[]}
const quality={score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]}
it.each([
  ['native39_landmarks_invalid','关键点未能完整定位'],
  ['native39_pose_direction_conflict','方向不一致'],
  ['collapsed_required_profile_landmarks','测量线检查未通过'],
  ['native39_runtime:offline','重试检测'],
  ['native39_output_values_invalid','关键点定位未完成'],
])('explains %s on both new reads and saved reports',async(reason,copy)=>{
  const failed={...pose,nativeProfile:{status:'unavailable' as const,reason}}
  const file=new File(['x'],'side.jpg',{type:'image/jpeg'})
  const result=await readCapture('right_profile',file,true,{prepare:async()=>({file,width:1000,height:1000,quality,pose:failed,straightening:{version:'test',status:'not_applied',reason:'side',originalFlags:[]}}),read:vi.fn(),timeoutMs:100})
  expect(result.analysisError).toContain(copy)
  expect(result.pose).toBe(failed)
  const capture={id:'profile' as const,label:'侧面',eyebrow:'',hint:'',url:'photo',quality,poseValidation:failed}
  expect(captureResult(capture).issues[0]).toContain(copy)
  expect(captureResult(capture).title).toBe('侧面测量未完成')
  expect(buildConsumerReport([capture]).measuredCount).toBe(0)
  expect(buildConsumerReport([capture]).native).toBeNull()
})
it('reports pose and pixel-quality gates before landmark inference',()=>{
  expect(profileMeasurementFailure({...pose,status:'reject',flags:['角度不足']})).toContain('角度不足')
  expect(profileMeasurementFailure(pose,{...quality,score:0,flags:['照片太暗']})).toContain('照片太暗')
})
it('does not report success merely because a face was detected',()=>{
  expect(profileMeasurementFailure(pose,quality)).toContain('未生成测量线')
  expect(profileMeasurementFailure({...pose,nativeProfile:{status:'measured'}},quality)).toBeUndefined()
})
