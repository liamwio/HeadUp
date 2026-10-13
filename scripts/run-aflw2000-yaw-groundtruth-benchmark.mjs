import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingDir = join(benchmarkDir, '.staging', 'aflw2000-yaw-groundtruth')
const extractDir = join(stagingDir, 'extract')
const resultPath = join(benchmarkDir, 'aflw2000-yaw-groundtruth-result.json')
const manualReviewDir = join(projectDir, 'data', 'manual-test', 'aflw2000-yaw-v1')
const manualReviewStagingDir = join(stagingDir, 'manual-review')
const archivePath = join(stagingDir, 'test.data.zip')
const yawPath = join(stagingDir, 'AFLW2000-3D.pose.npy')
const threeAxisPath = join(stagingDir, 'val_AFLW2000.json')
const poseModelPath = join(projectDir, 'public', 'models', 'whenet_1x3x224x224_prepost.onnx')

const source = {
  name: 'AFLW2000-3D cropped test set with fitted yaw, pitch and roll annotations',
  projectPage: 'http://www.cbsr.ia.ac.cn/users/xiangyuzhu/projects/3DDFA/main.htm',
  publisherRepository: 'https://github.com/cleardusk/3DDFA',
  pinnedCommit: '3545f355bfc71e5748fa915b13932958363135d7',
  archive: {
    url: 'https://drive.usercontent.google.com/download?id=1r_ciJ1M0BSRTwndIBt42GlPFRv6CvvEP&export=download&confirm=t',
    bytes: 158_854_200,
    sha256: 'c33b6c472baa0aca22fc21f456bcdfb5da964459208166eb93c8fffc720ddbad',
    expectedEntries: 23_085,
  },
  yawAnnotations: {
    url: 'https://raw.githubusercontent.com/cleardusk/3DDFA/3545f355bfc71e5748fa915b13932958363135d7/test.configs/AFLW2000-3D.pose.npy',
    bytes: 8_128,
    sha256: '901c784bc19885c9fc19971af902f1a8c5c746e9e5b959fb997895b1578d91c4',
  },
  threeAxisAnnotations: {
    repository: 'https://huggingface.co/HoyerChou/DirectMHP',
    pinnedCommit: 'f17041d6ec8381ba8bcae7ea7fea487f93911ef6',
    url: 'https://huggingface.co/HoyerChou/DirectMHP/resolve/f17041d6ec8381ba8bcae7ea7fea487f93911ef6/val_AFLW2000.json',
    bytes: 1_695_998,
    sha256: '7893c44c0f5bf9ddcf72d514ca9bc247cc599d025337b326b5fff77b6291d9e2',
    expectedCases: 1_988,
    poseOrder: ['yaw', 'pitch', 'roll'],
  },
}

const expectedPoseModelSha256 = '28345f49bd38a3e74f5d6b028469fe27b6bf5b09405ffdfa0be4b28db6c2be0e'
const allowedStagingRoot = resolve(join(benchmarkDir, '.staging')) + sep
if (!resolve(stagingDir).startsWith(allowedStagingRoot)) throw new Error('Unsafe staging directory')
const allowedManualRoot = resolve(join(projectDir, 'data', 'manual-test')) + sep
if (!resolve(manualReviewDir).startsWith(allowedManualRoot)) throw new Error('Unsafe manual-review directory')

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
    min: percentile(values, 0), p05: percentile(values, 0.05), median: percentile(values, 0.5),
    mean: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    p95: percentile(values, 0.95), max: percentile(values, 1),
  }
}

function rate(numerator, denominator) {
  return denominator ? round(numerator / denominator) : null
}

function circularAbsoluteError(predicted, truth) {
  const difference = Math.abs(predicted - truth) % 360
  return Math.min(difference, 360 - difference)
}

async function download(url, destination) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', destination, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

async function verifyFile(path, expected, label) {
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== expected.bytes) throw new Error(`${label} size mismatch: ${bytes.length}`)
  if (sha256 !== expected.sha256) throw new Error(`${label} SHA-256 mismatch: ${sha256}`)
  return { bytes: bytes.length, sha256 }
}

