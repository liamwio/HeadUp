import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingDir = join(benchmarkDir, '.staging', 'stirling-esrc-sample')
const archivePath = join(stagingDir, 'samples.zip')
const extractDir = join(stagingDir, 'extracted')
const resultPath = join(benchmarkDir, 'stirling-esrc-sample-result.json')
const sourceUrl = 'https://pics.stir.ac.uk/ESRC/samples.zip'
const sourcePage = 'https://pics.stir.ac.uk/ESRC/examples.htm'
const expectedArchiveBytes = 10_912_733
const expectedArchiveSha256 = '9c606566bcf3ad3b0f1baa042f12a0e675630a582865c573993580f6b6c9e996'
const yuNetPath = join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx')
const poseModelPath = join(projectDir, 'public', 'models', 'whenet_1x3x224x224_prepost.onnx')
const yuNetSha256 = 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0'

const allowedStagingRoot = resolve(join(benchmarkDir, '.staging')) + sep
if (!resolve(stagingDir).startsWith(allowedStagingRoot)) throw new Error('Unsafe staging directory')

function round(value, digits = 4) {
  return Number(value.toFixed(digits))
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))])
}

function distribution(values) {
  return {
    min: percentile(values, 0),
    p05: percentile(values, 0.05),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
  }
}

function countBy(items, key) {
  return Object.fromEntries(Object.entries(Object.groupBy(items, key)).map(([name, rows]) => [name, rows.length]))
}

function captureFamily(fileName) {
  const match = fileName.match(/_(V0S|V4R|V4L|V9L)_/i)
  if (match) return match[1].toUpperCase()
  if (/_O1_/i.test(fileName)) return 'OUTDOOR'
  if (/_conf\./i.test(fileName)) return 'CONFORMED_TEXTURE'
  if (/_B_N\./i.test(fileName)) return 'BLUE_BACKGROUND'
  return 'OTHER_STILL'
}

async function download(url, destination) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '180', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', destination, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

async function makeYuNetTensor(path) {
  const metadata = await sharp(path).metadata()
  if (!metadata.width || !metadata.height) throw new Error('Unable to read image dimensions')
  const scale = 320 / Math.max(metadata.width, metadata.height)
  const scaledWidth = Math.max(1, Math.round(metadata.width * scale))
  const scaledHeight = Math.max(1, Math.round(metadata.height * scale))
  const paddedWidth = Math.ceil(scaledWidth / 32) * 32
  const paddedHeight = Math.ceil(scaledHeight / 32) * 32
  const { data, info } = await sharp(path).resize(scaledWidth, scaledHeight, { fit: 'fill' }).extend({
    right: paddedWidth - scaledWidth,
    bottom: paddedHeight - scaledHeight,
    background: { r: 0, g: 0, b: 0 },
  }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3 + 2]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3]
  }
  return new ort.Tensor('float32', input, [1, 3, info.height, info.width])
}

async function makePoseTensor(path) {
  const metadata = await sharp(path).metadata()
  if (!metadata.width || !metadata.height) throw new Error('Unable to read image dimensions')
  const cropSize = Math.min(metadata.width, metadata.height)
  const left = Math.floor((metadata.width - cropSize) / 2)
  const top = Math.floor((metadata.height - cropSize) / 2)
  const { data, info } = await sharp(path).extract({ left, top, width: cropSize, height: cropSize })
    .resize(224, 224).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3 + 2]
  }
  return new ort.Tensor('float32', input, [1, 3, 224, 224])
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

function predictedPoseGroup(yaw) {
  if (Math.abs(yaw) <= 12) return 'front'
  if (Math.abs(yaw) >= 35) return yaw < 0 ? 'right_profile' : 'left_profile'
  return yaw < 0 ? 'right_oblique' : 'left_oblique'
}

