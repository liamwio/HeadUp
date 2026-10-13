import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingDir = join(benchmarkDir, '.staging', 'coco-nonperson')
const annotationsPath = join(stagingDir, 'annotations_trainval2017.zip')
const instancesPath = join(stagingDir, 'annotations', 'instances_val2017.json')
const imagePath = join(stagingDir, 'current.jpg')
const variant = process.argv[2] === 'wholebody' ? 'wholebody' : 'yunet'
const modelConfig = variant === 'yunet' ? {
  path: join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx'),
  resultPath: join(benchmarkDir, 'coco-nonperson-yunet-result.json'),
  name: 'OpenCV YuNet face detector 2026may, proportional dynamic input (max edge 320)',
  sha256: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
} : {
  path: join(benchmarkDir, '.staging', 'wholebody-head-eval', 'yolov9_n_wholebody13_post_0245_1x3x320x320.onnx'),
  resultPath: join(benchmarkDir, 'coco-nonperson-head-result.json'),
  name: 'YOLOv9-N Wholebody13 post 0.245, 320x320',
  sha256: '0944d14624b2bb660fc8394ad241366d90ad2ceaf320f430ed8b402fa3dfdcb1',
}
const resultPath = modelConfig.resultPath
const modelPath = modelConfig.path
const annotationsUrl = 'http://images.cocodataset.org/annotations/annotations_trainval2017.zip'
const expectedAnnotationsSha256 = '113a836d90195ee1f884e704da6304dfaaecff1f023f49b6ca93c4aaae470268'
const poseModelPath = join(projectDir, 'public', 'models', 'whenet_1x3x224x224_prepost.onnx')
if (!resolve(stagingDir).startsWith(resolve(join(benchmarkDir, '.staging')))) throw new Error('Unsafe staging path')

async function download(url, path) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '180', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', path, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

async function tensorFromImage(path) {
  let pipeline = sharp(path).removeAlpha()
  if (variant === 'yunet') {
    const metadata = await pipeline.metadata()
    if (!metadata.width || !metadata.height) throw new Error('Unable to read image dimensions')
    const scale = 320 / Math.max(metadata.width, metadata.height)
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
    pipeline = pipeline.resize(320, 320, { fit: 'fill' })
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3 + 2]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3]
  }
  return new ort.Tensor('float32', input, [1, 3, info.height, info.width])
}

async function poseTensorFromImage(path) {
  const metadata = await sharp(path).metadata()
  if (!metadata.width || !metadata.height) throw new Error('Unable to read image dimensions')
  const cropSize = Math.min(metadata.width, metadata.height)
  const left = Math.floor((metadata.width - cropSize) / 2)
  const top = Math.floor((metadata.height - cropSize) / 2)
  const { data, info } = await sharp(path).extract({ left, top, width: cropSize, height: cropSize }).resize(224, 224).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3 + 2]
  }
  return new ort.Tensor('float32', input, [1, 3, 224, 224])
}

function selectBalancedImages(instances, targetCount) {
  const personCategory = instances.categories.find((category) => category.name === 'person')
  if (!personCategory) throw new Error('COCO person category is missing')
  const personImageIds = new Set(instances.annotations.filter((annotation) => annotation.category_id === personCategory.id).map((annotation) => annotation.image_id))
  const eligibleImages = new Map(instances.images.filter((image) => !personImageIds.has(image.id) && image.width >= 480 && image.height >= 320).map((image) => [image.id, image]))
  const annotationsByCategory = Map.groupBy(instances.annotations.filter((annotation) => annotation.category_id !== personCategory.id && eligibleImages.has(annotation.image_id)), (annotation) => annotation.category_id)
  const categories = instances.categories.filter((category) => category.id !== personCategory.id && annotationsByCategory.has(category.id)).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  const selected = []
  const selectedIds = new Set()
  for (let round = 0; selected.length < targetCount && round < 10; round += 1) {
    for (const category of categories) {
      const candidate = annotationsByCategory.get(category.id).map((annotation) => eligibleImages.get(annotation.image_id)).find((image) => image && !selectedIds.has(image.id))
      if (!candidate) continue
      selectedIds.add(candidate.id)
      selected.push({ image: candidate, category: category.name })
      if (selected.length >= targetCount) break
    }
  }
  if (selected.length !== targetCount) throw new Error(`Could only select ${selected.length}/${targetCount} balanced non-person images`)
  return selected
}