function parseNpyFloat32(buffer) {
  if (buffer.subarray(0, 6).toString('latin1') !== '\x93NUMPY') throw new Error('Invalid NPY magic')
  if (buffer[6] !== 1 || buffer[7] !== 0) throw new Error('Only NPY v1.0 is supported')
  const headerLength = buffer.readUInt16LE(8)
  const dataOffset = 10 + headerLength
  const header = buffer.subarray(10, dataOffset).toString('latin1')
  if (!header.includes("'descr': '<f4'") || !header.includes("'shape': (2000,)")) {
    throw new Error(`Unexpected yaw NPY header: ${header.trim()}`)
  }
  const values = new Float32Array(2_000)
  for (let index = 0; index < values.length; index += 1) values[index] = buffer.readFloatLE(dataOffset + index * 4)
  return Array.from(values)
}

async function makePoseTensor(path) {
  const metadata = await sharp(path).metadata()
  if (!metadata.width || !metadata.height) throw new Error('Unable to read AFLW2000 crop dimensions')
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

function thresholdDiagnostics(cases, predictedThreshold) {
  const frontTruth = cases.filter((item) => Math.abs(item.truthYaw) <= 8)
  const strongNonFrontTruth = cases.filter((item) => Math.abs(item.truthYaw) >= 20)
  const profileTruth = cases.filter((item) => Math.abs(item.truthYaw) >= 45)
  const predictedFront = (item) => Math.abs(item.predictedYaw) <= predictedThreshold
  const predictedProfileWithDirection = (item) => Math.abs(item.predictedYaw) >= 35
    && Math.sign(item.predictedYaw) === Math.sign(item.truthYaw)
  return {
    predictedFrontThresholdDegrees: predictedThreshold,
    frontTruthDefinition: 'absolute ground-truth yaw <= 8 degrees',
    frontTruthImages: frontTruth.length,
    frontAccepted: frontTruth.filter(predictedFront).length,
    frontRecall: rate(frontTruth.filter(predictedFront).length, frontTruth.length),
    strongNonFrontTruthDefinition: 'absolute ground-truth yaw >= 20 degrees',
    strongNonFrontTruthImages: strongNonFrontTruth.length,
    strongNonFrontFalseAcceptedAsFront: strongNonFrontTruth.filter(predictedFront).length,
    strongNonFrontFalseAcceptRate: rate(strongNonFrontTruth.filter(predictedFront).length, strongNonFrontTruth.length),
    profileTruthDefinition: 'absolute ground-truth yaw >= 45 degrees',
    profileTruthImages: profileTruth.length,
    profileDirectionAccepted: profileTruth.filter(predictedProfileWithDirection).length,
    profileDirectionRecall: rate(profileTruth.filter(predictedProfileWithDirection).length, profileTruth.length),
  }
}

function summarizeYaw(cases) {
  const errors = cases.map((item) => item.error)
  const signEligible = cases.filter((item) => Math.abs(item.truthYaw) >= 35)
  return {
    images: cases.length,
    groundTruthYaw: distribution(cases.map((item) => item.truthYaw)),
    predictedYaw: distribution(cases.map((item) => item.predictedYaw)),
    absoluteErrorDegrees: distribution(errors),
    within5Degrees: { images: errors.filter((value) => value <= 5).length, rate: rate(errors.filter((value) => value <= 5).length, errors.length) },
    within10Degrees: { images: errors.filter((value) => value <= 10).length, rate: rate(errors.filter((value) => value <= 10).length, errors.length) },
    within15Degrees: { images: errors.filter((value) => value <= 15).length, rate: rate(errors.filter((value) => value <= 15).length, errors.length) },
    signEligibleImages: signEligible.length,
    wrongDirectionSigns: signEligible.filter((item) => Math.sign(item.predictedYaw) !== Math.sign(item.truthYaw)).length,
    wrongDirectionRate: rate(signEligible.filter((item) => Math.sign(item.predictedYaw) !== Math.sign(item.truthYaw)).length, signEligible.length),
  }
}

function summarizeThreeAxis(cases) {
  const summarizeAxis = (truthKey, predictedKey, errorKey) => ({
    groundTruth: distribution(cases.map((item) => item[truthKey])),
    predicted: distribution(cases.map((item) => item[predictedKey])),
    absoluteErrorDegrees: distribution(cases.map((item) => item[errorKey])),
    within5Degrees: rate(cases.filter((item) => item[errorKey] <= 5).length, cases.length),
    within10Degrees: rate(cases.filter((item) => item[errorKey] <= 10).length, cases.length),
    within15Degrees: rate(cases.filter((item) => item[errorKey] <= 15).length, cases.length),
  })
  return {
    images: cases.length,
    yaw: summarizeAxis('truthYaw', 'predictedYaw', 'error'),
    pitch: summarizeAxis('truthPitch', 'predictedPitch', 'pitchError'),
    roll: summarizeAxis('truthRoll', 'predictedRoll', 'rollError'),
    meanThreeAxisMae: round([
      ...cases.map((item) => item.error),
      ...cases.map((item) => item.pitchError),
      ...cases.map((item) => item.rollError),
    ].reduce((sum, value) => sum + value, 0) / (cases.length * 3)),
  }
}

function jointFrontGateDiagnostics(cases, thresholds = { yaw: 12, pitch: 9, roll: 12 }) {
  const truthFront = cases.filter((item) => Math.abs(item.truthYaw) <= 8
    && Math.abs(item.truthPitch) <= 6 && Math.abs(item.truthRoll) <= 8)
  const failedAxes = (item) => [
    Math.abs(item.predictedYaw) > thresholds.yaw ? 'yaw' : null,
    Math.abs(item.predictedPitch) > thresholds.pitch ? 'pitch' : null,
    Math.abs(item.predictedRoll) > thresholds.roll ? 'roll' : null,
  ].filter(Boolean)
  const predictedFront = (item) => failedAxes(item).length === 0
  const strongPitchInvalid = cases.filter((item) => Math.abs(item.truthYaw) <= 12
    && Math.abs(item.truthPitch) >= 15 && Math.abs(item.truthRoll) <= 15)
  const strongRollInvalid = cases.filter((item) => Math.abs(item.truthYaw) <= 12
    && Math.abs(item.truthPitch) <= 10 && Math.abs(item.truthRoll) >= 20)
  const rejectedTruthFront = truthFront.filter((item) => !predictedFront(item))
  const rejectionAxisCounts = Object.fromEntries(['yaw', 'pitch', 'roll'].map((axis) => [
    axis,
    rejectedTruthFront.filter((item) => failedAxes(item).includes(axis)).length,
  ]))
  return {
    predictedThresholdDegrees: thresholds,
    truthFrontDefinition: '|GT yaw|<=8, |GT pitch|<=6 and |GT roll|<=8 degrees',
    truthFrontImages: truthFront.length,
    truthFrontAccepted: truthFront.filter(predictedFront).length,
    truthFrontRecall: rate(truthFront.filter(predictedFront).length, truthFront.length),
    truthFrontRejectionAttribution: {
      rejectedImages: rejectedTruthFront.length,
      failedAxisCountsIncludingOverlap: rejectionAxisCounts,
      onlyYaw: rejectedTruthFront.filter((item) => failedAxes(item).join(',') === 'yaw').length,
      onlyPitch: rejectedTruthFront.filter((item) => failedAxes(item).join(',') === 'pitch').length,
      onlyRoll: rejectedTruthFront.filter((item) => failedAxes(item).join(',') === 'roll').length,
      multipleAxes: rejectedTruthFront.filter((item) => failedAxes(item).length > 1).length,
    },
    strongPitchInvalidDefinition: '|GT yaw|<=12, |GT pitch|>=15 and |GT roll|<=15 degrees',
    strongPitchInvalidImages: strongPitchInvalid.length,
    strongPitchInvalidFalseAccepted: strongPitchInvalid.filter(predictedFront).length,
    strongPitchInvalidFalseAcceptRate: rate(strongPitchInvalid.filter(predictedFront).length, strongPitchInvalid.length),
    strongRollInvalidDefinition: '|GT yaw|<=12, |GT pitch|<=10 and |GT roll|>=20 degrees',
    strongRollInvalidImages: strongRollInvalid.length,
    strongRollInvalidFalseAccepted: strongRollInvalid.filter(predictedFront).length,
    strongRollInvalidFalseAcceptRate: rate(strongRollInvalid.filter(predictedFront).length, strongRollInvalid.length),
  }
}

function selectManualReviewCases(cases) {
  const selected = new Map()
  const add = (item, reason) => {
    if (!item) return
    const reasons = selected.get(item) || new Set()
    reasons.add(reason)
    selected.set(item, reasons)
  }
  const strata = [
    { label: '典型负向极侧', min: -99, max: -60 },
    { label: '典型负向侧面', min: -60, max: -35 },
    { label: '典型负向斜侧', min: -35, max: -12 },
    { label: '典型正面', min: -12, max: 12 },
    { label: '典型正向斜侧', min: 12, max: 35 },
    { label: '典型正向侧面', min: 35, max: 60 },
    { label: '典型正向极侧', min: 60, max: 99 },
  ]
  for (const stratum of strata) {
    const center = (stratum.min + stratum.max) / 2
    const candidates = cases.filter((item) => item.truthYaw >= stratum.min && item.truthYaw <= stratum.max)
      .sort((left, right) => Math.abs(left.truthYaw - center) - Math.abs(right.truthYaw - center)
        || left.error - right.error || left.sourceName.localeCompare(right.sourceName))
    for (const item of candidates.slice(0, 4)) add(item, stratum.label)
  }

  const frontFalseRejects = cases.filter((item) => Math.abs(item.truthYaw) <= 8 && Math.abs(item.predictedYaw) > 12)
    .sort((left, right) => right.error - left.error)
  for (const item of frontFalseRejects.slice(0, 3)) add(item, '正面误拒边界')
  const strongNonFrontFalseAccepts = cases.filter((item) => Math.abs(item.truthYaw) >= 20 && Math.abs(item.predictedYaw) <= 12)
    .sort((left, right) => right.error - left.error)
  for (const item of strongNonFrontFalseAccepts.slice(0, 3)) add(item, '非正面误接收边界')
  const profileDirectionMisses = cases.filter((item) => Math.abs(item.truthYaw) >= 45
    && !(Math.abs(item.predictedYaw) >= 35 && Math.sign(item.predictedYaw) === Math.sign(item.truthYaw)))
    .sort((left, right) => right.error - left.error)
  for (const item of profileDirectionMisses.slice(0, 4)) add(item, '侧面方向门失败')
  for (const item of [...cases].sort((left, right) => right.error - left.error).slice(0, 6)) add(item, '高误差案例')

  const axisStrata = [
    { key: 'truthPitch', label: '典型低头', min: -99, max: -15, center: -25 },
    { key: 'truthPitch', label: '典型抬头', min: 15, max: 99, center: 25 },
    { key: 'truthRoll', label: '典型负向侧倾', min: -99, max: -20, center: -30 },
    { key: 'truthRoll', label: '典型正向侧倾', min: 20, max: 99, center: 30 },
  ]
  for (const stratum of axisStrata) {
    const candidates = cases.filter((item) => item[stratum.key] >= stratum.min && item[stratum.key] <= stratum.max)
      .sort((left, right) => Math.abs(left[stratum.key] - stratum.center) - Math.abs(right[stratum.key] - stratum.center)
        || left.sourceName.localeCompare(right.sourceName))
    for (const item of candidates.slice(0, 2)) add(item, stratum.label)
  }
  for (const item of [...cases].sort((left, right) => right.pitchError - left.pitchError).slice(0, 3)) add(item, '俯仰高误差案例')
  for (const item of [...cases].sort((left, right) => right.rollError - left.rollError).slice(0, 3)) add(item, '侧倾高误差案例')
  const predictedJointFront = (item) => Math.abs(item.predictedYaw) <= 12
    && Math.abs(item.predictedPitch) <= 9 && Math.abs(item.predictedRoll) <= 12
  const pitchFalseAccepts = cases.filter((item) => Math.abs(item.truthYaw) <= 12
    && Math.abs(item.truthPitch) >= 15 && Math.abs(item.truthRoll) <= 15 && predictedJointFront(item))
    .sort((left, right) => right.pitchError - left.pitchError)
  for (const item of pitchFalseAccepts.slice(0, 3)) add(item, '俯仰误接收边界')
  const rollFalseAccepts = cases.filter((item) => Math.abs(item.truthYaw) <= 12
    && Math.abs(item.truthPitch) <= 10 && Math.abs(item.truthRoll) >= 20 && predictedJointFront(item))
    .sort((left, right) => right.rollError - left.rollError)
  for (const item of rollFalseAccepts.slice(0, 3)) add(item, '侧倾误接收边界')
  return selected
}

async function materializeManualReviewSet(cases) {
  const selected = selectManualReviewCases(cases)
  await mkdir(manualReviewStagingDir, { recursive: true })
  const manifestCases = []
  let index = 0
  for (const [item, reasons] of selected.entries()) {
    index += 1
    const anonymousId = `case_${String(index).padStart(3, '0')}`
    const outputName = `${anonymousId}.jpg`
    const destination = join(manualReviewStagingDir, outputName)
    await copyFile(item.sourcePath, destination)
    const bytes = await readFile(destination)
    manifestCases.push({
      anonymousId,
      image: outputName,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      groundTruthYawDegrees: round(item.truthYaw, 2),
      predictedYawDegrees: round(item.predictedYaw, 2),
      absoluteErrorDegrees: round(item.error, 2),
      groundTruthPitchDegrees: round(item.truthPitch, 2),
      predictedPitchDegrees: round(item.predictedPitch, 2),
      pitchAbsoluteErrorDegrees: round(item.pitchError, 2),
      groundTruthRollDegrees: round(item.truthRoll, 2),
      predictedRollDegrees: round(item.predictedRoll, 2),
      rollAbsoluteErrorDegrees: round(item.rollError, 2),
      selectionReasons: [...reasons],
    })
  }
  const reasonCounts = {}
  for (const item of manifestCases) for (const reason of item.selectionReasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1
  const manifest = {
    generatedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-LOCAL-MANUAL-REVIEW-1.0',
    source: 'AFLW2000-3D author-published cropped test set',
    purpose: 'Local developer manual review of typical three-axis pose coverage, production-threshold boundaries and model failures.',
    publicDistributionAllowed: false,
    appBundleIncluded: false,
    cases: manifestCases,
  }
  await writeFile(join(manualReviewStagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(manualReviewStagingDir, 'README.md'), [
    '# HeadUp AFLW2000 本地手测集',
    '',
    `共 ${manifestCases.length} 张匿名重命名图片；覆盖典型正面、斜侧、侧面、俯仰、侧倾、生产阈值边界和高误差案例。`,
    '',
    '- 仅供本机开发者手动测试，不进入 `public/`、APP构建或公开发布。',
    '- `manifest.json` 记录拟合姿态真值、当前WHENet预测、误差和入选理由。',
    '- 完整AFLW2000压缩包、其余图片、源文件名和未入选逐图预测均在基准结束后删除。',
    '- 若要刷新，请运行 `pnpm test:aflw2000-yaw-groundtruth`；刷新会原子替换本目录。',
    '',
  ].join('\n'))
  await rm(manualReviewDir, { recursive: true, force: true })
  await mkdir(resolve(manualReviewDir, '..'), { recursive: true })
  await rename(manualReviewStagingDir, manualReviewDir)
  return { images: manifestCases.length, reasonCounts }
}

ort.env.wasm.numThreads = 1
await rm(stagingDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
let aggregateResult

try {
  process.stdout.write('Downloading pinned AFLW2000-3D cropped test archive\n')
  await download(source.archive.url, archivePath)
  const archiveFingerprint = await verifyFile(archivePath, source.archive, 'AFLW2000 archive')
  process.stdout.write('Downloading pinned AFLW2000-3D fitted-yaw annotations\n')
  await download(source.yawAnnotations.url, yawPath)
  const annotationFingerprint = await verifyFile(yawPath, source.yawAnnotations, 'AFLW2000 yaw annotations')
  process.stdout.write('Downloading pinned AFLW2000-3D three-axis annotations\n')
  await download(source.threeAxisAnnotations.url, threeAxisPath)
  const threeAxisFingerprint = await verifyFile(threeAxisPath, source.threeAxisAnnotations, 'AFLW2000 three-axis annotations')

  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 8 * 1024 * 1024 })
  const entries = listing.split(/\r?\n/).filter(Boolean)
  if (entries.length !== source.archive.expectedEntries) throw new Error(`Archive entry count mismatch: ${entries.length}`)
  const unsafeEntry = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafeEntry) throw new Error(`Unsafe archive entry: ${unsafeEntry}`)
  await execFileAsync('tar.exe', [
    '-xf', archivePath, '-C', extractDir,
    'test.data/AFLW2000-3D_crop', 'test.data/AFLW2000-3D_crop.list',
  ], { maxBuffer: 2 * 1024 * 1024 })

  const imageDir = join(extractDir, 'test.data', 'AFLW2000-3D_crop')
  const cropList = (await readFile(join(extractDir, 'test.data', 'AFLW2000-3D_crop.list'), 'utf8'))
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  const extractedNames = (await readdir(imageDir)).filter((name) => /\.jpe?g$/i.test(name))
  if (cropList.length !== 2_000 || extractedNames.length !== 2_000 || new Set(cropList).size !== 2_000) {
    throw new Error(`Expected 2000 ordered AFLW2000 crops; list=${cropList.length}, files=${extractedNames.length}`)
  }
  if (cropList.some((name) => !/^image\d{5}\.jpg$/i.test(name) || !extractedNames.includes(name))) {
    throw new Error('AFLW2000 crop list and extracted files do not match')
  }

  const truthYaw = parseNpyFloat32(await readFile(yawPath))
  const threeAxisAnnotations = JSON.parse(await readFile(threeAxisPath, 'utf8'))
  const annotationNames = Object.keys(threeAxisAnnotations)
  const missingAnnotationNames = cropList.filter((name) => !Object.hasOwn(threeAxisAnnotations, name))
  const cropNameSet = new Set(cropList)
  const extraAnnotationNames = annotationNames.filter((name) => !cropNameSet.has(name))
  if (annotationNames.length !== source.threeAxisAnnotations.expectedCases || extraAnnotationNames.length) {
    throw new Error(`Three-axis annotation keys do not align with the 2000 ordered crops: missing=${JSON.stringify(missingAnnotationNames.slice(0, 10))}, extra=${JSON.stringify(extraAnnotationNames.slice(0, 10))}`)
  }
  if (missingAnnotationNames.length !== 2_000 - source.threeAxisAnnotations.expectedCases) {
    throw new Error(`Unexpected three-axis annotation coverage gap: ${missingAnnotationNames.length}`)
  }
  const yawBridgeDifferences = cropList.flatMap((name, index) => {
    if (!threeAxisAnnotations[name]) return []
    const pose = threeAxisAnnotations[name]?.pose
    if (!Array.isArray(pose) || pose.length !== 3 || pose.some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid three-axis pose for ${name}`)
    }
    return [Math.abs(pose[0] - truthYaw[index])]
  })
  const yawBridgeDifferenceDistribution = distribution(yawBridgeDifferences)
  if (yawBridgeDifferenceDistribution.median > 0.25) {
    throw new Error(`Three-axis/yaw annotation alignment is implausible: ${JSON.stringify(yawBridgeDifferenceDistribution)}`)
  }
  const poseModel = await readFile(poseModelPath)
  const poseModelSha256 = createHash('sha256').update(poseModel).digest('hex')
  if (poseModelSha256 !== expectedPoseModelSha256) throw new Error(`WHENet SHA-256 mismatch: ${poseModelSha256}`)
  const poseSession = await ort.InferenceSession.create(poseModel, { executionProviders: ['wasm'] })

  const cases = []
  for (const [index, name] of cropList.entries()) {
    const tensor = await makePoseTensor(join(imageDir, name))
    const outputs = await poseSession.run({ [poseSession.inputNames[0]]: tensor })
    const [predictedYaw, predictedRoll, predictedPitch] = Array.from(outputs[poseSession.outputNames[0]].data)
    const truth = truthYaw[index]
    const annotation = threeAxisAnnotations[name]
    const truthThreeAxisYaw = annotation?.pose?.[0] ?? null
    const truthPitch = annotation?.pose?.[1] ?? null
    const truthRoll = annotation?.pose?.[2] ?? null
    cases.push({
      sourceName: name,
      sourcePath: join(imageDir, name),
      truthYaw: truth,
      truthThreeAxisYaw,
      truthPitch,
      truthRoll,
      predictedYaw,
      predictedPitch,
      predictedRoll,
      error: circularAbsoluteError(predictedYaw, truth),
      pitchError: Number.isFinite(truthPitch) ? Math.abs(predictedPitch - truthPitch) : null,
      rollError: Number.isFinite(truthRoll) ? Math.abs(predictedRoll - truthRoll) : null,
    })
    if ((index + 1) % 200 === 0) process.stdout.write(`Processed ${index + 1}/2000 transient AFLW2000 crops\n`)
  }

  const conventionalSubset = cases.filter((item) => Math.abs(item.truthYaw) <= 99)
  const conventionalThreeAxisSubset = cases.filter((item) => Number.isFinite(item.truthThreeAxisYaw)
    && Number.isFinite(item.truthPitch) && Number.isFinite(item.truthRoll)
    && Math.abs(item.truthThreeAxisYaw) <= 99
    && Math.abs(item.truthPitch) <= 99 && Math.abs(item.truthRoll) <= 99)
    .map((item) => ({
      ...item,
      truthYaw: item.truthThreeAxisYaw,
      error: circularAbsoluteError(item.predictedYaw, item.truthThreeAxisYaw),
    }))
  const extremeAnnotationOutliers = cases.filter((item) => Math.abs(item.truthYaw) > 99)
  const bins = [
    { key: 'absolute_0_to_30', select: (item) => Math.abs(item.truthYaw) <= 30 },
    { key: 'absolute_30_to_60', select: (item) => Math.abs(item.truthYaw) > 30 && Math.abs(item.truthYaw) <= 60 },
    { key: 'absolute_60_to_99', select: (item) => Math.abs(item.truthYaw) > 60 && Math.abs(item.truthYaw) <= 99 },
  ]

  const conventional = summarizeYaw(conventionalSubset)
  const threeAxis = summarizeThreeAxis(conventionalThreeAxisSubset)
  const jointFrontGate = jointFrontGateDiagnostics(conventionalThreeAxisSubset)
  const jointFrontSensitivity = [
    { yaw: 12, pitch: 8, roll: 12 },
    { yaw: 12, pitch: 9, roll: 12 },
    { yaw: 12, pitch: 10, roll: 12 },
    { yaw: 13, pitch: 9, roll: 12 },
    { yaw: 12, pitch: 9, roll: 13 },
    { yaw: 12, pitch: 9, roll: 14 },
    { yaw: 13, pitch: 9, roll: 13 },
  ].map((thresholds) => jointFrontGateDiagnostics(conventionalThreeAxisSubset, thresholds))
  if (!jointFrontGate.truthFrontImages || !jointFrontGate.strongPitchInvalidImages || !jointFrontGate.strongRollInvalidImages) {
    throw new Error(`Three-axis gate cohort is empty: ${JSON.stringify(jointFrontGate)}`)
  }
  const manualReviewSet = await materializeManualReviewSet(conventionalThreeAxisSubset)
  const predeclaredGates = {
    yawMaeAtMost7Point11Degrees: conventional.absoluteErrorDegrees.mean <= 7.11,
    frontRecallAtLeastPoint90: thresholdDiagnostics(conventionalSubset, 12).frontRecall >= 0.9,
    strongNonFrontFalseAcceptAtMostPoint05: thresholdDiagnostics(conventionalSubset, 12).strongNonFrontFalseAcceptRate <= 0.05,
    strongProfileDirectionRecallAtLeastPoint90: thresholdDiagnostics(conventionalSubset, 12).profileDirectionRecall >= 0.9,
    wrongDirectionRateAtMostPoint02: conventional.wrongDirectionRate <= 0.02,
    pitchMaeAtMost8Point24Degrees: threeAxis.pitch.absoluteErrorDegrees.mean <= 8.24,
    rollMaeAtMost6Point92Degrees: threeAxis.roll.absoluteErrorDegrees.mean <= 6.92,
    jointFrontRecallAtLeastPoint85: jointFrontGate.truthFrontRecall >= 0.85,
    strongPitchFalseAcceptAtMostPoint05: jointFrontGate.strongPitchInvalidFalseAcceptRate <= 0.05,
    strongRollFalseAcceptAtMostPoint05: jointFrontGate.strongRollInvalidFalseAcceptRate <= 0.05,
  }

  aggregateResult = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-TRANSIENT-AFLW2000-THREE-AXIS-GT-2.1',
    source: {
      ...source,
      archive: { ...source.archive, ...archiveFingerprint },
      yawAnnotations: { ...source.yawAnnotations, ...annotationFingerprint },
      threeAxisAnnotations: { ...source.threeAxisAnnotations, ...threeAxisFingerprint },
    },
    protocol: {
      images: cases.length,
      threeAxisAnnotatedImages: annotationNames.length,
      threeAxisMissingImages: missingAnnotationNames.length,
      conventionalSubset: 'absolute fitted ground-truth yaw <= 99 degrees; reported for continuity with the prior yaw-only run',
      conventionalThreeAxisSubset: 'absolute fitted ground-truth yaw, pitch and roll are each <=99 degrees',
      predictionPreprocessing: 'exact HeadUp WHENet center-square crop, 224x224 resize, RGB CHW bytes',
      error: 'circular absolute yaw error and linear absolute pitch/roll error in degrees',
      gatePolicy: {
        yawMaeReference: 'WHENet paper reports 5.11 degrees on AFLW2000; diagnostic ceiling is reference + 2.00 = 7.11 degrees',
        frontRecall: '>= 90% for |GT yaw| <= 8 using production |predicted yaw| <= 12',
        strongNonFrontFalseAccept: '<= 5% for |GT yaw| >= 20 using production |predicted yaw| <= 12',
        strongProfileDirectionRecall: '>= 90% for |GT yaw| >= 45 using production |predicted yaw| >= 35 with correct sign',
        wrongDirectionRate: '<= 2% for |GT yaw| >= 35',
        pitchMaeReference: 'WHENet paper reports 6.24 degrees on AFLW2000; diagnostic ceiling is reference + 2.00 = 8.24 degrees',
        rollMaeReference: 'WHENet paper reports 4.92 degrees on AFLW2000; diagnostic ceiling is reference + 2.00 = 6.92 degrees',
        jointFrontRecall: '>=85% for strict three-axis truth-front captures',
        strongPitchAndRollFalseAccept: '<=5% for each strong invalid axis group',
      },
    },
    coverage: {
      images: cases.length,
      conventionalSubsetImages: conventionalSubset.length,
      conventionalThreeAxisSubsetImages: conventionalThreeAxisSubset.length,
      extremeAnnotationOutliers: extremeAnnotationOutliers.length,
      threeAxisAnnotationOutliers: cases.length - conventionalThreeAxisSubset.length,
      orderedCropsAndAnnotationsAligned: true,
      yawDifferenceBetweenPinned3DDFAAndDirectMHPAnnotations: yawBridgeDifferenceDistribution,
      yawAnnotationDifferencesOverPoint1Degrees: yawBridgeDifferences.filter((value) => value > 0.1).length,
      datasetDescription: '2000 AFLW images with fitted 3D yaw plus 1988 same-name DirectMHP three-axis annotations; unconstrained lighting, occlusion and pose',
    },
    model: { name: 'WHENet v1.0.4 pre/post ONNX', sha256: poseModelSha256 },
    allAnnotationsDiagnostic: summarizeYaw(cases),
    conventionalSubset: conventional,
    conventionalThreeAxisSubset: threeAxis,
    jointProductionFrontGate: jointFrontGate,
    jointProductionFrontSensitivity: jointFrontSensitivity,
    byGroundTruthYawBin: Object.fromEntries(bins.map((bin) => [bin.key, summarizeYaw(conventionalSubset.filter(bin.select))])),
    productionYawThreshold: thresholdDiagnostics(conventionalSubset, 12),
    thresholdSensitivity: [8, 10, 12, 15].map((threshold) => thresholdDiagnostics(conventionalSubset, threshold)),
    manualReviewSet: {
      localDirectory: 'data/manual-test/aflw2000-yaw-v1',
      images: manualReviewSet.images,
      selectionReasonCounts: manualReviewSet.reasonCounts,
      appBundleIncluded: false,
      publicDistributionAllowed: false,
    },
    predeclaredGates: {
      ...predeclaredGates,
      passed: Object.values(predeclaredGates).filter(Boolean).length,
      total: Object.keys(predeclaredGates).length,
      allPassed: Object.values(predeclaredGates).every(Boolean),
    },
    limitations: [
      'Yaw/pitch/roll are fitted 3D pose annotations, not independent goniometer measurements.',
      'The archive contains pre-cropped 120x120 faces, so it isolates pose estimation and does not represent product-resolution quality or full-frame face detection.',
      'AFLW2000 does not provide identity labels suitable for a subject-disjoint calibration/confirmation split; no production threshold is tuned from this result.',
      'Fitted 3D yaw is benchmark ground truth but not an independent manual goniometer measurement.',
      'This benchmark does not provide profile soft-tissue or neck landmark truth and therefore cannot validate HeadUp craniofacial geometry outputs.',
    ],
    retention: {
      imagesRetained: true,
      retainedImageCount: manualReviewSet.images,
      retainedImagePurpose: 'local developer manual testing only',
      archivesRetained: false,
      fileNamesRetained: false,
      individualPredictionsRetained: true,
      individualPredictionsScope: 'retained manual-review subset only',
      fullAnnotationsRetained: false,
      manualSubsetAnnotationsRetained: true,
      aggregateBenchmarkResultOnly: true,
      manualSubsetHasIndividualRecords: true,
    },
  }
  await writeFile(resultPath, `${JSON.stringify(aggregateResult, null, 2)}\n`)
} finally {
  const resolved = resolve(stagingDir)
  if (!resolved.startsWith(allowedStagingRoot)) throw new Error(`Refusing cleanup outside staging: ${resolved}`)
  await rm(resolved, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({
  testedAt: aggregateResult.testedAt,
  coverage: aggregateResult.coverage,
  conventionalSubset: aggregateResult.conventionalSubset,
  conventionalThreeAxisSubset: aggregateResult.conventionalThreeAxisSubset,
  jointProductionFrontGate: aggregateResult.jointProductionFrontGate,
  productionYawThreshold: aggregateResult.productionYawThreshold,
  predeclaredGates: aggregateResult.predeclaredGates,
  retention: aggregateResult.retention,
  resultPath,
}, null, 2)}\n`)