ort.env.wasm.numThreads = 1
await rm(stagingDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
let aggregateResult

try {
  await download(sourceUrl, archivePath)
  const archive = await readFile(archivePath)
  const archiveSha256 = createHash('sha256').update(archive).digest('hex')
  if (archive.length !== expectedArchiveBytes) throw new Error(`Archive size mismatch: ${archive.length}`)
  if (archiveSha256 !== expectedArchiveSha256) throw new Error(`Archive SHA-256 mismatch: ${archiveSha256}`)

  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 2 * 1024 * 1024 })
  const entries = listing.split(/\r?\n/).filter(Boolean)
  const unsafeEntry = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafeEntry) throw new Error(`Unsafe archive entry: ${unsafeEntry}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir])

  const stillNames = (await readdir(extractDir)).filter((name) => /\.jpe?g$/i.test(name)).sort()
  if (stillNames.length !== 9) throw new Error(`Expected 9 JPEG stills, found ${stillNames.length}`)

  const [yuNetModel, poseModel] = await Promise.all([readFile(yuNetPath), readFile(poseModelPath)])
  const actualYuNetSha256 = createHash('sha256').update(yuNetModel).digest('hex')
  if (actualYuNetSha256 !== yuNetSha256) throw new Error(`YuNet SHA-256 mismatch: ${actualYuNetSha256}`)
  const [yuNetSession, poseSession, qualityHarness] = await Promise.all([
    ort.InferenceSession.create(yuNetModel, { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(poseModel, { executionProviders: ['wasm'] }),
    createProductionQualityHarness(projectDir),
  ])

  const cases = []
  for (const fileName of stillNames) {
    const path = join(extractDir, fileName)
    const [quality, yuNetTensor, poseTensor] = await Promise.all([
      qualityHarness.inspect(path),
      makeYuNetTensor(path),
      makePoseTensor(path),
    ])
    const [yuNetOutputs, poseOutputs] = await Promise.all([
      yuNetSession.run({ [yuNetSession.inputNames[0]]: yuNetTensor }),
      poseSession.run({ [poseSession.inputNames[0]]: poseTensor }),
    ])
    const detection = decodeYuNetPrimary(yuNetOutputs, yuNetTensor.dims[3], yuNetTensor.dims[2])
    const [yaw, roll, pitch] = Array.from(poseOutputs[poseSession.outputNames[0]].data)
    cases.push({
      family: captureFamily(fileName),
      resolution: `${quality.dimensions.width}x${quality.dimensions.height}`,
      qualityAccepted: quality.accepted,
      qualityScore: quality.quality.score,
      qualityFlags: quality.quality.flags,
      faceScore: detection?.score ?? 0,
      faceAreaRatio: detection?.areaRatio ?? 0,
      faceCenterDistance: detection?.centerDistance ?? 1,
      yaw,
      roll,
      pitch,
      poseGroup: predictedPoseGroup(yaw),
    })
  }

  const qualityFlags = {}
  for (const item of cases) for (const flag of item.qualityFlags) qualityFlags[flag] = (qualityFlags[flag] || 0) + 1
  const frontProxy = (item) => item.qualityAccepted && item.faceScore >= 0.9 && item.faceAreaRatio >= 0.09
    && item.faceCenterDistance <= 0.18 && Math.abs(item.yaw) <= 12 && Math.abs(item.roll) <= 12 && Math.abs(item.pitch) <= 9
  const profileProxy = (item) => item.qualityAccepted && item.faceScore >= 0.85 && item.faceAreaRatio >= 0.07
    && item.faceCenterDistance <= 0.25 && Math.abs(item.yaw) >= 35 && Math.abs(item.roll) <= 18

  aggregateResult = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-TRANSIENT-REAL-PORTRAIT-1.0',
    source: {
      name: 'Stirling/ESRC 3D Face Database public example package',
      sourcePage,
      downloadUrl: sourceUrl,
      archiveBytes: archive.length,
      archiveSha256,
      publisherStatement: 'Public example package; full database separately requires a signed research agreement.',
    },
    selection: {
      realPeople: true,
      identities: 1,
      jpegStills: cases.length,
      captureFamilies: countBy(cases, (item) => item.family),
      resolutions: countBy(cases, (item) => item.resolution),
      eyewearTargeted: false,
    },
    productionProxy: {
      qualityAccepted: cases.filter((item) => item.qualityAccepted).length,
      yuNetDetectedAtPoint85: cases.filter((item) => item.faceScore >= 0.85).length,
      frontGatePassedWithoutMediaPipe: cases.filter(frontProxy).length,
      profileGatePassed: cases.filter(profileProxy).length,
      caution: 'Front count is an upper-bound proxy because the browser gate additionally requires MediaPipe landmarks. Capture-family names are not manual pose truth.',
    },
    distributions: {
      qualityScore: distribution(cases.map((item) => item.qualityScore)),
      yuNetScore: distribution(cases.map((item) => item.faceScore)),
      faceAreaRatio: distribution(cases.map((item) => item.faceAreaRatio)),
      faceCenterDistance: distribution(cases.map((item) => item.faceCenterDistance)),
      yaw: distribution(cases.map((item) => item.yaw)),
      roll: distribution(cases.map((item) => item.roll)),
      pitch: distribution(cases.map((item) => item.pitch)),
    },
    predictedPoseGroups: countBy(cases, (item) => item.poseGroup),
    qualityFlags,
    limitations: [
      'Only one real identity is present, so this is a pipeline smoke test rather than demographic or subject-level validation.',
      'The package has no HeadUp semantic profile/neck ground truth; it cannot estimate landmark or eight-metric accuracy.',
      'The stills are controlled/research captures rather than standard phone cross-session retakes.',
    ],
    retention: {
      imagesRetained: false,
      archiveRetained: false,
      identifiersRetained: false,
      individualPredictionsRetained: false,
      aggregateOnly: true,
    },
  }
  await writeFile(resultPath, `${JSON.stringify(aggregateResult, null, 2)}\n`)
} finally {
  const resolved = resolve(stagingDir)
  if (!resolved.startsWith(allowedStagingRoot)) throw new Error(`Refusing cleanup outside staging: ${resolved}`)
  await rm(resolved, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ ...aggregateResult, resultPath }, null, 2)}\n`)
