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
const stagingDir = join(benchmarkDir, '.staging', 'openimages-head-proxy')
const annotationsPath = join(stagingDir, 'validation-annotations-bbox.csv')
const imageLabelsPath = join(stagingDir, 'validation-annotations-human-imagelabels-boxable.csv')
const resourceArchivePath = join(stagingDir, 'wholebody-resources-n.tar.gz')
const imagePath = join(stagingDir, 'current.jpg')
const cropPath = join(stagingDir, 'current-crop.jpg')
const hairModelPath = join(stagingDir, 'hair_segmenter.tflite')
const liteRtPythonPath = join(stagingDir, 'litert-python')
const resultPath = join(benchmarkDir, 'openimages-head-proxy-result.json')
const annotationsUrl = 'https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv'
const expectedAnnotationsMd5 = 'c5e8200df129ea6867e913e8b21fcab9'
const imageLabelsUrl = 'https://storage.googleapis.com/openimages/v5/validation-annotations-human-imagelabels-boxable.csv'
const expectedImageLabelsMd5 = '2e129f40a209e65dfe4342ed0e7bd5f2'
const resourceArchiveUrl = 'https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/454_YOLOv9-WholeBody13/resources_n.tar.gz'
const expectedResourceSha256 = '1424ccc9b6c7c2ede25e8d1f8c643f619aae8fa83bc7a73f72a67709a4fd147c'
const expectedHeadModelSha256 = '0944d14624b2bb660fc8394ad241366d90ad2ceaf320f430ed8b402fa3dfdcb1'
const hairModelUrl = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/1/hair_segmenter.tflite'
const expectedHairModelSha256 = '2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84'
const hairInferenceScript = join(projectDir, 'scripts', 'run-hair-segmenter-litert.py')
const pythonExecutable = process.env.HEADUP_PYTHON || 'python'
const yuNetPath = join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx')
const poseModelPath = join(projectDir, 'public', 'models', 'whenet_1x3x224x224_prepost.onnx')
const HUMAN_FACE = '/m/0dzct'
const HUMAN_HAIR = '/m/03q69'
const HUMAN_HEAD = '/m/04hgtk'
const DESIRED_IMAGES = 160

if (!resolve(stagingDir).startsWith(resolve(join(benchmarkDir, '.staging')))) throw new Error('Unsafe staging path')

async function download(url, path, maxTime = '240') {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', maxTime, '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', path, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

function parseBox(row) {
  return {
    imageId: row[0],
    label: row[2],
    xMin: Number(row[4]),
    xMax: Number(row[5]),
    yMin: Number(row[6]),
    yMax: Number(row[7]),
    occluded: row[8] === '1',
    truncated: row[9] === '1',
    groupOf: row[10] === '1',
    depiction: row[11] === '1',
  }
}

function overlapFraction(inner, outer) {
  const width = Math.max(0, Math.min(inner.xMax, outer.xMax) - Math.max(inner.xMin, outer.xMin))
  const height = Math.max(0, Math.min(inner.yMax, outer.yMax) - Math.max(inner.yMin, outer.yMin))
  const area = (inner.xMax - inner.xMin) * (inner.yMax - inner.yMin)
  return area > 0 ? width * height / area : 0
}

function collectExplicitFaceNegatives(csv) {
  const negatives = new Set()
  const lines = csv.split(/\r?\n/)
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index]) continue
    const [imageId, , label, confidence] = lines[index].split(',')
    if (label === HUMAN_FACE && confidence === '0') negatives.add(imageId)
  }
  return negatives
}

function selectCandidates(csv, explicitFaceNegatives) {
  const lines = csv.split(/\r?\n/)
  const groups = new Map()
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index]) continue
    const row = lines[index].split(',')
    if (![HUMAN_FACE, HUMAN_HAIR, HUMAN_HEAD].includes(row[2])) continue
    const box = parseBox(row)
    const group = groups.get(box.imageId) ?? { heads: [], faces: [], hair: [] }
    if (box.label === HUMAN_HEAD) group.heads.push(box)
    if (box.label === HUMAN_FACE) group.faces.push(box)
    if (box.label === HUMAN_HAIR) group.hair.push(box)
    groups.set(box.imageId, group)
  }

  const candidates = []
  for (const [imageId, group] of groups) {
    if (group.heads.length !== 1 || group.faces.length > 0 || !explicitFaceNegatives.has(imageId)) continue
    const head = group.heads[0]
    if (head.groupOf || head.depiction) continue
    const hairVisible = group.hair.some((hair) => overlapFraction(hair, head) >= 0.2)
    const stratum = `${hairVisible ? 'hair' : 'no_hair'}_${head.occluded ? 'occluded' : 'clear'}`
    const order = createHash('sha256').update(imageId).digest('hex')
    candidates.push({ imageId, head, hairVisible, stratum, order })
  }
  return candidates.sort((left, right) => left.order.localeCompare(right.order))
}

