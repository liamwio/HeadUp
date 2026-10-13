import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { retryableLoad } from './retryableLoad'
import type { CaptureId, PoseValidation } from '../types'
import { estimateWideHeadPoseFromBitmap } from './wideHeadPose'
import { validateCapturePoseRules } from './poseRules'
import { detectFacesFromBitmap } from './faceDetector'
import { faceBoundsFromDetection } from './faceDetectionBounds'
import { detectObviousFrontOcclusion } from './frontOcclusion'
import { preflightImageFile } from './imageInputPreflight'

const getLandmarker = retryableLoad(async ():Promise<FaceLandmarker> => {
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 2,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      outputFacialTransformationMatrixes: false,
    })
})

export async function detectFaceLandmarksSource(source: ImageBitmap | HTMLCanvasElement) {
  const landmarker = await getLandmarker()
  return landmarker.detect(source).faceLandmarks.map((face) => face.map(({ x, y, z }) => ({ x, y, z })))
}

export function isPoseAcceptable(pose: PoseValidation): boolean {
  return pose.status === 'pass'
}

export async function inspectCapturePoseBitmap(expected: CaptureId, bitmap: ImageBitmap): Promise<PoseValidation> {
  if (expected === 'right_profile') expected = 'profile'
  // True profiles use YuNet + wide pose + Menpo39. A frontal mesh is not a
  // prerequisite: it may fail to load or detect a face at a near-90° yaw.
  const isProfile = expected === 'profile'
  const [faces, widePose, faceDetection] = await Promise.all([
    isProfile ? Promise.resolve([]) : detectFaceLandmarksSource(bitmap),
    estimateWideHeadPoseFromBitmap(bitmap),
    detectFacesFromBitmap(bitmap),
  ])
  const detectedFaces = faces.length
  const poseValidation = validateCapturePoseRules(expected, widePose, detectedFaces, faceDetection)
  const faceBounds = faceBoundsFromDetection(expected, faceDetection, detectedFaces)
  const validation = faceBounds ? { ...poseValidation, faceBounds } : poseValidation
  if ((expected === 'front' || expected === 'profile') && validation.estimatedPose!=='no_face'&&validation.estimatedPose!=='multiple_faces'&&faces[0]) {
    const landmarks = faces[0]
    if (expected === 'front'&&validation.status==='pass') {
      const occlusionFlags = detectObviousFrontOcclusion(bitmap, landmarks)
      if (occlusionFlags.length > 0) return { ...validation, status: 'reject', flags: occlusionFlags }
    }
    return {
      ...validation,
      landmarkImageWidth: bitmap.width,
      landmarkImageHeight: bitmap.height,
      landmarks,
    }
  }
  return validation
}

export async function inspectCapturePose(expected: CaptureId, file: File): Promise<PoseValidation> {
  await preflightImageFile(file)
  const bitmap = await createImageBitmap(file)
  try { return await inspectCapturePoseBitmap(expected, bitmap) } finally { bitmap.close() }
}
