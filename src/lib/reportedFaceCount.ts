import type {PoseValidation} from '../types'
import {PROFILE_FACE_THRESHOLD} from './poseRules'

/** Interpret old zero-mesh profile records without rewriting saved results. */
export function reportedFaceCount(pose:PoseValidation,profile:boolean):number|undefined {
  if (!profile || pose.detectedFaces!==0 || pose.estimatedPose==='no_face' || pose.estimatedPose==='multiple_faces') return pose.detectedFaces
  if (Number.isFinite(pose.faceDetectorScore) && pose.faceDetectorScore!>=PROFILE_FACE_THRESHOLD && pose.faceDetectorScore!<=1) return 1
  // Old records without independent detector evidence cannot establish a count.
  return undefined
}
