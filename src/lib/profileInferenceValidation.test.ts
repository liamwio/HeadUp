import {describe,expect,it} from 'vitest'
import {nativeProfileLandmarkRejection,nativeProfileOutputRejection,validNormalizedProfileOutput} from './profileInferenceValidation'

const coordinates=()=>new Float32Array(78).fill(.5)
const confidence=()=>new Float32Array(39).fill(.01)
const landmarks=()=>Array.from({length:39},(_,index)=>({x:index===19?.7:.5,y:.5}))

describe('native profile numeric output contract',()=>{
  it('accepts finite normalized heads, including low confidence without inventing a threshold',()=>{
    const points=coordinates(),scores=confidence()
    points[0]=0;points[1]=1;scores[0]=0;scores[1]=1
    expect(nativeProfileOutputRejection(points,scores)).toBeUndefined()
  })
  it.each([undefined,null,new Float32Array(77),new Float32Array(79)])('rejects missing or incorrect coordinate count',value=>{
    expect(nativeProfileOutputRejection(value,confidence())).toBe('native39_output_contract_failed')
  })
  it.each([undefined,null,new Float32Array(38),new Float32Array(40)])('rejects missing or incorrect confidence count',value=>{
    expect(nativeProfileOutputRejection(coordinates(),value)).toBe('native39_output_contract_failed')
  })
  it.each([NaN,Infinity,-Infinity,-.001,1.001])('rejects invalid coordinate %s',value=>{
    const points=coordinates();points[17]=value
    expect(nativeProfileOutputRejection(points,confidence())).toBe('native39_output_values_invalid')
  })
  it.each([NaN,Infinity,-Infinity,-.001,1.001])('rejects invalid confidence %s',value=>{
    const scores=confidence();scores[20]=value
    expect(nativeProfileOutputRejection(coordinates(),scores)).toBe('native39_output_values_invalid')
  })
  it('rejects coercible strings rather than silently accepting the wrong tensor type',()=>{
    const points:Array<unknown>=Array.from(coordinates());points[0]='0.5'
    expect(nativeProfileOutputRejection(points,confidence())).toBe('native39_output_values_invalid')
  })
  it('validates each local refiner coordinate and its own point count',()=>{
    expect(validNormalizedProfileOutput(new Float32Array(10).fill(.5),10)).toBe(true)
    expect(validNormalizedProfileOutput(new Float32Array(10).fill(NaN),10)).toBe(false)
    expect(validNormalizedProfileOutput(new Float32Array(10).fill(1.5),10)).toBe(false)
    expect(validNormalizedProfileOutput(new Float32Array(10).fill(.5),6)).toBe(false)
  })
})

describe('native profile normalized landmark and direction contract',()=>{
  it('accepts a right profile and its left-profile mirror',()=>{
    const points=landmarks()
    expect(nativeProfileLandmarkRejection(points,'right')).toBeUndefined()
    expect(nativeProfileLandmarkRejection(points.map(point=>({...point,x:1-point.x})),'left')).toBeUndefined()
  })
  it('rejects direction conflicts before refinement and newly reversed points after refinement',()=>{
    const before=landmarks(),after=before.map(point=>({...point}))
    expect(nativeProfileLandmarkRejection(before,'left')).toBe('native39_pose_direction_conflict')
    expect(nativeProfileLandmarkRejection(before,'right')).toBeUndefined()
    after[19].x=.4
    expect(nativeProfileLandmarkRejection(after,'right')).toBe('native39_pose_direction_conflict')
  })
  it.each(['left','right'] as const)('rejects a collapsed nose/chin direction for %s',orientation=>{
    const points=landmarks();points[19].x=points[10].x
    expect(nativeProfileLandmarkRejection(points,orientation)).toBe('native39_pose_direction_conflict')
  })
  it.each([NaN,Infinity,-Infinity,-.001,1.001])('rejects invalid final normalized point %s',value=>{
    const points=landmarks();points[4].y=value
    expect(nativeProfileLandmarkRejection(points,'right')).toBe('native39_landmarks_invalid')
  })
  it('requires all 39 output points after refinement',()=>{
    expect(nativeProfileLandmarkRejection(landmarks().slice(1),'right')).toBe('native39_landmarks_invalid')
  })
})
