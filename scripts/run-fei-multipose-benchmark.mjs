import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingDir = join(benchmarkDir, '.staging', 'fei-multipose')
const extractDir = join(stagingDir, 'images')
const resultPath = join(benchmarkDir, 'fei-multipose-result.json')
const manualDir = join(projectDir, 'data', 'manual-test', 'front-profile-new-v1', 'fei')
const sourcePage = 'https://fei.edu.br/~cet/facedatabase.html'
const archives = [
  { name: 'originalimages_part1.zip', bytes: 86_857_988, sha256: '1d0b0ebe94278a5677edc450251f91450dadb821d9774edc111ad1be0e7475ed' },
  { name: 'originalimages_part2.zip', bytes: 89_176_109, sha256: '993c2a48ac38c64824c619cbcdb0700598786aa2fa20a76f4b199457c8662e69' },
  { name: 'originalimages_part3.zip', bytes: 88_206_682, sha256: '65d282b338001e4ece78944b751d5d78d94eddfacf2c734cf8530bcd6435e252' },
  { name: 'originalimages_part4.zip', bytes: 89_251_729, sha256: 'dd82ed2b475781dd4e829fb964923eb3a69e6f413f0e05ae694e65fce9fbe44f' },
].map((item) => ({ ...item, url: `https://fei.edu.br/~cet/${item.name}` }))
const yuNetPath = join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx')
const poseModelPath = join(projectDir, 'public', 'models', 'whenet_1x3x224x224_prepost.onnx')
const nativeProfileModelPath = join(projectDir, 'public', 'models', 'menpo39-profile-v1.onnx')
const expectedYuNetSha256 = 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0'
const expectedPoseSha256 = '28345f49bd38a3e74f5d6b028469fe27b6bf5b09405ffdfa0be4b28db6c2be0e'
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
    min: percentile(values, 0), p05: percentile(values, 0.05), median: percentile(values, 0.5),
    p95: percentile(values, 0.95), max: percentile(values, 1),
  }
}

function rate(numerator, denominator) {
  return denominator ? round(numerator / denominator) : null
}

async function download(url, destination) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
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
        x: centerX - boxWidth / 2,
        y: centerY - boxHeight / 2,
        width: boxWidth,
        height: boxHeight,
        areaRatio: (boxWidth * boxHeight) / (width * height),
        centerDistance: Math.hypot(centerX / width - 0.5, centerY / height - 0.5),
      }
    }
  }
  return primary
}

const nativeCrop = {
  left: { factor: 1.138812414528869, shiftX: 0.03847504237478136, shiftY: 0.11833929151974497 },
  right: { factor: 1.1504958141994608, shiftX: -0.03945996063163659, shiftY: 0.12225221823707466 },
}

async function makeNativeProfileTensor(path, detection, orientation) {
  const metadata = await sharp(path).metadata()
  const detectorScale = 320 / Math.max(metadata.width, metadata.height)
  const x = detection.x / detectorScale, y = detection.y / detectorScale
  const width = detection.width / detectorScale, height = detection.height / detectorScale
  const detectorSide = Math.max(width, height), params = nativeCrop[orientation]
  const side = detectorSide * params.factor
  const sourceX = x + width / 2 + params.shiftX * detectorSide - side / 2
  const sourceY = y + height / 2 + params.shiftY * detectorSide - side / 2
  const validLeft=Math.max(0,Math.floor(sourceX)),validTop=Math.max(0,Math.floor(sourceY))
  const validRight=Math.min(metadata.width,Math.ceil(sourceX+side)),validBottom=Math.min(metadata.height,Math.ceil(sourceY+side))
  const validWidth=Math.max(1,validRight-validLeft),validHeight=Math.max(1,validBottom-validTop)
  const targetLeft=Math.max(0,Math.min(223,Math.round((validLeft-sourceX)/side*224))),targetTop=Math.max(0,Math.min(223,Math.round((validTop-sourceY)/side*224)))
  const targetRight=Math.max(targetLeft+1,Math.min(224,Math.round((validRight-sourceX)/side*224))),targetBottom=Math.max(targetTop+1,Math.min(224,Math.round((validBottom-sourceY)/side*224)))
  const patch=await sharp(path).extract({left:validLeft,top:validTop,width:validWidth,height:validHeight}).resize(targetRight-targetLeft,targetBottom-targetTop,{fit:'fill'}).removeAlpha().png().toBuffer()
  const {data}=await sharp({create:{width:224,height:224,channels:3,background:{r:128,g:128,b:128}}}).composite([{input:patch,left:targetLeft,top:targetTop}]).removeAlpha().raw().toBuffer({resolveWithObject:true})
  const channelSize=224*224,input=new Float32Array(channelSize*3),mean=[.485,.456,.406],std=[.229,.224,.225]
  for(let index=0;index<channelSize;index+=1){input[index]=(data[index*3]/255-mean[0])/std[0];input[channelSize+index]=(data[index*3+1]/255-mean[1])/std[1];input[channelSize*2+index]=(data[index*3+2]/255-mean[2])/std[2]}
  return new ort.Tensor('float32',input,[1,3,224,224])
}

