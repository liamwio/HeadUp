import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { transformWithOxc } from 'vite'

export async function createProductionQualityHarness(projectDir, { resizeKernel = 'lanczos3' } = {}) {
  const qualitySourcePath = join(projectDir, 'src', 'lib', 'imageQuality.ts')
  const preflightSourcePath = join(projectDir, 'src', 'lib', 'imageInputPreflight.ts')
  const [qualitySource, preflightSource] = await Promise.all([readFile(qualitySourcePath, 'utf8'), readFile(preflightSourcePath, 'utf8')])
  const [transformed, transformedPreflight] = await Promise.all([
    transformWithOxc(qualitySource, qualitySourcePath, { lang: 'ts', module: true, target: 'es2022' }),
    transformWithOxc(preflightSource, preflightSourcePath, { lang: 'ts', module: true, target: 'es2022' }),
  ])
  const preflightModuleUrl = `data:text/javascript;base64,${Buffer.from(transformedPreflight.code).toString('base64')}`
  const linkedQualityCode = transformed.code.replaceAll('"./imageInputPreflight"', JSON.stringify(preflightModuleUrl))
  const qualityModuleUrl = `data:text/javascript;base64,${Buffer.from(linkedQualityCode).toString('base64')}`
  const { computeCenterTwoChannelClippingFraction, computePeriodicGradientPeak, isPhotoQualityAcceptable, scorePhotoMetrics } = await import(qualityModuleUrl)

  return {
    scorerSource: pathToFileURL(qualitySourcePath).href,
    async inspect(input, inputOptions = {}) {
      const image = sharp(input, { failOn: 'warning', ...inputOptions })
      const metadata = await image.metadata()
      const originalWidth = metadata.width || 0
      const originalHeight = metadata.height || 0
      const max = 360
      const scale = Math.min(1, max / Math.max(originalWidth, originalHeight))
      const width = Math.max(1, Math.round(originalWidth * scale))
      const height = Math.max(1, Math.round(originalHeight * scale))
      const { data, info } = await image.resize(width, height, { kernel: resizeKernel }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const gray = new Float32Array(width * height)
      let sum = 0
      for (let pixel = 0; pixel < gray.length; pixel++) {
        const offset = pixel * info.channels
        const value = info.channels === 1
          ? data[offset]
          : data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114
        gray[pixel] = value
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
          const index = y * width + x
          edgeSum += Math.abs(gray[index - 1] + gray[index + 1] + gray[index - width] + gray[index + width] - 4 * gray[index])
          edgeCount++
        }
      }
      const sharpness = edgeSum / Math.max(edgeCount, 1)
      const periodicGradientPeak = computePeriodicGradientPeak(gray, width, height)
      const highlightClipping = computeCenterTwoChannelClippingFraction(data, width, height, info.channels)
      const quality = scorePhotoMetrics(originalWidth, originalHeight, brightness, contrast, sharpness, periodicGradientPeak, highlightClipping)
      return {
        dimensions: { width: originalWidth, height: originalHeight },
        raw: {
          brightness: Number(brightness.toFixed(3)),
          contrast: Number(contrast.toFixed(3)),
          sharpness: Number(sharpness.toFixed(3)),
          periodicGradientPeak: Number(periodicGradientPeak.toFixed(6)),
          highlightClipping: Number(highlightClipping.toFixed(6)),
        },
        quality,
        accepted: isPhotoQualityAcceptable(quality),
      }
    },
  }
}
