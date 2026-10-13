import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const realDbDir = join(projectDir, 'data', 'face-db-real-research')
const requestedVariant = process.argv[2]
const variant = ['wholebody', 'yunet'].includes(requestedVariant) ? requestedVariant : 'yolov7'
const modelConfig = variant === 'wholebody' ? {
  path: join(projectDir, 'data', 'face-benchmark', '.staging', 'wholebody-head-eval', 'yolov9_n_wholebody13_post_0245_1x3x320x320.onnx'),
  resultPath: join(realDbDir, 'wholebody-head-detector-benchmark.json'),
  name: 'YOLOv9-N Wholebody13 post 0.245, 320x320',
  sha256: '0944d14624b2bb660fc8394ad241366d90ad2ceaf320f430ed8b402fa3dfdcb1',
  width: 320,
  height: 320,
} : variant === 'yunet' ? {
  path: join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx'),
  resultPath: join(realDbDir, 'yunet-face-detector-benchmark.json'),
  name: 'OpenCV YuNet face detector 2026may, proportional dynamic input (max edge 320)',
  sha256: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
  width: 320,
  height: 320,
} : {
  path: join(projectDir, 'data', 'face-benchmark', '.staging', 'head-detector-eval', 'yolov7_tiny_head_0.768_post_480x640.onnx'),
  resultPath: join(realDbDir, 'head-detector-benchmark.json'),
  name: 'YOLOv7-tiny Head 0.768 post 480x640, DMHead 1.1.2',
  sha256: '2cec68f5272927cbccf6c4bd80ac6135cd5b453b239716f007563bb731ec98eb',
  width: 640,
  height: 480,
}
const modelPath = modelConfig.path
const resultPath = modelConfig.resultPath
const manifest = (await readFile(join(realDbDir, 'manifest.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(4))
}

function distribution(values) {
  return { min: percentile(values, 0), p05: percentile(values, 0.05), median: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) }
}

async function makeTensor(source) {
  let pipeline = sharp(source).removeAlpha()
  if (variant === 'yunet') {
    const metadata = await pipeline.metadata()
    if (!metadata.width || !metadata.height) throw new Error('Unable to read image dimensions')
    const scale = modelConfig.width / Math.max(metadata.width, metadata.height)
    const scaledWidth = Math.max(1, Math.round(metadata.width * scale))
    const scaledHeight = Math.max(1, Math.round(metadata.height * scale))
    const paddedWidth = Math.ceil(scaledWidth / 32) * 32
    const paddedHeight = Math.ceil(scaledHeight / 32) * 32
    pipeline = pipeline.resize(scaledWidth, scaledHeight, { fit: 'fill' }).extend({
      right: paddedWidth - scaledWidth,
      bottom: paddedHeight - scaledHeight,
      background: { r: 0, g: 0, b: 0 },
    })
  } else {
    pipeline = pipeline.resize(modelConfig.width, modelConfig.height, { fit: 'fill' })
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    const red = data[index * 3]
    const green = data[index * 3 + 1]
    const blue = data[index * 3 + 2]
    input[index] = variant === 'yolov7' ? red / 255 : blue
    input[channelSize + index] = variant === 'yolov7' ? green / 255 : green
    input[channelSize * 2 + index] = variant === 'yolov7' ? blue / 255 : red
  }
  return new ort.Tensor('float32', input, [1, 3, info.height, info.width])
}

function generatedNegatives() {
  const width = 640
  const height = 480
  const cases = []
  for (const value of [0, 24, 48, 80, 128, 176, 224, 255]) {
    cases.push({ family: 'solid', source: { create: { width, height, channels: 3, background: { r: value, g: value, b: value } } } })
  }
  for (let variant = 0; variant < 8; variant += 1) {
    const horizontal = Buffer.alloc(width * height * 3)
    const vertical = Buffer.alloc(width * height * 3)
    const checker = Buffer.alloc(width * height * 3)
    const noise = Buffer.alloc(width * height * 3)
    let state = 17 + variant * 7919
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3
        const horizontalValue = Math.round((x / (width - 1)) * 255)
        const verticalValue = Math.round((y / (height - 1)) * 255)
        const checkerValue = ((Math.floor(x / (8 + variant * 3)) + Math.floor(y / (8 + variant * 3))) % 2) * 255
        state = (state * 1664525 + 1013904223) >>> 0
        const noiseValue = state & 255
        horizontal.fill(horizontalValue, index, index + 3)
        vertical.fill(verticalValue, index, index + 3)
        checker.fill(checkerValue, index, index + 3)
        noise[index] = noiseValue
        noise[index + 1] = (noiseValue * 37) & 255
        noise[index + 2] = (noiseValue * 91) & 255
      }
    }
    cases.push({ family: 'horizontal_gradient', source: horizontal })
    cases.push({ family: 'vertical_gradient', source: vertical })
    cases.push({ family: 'checkerboard', source: checker })
    cases.push({ family: 'noise', source: noise })
  }
  for (let variant = 0; variant < 10; variant += 1) {
    const eyeOffset = 40 + variant * 5
    const svg = `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#${variant % 2 ? 'ddd6c9' : '527b73'}"/><ellipse cx="320" cy="240" rx="${100 + variant * 8}" ry="${130 - variant * 3}" fill="#${variant % 2 ? '527b73' : 'ddd6c9'}"/><circle cx="${320 - eyeOffset}" cy="210" r="12" fill="#17251f"/><circle cx="${320 + eyeOffset}" cy="210" r="12" fill="#17251f"/><path d="M270 300 Q320 ${330 + variant * 3} 370 300" fill="none" stroke="#17251f" stroke-width="10"/></svg>`
    cases.push({ family: 'face_like_geometry', source: Buffer.from(svg) })
  }
  return cases
}

