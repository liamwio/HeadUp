import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingDir = join(benchmarkDir, '.staging', 'pointing04')
const resultPath = join(benchmarkDir, 'transient-wide-pose-result.json')
const hairModelPath = join(stagingDir, 'hair_segmenter.tflite')
const liteRtPythonPath = join(stagingDir, 'litert-python')
const hairInferenceScript = join(projectDir, 'scripts', 'run-hair-segmenter-litert.py')
const yuNetPath = join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx')
const pythonExecutable = process.env.HEADUP_PYTHON || 'py'
const pythonPrefixArgs = process.env.HEADUP_PYTHON ? [] : ['-3.11']
const hairModelUrl = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/1/hair_segmenter.tflite'
const expectedHairModelSha256 = '2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84'
const sourceConfig = JSON.parse(await readFile(join(benchmarkDir, 'sources.json'), 'utf8'))
const source = sourceConfig.sources.find((item) => item.id === 'pointing04-figshare-v2')
if (!source) throw new Error('Pointing04 source configuration is missing')
if (!resolve(stagingDir).startsWith(resolve(join(benchmarkDir, '.staging')))) throw new Error('Unsafe staging path')

async function downloadToFile(url, path) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error',
    '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '120',
    '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', path,
    url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(2))
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

function compactDistribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(4))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

function summarize(items) {
  return {
    images: items.length,
    predictedYaw: distribution(items.map((item) => item.yaw)),
    predictedPitch: distribution(items.map((item) => item.pitch)),
    predictedRoll: distribution(items.map((item) => item.roll)),
    yuNetFaceScore: compactDistribution(items.map((item) => item.faceScore)),
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else files.push(path)
  }
  return files
}

async function makeTensor(path) {
  const { data, info } = await sharp(path)
    .resize(224, 224, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3 + 2]
  }
  return new ort.Tensor('float32', input, [1, 3, 224, 224])
}

