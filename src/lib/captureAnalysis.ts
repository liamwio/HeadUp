import type { CaptureId } from '../types'
import { detectFacesFromBitmap } from './faceDetector'
import { inspectCapturePoseBitmap } from './facePose'
import { preflightImageFile } from './imageInputPreflight'
import { inspectImageBitmap } from './imageQuality'
import { estimateWideHeadPoseFromBitmap } from './wideHeadPose'
import { isPhotoQualityAcceptable } from './imageQuality'
import { inferNativeProfileFromBitmap } from './nativeProfileInference'

export async function inspectCaptureFile(expected: CaptureId, file: File) {
  await preflightImageFile(file)
  const bitmap = await createImageBitmap(file)
  try {
    const quality = inspectImageBitmap(bitmap)
    let pose = await inspectCapturePoseBitmap(expected, bitmap)
    // Native profile inference is independent of MediaPipe profile landmarks, but the
    // report still needs the source image dimensions to project normalized Menpo39 points.
    // Preserve them for every capture, including profiles where MediaPipe returns no mesh.
    pose = { ...pose, landmarkImageWidth: bitmap.width, landmarkImageHeight: bitmap.height }
    if (expected === 'profile' && isPhotoQualityAcceptable(quality) && pose.status === 'pass') {
      pose = { ...pose, nativeProfile: await inferNativeProfileFromBitmap(bitmap, pose) }
    }
    return { width: bitmap.width, height: bitmap.height, quality, pose }
  } finally {
    bitmap.close()
  }
}

export async function inspectWidePoseAndFaces(file: File) {
  await preflightImageFile(file)
  const bitmap = await createImageBitmap(file)
  try {
    const [pose, faceSummary] = await Promise.all([
      estimateWideHeadPoseFromBitmap(bitmap),
      detectFacesFromBitmap(bitmap),
    ])
    return { pose, faceSummary, width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}
