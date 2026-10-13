import { describe, expect, it } from 'vitest'
import { computeCenterTwoChannelClippingFraction, computePeriodicGradientPeak, isPhotoQualityAcceptable, OVEREXPOSURE_BRIGHTNESS_THRESHOLD, scorePhotoMetrics, UPSCALE_PERIODIC_GRADIENT_THRESHOLD } from './imageQuality'

describe('scorePhotoMetrics', () => {
  it('accepts a well-lit, sharp high-resolution image', () => {
    const result = scorePhotoMetrics(2400, 3200, 128, 36, 70)
    expect(result.score).toBeGreaterThan(85)
    expect(result.flags).toEqual([])
  })

  it('returns actionable flags for dark and blurry images', () => {
    const result = scorePhotoMetrics(600, 800, 35, 12, 2)
    expect(result.score).toBeLessThan(55)
    expect(result.flags).toContain('光线不足')
    expect(result.flags).toContain('画面模糊')
    expect(isPhotoQualityAcceptable(result)).toBe(false)
  })

  it('accepts calibrated clear studio portraits without false blur warnings', () => {
    const result = scorePhotoMetrics(1350, 1350, 181, 56, 6.2)
    expect(result.flags).not.toContain('画面模糊')
    expect(result.flags).not.toContain('清晰度一般')
    expect(isPhotoQualityAcceptable(result)).toBe(true)
  })

  it('accepts the human-reviewed bright boundary while still blocking values above it', () => {
    const reviewedBoundary = scorePhotoMetrics(1350, 1350, 209.39, 36, 4.31)
    const overexposed = scorePhotoMetrics(1350, 1350, OVEREXPOSURE_BRIGHTNESS_THRESHOLD + 0.01, 36, 4.31)
    expect(reviewedBoundary.flags).not.toContain('画面过曝')
    expect(isPhotoQualityAcceptable(reviewedBoundary)).toBe(true)
    expect(overexposed.flags).toContain('画面过曝')
    expect(isPhotoQualityAcceptable(overexposed)).toBe(false)
  })

  it('measures two-channel clipping only inside the central face ellipse', () => {
    const width = 20
    const height = 20
    const outsideOnly = new Uint8ClampedArray(width * height * 4)
    const centerClipped = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      outsideOnly[index + 3] = 255
      centerClipped[index + 3] = 255
      const nx = (x / (width - 1) - 0.5) / 0.32
      const ny = (y / (height - 1) - 0.48) / 0.42
      const inside = nx ** 2 + ny ** 2 <= 1
      const target = inside ? centerClipped : outsideOnly
      target[index] = 255
      target[index + 1] = 255
    }
    expect(computeCenterTwoChannelClippingFraction(outsideOnly, width, height)).toBe(0)
    expect(computeCenterTwoChannelClippingFraction(centerClipped, width, height)).toBe(1)
  })

  it('blocks central highlight clipping even when whole-frame mean brightness is normal', () => {
    const result = scorePhotoMetrics(1350, 1350, 128, 36, 6, 1, 0.06)
    expect(result.highlightClipping).toBe(0.06)
    expect(result.flags).toContain('画面过曝')
    expect(isPhotoQualityAcceptable(result)).toBe(false)
  })

  it('blocks severe blur while allowing a review-level sharpness warning', () => {
    const severe = scorePhotoMetrics(1350, 1350, 181, 56, 2.5)
    const review = scorePhotoMetrics(1350, 1350, 181, 56, 4)
    expect(severe.flags).toContain('画面模糊')
    expect(isPhotoQualityAcceptable(severe)).toBe(false)
    expect(review.flags).toContain('清晰度一般')
    expect(isPhotoQualityAcceptable(review)).toBe(true)
  })

  it('detects periodic block replication while preserving non-periodic detail', () => {
    const width = 90
    const height = 90
    const blocky = new Float32Array(width * height)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) blocky[y * width + x] = (Math.floor(x / 3) * 17 + Math.floor(y / 3) * 29) % 256
    let state = 123456789
    const natural = new Float32Array(width * height)
    for (let index = 0; index < natural.length; index++) {
      state = (state * 1664525 + 1013904223) >>> 0
      natural[index] = state & 255
    }
    const blockPeak = computePeriodicGradientPeak(blocky, width, height)
    const naturalPeak = computePeriodicGradientPeak(natural, width, height)
    expect(blockPeak).toBeGreaterThan(UPSCALE_PERIODIC_GRADIENT_THRESHOLD)
    expect(naturalPeak).toBeLessThan(UPSCALE_PERIODIC_GRADIENT_THRESHOLD)
    const quality = scorePhotoMetrics(1080, 1080, 128, 40, 7, blockPeak)
    expect(quality.flags).toContain('疑似低清放大')
    expect(isPhotoQualityAcceptable(quality)).toBe(false)
  })

  it('ignores a narrow uniform framing border without hiding interior block replication', () => {
    const width = 100
    const height = 100
    let state = 987654321
    const shiftedNatural = new Float32Array(width * height)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      state = (state * 1664525 + 1013904223) >>> 0
      shiftedNatural[y * width + x] = x < 3 ? 0 : state & 255
    }
    const blockyWithBorder = new Float32Array(width * height)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      blockyWithBorder[y * width + x] = x < 3 ? 0 : (Math.floor(x / 3) * 17 + Math.floor(y / 3) * 29) % 256
    }
    expect(computePeriodicGradientPeak(shiftedNatural, width, height)).toBeLessThan(UPSCALE_PERIODIC_GRADIENT_THRESHOLD)
    expect(computePeriodicGradientPeak(blockyWithBorder, width, height)).toBeGreaterThan(UPSCALE_PERIODIC_GRADIENT_THRESHOLD)
  })
})
