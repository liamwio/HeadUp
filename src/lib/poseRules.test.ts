import { describe, expect, it } from 'vitest'
import { classifyYaw,PROFILE_MINIMUM_ABSOLUTE_YAW, validateCapturePoseRules } from './poseRules'
import { isPoseAcceptable } from './facePose'

const profileFace = {
  inputWidth: 320,
  inputHeight: 320,
  detections: [{ score: 0.9, x: 80, y: 50, width: 100, height: 110, areaRatio: 0.107, centerDistance: 0.14 }],
}

const frontFace = {
  inputWidth: 320,
  inputHeight: 320,
  detections: [{ score: 0.94, x: 100, y: 70, width: 120, height: 120, areaRatio: 0.141, centerDistance: 0.02 }],
}

describe('wide head-pose rules', () => {
  it('classifies calibrated London-set directions', () => {
    expect(classifyYaw(-84.5)).toBe('right_profile')
    expect(classifyYaw(79.7)).toBe('left_profile')
    expect(classifyYaw(-1.6)).toBe('front')
  })

  it('rejects external three-quarter false accepts while retaining the 70-degree boundary',()=>{
    expect(PROFILE_MINIMUM_ABSOLUTE_YAW).toBe(70)
    expect(classifyYaw(-49.9)).toBe('oblique')
    expect(classifyYaw(-69.9)).toBe('oblique')
    expect(classifyYaw(-70)).toBe('right_profile')
    expect(validateCapturePoseRules('profile',{yaw:-49.9,roll:5.9,pitch:-6.5},1,profileFace).flags[0]).toContain('接近 90°')
  })

  it('accepts a right profile even when the frontal landmarker cannot see it', () => {
    expect(validateCapturePoseRules('profile', { yaw: -84.5, roll: -1.2, pitch: 1.8 }, 0, profileFace).status).toBe('pass')
  })

  it('accepts a left profile in the same slot without requiring frontal landmarks', () => {
    const result = validateCapturePoseRules('profile', { yaw: 79.7, roll: -3.9, pitch: -0.3 }, 0, profileFace)
    expect(result.status).toBe('pass')
    expect(result.estimatedPose).toBe('left_profile')
    expect(result.flags).toEqual([])
  })

  it.each([-1,1])('applies identical profile quality and pose boundaries to direction %s',sign=>{
    const pose={yaw:70*sign,roll:18,pitch:0}
    expect(validateCapturePoseRules('profile',pose,0,profileFace).status).toBe('pass')
    expect(validateCapturePoseRules('profile',{...pose,yaw:69.9*sign},0,profileFace).status).toBe('reject')
    expect(validateCapturePoseRules('profile',{...pose,roll:18.1},0,profileFace).status).toBe('reject')
    expect(validateCapturePoseRules('profile',pose,2,profileFace).estimatedPose).toBe('multiple_faces')
    for(const patch of [{score:.84},{areaRatio:.069},{centerDistance:.251}]) {
      const faces={...profileFace,detections:[{...profileFace.detections[0],...patch}]}
      expect(validateCapturePoseRules('profile',pose,0,faces).status).toBe('reject')
    }
    expect(validateCapturePoseRules('front',pose,1,frontFace).status).toBe('reject')
  })

  it('rejects a visible face as a top-view image', () => {
    expect(validateCapturePoseRules('top', { yaw: 0, roll: 0, pitch: 0 }, 1).status).toBe('reject')
  })

  it('keeps an unverified crown view in review instead of claiming a pass', () => {
    const result = validateCapturePoseRules('top', { yaw: 0, roll: 0, pitch: -70 }, 0)
    expect(result.status).toBe('review')
    expect(isPoseAcceptable(result)).toBe(false)
  })

  it('requires independent high-confidence face evidence for front and profile slots', () => {
    expect(validateCapturePoseRules('front', { yaw: 0, roll: 0, pitch: 0 }, 1).status).toBe('reject')
    expect(validateCapturePoseRules('profile', { yaw: -80, roll: 0, pitch: 0 }, 0).status).toBe('reject')
    expect(validateCapturePoseRules('front', { yaw: 0, roll: 0, pitch: 0 }, 1, frontFace).status).toBe('pass')
  })

  it('rejects a distant or off-centre profile even when score and pose pass', () => {
    const distantFace = { ...profileFace, detections: [{ ...profileFace.detections[0], areaRatio: 0.04 }] }
    const offCentreFace = { ...profileFace, detections: [{ ...profileFace.detections[0], centerDistance: 0.4 }] }
    expect(validateCapturePoseRules('profile', { yaw: -80, roll: 0, pitch: 0 }, 0, distantFace).flags[0]).toContain('太小')
    expect(validateCapturePoseRules('profile', { yaw: -80, roll: 0, pitch: 0 }, 0, offCentreFace).flags[0]).toContain('中央')
  })

  it('retains independent detector metrics on rule rejection for calibration', () => {
    const result = validateCapturePoseRules('front', { yaw: 0, roll: 0, pitch: 0 }, 1, {
      ...frontFace,
      detections: [{ ...frontFace.detections[0], centerDistance: 0.19 }],
    })
    expect(result.status).toBe('reject')
    expect(result.faceDetectorScore).toBe(0.94)
    expect(result.faceAreaRatio).toBe(0.141)
    expect(result.faceCenterDistance).toBe(0.19)
  })

  it.each([-1,1])('retains the independently detected profile face when roll rejects, direction %s',sign=>{
    const result=validateCapturePoseRules('profile',{yaw:80*sign,roll:22,pitch:0},0,profileFace)
    expect(result.status).toBe('reject')
    expect(result.flags).toEqual(['头部横向倾斜过大'])
    expect(result.detectedFaces).toBe(1)
    expect(result.faceDetectorScore).toBe(.9)
    expect(result.nativeProfile).toBeUndefined()
  })

  it('retains the profile face count on framing rejection but not on missing detection',()=>{
    for(const patch of [{areaRatio:.01},{centerDistance:.5}]){
      const result=validateCapturePoseRules('profile',{yaw:80,roll:0,pitch:0},0,{...profileFace,detections:[{...profileFace.detections[0],...patch}]})
      expect(result.status).toBe('reject')
      expect(result.detectedFaces).toBe(1)
    }
    expect(validateCapturePoseRules('profile',{yaw:80,roll:22,pitch:0},0,{...profileFace,detections:[]}).detectedFaces).toBe(0)
  })

  it('uses the MUCT engineering-set front framing, yaw and pitch calibration', () => {
    const widerFraming = {
      ...frontFace,
      detections: [{ ...frontFace.detections[0], centerDistance: 0.18 }],
    }
    expect(validateCapturePoseRules('front', { yaw: 12, roll: 0, pitch: 9 }, 1, widerFraming).status).toBe('pass')
    expect(validateCapturePoseRules('front', { yaw: 12.1, roll: 0, pitch: 0 }, 1, widerFraming).flags[0]).toContain('直视镜头')
    expect(validateCapturePoseRules('front', { yaw: 0, roll: 0, pitch: 9.1 }, 1, widerFraming).flags[0]).toContain('镜头需与眼睛同高')
    expect(validateCapturePoseRules('front', { yaw: 0, roll: 0, pitch: -9.1 }, 1, widerFraming).flags[0]).toContain('镜头需与眼睛同高')
    expect(validateCapturePoseRules('profile', { yaw: -80, roll: 0, pitch: 30 }, 0, profileFace).status).toBe('pass')
  })
})