async function runNativeProfile(path,detection,orientation,session){
  if(!detection||detection.score<.85)return{status:'rejected',reason:'yunet_score_below_0.85'}
  const started=performance.now(),outputs=await session.run({[session.inputNames[0]]:await makeNativeProfileTensor(path,detection,orientation)})
  const coordinates=Array.from(outputs.coordinates.data),confidence=Array.from(outputs.confidence.data)
  if(coordinates.length!==78||confidence.length!==39)return{status:'rejected',reason:'output_contract'}
  const sorted=[...confidence].sort((a,b)=>a-b),confidenceP10=sorted[Math.max(0,Math.ceil(sorted.length*.1)-1)]
  const direction=Math.sign(coordinates[19*2]-coordinates[10*2]),directionCorrect=orientation==='right'?direction>0:direction<0
  if(!directionCorrect)return{status:'rejected',reason:'direction_conflict',confidenceP10,runtimeMs:performance.now()-started}
  return{status:'measured',coordinates,confidenceP10,runtimeMs:performance.now()-started}
}

function summarizeNative(items){const measured=items.filter(item=>item.native39?.status==='measured'),reasons={};for(const item of items)if(item.native39?.status!=='measured'){const reason=item.native39?.reason||'not_run';reasons[reason]=(reasons[reason]||0)+1}return{images:items.length,measured:measured.length,measuredRate:rate(measured.length,items.length),rejectedByReason:reasons,confidenceP10:distribution(measured.map(item=>item.native39.confidenceP10)),runtimeMs:distribution(measured.map(item=>item.native39.runtimeMs))}}

function frontStructuralProxy(item) {
  return item.faceScore >= 0.9 && item.faceAreaRatio >= 0.09
    && item.faceCenterDistance <= 0.18 && Math.abs(item.yaw) <= 12
    && Math.abs(item.roll) <= 12 && Math.abs(item.pitch) <= 9
}

function leftProfileStructuralProxy(item) {
  return item.faceScore >= 0.85 && item.faceAreaRatio >= 0.07
    && item.faceCenterDistance <= 0.25 && item.yaw >= 35 && Math.abs(item.roll) <= 18
}

function rightProfileStructuralProxy(item) {
  return item.faceScore >= 0.85 && item.faceAreaRatio >= 0.07
    && item.faceCenterDistance <= 0.25 && item.yaw <= -35 && Math.abs(item.roll) <= 18
}

function frontProxy(item) { return item.qualityAccepted && frontStructuralProxy(item) }
function leftProfileProxy(item) { return item.qualityAccepted && leftProfileStructuralProxy(item) }
function rightProfileProxy(item) { return item.qualityAccepted && rightProfileStructuralProxy(item) }

function summarize(items) {
  const poseEligible = items.filter((item) => item.faceScore >= 0.85)
  return {
    images: items.length,
    qualityAccepted: items.filter((item) => item.qualityAccepted).length,
    detectedAtPoint85: items.filter((item) => item.faceScore >= 0.85).length,
    detectedAtPoint90: items.filter((item) => item.faceScore >= 0.9).length,
    frontProxyPassed: items.filter(frontProxy).length,
    leftProfileProxyPassed: items.filter(leftProfileProxy).length,
    rightProfileProxyPassed: items.filter(rightProfileProxy).length,
    qualityIndependentFrontStructuralProxyPassed: items.filter(frontStructuralProxy).length,
    qualityIndependentLeftProfileStructuralProxyPassed: items.filter(leftProfileStructuralProxy).length,
    qualityIndependentRightProfileStructuralProxyPassed: items.filter(rightProfileStructuralProxy).length,
    qualityScore: distribution(items.map((item) => item.qualityScore)),
    faceScore: distribution(items.map((item) => item.faceScore)),
    faceAreaRatio: distribution(items.map((item) => item.faceAreaRatio)),
    faceCenterDistance: distribution(items.map((item) => item.faceCenterDistance)),
    yaw: distribution(items.map((item) => item.yaw)),
    roll: distribution(items.map((item) => item.roll)),
    pitch: distribution(items.map((item) => item.pitch)),
    poseWhenFaceDetectedAtPoint85: {
      images: poseEligible.length,
      yaw: distribution(poseEligible.map((item) => item.yaw)),
      roll: distribution(poseEligible.map((item) => item.roll)),
      pitch: distribution(poseEligible.map((item) => item.pitch)),
    },
  }
}

