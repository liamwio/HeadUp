import type { CaptureId, EstimatedPose, PoseValidation } from '../types'
import type { WideHeadPose } from './wideHeadPose'
import type { FaceDetection, FaceDetectionSummary } from './faceDetector'

export const FRONT_CAPTURE_THRESHOLDS = {
  faceScore: 0.9,
  minimumAreaRatio: 0.09,
  maximumCenterDistance: 0.18,
  maximumAbsoluteYaw: 12,
  maximumAbsolutePitch: 9,
  maximumAbsoluteRoll: 12,
} as const

export const PROFILE_FACE_THRESHOLD = 0.85
const PROFILE_MINIMUM_AREA_RATIO = 0.07
const PROFILE_MAXIMUM_CENTER_DISTANCE = 0.25
export const PROFILE_MINIMUM_ABSOLUTE_YAW=70
export const PROFILE_MAXIMUM_ABSOLUTE_ROLL=18

export function classifyYaw(yaw: number): EstimatedPose {
  const absoluteYaw = Math.abs(yaw)
  if (absoluteYaw <= 20) return 'front'
  if (absoluteYaw < PROFILE_MINIMUM_ABSOLUTE_YAW) return 'oblique'
  return yaw < 0 ? 'right_profile' : 'left_profile'
}

function reject(estimatedPose: EstimatedPose, flags: string[], detectedFaces: number, pose: WideHeadPose, face?: FaceDetection): PoseValidation {
  return {
    status: 'reject', estimatedPose, detectedFaces, ...pose,
    ...(face ? {
      faceDetectorScore: face.score,
      faceAreaRatio: face.areaRatio,
      faceCenterDistance: face.centerDistance,
    } : {}),
    flags,
  }
}

export function validateCapturePoseRules(expected: CaptureId, pose: WideHeadPose, detectedFaces: number, faceDetection?: FaceDetectionSummary): PoseValidation {
  const independentFaces = faceDetection?.detections.filter((detection) => detection.score >= 0.6) ?? []
  if (detectedFaces > 1 || independentFaces.length > 1) return reject('multiple_faces', ['画面中只能出现一个人'], Math.max(detectedFaces, independentFaces.length), pose)
  if (detectedFaces === 0 && expected === 'front') {
    return reject('no_face', ['未检测到可用于定位的正面面部'], 0, pose)
  }

  const estimatedPose = classifyYaw(pose.yaw)
  if (expected === 'top') {
    if (detectedFaces > 0) return reject(estimatedPose, ['检测到完整面部，当前照片不是头顶俯视'], detectedFaces, pose)
    return {
      status: 'review',
      estimatedPose: 'no_face',
      detectedFaces: 0,
      ...pose,
      flags: ['未检测到完整面部；头顶轮廓将在下一阶段校验'],
    }
  }

  const primaryFace = faceDetection?.detections[0]
  const faceThreshold = expected === 'front' ? FRONT_CAPTURE_THRESHOLDS.faceScore : PROFILE_FACE_THRESHOLD
  if (!primaryFace || primaryFace.score < faceThreshold) {
    return reject('no_face', ['未检测到可信的单人面部，请重新取景'], detectedFaces, pose, primaryFace)
  }
  // The independent detector has confirmed one face. A later framing/pose
  // rejection must not report the frontal mesh's zero profile-face count.
  detectedFaces = Math.max(detectedFaces, 1)
  const minimumAreaRatio = expected === 'front' ? FRONT_CAPTURE_THRESHOLDS.minimumAreaRatio : PROFILE_MINIMUM_AREA_RATIO
  if (primaryFace.areaRatio < minimumAreaRatio) {
    return reject(estimatedPose, ['面部在画面中太小，请靠近镜头'], detectedFaces, pose, primaryFace)
  }
  const maximumCenterDistance = expected === 'front' ? FRONT_CAPTURE_THRESHOLDS.maximumCenterDistance : PROFILE_MAXIMUM_CENTER_DISTANCE
  if (primaryFace.centerDistance > maximumCenterDistance) {
    return reject(estimatedPose, ['请将面部置于画面中央'], detectedFaces, pose, primaryFace)
  }

  const rollLimit = expected === 'profile' ? PROFILE_MAXIMUM_ABSOLUTE_ROLL : FRONT_CAPTURE_THRESHOLDS.maximumAbsoluteRoll
  if (Math.abs(pose.roll) > rollLimit) return reject(estimatedPose, ['头部横向倾斜过大'], detectedFaces, pose, primaryFace)
  if (expected === 'front' && Math.abs(pose.pitch) > FRONT_CAPTURE_THRESHOLDS.maximumAbsolutePitch) {
    return reject(estimatedPose, ['镜头需与眼睛同高，请避免抬头或低头'], detectedFaces, pose, primaryFace)
  }
  if (expected === 'front' && Math.abs(pose.yaw) > FRONT_CAPTURE_THRESHOLDS.maximumAbsoluteYaw) {
    return reject(estimatedPose, ['正面照片需要直视镜头'], detectedFaces, pose, primaryFace)
  }
  if (expected === 'profile' && estimatedPose !== 'right_profile' && estimatedPose !== 'left_profile') {
    return reject(estimatedPose, ['侧面照片需要接近 90°'], detectedFaces, pose, primaryFace)
  }
  return {
    status: 'pass',
    estimatedPose,
    detectedFaces: Math.max(detectedFaces, 1),
    ...pose,
    faceDetectorScore: primaryFace.score,
    faceAreaRatio: primaryFace.areaRatio,
    faceCenterDistance: primaryFace.centerDistance,
    flags: [],
  }
}