async function makeYuNetTensor(path) {
  let pipeline = sharp(path).removeAlpha()
  const metadata = await pipeline.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Unable to read image dimensions')
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

function poseGroup(vertical, horizontal) {
  if (vertical === -90) return 'looking_down_crown_visible'
  if (vertical === 90) return 'looking_up_face_visible'
  if (vertical === 0 && horizontal === 0) return 'front'
  if (Math.abs(horizontal) >= 75) return horizontal > 0 ? 'right_extreme' : 'left_extreme'
  return 'oblique'
}

function hairEvidenceGroup(vertical, horizontal) {
  if (vertical === -90) return 'looking_down_crown_visible'
  if (vertical === 90) return 'looking_up_face_visible'
  if (vertical === 0 && horizontal === 0) return 'front'
  if (vertical === 0 && horizontal === -90) return 'left_true_profile'
  if (vertical === 0 && horizontal === 90) return 'right_true_profile'
  return null
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
const metadataPath = join(stagingDir, 'figshare-article.json')
await downloadToFile(source.metadataApi, metadataPath)
const article = JSON.parse(await readFile(metadataPath, 'utf8'))
await rm(metadataPath, { force: true })
const archives = article.files
  .filter((file) => /^Person(?:0[1-9]|1[0-5])-2\.tar\.gz$/.test(file.name))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'))
if (archives.length !== source.expectedArchives) throw new Error(`Expected ${source.expectedArchives} archives, found ${archives.length}`)

const model = await readFile(join(projectDir, 'public', 'models', 'whenet_1x3x224x224_prepost.onnx'))
const [session, yuNetSession] = await Promise.all([
  ort.InferenceSession.create(model, { executionProviders: ['wasm'] }),
  ort.InferenceSession.create(await readFile(yuNetPath), { executionProviders: ['wasm'] }),
])
const cases = []
const hairCases = []
const verifiedArchives = []

  await downloadToFile(hairModelUrl, hairModelPath)
  const hairModelSha256 = createHash('sha256').update(await readFile(hairModelPath)).digest('hex')
  if (hairModelSha256 !== expectedHairModelSha256) throw new Error(`Hair Segmenter checksum mismatch: ${hairModelSha256}`)
  await execFileAsync(pythonExecutable, [
    ...pythonPrefixArgs,
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--quiet',
    '--target', liteRtPythonPath,
    'ai-edge-litert==2.1.6', 'numpy==2.2.6', 'pillow==11.3.0',
  ], { maxBuffer: 10 * 1024 * 1024 })

  for (const [archiveIndex, archive] of archives.entries()) {
    const archivePath = join(stagingDir, archive.name)
    const extractDir = join(stagingDir, archive.name.replace(/\.tar\.gz$/, ''))
    try {
      await downloadToFile(archive.download_url, archivePath)
      const bytes = await readFile(archivePath)
      const md5 = createHash('md5').update(bytes).digest('hex')
      if (md5 !== archive.supplied_md5) throw new Error(`Checksum mismatch for ${archive.name}`)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const { stdout: listing } = await execFileAsync('tar.exe', ['-tzf', archivePath], { maxBuffer: 5 * 1024 * 1024 })
      const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
      if (unsafe) throw new Error(`Unsafe archive entry: ${unsafe}`)
      await mkdir(extractDir, { recursive: true })
      await execFileAsync('tar.exe', ['-xzf', archivePath, '-C', extractDir])
      const images = (await listFiles(extractDir)).filter((path) => /\.jpe?g$/i.test(path))
      if (images.length !== 93) throw new Error(`Expected 93 images in ${archive.name}, found ${images.length}`)
      for (const path of images) {
        const match = /([+-]\d+)([+-]\d+)\.jpe?g$/i.exec(path)
        if (!match) throw new Error(`Unable to parse pose labels from ${path}`)
        const vertical = Number(match[1])
        const horizontal = Number(match[2])
        const [tensor, yuNetTensor] = await Promise.all([makeTensor(path), makeYuNetTensor(path)])
        const [outputs, yuNetOutputs] = await Promise.all([
          session.run({ [session.inputNames[0]]: tensor }),
          yuNetSession.run({ [yuNetSession.inputNames[0]]: yuNetTensor }),
        ])
        const values = Array.from(outputs[session.outputNames[0]].data)
        cases.push({ vertical, horizontal, group: poseGroup(vertical, horizontal), yaw: values[0], roll: values[1], pitch: values[2], faceScore: yuNetMaxScore(yuNetOutputs) })
        const evidenceGroup = hairEvidenceGroup(vertical, horizontal)
        if (evidenceGroup) {
          const { stdout } = await execFileAsync(pythonExecutable, [...pythonPrefixArgs, hairInferenceScript, hairModelPath, path], {
            env: { ...process.env, PYTHONPATH: liteRtPythonPath },
            maxBuffer: 2 * 1024 * 1024,
          })
          hairCases.push({ group: evidenceGroup, ...JSON.parse(stdout) })
        }
      }
      verifiedArchives.push({ name: archive.name, bytes: archive.size, md5, sha256 })
      process.stdout.write(`Processed ${archiveIndex + 1}/${archives.length}: ${archive.name}\n`)
    } finally {
      await rm(archivePath, { force: true })
      await rm(extractDir, { recursive: true, force: true })
    }
  }

  if (cases.length !== source.expectedImages) throw new Error(`Expected ${source.expectedImages} images, tested ${cases.length}`)
  const byGroup = Object.fromEntries(Object.entries(Object.groupBy(cases, (item) => item.group)).map(([name, items]) => [name, summarize(items)]))
  const byVerticalAngle = Object.fromEntries(Object.entries(Object.groupBy(cases, (item) => String(item.vertical))).map(([name, items]) => [name, summarize(items)]))
  const byHorizontalAngle = Object.fromEntries(Object.entries(Object.groupBy(cases, (item) => String(item.horizontal))).map(([name, items]) => [name, summarize(items)]))
  const topProxyEvaluation = [-15, -20, -25, -30].map((pitchThreshold) => {
    const accepts = (item) => item.pitch <= pitchThreshold && Math.abs(item.yaw) <= 45 && Math.abs(item.roll) <= 15
    return {
      pitchThreshold,
      crownAccepted: cases.filter((item) => item.vertical === -90 && accepts(item)).length,
      crownTotal: cases.filter((item) => item.vertical === -90).length,
      nonCrownFalseAccepted: cases.filter((item) => item.vertical !== -90 && accepts(item)).length,
      nonCrownTotal: cases.filter((item) => item.vertical !== -90).length,
    }
  })
  const topProxyWithFaceExclusion = [-15, -20, -25, -30].flatMap((pitchThreshold) => [0.85, 0.9, 0.95].map((faceScoreThreshold) => {
    const accepts = (item) => item.pitch <= pitchThreshold && Math.abs(item.yaw) <= 45 && Math.abs(item.roll) <= 15 && item.faceScore < faceScoreThreshold
    return {
      pitchThreshold,
      faceScoreMustBeBelow: faceScoreThreshold,
      crownAccepted: cases.filter((item) => item.vertical === -90 && accepts(item)).length,
      crownTotal: cases.filter((item) => item.vertical === -90).length,
      nonCrownFalseAccepted: cases.filter((item) => item.vertical !== -90 && accepts(item)).length,
      nonCrownTotal: cases.filter((item) => item.vertical !== -90).length,
    }
  }))
  const frontPitchGateSweep = [3, 5, 7, 8, 9, 10, 12, 15].map((threshold) => {
    const baseFrontProxy = (item) => Math.abs(item.yaw) <= 12 && Math.abs(item.roll) <= 12 && item.faceScore >= 0.9
    const accepts = (item) => baseFrontProxy(item) && Math.abs(item.pitch) <= threshold
    const nominalFront = cases.filter((item) => item.vertical === 0 && item.horizontal === 0)
    const centralNonFront = cases.filter((item) => item.vertical !== 0 && item.horizontal === 0)
    const allNonFront = cases.filter((item) => item.vertical !== 0 || item.horizontal !== 0)
    return {
      threshold,
      nominalFront: { accepted: nominalFront.filter(accepts).length, baseFrontProxyAccepted: nominalFront.filter(baseFrontProxy).length, images: nominalFront.length },
      centralNonFront: { accepted: centralNonFront.filter(accepts).length, baseFrontProxyAccepted: centralNonFront.filter(baseFrontProxy).length, images: centralNonFront.length },
      allNonFront: { accepted: allNonFront.filter(accepts).length, baseFrontProxyAccepted: allNonFront.filter(baseFrontProxy).length, images: allNonFront.length },
      centralByVerticalAngle: Object.fromEntries(Object.entries(Object.groupBy(cases.filter((item) => item.horizontal === 0), (item) => String(item.vertical))).map(([angle, items]) => [angle, { accepted: items.filter(accepts).length, images: items.length }])),
    }
  })
  const pitch8Reference = frontPitchGateSweep.find((item) => item.threshold === 8)
  const pitch9Candidate = frontPitchGateSweep.find((item) => item.threshold === 9)
  if (!pitch8Reference || !pitch9Candidate) throw new Error('Pitch 8/9 confirmation rows are missing')
  const strongCentralNonFront = cases.filter((item) => item.horizontal === 0 && Math.abs(item.vertical) >= 30)
  const strongCentralAcceptedAt9 = strongCentralNonFront.filter((item) => Math.abs(item.yaw) <= 12
    && Math.abs(item.roll) <= 12 && item.faceScore >= 0.9 && Math.abs(item.pitch) <= 9).length
  const pitch9CandidateConfirmation = {
    candidate: 'change production maximum absolute pitch from 8 to 9 degrees',
    predeclaredBeforeRun: true,
    gates: {
      nominalFrontAcceptedAtLeast14Of15: pitch9Candidate.nominalFront.accepted >= 14,
      strongCentralNonFrontFalseAcceptAtMost10Percent: strongCentralAcceptedAt9 / strongCentralNonFront.length <= 0.10,
      allNonFrontFalseAcceptIncreaseVersus8AtMost1Point5PercentagePoints:
        (pitch9Candidate.allNonFront.accepted - pitch8Reference.allNonFront.accepted) / pitch9Candidate.allNonFront.images <= 0.015,
    },
    evidence: {
      nominalFrontAccepted: pitch9Candidate.nominalFront.accepted,
      nominalFrontImages: pitch9Candidate.nominalFront.images,
      strongCentralNonFrontAccepted: strongCentralAcceptedAt9,
      strongCentralNonFrontImages: strongCentralNonFront.length,
      allNonFrontAcceptedAt8: pitch8Reference.allNonFront.accepted,
      allNonFrontAcceptedAt9: pitch9Candidate.allNonFront.accepted,
      allNonFrontImages: pitch9Candidate.allNonFront.images,
    },
  }
  pitch9CandidateConfirmation.passed = Object.values(pitch9CandidateConfirmation.gates).every(Boolean)
  const hairEvidenceByGroup = Object.fromEntries(Object.entries(Object.groupBy(hairCases, (item) => item.group)).map(([name, items]) => [name, {
    images: items.length,
    hairPixelFraction: compactDistribution(items.map((item) => item.hairPixelFraction)),
    upperHalfHairFraction: compactDistribution(items.map((item) => item.upperHalfHairFraction)),
    centerUpperHairFraction: compactDistribution(items.map((item) => item.centerUpperHairFraction)),
  }]))
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: sourceConfig.policyVersion,
    source: { id: source.id, name: source.name, doi: source.doi, license: source.license },
    model: 'WHENet v1.0.4 prepost ONNX',
    images: cases.length,
    archives: verifiedArchives,
    byGroup,
    byVerticalAngle,
    byHorizontalAngle,
    frontPitchGateSweep,
    pitch9CandidateConfirmation,
    topProxyEvaluation,
    topProxyWithFaceExclusion,
    supplementalHairEvidence: {
      model: 'MediaPipe Hair Segmenter float32 v1',
      modelSha256: hairModelSha256,
      runtime: 'ai-edge-litert 2.1.6 installed transiently for this benchmark',
      preprocessing: 'RGBA float32, metadata normalization mean=0/std=255, opaque alpha, direct 512x512 resize',
      sampledImages: hairCases.length,
      byGroup: hairEvidenceByGroup,
      warning: 'Hair segmentation is supplemental evidence only and cannot establish crown orientation by itself.',
    },
    retention: { imagesRetained: false, identifiersRetained: false, individualPredictionsRetained: false, aggregateOnly: true },
    caution: 'Pointing04 uses instructed gaze/head targets and is known to contain pose-label noise; results are robustness evidence, not threshold calibration.',
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ images: result.images, byGroup: result.byGroup, resultPath }, null, 2) + '\n')
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