function decodeYuNetPrimary(outputs, width, height) {
  let primary
  for (const stride of [8, 16, 32]) {
    const classifications = outputs[`cls_${stride}`].data
    const objectness = outputs[`obj_${stride}`].data
    const boxes = outputs[`bbox_${stride}`].data
    const columns = width / stride
    for (let index = 0; index < classifications.length; index += 1) {
      const score = Math.sqrt(
        Math.min(1, Math.max(0, classifications[index])) * Math.min(1, Math.max(0, objectness[index])),
      )
      if (primary && score <= primary.score) continue
      const row = Math.floor(index / columns)
      const column = index % columns
      const boxWidth = Math.exp(boxes[index * 4 + 2]) * stride
      const boxHeight = Math.exp(boxes[index * 4 + 3]) * stride
      const centerX = (column + boxes[index * 4]) * stride
      const centerY = (row + boxes[index * 4 + 1]) * stride
      primary = {
        score,
        areaRatio: (boxWidth * boxHeight) / (width * height),
        centerDistance: Math.hypot(centerX / width - 0.5, centerY / height - 0.5),
      }
    }
  }
  return primary
}

ort.env.wasm.numThreads = 1
await mkdir(stagingDir, { recursive: true })
try {
  try {
    const currentHash = createHash('sha256').update(await readFile(annotationsPath)).digest('hex')
    if (currentHash !== expectedAnnotationsSha256) throw new Error('Existing COCO archive checksum mismatch')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await download(annotationsUrl, annotationsPath)
    const downloadedHash = createHash('sha256').update(await readFile(annotationsPath)).digest('hex')
    if (downloadedHash !== expectedAnnotationsSha256) throw new Error(`COCO archive checksum mismatch: ${downloadedHash}`)
  }
  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', annotationsPath], { maxBuffer: 5 * 1024 * 1024 })
  const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe COCO archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', annotationsPath, '-C', stagingDir, 'annotations/instances_val2017.json'])
  const instances = JSON.parse(await readFile(instancesPath, 'utf8'))
  const selected = selectBalancedImages(instances, 120)
  const model = await readFile(modelPath)
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
  const poseSession = variant === 'yunet'
    ? await ort.InferenceSession.create(await readFile(poseModelPath), { executionProviders: ['wasm'] })
    : undefined
  const aggregateCases = []
  for (const [index, item] of selected.entries()) {
    try {
      await download(`http://images.cocodataset.org/val2017/${item.image.file_name}`, imagePath)
      const tensor = await tensorFromImage(imagePath)
      const outputs = await session.run({ [session.inputNames[0]]: tensor })
      const primaryDetection = variant === 'yunet' ? decodeYuNetPrimary(outputs, tensor.dims[3], tensor.dims[2]) : undefined
      const scores = variant === 'yunet'
        ? [8, 16, 32].flatMap((stride) => {
            const classifications = outputs[`cls_${stride}`].data
            const objectness = outputs[`obj_${stride}`].data
            return Array.from(classifications, (classification, scoreIndex) => Math.sqrt(
              Math.min(1, Math.max(0, classification)) * Math.min(1, Math.max(0, objectness[scoreIndex])),
            ))
          })
        : Array.from(outputs[session.outputNames[0]].data).reduce((headScores, value, scoreIndex, rows) => {
            if (scoreIndex % 7 === 1 && Math.round(value) === 3) headScores.push(rows[scoreIndex + 1])
            return headScores
          }, [])
      let pose
      if (poseSession) {
        const poseTensor = await poseTensorFromImage(imagePath)
        const poseOutputs = await poseSession.run({ [poseSession.inputNames[0]]: poseTensor })
        const [yaw, roll, pitch] = Array.from(poseOutputs[poseSession.outputNames[0]].data)
        pose = { yaw, roll, pitch }
      }
      aggregateCases.push({
        category: item.category,
        maxScore: scores.length > 0 ? Math.max(...scores) : 0,
        primaryAreaRatio: primaryDetection?.areaRatio,
        primaryCenterDistance: primaryDetection?.centerDistance,
        pose,
      })
      if ((index + 1) % 20 === 0) process.stdout.write(`Processed ${index + 1}/${selected.length} transient COCO images\n`)
    } finally {
      await rm(imagePath, { force: true })
    }
  }
  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9].map((threshold) => ({
    threshold,
    potentialFalsePositiveImages: aggregateCases.filter((item) => item.maxScore >= threshold).length,
    potentialFalsePositiveRate: Number((aggregateCases.filter((item) => item.maxScore >= threshold).length / aggregateCases.length).toFixed(4)),
  }))
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-TRANSIENT-BENCHMARK-1.0',
    source: { name: 'COCO 2017 validation annotations and images', url: 'https://cocodataset.org/#download', licenseNote: 'COCO images retain their individual source licenses; used transiently for research evaluation only.' },
    selection: { images: aggregateCases.length, excludesAnyImageWithPersonAnnotation: true, minimumResolution: '480x320', categoryBalanced: true },
    model: modelConfig.name,
    modelSha256: modelConfig.sha256,
    thresholds,
    combinedRightProfileGate: variant === 'yunet' ? {
      faceThreshold: 0.85,
      yawMaximum: -35,
      absoluteRollMaximum: 18,
      potentialFalsePositiveImages: aggregateCases.filter((item) => item.maxScore >= 0.85 && item.pose?.yaw <= -35 && Math.abs(item.pose.roll) <= 18).length,
    } : undefined,
    framedRightProfileGate: variant === 'yunet' ? {
      faceThreshold: 0.85,
      minimumFaceAreaRatio: 0.07,
      maximumCenterDistance: 0.25,
      yawMaximum: -35,
      absoluteRollMaximum: 18,
      potentialFalsePositiveImages: aggregateCases.filter((item) => item.maxScore >= 0.85
        && item.primaryAreaRatio >= 0.07 && item.primaryCenterDistance <= 0.25
        && item.pose?.yaw <= -35 && Math.abs(item.pose.roll) <= 18).length,
    } : undefined,
    framedFrontProxyGateWithoutMediaPipe: variant === 'yunet' ? {
      faceThreshold: 0.9,
      minimumFaceAreaRatio: 0.09,
      maximumCenterDistance: 0.18,
      absoluteYawMaximum: 12,
      absoluteRollMaximum: 12,
      potentialFalsePositiveImages: aggregateCases.filter((item) => item.maxScore >= 0.9
        && item.primaryAreaRatio >= 0.09 && item.primaryCenterDistance <= 0.18
        && Math.abs(item.pose?.yaw) <= 12 && Math.abs(item.pose?.roll) <= 12).length,
      caution: 'Upper-bound proxy only: the browser production gate additionally requires MediaPipe to locate exactly one complete face.',
    } : undefined,
    categoriesCovered: new Set(aggregateCases.map((item) => item.category)).size,
    retention: { imagesRetained: false, identifiersRetained: false, individualPredictionsRetained: false, aggregateOnly: true },
    caution: 'Absence of a COCO person annotation is strong but not perfect evidence that no small or occluded person is present; detections are potential false positives pending visual review.',
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ ...result, resultPath }, null, 2) + '\n')
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
