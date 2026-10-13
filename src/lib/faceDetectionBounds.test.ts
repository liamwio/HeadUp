import { describe, expect, it } from 'vitest'
import type { FaceDetectionSummary } from './faceDetector'
import { faceBoundsFromDetection } from './faceDetectionBounds'

function detection(contentWidth = 240, contentHeight = 320): FaceDetectionSummary {
  return {
    inputWidth: Math.ceil(contentWidth / 32) * 32,
    inputHeight: Math.ceil(contentHeight / 32) * 32,
    contentWidth,
    contentHeight,
    detections: [{ score: 0.95, x: contentWidth * .25, y: contentHeight * .2,
      width: contentWidth * .5, height: contentHeight * .6, areaRatio: .3, centerDistance: 0 }],
  }
}

describe('live face framing geometry', () => {
  it.each([[240, 320], [320, 240]])('uses %s×%s content instead of the padded model input', (width, height) => {
    expect(faceBoundsFromDetection('front', detection(width, height), 1))
      .toEqual({ x: .25, y: .2, width: .5, height: .6 })
  })

  it('preserves detected bounds outside the image for clipping guidance', () => {
    const summary = detection()
    Object.assign(summary.detections[0], { x: -24, y: -32, width: 288, height: 384 })
    expect(faceBoundsFromDetection('front', summary, 1))
      .toEqual({ x: -.1, y: -.1, width: 1.2, height: 1.2 })
  })

  it('supports the profile detector when a frontal mesh is unavailable', () => {
    const summary = detection()
    summary.detections[0].score = .85
    expect(faceBoundsFromDetection('profile', summary, 0)).toBeDefined()
    expect(faceBoundsFromDetection('front', summary, 1)).toBeUndefined()
    summary.detections[0].score = .849
    expect(faceBoundsFromDetection('profile', summary, 0)).toBeUndefined()
  })

  it('excludes multiple people, missing faces and unsupported views', () => {
    const summary = detection()
    expect(faceBoundsFromDetection('front', summary, 0)).toBeUndefined()
    expect(faceBoundsFromDetection('front', summary, 2)).toBeUndefined()
    expect(faceBoundsFromDetection('top', summary, 0)).toBeUndefined()
    summary.detections.push({ ...summary.detections[0], score: .6 })
    expect(faceBoundsFromDetection('profile', summary, 0)).toBeUndefined()
    expect(faceBoundsFromDetection('front', { ...summary, detections: [] }, 1)).toBeUndefined()
  })

  it('does not invent content dimensions for old summaries or expose invalid geometry', () => {
    const summary = detection()
    expect(faceBoundsFromDetection('front', { ...summary, contentWidth: undefined }, 1)).toBeUndefined()
    expect(faceBoundsFromDetection('front', { ...summary, contentHeight: 0 }, 1)).toBeUndefined()
    expect(faceBoundsFromDetection('front', { ...summary, contentWidth: Infinity }, 1)).toBeUndefined()
    expect(faceBoundsFromDetection('front', { ...summary, contentWidth: Number.MIN_VALUE }, 1)).toBeUndefined()
    expect(faceBoundsFromDetection('front', summary, NaN)).toBeUndefined()
    for (const patch of [{ x: NaN }, { y: Infinity }, { width: 0 }, { height: -1 }, { score: NaN }, { score: 1.1 }]) {
      expect(faceBoundsFromDetection('front', { ...summary, detections: [{ ...summary.detections[0], ...patch }] }, 1))
        .toBeUndefined()
    }
  })
})
