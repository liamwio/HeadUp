import {it,expect} from 'vitest'
import {liveCaptureChecks} from './liveCaptureChecks'
import type {LiveInspection} from './liveCamera'
const good:LiveInspection={pose:{status:'pass',estimatedPose:'front',detectedFaces:1,yaw:0,pitch:0,roll:0,flags:[],faceBounds:{x:.29,y:.25,width:.42,height:.5}},quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]}}
it('shows six distinct checks and clears every result after a model failure or absent face',()=>{
  const checks=liveCaptureChecks('front',good);expect(checks).toHaveLength(6);expect(new Set(checks.map(c=>c.label)).size).toBe(6);expect(checks.every(c=>c.state==='good')).toBe(true)
  expect(liveCaptureChecks('front',null).every(c=>c.state==='unknown')).toBe(true)
  expect(liveCaptureChecks('front',{...good,pose:{...good.pose,estimatedPose:'no_face'}}).every(c=>c.state==='unknown')).toBe(true)
})
it('does not mark pitch or wrong-side orientation ready even when other checks pass',()=>{
  expect(liveCaptureChecks('front',{...good,pose:{...good.pose,pitch:15}}).find(c=>c.label==='角度')?.state).toBe('adjust')
  expect(liveCaptureChecks('profile',{...good,pose:{...good.pose,estimatedPose:'left_profile'}},'right_profile').find(c=>c.label==='角度')?.state).toBe('adjust')
})