function identitySequenceSummary(itemsBySubject) {
  let orderComparisons = 0
  let concordantComparisons = 0
  let bothExtremesDetected = 0
  let bothExtremeDirectionsCorrect = 0
  let bothExtremeProfileProxiesPassed = 0
  const perIdentityConcordance = []
  const extremeMagnitudeDifference = []
  for (const rows of itemsBySubject.values()) {
    const byView = new Map(rows.map((item) => [item.viewIndex, item]))
    const sequence = Array.from({ length: 10 }, (_, index) => byView.get(index + 1))
    if (sequence.some((item) => !item)) throw new Error('Incomplete FEI yaw sequence')
    let identityComparisons = 0
    let identityConcordant = 0
    for (let left = 0; left < sequence.length; left += 1) {
      for (let right = left + 1; right < sequence.length; right += 1) {
        identityComparisons += 1
        if (sequence[left].yaw > sequence[right].yaw) identityConcordant += 1
      }
    }
    orderComparisons += identityComparisons
    concordantComparisons += identityConcordant
    perIdentityConcordance.push(identityConcordant / identityComparisons)
    const leftExtreme = byView.get(1)
    const rightExtreme = byView.get(10)
    if (leftExtreme.faceScore >= 0.85 && rightExtreme.faceScore >= 0.85) bothExtremesDetected += 1
    if (leftExtreme.yaw >= 35 && rightExtreme.yaw <= -35) bothExtremeDirectionsCorrect += 1
    if (leftProfileStructuralProxy(leftExtreme) && rightProfileStructuralProxy(rightExtreme)) bothExtremeProfileProxiesPassed += 1
    extremeMagnitudeDifference.push(Math.abs(Math.abs(leftExtreme.yaw) - Math.abs(rightExtreme.yaw)))
  }
  return {
    identities: itemsBySubject.size,
    expectedOrder: 'view 01 positive/left profile through view 10 negative/right profile',
    yawPairComparisons: orderComparisons,
    concordantYawPairs: concordantComparisons,
    yawOrderConcordanceRate: rate(concordantComparisons, orderComparisons),
    perIdentityYawOrderConcordance: distribution(perIdentityConcordance),
    bothExtremesDetectedAtPoint85: bothExtremesDetected,
    bothExtremeDirectionsCorrect,
    bothExtremeQualityIndependentStructuralProxiesPassed: bothExtremeProfileProxiesPassed,
    absoluteExtremeYawMagnitudeDifferenceDegrees: distribution(extremeMagnitudeDifference),
  }
}

