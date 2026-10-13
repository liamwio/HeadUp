import type { LandmarkPoint } from '../types'

export type RegionStats = {
  meanLuminance: number
  luminanceStdDev: number
  dominantColorFraction: number
}

export function obviousOcclusionFlags(eyeRegion: RegionStats, lowerFaceRegion: RegionStats): string[] {
  const flags: string[] = []
  const eyesUniform = (eyeRegion.dominantColorFraction >= 0.55 && eyeRegion.luminanceStdDev <= 35)
    || (eyeRegion.meanLuminance <= 28 && eyeRegion.luminanceStdDev <= 18)
  if (eyesUniform) flags.push('眼部存在大面积明显遮挡，请摘下墨镜或遮挡物')
  if (lowerFaceRegion.dominantColorFraction >= 0.78 && lowerFaceRegion.luminanceStdDev <= 16) {
    flags.push('口鼻区域存在大面积明显遮挡，请摘下口罩或遮挡物')
  }
  return flags
}

function regionStats(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number },
): RegionStats {
  const xMin = Math.max(0, Math.min(width - 1, Math.floor(bounds.xMin * width)))
  const yMin = Math.max(0, Math.min(height - 1, Math.floor(bounds.yMin * height)))
  const xMax = Math.max(xMin + 1, Math.min(width, Math.ceil(bounds.xMax * width)))
  const yMax = Math.max(yMin + 1, Math.min(height, Math.ceil(bounds.yMax * height)))
  const histogram = new Map<number, number>()
  let count = 0
  let sum = 0
  let squareSum = 0
  for (let y = yMin; y < yMax; y += 2) {
    for (let x = xMin; x < xMax; x += 2) {
      const index = (y * width + x) * 4
      const red = pixels[index]
      const green = pixels[index + 1]
      const blue = pixels[index + 2]
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114
      sum += luminance
      squareSum += luminance * luminance
      count += 1
      const colorBin = (red >> 5) << 6 | (green >> 5) << 3 | (blue >> 5)
      histogram.set(colorBin, (histogram.get(colorBin) ?? 0) + 1)
    }
  }
  const meanLuminance = count ? sum / count : 0
  const variance = count ? Math.max(0, squareSum / count - meanLuminance * meanLuminance) : 0
  const dominant = count ? Math.max(...histogram.values()) / count : 1
  return { meanLuminance, luminanceStdDev: Math.sqrt(variance), dominantColorFraction: dominant }
}

export function detectObviousFrontOcclusion(bitmap: ImageBitmap, landmarks: LandmarkPoint[]): string[] {
  if (landmarks.length < 455) return ['无法完成正面遮挡检查']
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return ['无法完成正面遮挡检查']
  context.drawImage(bitmap, 0, 0, size, size)
  const pixels = context.getImageData(0, 0, size, size).data

  const eyeXMin = Math.min(landmarks[33].x, landmarks[263].x) - 0.035
  const eyeXMax = Math.max(landmarks[33].x, landmarks[263].x) + 0.035
  const eyeYMin = Math.min(landmarks[159].y, landmarks[386].y) - 0.04
  const eyeYMax = Math.max(landmarks[145].y, landmarks[374].y) + 0.04
  const mouthXMin = Math.min(landmarks[61].x, landmarks[291].x) - 0.055
  const mouthXMax = Math.max(landmarks[61].x, landmarks[291].x) + 0.055
  const lowerYMin = landmarks[2].y + 0.015
  const lowerYMax = landmarks[152].y - 0.025

  return obviousOcclusionFlags(
    regionStats(pixels, size, size, { xMin: eyeXMin, yMin: eyeYMin, xMax: eyeXMax, yMax: eyeYMax }),
    regionStats(pixels, size, size, { xMin: mouthXMin, yMin: lowerYMin, xMax: mouthXMax, yMax: lowerYMax }),
  )
}