function distribution(values, digits = 4) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(digits))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

async function makeYuNetTensor(path) {
  let pipeline = sharp(path).removeAlpha()
  const metadata = await pipeline.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Unable to read crop dimensions')
  const scale = 320 / Math.max(metadata.width, metadata.height)
  const scaledWidth = Math.max(1, Math.round(metadata.width * scale))
  const scaledHeight = Math.max(1, Math.round(metadata.height * scale))
  const width = Math.ceil(scaledWidth / 32) * 32
  const height = Math.ceil(scaledHeight / 32) * 32
  const { data, info } = await pipeline.resize(scaledWidth, scaledHeight).extend({
    right: width - scaledWidth,
    bottom: height - scaledHeight,
    background: { r: 0, g: 0, b: 0 },
  }).raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3 + 2]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3]
  }
  return new ort.Tensor('float32', input, [1, 3, info.height, info.width])
}

async function makeWholebodyTensor(path) {
  const { data, info } = await sharp(path).resize(320, 320, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3 + 2]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3]
  }
  return new ort.Tensor('float32', input, [1, 3, 320, 320])
}

async function makePoseTensor(path) {
  const { data, info } = await sharp(path).resize(224, 224, { fit: 'cover', position: 'centre' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3 + 2]
  }
  return new ort.Tensor('float32', input, [1, 3, 224, 224])
}

function yuNetMaxScore(outputs) {
  let maximum = 0
  for (const stride of [8, 16, 32]) {
    const classifications = outputs[`cls_${stride}`].data
    const objectness = outputs[`obj_${stride}`].data
    for (let index = 0; index < classifications.length; index += 1) {
      maximum = Math.max(maximum, Math.sqrt(
        Math.min(1, Math.max(0, classifications[index])) * Math.min(1, Math.max(0, objectness[index])),
      ))
    }
  }
  return maximum
}

function wholebodyHeadMaxScore(outputs, outputName) {
  const rows = outputs[outputName].data
  let maximum = 0
  for (let index = 0; index < rows.length; index += 7) {
    if (Math.round(rows[index + 1]) === 3) maximum = Math.max(maximum, rows[index + 2])
  }
  return maximum
}

function cropCoordinates(metadata, box) {
  const centerX = ((box.xMin + box.xMax) / 2) * metadata.width
  const centerY = ((box.yMin + box.yMax) / 2) * metadata.height
  const size = Math.max((box.xMax - box.xMin) * metadata.width, (box.yMax - box.yMin) * metadata.height) * 1.35
  const left = Math.max(0, Math.min(metadata.width - 1, Math.floor(centerX - size / 2)))
  const top = Math.max(0, Math.min(metadata.height - 1, Math.floor(centerY - size / 2)))
  const width = Math.max(1, Math.min(Math.round(size), metadata.width - left))
  const height = Math.max(1, Math.min(Math.round(size), metadata.height - top))
  return { left, top, width, height }
}