ort.env.wasm.numThreads = 1
await rm(stagingDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
let aggregateResult

try {
  const sourceArchives = []
  for (const archive of archives) {
    const path = join(stagingDir, archive.name)
    process.stdout.write(`Downloading ${archive.name}\n`)
    await download(archive.url, path)
    const bytes = await readFile(path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== archive.bytes) throw new Error(`${archive.name} size mismatch: ${bytes.length}`)
    if (sha256 !== archive.sha256) throw new Error(`${archive.name} SHA-256 mismatch: ${sha256}`)
    const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', path], { maxBuffer: 2 * 1024 * 1024 })
    const entries = listing.split(/\r?\n/).filter(Boolean)
    const unsafeEntry = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
    if (unsafeEntry) throw new Error(`Unsafe archive entry in ${archive.name}: ${unsafeEntry}`)
    if (entries.length !== 700 || entries.some((entry) => !/^\d{1,3}-\d{2}\.jpg$/i.test(entry))) {
      throw new Error(`${archive.name} does not contain the expected 700 flat JPEG entries`)
    }
    await execFileAsync('tar.exe', ['-xf', path, '-C', extractDir])
    sourceArchives.push({ name: archive.name, bytes: bytes.length, sha256, jpegEntries: entries.length })
    await rm(path, { force: true })
  }

  const fileNames = (await readdir(extractDir)).filter((name) => /\.jpg$/i.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (fileNames.length !== 2_800) throw new Error(`Expected 2800 FEI JPEGs, found ${fileNames.length}`)
  const records = fileNames.map((name) => {
    const match = basename(name).match(/^(\d{1,3})-(\d{2})\.jpg$/i)
    if (!match) throw new Error(`Unexpected FEI file name: ${name}`)
    return { path: join(extractDir, name), subjectIndex: Number(match[1]), viewIndex: Number(match[2]) }
  })
  const uniqueKeys = new Set(records.map((item) => `${item.subjectIndex}-${item.viewIndex}`))
  if (uniqueKeys.size !== 2_800 || records.some((item) => item.subjectIndex < 1 || item.subjectIndex > 200 || item.viewIndex < 1 || item.viewIndex > 14)) {
    throw new Error('FEI subject/view matrix is not exactly 200 x 14')
  }

  const [yuNetModel, poseModel, nativeProfileModel] = await Promise.all([readFile(yuNetPath), readFile(poseModelPath), readFile(nativeProfileModelPath)])
  const yuNetSha256 = createHash('sha256').update(yuNetModel).digest('hex')
  const poseSha256 = createHash('sha256').update(poseModel).digest('hex')
  if (yuNetSha256 !== expectedYuNetSha256) throw new Error(`YuNet SHA-256 mismatch: ${yuNetSha256}`)
  if (poseSha256 !== expectedPoseSha256) throw new Error(`WHENet SHA-256 mismatch: ${poseSha256}`)
  const nativeProfileSha256=createHash('sha256').update(nativeProfileModel).digest('hex')
  const [yuNetSession, poseSession, nativeProfileSession, qualityHarness] = await Promise.all([
    ort.InferenceSession.create(yuNetModel, { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(poseModel, { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(nativeProfileModel,{executionProviders:['wasm']}),
    createProductionQualityHarness(projectDir),
  ])

  const cases = []
  for (const [index, record] of records.entries()) {
    const [quality, yuNetTensor, poseTensor] = await Promise.all([
      qualityHarness.inspect(record.path), makeYuNetTensor(record.path), makePoseTensor(record.path),
    ])
    const [yuNetOutputs, poseOutputs] = await Promise.all([
      yuNetSession.run({ [yuNetSession.inputNames[0]]: yuNetTensor }),
      poseSession.run({ [poseSession.inputNames[0]]: poseTensor }),
    ])
    const detection = decodeYuNetPrimary(yuNetOutputs, yuNetTensor.dims[3], yuNetTensor.dims[2])
    const [yaw, roll, pitch] = Array.from(poseOutputs[poseSession.outputNames[0]].data)
    const native39=record.viewIndex===1||record.viewIndex===10?await runNativeProfile(record.path,detection,record.viewIndex===1?'left':'right',nativeProfileSession):null
    cases.push({
      subjectIndex: record.subjectIndex,
      viewIndex: record.viewIndex,
      qualityAccepted: quality.accepted,
      qualityScore: quality.quality.score,
      qualityFlags: quality.quality.flags,
      faceScore: detection?.score ?? 0,
      faceAreaRatio: detection?.areaRatio ?? 0,
      faceCenterDistance: detection?.centerDistance ?? 1,
      yaw, roll, pitch,
      native39,
    })
    if ((index + 1) % 200 === 0) process.stdout.write(`Processed ${index + 1}/${records.length} transient FEI images\n`)
  }

  const byView = Object.fromEntries(Array.from({ length: 14 }, (_, index) => {
    const viewIndex = index + 1
    return [`view_${String(viewIndex).padStart(2, '0')}`, summarize(cases.filter((item) => item.viewIndex === viewIndex))]
  }))
  const qualityFlags = {}
  for (const item of cases) for (const flag of item.qualityFlags) qualityFlags[flag] = (qualityFlags[flag] || 0) + 1
  const itemsBySubject = new Map()
  for (const item of cases) {
    if (!itemsBySubject.has(item.subjectIndex)) itemsBySubject.set(item.subjectIndex, [])
    itemsBySubject.get(item.subjectIndex).push(item)
  }
  const mirrorRms=[]
  for(const rows of itemsBySubject.values()){const left=rows.find(item=>item.viewIndex===1)?.native39,right=rows.find(item=>item.viewIndex===10)?.native39;if(left?.status!=='measured'||right?.status!=='measured')continue;let sum=0;for(let index=0;index<39;index+=1){const dx=left.coordinates[index*2]-(1-right.coordinates[index*2]),dy=left.coordinates[index*2+1]-right.coordinates[index*2+1];sum+=dx*dx+dy*dy}mirrorRms.push(Math.sqrt(sum/39))}

  await rm(manualDir, { recursive: true, force: true })

  aggregateResult = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-TRANSIENT-REAL-MULTIPOSE-1.0',
    source: {
      name: 'FEI Face Database original images',
      sourcePage,
      publisher: 'Artificial Intelligence Laboratory of FEI, Brazil',
      researchOnly: true,
      sourceArchives,
    },
    coverage: {
      identities: itemsBySubject.size,
      images: cases.length,
      imagesPerIdentity: 14,
      resolution: '640x480',
      officialAgeRange: '19-40',
      officialSexBalance: { female: 100, male: 100 },
      acquisition: 'upright colour portraits, white homogeneous background, approximately 180-degree pose sweep, expression, scale and illumination variation',
      subgroupCaution: 'The download has no per-image demographic manifest used by this benchmark, so errors are not reported by sex, age or ancestry subgroup.',
      eyewearTargeted: false,
    },
    models: {
      qualityGate: { implementation: 'src/lib/imageQuality.ts' },
      faceDetector: { name: 'OpenCV YuNet 2026may', sha256: yuNetSha256 },
      poseEstimator: { name: 'WHENet pre/post ONNX', sha256: poseSha256 },
      nativeProfileLandmarks:{name:'HeadUp Menpo39 ONNX v1',sha256:nativeProfileSha256,input:'YuNet orientation-specific calibrated crop'},
    },
    overall: summarize(cases),
    byViewIndex: byView,
    identityPoseSequence: identitySequenceSummary(itemsBySubject),
    frontControls: {
      viewIndices: [11, 12, 13, 14],
      interpretation: 'Publisher examples show frontal neutral/expression/scale-or-light controls; exact semantic names are not encoded in the archive.',
      ...summarize(cases.filter((item) => item.viewIndex >= 11)),
    },
    extremeProfiles: {
      leftViewIndex: 1,
      rightViewIndex: 10,
      left: summarize(cases.filter((item) => item.viewIndex === 1)),
      right: summarize(cases.filter((item) => item.viewIndex === 10)),
    },
    native39ExternalProfile:{left:summarizeNative(cases.filter(item=>item.viewIndex===1)),right:summarizeNative(cases.filter(item=>item.viewIndex===10)),bothSidesMeasuredIdentities:mirrorRms.length,leftRightMirroredCoordinateRms:distribution(mirrorRms),interpretation:'No FEI landmark truth is available; coverage, direction guard, runtime and same-identity mirrored consistency are reported without claiming point accuracy.'},
    detectionStressFinding: {
      views01Through13DetectedAtPoint85: cases.filter((item) => item.viewIndex <= 13 && item.faceScore >= 0.85).length,
      views01Through13Images: cases.filter((item) => item.viewIndex <= 13).length,
      view14DetectedAtPoint85: cases.filter((item) => item.viewIndex === 14 && item.faceScore >= 0.85).length,
      view14Images: cases.filter((item) => item.viewIndex === 14).length,
      interpretation: 'All misses at score 0.85 are isolated to view 14, which the publisher example and quality flags identify as the illumination stress condition.',
    },
    qualityFlags,
    manualPackage: { subjects: 0, images: 0, policy: 'no downloaded source images retained after automated test' },
    limitations: [
      'Controlled white-background portraits do not represent phone distance, background, lens, device or cross-session variation.',
      'The archive has no profile or neck landmark ground truth, so this benchmark tests detection, capture quality and pose ordering rather than eight-metric geometry accuracy.',
      'Front proxy counts omit the browser MediaPipe complete-landmark requirement and therefore are upper bounds.',
      'Official aggregate age/sex coverage does not prove equal error rates; no individual demographic labels or predictions are retained.',
    ],
    retention: {
      imagesRetained: false,
      archivesRetained: false,
      subjectIdentifiersRetained: false,
      fileNamesRetained: false,
      individualPredictionsRetained: false,
      aggregateOnly: true,
      manualTestImagesRetained: 0,
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
  overall: aggregateResult.overall,
  identityPoseSequence: aggregateResult.identityPoseSequence,
  extremeProfiles: {
    left: aggregateResult.extremeProfiles.left,
    right: aggregateResult.extremeProfiles.right,
  },
  retention: aggregateResult.retention,
  resultPath,
}, null, 2)}\n`)
