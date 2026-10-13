import type { Capture } from '../types'
import { isPhotoQualityAcceptable } from './imageQuality'
import { isPoseAcceptable } from './facePose'

export function getCaptureReadiness(captures: Capture[]) {
  const topCapture = captures.find((capture) => capture.id === 'top')
  const requiredCaptures = captures.filter((capture) => capture.id !== 'top')
  const strictReady=(capture:Capture)=>Boolean(capture.quality&&isPhotoQualityAcceptable(capture.quality)&&capture.poseValidation&&isPoseAcceptable(capture.poseValidation))
  const requiredReady = requiredCaptures.every((capture) => strictReady(capture)||Boolean(capture.quality&&capture.acceptedWithBias))
  const topPending = !topCapture?.quality || topCapture.poseValidation?.status !== 'pass'
  const complete = requiredReady
  const rejected = requiredCaptures.filter((capture) => !capture.acceptedWithBias&&capture.quality && (
    !isPhotoQualityAcceptable(capture.quality) || !capture.poseValidation || capture.poseValidation.status === 'reject'
      || !isPoseAcceptable(capture.poseValidation)
  )).length
  const missing = requiredCaptures.filter((capture) => !capture.quality).length
  const overridden=requiredCaptures.filter(capture=>capture.acceptedWithBias&&!strictReady(capture)).length
  return { complete, topPending, rejected, missing, overridden }
}
