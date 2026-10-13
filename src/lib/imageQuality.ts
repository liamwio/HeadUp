import type { PhotoQuality } from '../types'
import { preflightImageFile } from './imageInputPreflight'

import {isPhotoQualityAcceptable} from './photoQualityAcceptance'
export {isPhotoQualityAcceptable} from './photoQualityAcceptance'
export const UPSCALE_PERIODIC_GRADIENT_THRESHOLD = 1.19081898
export const OVEREXPOSURE_BRIGHTNESS_THRESHOLD = 210
export const OVEREXPOSURE_CENTER_TWO_CHANNEL_CLIPPING_THRESHOLD = 0.06

export function computeCenterTwoChannelClippingFraction(rgba: ArrayLike<number>, width: number, height: number, channels = 4): number {
  if (width < 1 || height < 1 || channels < 3 || rgba.length !== width * height * channels) return 1
  let centerPixels = 0
  let clippedPixels = 0
  const widthScale = Math.max(1, width - 1)
  const heightScale = Math.max(1, height - 1)
  const xStart = Math.max(0, Math.ceil((0.5 - 0.32) * widthScale))
  const xEnd = Math.min(width - 1, Math.floor((0.5 + 0.32) * widthScale))
  const yStart = Math.max(0, Math.ceil((0.48 - 0.42) * heightScale))
  const yEnd = Math.min(height - 1, Math.floor((0.48 + 0.42) * heightScale))
  const xSquares = new Float64Array(xEnd - xStart + 1)
  for (let x = xStart; x <= xEnd; x++) {
    const normalizedX = (x / widthScale - 0.5) / 0.32
    xSquares[x - xStart] = normalizedX * normalizedX
  }
  for (let y = yStart; y <= yEnd; y++) {
    const normalizedY = (y / heightScale - 0.48) / 0.42
    const ySquare = normalizedY * normalizedY
    for (let x = xStart; x <= xEnd; x++) {
      if (xSquares[x - xStart] + ySquare > 1) continue
      const index = (y * width + x) * channels
      const clippedChannels = Number(rgba[index] >= 250) + Number(rgba[index + 1] >= 250) + Number(rgba[index + 2] >= 250)
      centerPixels++
      if (clippedChannels >= 2) clippedPixels++
    }
  }
  return Number((clippedPixels / Math.max(1, centerPixels)).toFixed(6))
}


export function scorePhotoMetrics(width: number, height: number, brightness: number, contrast: number, sharpness: number, periodicGradientPeak = 1, highlightClipping = 0): PhotoQuality {
  const resolution = Math.min(100, Math.round((Math.min(width, height) / 1080) * 100))
  const brightnessScore = Math.max(0, 100 - Math.abs(brightness - 128) * 0.85)
  const contrastScore = Math.min(100, contrast * 2.8)
  const sharpnessScore = Math.max(0, Math.min(100, (sharpness - 2.25) * 22))
  const score = Math.round(resolution * 0.25 + brightnessScore * 0.25 + contrastScore * 0.2 + sharpnessScore * 0.3)
  const flags: string[] = []
  if (resolution < 55) flags.push('分辨率偏低')
  if (brightness < 60) flags.push('光线不足')
  if (brightness > OVEREXPOSURE_BRIGHTNESS_THRESHOLD || highlightClipping >= OVEREXPOSURE_CENTER_TWO_CHANNEL_CLIPPING_THRESHOLD) flags.push('画面过曝')
  if (contrast < 18) flags.push('对比度偏低')
  if (sharpness < 3.35) flags.push('画面模糊')
  else if (sharpness < 4.3) flags.push('清晰度一般')
  if (periodicGradientPeak >= UPSCALE_PERIODIC_GRADIENT_THRESHOLD) flags.push('疑似低清放大')
  return { score, resolution, brightness: Math.round(brightnessScore), contrast: Math.round(contrastScore), sharpness: Math.round(sharpnessScore), resamplingRisk: Number(periodicGradientPeak.toFixed(4)), highlightClipping: Number(highlightClipping.toFixed(6)), flags }
}

export function computePeriodicGradientPeak(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3 || gray.length !== width * height) return Number.POSITIVE_INFINITY
  const marginX = Math.max(1, Math.floor(width * 0.05))
  const marginY = Math.max(1, Math.floor(height * 0.05))
  const periods = [2, 3, 4, 5, 6]
  const horizontalSums = periods.map((period) => new Float64Array(period))
  const horizontalCounts = periods.map((period) => new Uint32Array(period))
  const verticalSums = periods.map((period) => new Float64Array(period))
  const verticalCounts = periods.map((period) => new Uint32Array(period))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (x > marginX && x < width - marginX) {
        const gradient = Math.abs(gray[index] - gray[index - 1])
        periods.forEach((period, periodIndex) => {
          const phase = x % period
          horizontalSums[periodIndex][phase] += gradient
          horizontalCounts[periodIndex][phase]++
        })
      }
      if (y > marginY && y < height - marginY) {
        const gradient = Math.abs(gray[index] - gray[index - width])
        periods.forEach((period, periodIndex) => {
          const phase = y % period
          verticalSums[periodIndex][phase] += gradient
          verticalCounts[periodIndex][phase]++
        })
      }
    }
  }
  const peak = (sums: Float64Array[], counts: Uint32Array[]) => {
    let maximum = 1
    periods.forEach((period, periodIndex) => {
      const means = Array.from({ length: period }, (_, phase) => sums[periodIndex][phase] / Math.max(1, counts[periodIndex][phase]))
      for (let phase = 0; phase < period; phase++) {
        const otherMean = means.filter((_, index) => index !== phase).reduce((sum, value) => sum + value, 0) / (period - 1)
        maximum = Math.max(maximum, means[phase] / Math.max(0.01, otherMean))
      }
    })
    return maximum
  }
  return Math.max(peak(horizontalSums, horizontalCounts), peak(verticalSums, verticalCounts))
}

export function inspectImageBitmap(bitmap: ImageBitmap): PhotoQuality {
  const originalWidth = bitmap.width
  const originalHeight = bitmap.height
  const max = 360
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法读取图像')
  ctx.drawImage(bitmap, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  const gray = new Float32Array(width * height)
  let sum = 0
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const value = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    gray[p] = value
    sum += value
  }
  const brightness = sum / gray.length
  let variance = 0
  for (const value of gray) variance += (value - brightness) ** 2
  const contrast = Math.sqrt(variance / gray.length)
  let edgeSum = 0
  let edgeCount = 0
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = y * width + x
      edgeSum += Math.abs(gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i])
      edgeCount++
    }
  }
  const periodicGradientPeak = computePeriodicGradientPeak(gray, width, height)
  const highlightClipping = computeCenterTwoChannelClippingFraction(data, width, height)
  return scorePhotoMetrics(originalWidth, originalHeight, brightness, contrast, edgeSum / Math.max(edgeCount, 1), periodicGradientPeak, highlightClipping)
}

export async function inspectImage(file: File): Promise<PhotoQuality> {
  await preflightImageFile(file)
  const bitmap = await createImageBitmap(file)
  try { return inspectImageBitmap(bitmap) } finally { bitmap.close() }
}