ort.env.wasm.numThreads = 1
const model = await readFile(modelPath)
const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })

function decodeYuNet(outputs, width, height) {
  const detections = []
  for (const stride of [8, 16, 32]) {
    const classifications = outputs[`cls_${stride}`].data
    const objectness = outputs[`obj_${stride}`].data
    const boxes = outputs[`bbox_${stride}`].data
    const columns = width / stride
    for (let index = 0; index < classifications.length; index += 1) {
      const score = Math.sqrt(
        Math.min(1, Math.max(0, classifications[index])) * Math.min(1, Math.max(0, objectness[index])),
      )
      const row = Math.floor(index / columns)
      const column = index % columns
      const boxWidth = Math.exp(boxes[index * 4 + 2]) * stride
      const boxHeight = Math.exp(boxes[index * 4 + 3]) * stride
      const centerX = (column + boxes[index * 4]) * stride
      const centerY = (row + boxes[index * 4 + 1]) * stride
      detections.push({
        score,
        areaRatio: (boxWidth * boxHeight) / (width * height),
        centerDistance: Math.hypot(centerX / width - 0.5, centerY / height - 0.5),
      })
    }
  }
  return detections.sort((a, b) => b.score - a.score)
}

async function scoreSource(source) {
  const tensor = await makeTensor(source)
  const outputs = await session.run({ [session.inputNames[0]]: tensor })
  const yunetDetections = variant === 'yunet' ? decodeYuNet(outputs, tensor.dims[3], tensor.dims[2]) : undefined
  const scores = variant === 'wholebody'
    ? Array.from(outputs[session.outputNames[0]].data).reduce((headScores, value, index, rows) => {
        if (index % 7 === 1 && Math.round(value) === 3) headScores.push(rows[index + 1])
        return headScores
      }, [])
    : variant === 'yunet'
      ? yunetDetections.map((detection) => detection.score)
      : Array.from(outputs.score.data)
  return {
    maxScore: scores.length > 0 ? Math.max(...scores) : 0,
    detections: scores.length,
    primaryAreaRatio: yunetDetections?.[0]?.areaRatio,
    primaryCenterDistance: yunetDetections?.[0]?.centerDistance,
  }
}

const startedAt = performance.now()
const positives = []
for (const record of manifest) {
  const result = await scoreSource(join(realDbDir, record.relativePath))
  positives.push({ view: record.view, ...result })
}
const negatives = []
for (const item of generatedNegatives()) {
  const source = Buffer.isBuffer(item.source) && !item.source.toString('utf8', 0, 4).startsWith('<svg')
    ? { raw: { width: 640, height: 480, channels: 3 }, input: item.source }
    : item.source
  const result = source.input ? await scoreSource(source.input).catch(async () => {
    const png = await sharp(source.input, { raw: source.raw }).png().toBuffer()
    return scoreSource(png)
  }) : await scoreSource(source)
  negatives.push({ family: item.family, ...result })
}

const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9].map((threshold) => ({
  threshold,
  positiveRecall: Number((positives.filter((item) => item.maxScore >= threshold).length / positives.length).toFixed(4)),
  frontRecall: Number((positives.filter((item) => item.view === 'front' && item.maxScore >= threshold).length / positives.filter((item) => item.view === 'front').length).toFixed(4)),
  profileRecall: Number((positives.filter((item) => item.view !== 'front' && item.maxScore >= threshold).length / positives.filter((item) => item.view !== 'front').length).toFixed(4)),
  generatedNegativeFalsePositiveRate: Number((negatives.filter((item) => item.maxScore >= threshold).length / negatives.length).toFixed(4)),
}))

const byView = Object.fromEntries(Object.entries(Object.groupBy(positives, (item) => item.view)).map(([view, items]) => [view, {
  images: items.length,
  maxScore: distribution(items.map((item) => item.maxScore)),
  primaryAreaRatio: variant === 'yunet' ? distribution(items.map((item) => item.primaryAreaRatio)) : undefined,
  primaryCenterDistance: variant === 'yunet' ? distribution(items.map((item) => item.primaryCenterDistance)) : undefined,
  detectedAtPoint2: items.filter((item) => item.maxScore >= 0.2).length,
}]))
const byNegativeFamily = Object.fromEntries(Object.entries(Object.groupBy(negatives, (item) => item.family)).map(([family, items]) => [family, { images: items.length, maxScore: distribution(items.map((item) => item.maxScore)), falsePositiveAtPoint2: items.filter((item) => item.maxScore >= 0.2).length }]))
const result = {
  benchmarkedAt: new Date().toISOString(),
  model: modelConfig.name,
  modelSha256: modelConfig.sha256,
  realPositiveImages: positives.length,
  generatedNegativeImages: negatives.length,
  byView,
  byNegativeFamily,
  thresholds,
  elapsedMilliseconds: Math.round(performance.now() - startedAt),
  individualPredictionsRetained: false,
  generatedNegativesRetained: false,
}
await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ...result, resultPath }, null, 2) + '\n')
