import { describe, expect, it } from 'vitest'
import type { Capture, CaptureId, PhotoQuality, PoseStatus } from '../types'
import { getCaptureReadiness } from './captureReadiness'

const quality: PhotoQuality = { score: 90, resolution: 100, brightness: 90, contrast: 90, sharpness: 90, flags: [] }

function capture(id: CaptureId, status: PoseStatus): Capture {
  return {
    id,
    label: id,
    eyebrow: '',
    hint: '',
    quality,
    poseValidation: { status, estimatedPose: id === 'front' ? 'front' : id === 'profile' ? 'right_profile' : 'no_face', detectedFaces: id === 'top' ? 0 : 1, flags: [] },
  }
}

describe('capture readiness', () => {
  it('allows the front-and-profile report when top view remains in review', () => {
    const result = getCaptureReadiness([capture('front', 'pass'), capture('profile', 'pass'), capture('top', 'review')])
    expect(result.complete).toBe(true)
    expect(result.topPending).toBe(true)
  })

  it('keeps the paused top module optional when it is missing or has non-product quality', () => {
    const missingTop = [capture('front', 'pass'), capture('profile', 'pass'), { id: 'top', label: 'top', eyebrow: '', hint: '' } as Capture]
    expect(getCaptureReadiness(missingTop)).toMatchObject({ complete: true, topPending: true, missing: 0 })
    const lowQualityTop = capture('top', 'review')
    lowQualityTop.quality = { ...quality, score: 30, flags: ['分辨率偏低'] }
    expect(getCaptureReadiness([capture('front', 'pass'), capture('profile', 'pass'), lowQualityTop])).toMatchObject({ complete: true, topPending: true })
  })

  it('does not block the report for a rejected optional top view but blocks rejected required views', () => {
    expect(getCaptureReadiness([capture('front', 'pass'), capture('profile', 'pass'), capture('top', 'reject')])).toMatchObject({ complete: true, topPending: true, rejected: 0 })
    expect(getCaptureReadiness([capture('front', 'reject'), capture('profile', 'pass'), capture('top', 'review')]).complete).toBe(false)
  })

  it('allows an explicit continue-with-bias decision while preserving the override count',()=>{
    const front=capture('front','reject')
    front.poseValidation!.flags=['镜头需与眼睛同高，请避免抬头或低头']
    expect(getCaptureReadiness([front,capture('profile','pass'),capture('top','review')])).toMatchObject({complete:false,rejected:1,overridden:0})
    front.acceptedWithBias=true
    expect(getCaptureReadiness([front,capture('profile','pass'),capture('top','review')])).toMatchObject({complete:true,rejected:0,overridden:1})
  })
})