ort.env.wasm.numThreads = 1
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  await Promise.all([
    download(annotationsUrl, annotationsPath),
    download(imageLabelsUrl, imageLabelsPath),
  ])
  const [annotationBytes, imageLabelBytes] = await Promise.all([readFile(annotationsPath), readFile(imageLabelsPath)])
  const annotationMd5 = createHash('md5').update(annotationBytes).digest('hex')
  if (annotationMd5 !== expectedAnnotationsMd5) throw new Error(`Open Images annotations checksum mismatch: ${annotationMd5}`)
  const imageLabelsMd5 = createHash('md5').update(imageLabelBytes).digest('hex')
  if (imageLabelsMd5 !== expectedImageLabelsMd5) throw new Error(`Open Images image-label checksum mismatch: ${imageLabelsMd5}`)
  const explicitFaceNegatives = collectExplicitFaceNegatives(imageLabelBytes.toString('utf8'))
  const candidates = selectCandidates(annotationBytes.toString('utf8'), explicitFaceNegatives)
  if (candidates.length < 50) throw new Error(`Only ${candidates.length} explicit Human face negative head candidates are available`)
  const targetImages = Math.min(DESIRED_IMAGES, candidates.length)
  process.stdout.write(`Found ${candidates.length} explicit face-negative head candidates; target ${targetImages}\n`)

  await download(resourceArchiveUrl, resourceArchivePath, '480')
  const resourceSha256 = createHash('sha256').update(await readFile(resourceArchivePath)).digest('hex')
  if (resourceSha256 !== expectedResourceSha256) throw new Error(`Wholebody resources checksum mismatch: ${resourceSha256}`)
  const { stdout: archiveListing } = await execFileAsync('tar.exe', ['-tf', resourceArchivePath], { maxBuffer: 20 * 1024 * 1024 })
  const entries = archiveListing.split(/\r?\n/).filter(Boolean)
  const unsafeEntry = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafeEntry) throw new Error(`Unsafe model archive entry: ${unsafeEntry}`)
  const modelEntry = entries.find((entry) => entry.endsWith('yolov9_n_wholebody13_post_0245_1x3x320x320.onnx'))
  if (!modelEntry) throw new Error('Expected Wholebody13 model is missing from archive')
  await execFileAsync('tar.exe', ['-xf', resourceArchivePath, '-C', stagingDir, modelEntry])
  const wholebodyModelPath = join(stagingDir, ...modelEntry.split('/'))
  const modelSha256 = createHash('sha256').update(await readFile(wholebodyModelPath)).digest('hex')
  if (modelSha256 !== expectedHeadModelSha256) throw new Error(`Wholebody model checksum mismatch: ${modelSha256}`)

  await download(hairModelUrl, hairModelPath)
  const hairModelSha256 = createHash('sha256').update(await readFile(hairModelPath)).digest('hex')
  if (hairModelSha256 !== expectedHairModelSha256) throw new Error(`Hair Segmenter checksum mismatch: ${hairModelSha256}`)
  await execFileAsync(pythonExecutable, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--quiet',
    '--target', liteRtPythonPath, 'ai-edge-litert==2.1.6',
  ], { maxBuffer: 10 * 1024 * 1024 })

  const [yuNetSession, poseSession, headSession] = await Promise.all([
    ort.InferenceSession.create(await readFile(yuNetPath), { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(await readFile(poseModelPath), { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(await readFile(wholebodyModelPath), { executionProviders: ['wasm'] }),
  ])
  const accepted = []
  const rejectedResolution = { count: 0 }
  for (const candidate of candidates) {
    if (accepted.length >= targetImages) break
    try {
      await download(`https://open-images-dataset.s3.amazonaws.com/validation/${candidate.imageId}.jpg`, imagePath, '90')
      const metadata = await sharp(imagePath).metadata()
      if (!metadata.width || !metadata.height) continue
      const crop = cropCoordinates(metadata, candidate.head)
      if (Math.min(crop.width, crop.height) < 96) {
        rejectedResolution.count += 1
        continue
      }
      await sharp(imagePath).extract(crop).jpeg({ quality: 92 }).toFile(cropPath)
      const [yuNetTensor, poseTensor, headTensor] = await Promise.all([
        makeYuNetTensor(cropPath),
        makePoseTensor(cropPath),
        makeWholebodyTensor(cropPath),
      ])
      const [yuNetOutputs, poseOutputs, headOutputs] = await Promise.all([
        yuNetSession.run({ [yuNetSession.inputNames[0]]: yuNetTensor }),
        poseSession.run({ [poseSession.inputNames[0]]: poseTensor }),
        headSession.run({ [headSession.inputNames[0]]: headTensor }),
      ])
      const [yaw, roll, pitch] = Array.from(poseOutputs[poseSession.outputNames[0]].data)
      const { stdout: hairStdout } = await execFileAsync(pythonExecutable, [hairInferenceScript, hairModelPath, cropPath], {
        env: { ...process.env, PYTHONPATH: liteRtPythonPath },
        maxBuffer: 2 * 1024 * 1024,
      })
      const hair = JSON.parse(hairStdout)
      accepted.push({
        stratum: candidate.stratum,
        hairVisible: candidate.hairVisible,
        occluded: candidate.head.occluded,
        truncated: candidate.head.truncated,
        cropMinimumPixels: Math.min(crop.width, crop.height),
        yuNetScore: yuNetMaxScore(yuNetOutputs),
        headScore: wholebodyHeadMaxScore(headOutputs, headSession.outputNames[0]),
        yaw,
        roll,
        pitch,
        hair,
      })
      if (accepted.length % 25 === 0) process.stdout.write(`Processed ${accepted.length}/${targetImages} transient Open Images head crops\n`)
    } catch (error) {
      if (!String(error?.message).includes('404')) process.stderr.write(`Skipped one Open Images candidate: ${error.message}\n`)
    } finally {
      await rm(imagePath, { force: true })
      await rm(cropPath, { force: true })
    }
  }
  if (accepted.length < 40) throw new Error(`Only ${accepted.length}/${targetImages} usable head crops were processed; at least 40 are required`)

  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9].map((threshold) => ({
    threshold,
    headDetectorRecall: Number((accepted.filter((item) => item.headScore >= threshold).length / accepted.length).toFixed(4)),
    headDetectorRecallHairVisible: Number((accepted.filter((item) => item.hairVisible && item.headScore >= threshold).length / accepted.filter((item) => item.hairVisible).length).toFixed(4)),
    headDetectorRecallHairAbsent: Number((accepted.filter((item) => !item.hairVisible && item.headScore >= threshold).length / accepted.filter((item) => !item.hairVisible).length).toFixed(4)),
  }))
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-TRANSIENT-BENCHMARK-1.0',
    source: {
      name: 'Open Images V7 validation human-part bounding boxes and CVDF image mirror',
      annotationsUrl,
      annotationsMd5: annotationMd5,
      imageLabelsUrl,
      imageLabelsMd5,
      annotationLicense: 'CC BY 4.0',
      imageLicenseNote: 'Images retain their source Creative Commons licenses and were used transiently for research evaluation only.',
    },
    selection: {
      images: accepted.length,
      criteria: 'Exactly one Human head box, explicit human-verified Human face Confidence=0 label, no Human face box, non-depiction, non-group, cropped with 35% context, minimum crop edge 96 px.',
      candidatePool: candidates.length,
      rejectedForLowCropResolution: rejectedResolution.count,
      strata: Object.fromEntries(Object.entries(Object.groupBy(accepted, (item) => item.stratum)).map(([stratum, items]) => [stratum, items.length])),
      cropMinimumPixels: distribution(accepted.map((item) => item.cropMinimumPixels), 0),
    },
    researchOnlyHeadDetector: {
      model: 'YOLOv9-N Wholebody13 head class, GPL-3.0, evaluated transiently and not distributed with HeadUp',
      modelSha256,
      headScore: distribution(accepted.map((item) => item.headScore)),
      thresholds,
    },
    productionFaceDetectorOnHeadWithoutFaceLabel: {
      model: 'OpenCV YuNet 2026may',
      faceScore: distribution(accepted.map((item) => item.yuNetScore)),
      wouldRejectAsFullFaceAtPoint9: accepted.filter((item) => item.yuNetScore >= 0.9).length,
    },
    supplementalHairSegmenter: {
      model: 'MediaPipe Hair Segmenter float32 v1, Apache-2.0-compatible model, diagnostic evidence only',
      runtime: 'ai-edge-litert 2.1.6 installed transiently for this benchmark',
      modelSha256: hairModelSha256,
      preprocessing: 'RGBA float32, metadata normalization mean=0/std=255, opaque alpha, direct 512x512 resize',
      hairPixelFraction: distribution(accepted.map((item) => item.hair.hairPixelFraction)),
      upperHalfHairFraction: distribution(accepted.map((item) => item.hair.upperHalfHairFraction)),
      centerUpperHairFraction: distribution(accepted.map((item) => item.hair.centerUpperHairFraction)),
      byOpenImagesHairBox: {
        present: {
          images: accepted.filter((item) => item.hairVisible).length,
          hairPixelFraction: distribution(accepted.filter((item) => item.hairVisible).map((item) => item.hair.hairPixelFraction)),
        },
        absent: {
          images: accepted.filter((item) => !item.hairVisible).length,
          hairPixelFraction: distribution(accepted.filter((item) => !item.hairVisible).map((item) => item.hair.hairPixelFraction)),
        },
      },
      warning: 'Hair evidence cannot establish crown orientation and is not a top-view acceptance rule; absent Open Images hair boxes are not guaranteed bald negatives.',
    },
    poseEstimatorOnHeadWithoutFaceLabel: {
      yaw: distribution(accepted.map((item) => item.yaw), 2),
      roll: distribution(accepted.map((item) => item.roll), 2),
      pitch: distribution(accepted.map((item) => item.pitch), 2),
      legacyTopProxyAccepted: accepted.filter((item) => item.pitch <= -20 && Math.abs(item.yaw) <= 45 && Math.abs(item.roll) <= 15).length,
      warning: 'These boxes prove head presence, not a calibrated crown/top capture; pose outputs are diagnostic only.',
    },
    retention: {
      imagesRetained: false,
      cropsRetained: false,
      identifiersRetained: false,
      individualPredictionsRetained: false,
      annotationArchiveRetained: false,
      gplModelRetained: false,
      aggregateOnly: true,
    },
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ ...result, resultPath }, null, 2) + '\n')
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
