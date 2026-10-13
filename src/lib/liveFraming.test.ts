import {describe,expect,it} from 'vitest'
import type {PoseValidation} from '../types'
import {evaluateLiveFraming} from './liveFraming'

const goodBounds={x:.29,y:.25,width:.42,height:.50}
function pose(faceBounds:PoseValidation['faceBounds']=goodBounds):PoseValidation {
  return {status:'pass',estimatedPose:'front',detectedFaces:1,flags:[],faceBounds}
}

describe('live relative framing',()=>{
  it.each([
    ['portrait',goodBounds],
    ['landscape',{x:.365,y:.25,width:.27,height:.50}],
  ] as const)('accepts normalized %s framing without claiming a measured distance',(_shape,bounds)=>{
    const result=evaluateLiveFraming(pose(bounds),'front')
    expect(result.ready).toBe(true)
    expect(result.message).toBeUndefined()
    expect(result.distance.state).toBe('good')
    expect(result.completeness.detail).toContain('顶部、下巴和两侧留白')
    expect(JSON.stringify(result)).not.toMatch(/厘米|cm|米远|头顶完整|头发完整/)
  })

  it.each([
    ['顶部',{...goodBounds,y:.10},'向下'],
    ['下巴',{...goodBounds,y:.45},'向上'],
    ['左侧',{...goodBounds,x:.02},'向右'],
    ['右侧',{...goodBounds,x:.57},'向左'],
  ] as const)('detects missing %s margin and gives unmirrored correction', (edge,bounds,correction)=>{
    const result=evaluateLiveFraming(pose(bounds),'front')
    expect(result.ready).toBe(false)
    expect(result.completeness.state).toBe('adjust')
    expect(result.message).toContain(`${edge}留白不足`)
    expect(result.message).toContain(correction)
  })

  it('prioritizes missing margins over small size or off-center position',()=>{
    const result=evaluateLiveFraming(pose({x:.02,y:.35,width:.15,height:.30}),'front')
    expect(result.distance.label).toBe('靠近一点')
    expect(result.position.state).toBe('adjust')
    expect(result.message).toBe(result.completeness.detail)
  })

  it('requests backing away when the face is too large, never moving closer',()=>{
    const result=evaluateLiveFraming(pose({x:.10,y:.10,width:.80,height:.80}),'front')
    expect(result.distance.label).toBe('退后一点')
    expect(result.message).toContain('退后一点')
    expect(result.ready).toBe(false)
  })

  it('uses both face area and height for a small face',()=>{
    expect(evaluateLiveFraming(pose({x:.425,y:.3,width:.15,height:.4}),'front').distance.label).toBe('靠近一点')
    expect(evaluateLiveFraming(pose({x:.3,y:.35,width:.4,height:.3}),'front').distance.label).toBe('靠近一点')
  })

  it('allows a narrower side face while retaining the minimum height',()=>{
    const face=pose({x:.405,y:.29,width:.19,height:.42})
    expect(evaluateLiveFraming(face,'front').distance.state).toBe('adjust')
    expect(evaluateLiveFraming(face,'profile').ready).toBe(true)
  })

  it.each([
    [{x:.15,y:.25,width:.30,height:.5},'向右'],
    [{x:.55,y:.25,width:.30,height:.5},'向左'],
    [{x:.35,y:.16,width:.30,height:.4},'向下'],
    [{x:.35,y:.44,width:.30,height:.4},'向上'],
  ] as const)('gives position corrections for %j', (bounds,direction)=>{
    const result=evaluateLiveFraming(pose(bounds),'front')
    expect(result.completeness.state).toBe('good')
    expect(result.position.detail).toContain(direction)
    expect(result.message).toBe(result.position.detail)
    expect(result.ready).toBe(false)
  })

  it('applies the same size and edge thresholds to either side',()=>{
    const left=pose({x:.04,y:.25,width:.30,height:.50})
    const right=pose({x:.66,y:.25,width:.30,height:.50})
    left.estimatedPose='left_profile';right.estimatedPose='right_profile'
    const a=evaluateLiveFraming(left,'profile'),b=evaluateLiveFraming(right,'profile')
    expect(a.distance).toEqual(b.distance)
    expect(a.ready).toBe(b.ready)
    expect(a.completeness.state).toBe(b.completeness.state)
    expect(a.message).toContain('左侧')
    expect(b.message).toContain('右侧')
  })

  it('keeps out-of-image coordinates as an adjustment instead of clamping them to a good frame',()=>{
    const result=evaluateLiveFraming(pose({x:-.1,y:.25,width:.42,height:.50}),'front')
    expect(result.completeness.state).toBe('adjust')
    expect(result.ready).toBe(false)
  })

  it.each([
    undefined,
    {...goodBounds,x:NaN},
    {...goodBounds,y:Infinity},
    {...goodBounds,width:0},
    {...goodBounds,height:-.5},
    {...goodBounds,width:Infinity},
    {...goodBounds,x:Number.MAX_VALUE,width:Number.MAX_VALUE},
  ])('does not mark missing or invalid bounds as ready: %j',bounds=>{
    const sample=pose();sample.faceBounds=bounds
    const result=evaluateLiveFraming(sample,'front')
    expect(result.ready).toBe(false)
    expect(result.distance.state).toBe('unknown')
    expect(result.completeness.state).toBe('unknown')
    expect(result.position.state).toBe('unknown')
  })

  it.each([0,2])('requires exactly one face (%i)',detectedFaces=>{
    expect(evaluateLiveFraming({...pose(),detectedFaces},'front').ready).toBe(false)
  })

  it.each(['left_profile','right_profile'] as const)('uses the single side detector bounds when landmarks cannot detect %s',estimatedPose=>{
    const side={...pose({x:.425,y:.3,width:.15,height:.4}),detectedFaces:0,estimatedPose}
    const small=evaluateLiveFraming(side,'profile')
    expect(small.distance.label).toBe('靠近一点')
    expect(small.ready).toBe(false)
    expect(evaluateLiveFraming({...side,faceBounds:goodBounds},'profile').ready).toBe(true)
    expect(evaluateLiveFraming({...side,faceBounds:undefined},'profile').distance.state).toBe('unknown')
    expect(evaluateLiveFraming({...side,faceBounds:goodBounds},'front').distance.state).toBe('unknown')
  })

  it.each(['no_face','multiple_faces'] as const)('never accepts %s even if stale bounds remain',estimatedPose=>{
    for(const detectedFaces of [0,1,2]) {
      const result=evaluateLiveFraming({...pose(),detectedFaces,estimatedPose},'profile')
      expect(result.ready).toBe(false)
      expect(result.distance.state).toBe('unknown')
    }
  })
})
