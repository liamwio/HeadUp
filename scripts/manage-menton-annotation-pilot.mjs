import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { featureRangeCoverage, selectStratifiedPilot } from './lib/menton-pilot-selection.mjs'

const execFileAsync = promisify(execFile)
const command = process.argv[2]
if (!['prepare', 'status', 'cleanup'].includes(command)) {
  throw new Error('usage: node manage-menton-annotation-pilot.mjs prepare|status|cleanup')
}

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'menton-annotation-pilot')
const sourceDir = join(stagingDir, 'source')
const batchDir = join(stagingDir, 'batch')
const manifestPath = join(stagingDir, 'pilot-manifest.json')
const markerPath = join(stagingDir, '.headup-transient-menton-pilot.json')
const resultPath = join(benchmarkDir, 'menton-annotation-pilot-selection-result.json')
const markerContract = 'HEADUP-TRANSIENT-MENTON-PILOT-1.0'
const allowedRoot = resolve(stagingRoot) + sep
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe pilot staging path')

const archives = [
  { name: 'originalimages_part1.zip', bytes: 86_857_988, sha256: '1d0b0ebe94278a5677edc450251f91450dadb821d9774edc111ad1be0e7475ed' },
  { name: 'originalimages_part2.zip', bytes: 89_176_109, sha256: '993c2a48ac38c64824c619cbcdb0700598786aa2fa20a76f4b199457c8662e69' },
  { name: 'originalimages_part3.zip', bytes: 88_206_682, sha256: '65d282b338001e4ece78944b751d5d78d94eddfacf2c734cf8530bcd6435e252' },
  { name: 'originalimages_part4.zip', bytes: 89_251_729, sha256: 'dd82ed2b475781dd4e829fb964923eb3a69e6f413f0e05ae694e65fce9fbe44f' },
].map((item) => ({ ...item, url: `https://fei.edu.br/~cet/${item.name}` }))

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function sha256File(path) {
  return sha256Buffer(await readFile(path))
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

async function download(url, destination) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Menton-Pilot/1.0',
    '--output', destination, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

async function safeEntries(path) {
  const { stdout } = await execFileAsync('tar.exe', ['-tf', path], { maxBuffer: 2 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\')
    || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe FEI archive entry: ${unsafe}`)
  return entries
}

async function imageMetrics(path) {
  const { data, info } = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== 640 || info.height !== 480 || info.channels !== 1) {
    throw new Error(`Unexpected FEI image contract: ${info.width}x${info.height}x${info.channels}`)
  }
  let sum = 0
  let sumSquares = 0
  let gradient = 0
  let gradientEdges = 0
  const histogram = new Uint32Array(256)
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const index = y * info.width + x
      const value = data[index]
      sum += value
      sumSquares += value * value
      histogram[value]++
      if (x > 0) { gradient += Math.abs(value - data[index - 1]); gradientEdges++ }
      if (y > 0) { gradient += Math.abs(value - data[index - info.width]); gradientEdges++ }
    }
  }
  const count = info.width * info.height
  const mean = sum / count
  const variance = Math.max(0, sumSquares / count - mean * mean)
  let entropy = 0
  for (const frequency of histogram) {
    if (!frequency) continue
    const probability = frequency / count
    entropy -= probability * Math.log2(probability)
  }
  return {
    width: info.width,
    height: info.height,
    brightness: mean / 255,
    contrast: Math.sqrt(variance) / 128,
    edgeSharpness: gradient / Math.max(1, gradientEdges) / 255,
    entropy,
  }
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits))
}

function roundedFeatureCoverage(coverage) {
  return Object.fromEntries(Object.entries(coverage).map(([name, item]) => [name, {
    full: Object.fromEntries(Object.entries(item.full).map(([key, value]) => [key, value === null ? null : round(value)])),
    selected: Object.fromEntries(Object.entries(item.selected).map(([key, value]) => [key, value === null ? null : round(value)])),
    rangeCoverage: round(item.rangeCoverage, 4),
  }]))
}

async function verifyMarker() {
  if (!(await exists(markerPath))) throw new Error('Pilot marker missing; refusing lifecycle operation')
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  if (marker.contract !== markerContract || marker.stagingRole !== 'transient_annotation_pilot') {
    throw new Error('Pilot marker contract mismatch')
  }
  return marker
}

async function verifyBatch() {
  await verifyMarker()
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 'headup.menton-annotation-pilot.v1'
    || manifest.trainingUseAllowed !== false || manifest.images.length !== 120) {
    throw new Error('Pilot manifest contract mismatch')
  }
  const files = (await readdir(batchDir)).filter((name) => /\.jpg$/i.test(name)).sort()
  if (files.length !== 120) throw new Error(`Pilot batch file count mismatch: ${files.length}`)
  let hashFailures = 0
  for (const item of manifest.images) {
    const path = join(batchDir, item.anonymousFile)
    if (!(await exists(path)) || await sha256File(path) !== item.sha256) hashFailures++
  }
  return { manifest, files, hashFailures }
}

async function updateResultAfterCleanup(cleanup) {
  if (!(await exists(resultPath))) return
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  result.retention = {
    ...result.retention,
    pilotBatchPresent: false,
    mustRunCleanup: false,
    imagesRetainedAfterCleanup: false,
    manifestRetainedAfterCleanup: false,
    cleanupVerified: cleanup.hashFailures === 0 && cleanup.images === 120,
    cleanedAt: new Date().toISOString(),
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
}

async function prepare() {
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(sourceDir, { recursive: true })
  await mkdir(batchDir, { recursive: true })
  try {
    const sourceArchives = []
    for (const archive of archives) {
      const path = join(stagingDir, archive.name)
      process.stdout.write(`Downloading ${archive.name}\n`)
      await download(archive.url, path)
      const bytes = await readFile(path)
      const hash = sha256Buffer(bytes)
      if (bytes.length !== archive.bytes || hash !== archive.sha256) {
        throw new Error(`${archive.name} fixed transport mismatch: ${bytes.length}, ${hash}`)
      }
      const entries = await safeEntries(path)
      if (entries.length !== 700 || entries.some((entry) => !/^\d{1,3}-\d{2}\.jpg$/i.test(entry))) {
        throw new Error(`${archive.name} entry contract mismatch`)
      }
      await execFileAsync('tar.exe', ['-xf', path, '-C', sourceDir])
      sourceArchives.push({ name: archive.name, bytes: bytes.length, sha256: hash, jpegEntries: entries.length })
      await rm(path, { force: true })
    }
    const fileNames = (await readdir(sourceDir)).filter((name) => /\.jpg$/i.test(name))
    if (fileNames.length !== 2_800) throw new Error(`Expected 2800 FEI images, found ${fileNames.length}`)
    const subjects = []
    for (let subjectIndex = 1; subjectIndex <= 200; subjectIndex++) {
      const leftPath = join(sourceDir, `${subjectIndex}-01.jpg`)
      const rightPath = join(sourceDir, `${subjectIndex}-10.jpg`)
      const [left, right] = await Promise.all([imageMetrics(leftPath), imageMetrics(rightPath)])
      const features = [
        (left.brightness + right.brightness) / 2,
        (left.contrast + right.contrast) / 2,
        (left.edgeSharpness + right.edgeSharpness) / 2,
        Math.abs(left.brightness - right.brightness),
        Math.abs(left.edgeSharpness - right.edgeSharpness),
      ]
      subjects.push({
        subjectIndex,
        features,
        tiebreaker: sha256Buffer(Buffer.from(`HeadUp-FEI-Menton-Pilot-V1/${subjectIndex}`)),
        left,
        right,
      })
    }
    const selected = selectStratifiedPilot(subjects)
      .sort((a, b) => a.tiebreaker.localeCompare(b.tiebreaker))
    const coverage = roundedFeatureCoverage(featureRangeCoverage(subjects, selected))
    const images = []
    for (const [index, subject] of selected.entries()) {
      const anonymousPair = `pilot_${String(index + 1).padStart(3, '0')}`
      for (const view of [
        { suffix: 'left', source: `${subject.subjectIndex}-01.jpg`, direction: 'left' },
        { suffix: 'right', source: `${subject.subjectIndex}-10.jpg`, direction: 'right' },
      ]) {
        const anonymousFile = `${anonymousPair}_${view.suffix}.jpg`
        const sourcePath = join(sourceDir, view.source)
        const destination = join(batchDir, anonymousFile)
        await copyFile(sourcePath, destination)
        images.push({
          anonymousPair,
          anonymousFile,
          direction: view.direction,
          width: 640,
          height: 480,
          sha256: await sha256File(destination),
        })
      }
    }
    const quartileCounts = Object.fromEntries([1, 2, 3, 4].map((quartile) => [String(quartile), selected.filter((item) => item.quartile === quartile).length]))
    const gates = {
      selectedExactly60Identities: selected.length === 60,
      selectedExactly120Images: images.length === 120,
      eachDirectionHas60Images: images.filter((item) => item.direction === 'left').length === 60
        && images.filter((item) => item.direction === 'right').length === 60,
      eachSubjectQuartileHas15Identities: Object.values(quartileCounts).every((value) => value === 15),
      everyImageIs640x480: images.every((item) => item.width === 640 && item.height === 480),
      eachVisualFeatureCoversAtLeast80PercentOfFullRange: Object.values(coverage).every((item) => item.rangeCoverage >= 0.8),
    }
    if (!Object.values(gates).every(Boolean)) throw new Error(`Pilot selection gates failed: ${JSON.stringify(gates)}`)
    const createdAt = new Date().toISOString()
    const manifest = {
      schemaVersion: 'headup.menton-annotation-pilot.v1',
      policyVersion: markerContract,
      createdAt,
      purpose: 'A/B annotation workflow rehearsal only; not canonical truth and not training data',
      trainingUseAllowed: false,
      source: { name: 'FEI Face Database extreme views 01/10', sourceArchives },
      selection: {
        identities: 60,
        images: 120,
        directions: { left: 60, right: 60 },
        identityQuartiles: quartileCounts,
        method: '15 identities per numeric subject quartile; deterministic maximin over paired brightness, contrast, edge sharpness and left/right differences',
      },
      images,
      requiredAction: 'Use the same 120 files for independent A and B sessions, then run cleanup immediately after JSON export.',
      retention: { transientBatch: true, deleteAfterPilot: true, publicDistributionAllowed: false },
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(markerPath, `${JSON.stringify({ contract: markerContract, stagingRole: 'transient_annotation_pilot', createdAt }, null, 2)}\n`)
    await writeFile(join(stagingDir, 'README.txt'), [
      'HeadUp menton annotation workflow pilot — NOT TRAINING DATA',
      `1. Open http://127.0.0.1:4175/research/pages/research-menton-annotation.html`,
      `2. A and B independently select all JPG files in: ${batchDir}`,
      '3. Export both session JSON files, compare, and complete any blind adjudication.',
      '4. Run: pnpm research:cleanup-menton-annotation-pilot',
    ].join('\r\n'))
    await rm(sourceDir, { recursive: true, force: true })
    const result = {
      testedAt: createdAt,
      policyVersion: 'HEADUP-MENTON-ANNOTATION-PILOT-SELECTION-1.0',
      source: { name: 'FEI Face Database original images', sourceArchives },
      role: 'annotation workflow rehearsal only; not canonical truth, model validation or training data',
      coverage: {
        sourceIdentities: 200,
        selectedIdentities: 60,
        selectedImages: 120,
        directions: { left: 60, right: 60 },
        identityQuartiles: quartileCounts,
        resolution: '640x480 below product gate',
        visualFeatureRangeCoverage: coverage,
      },
      predeclaredSelectionGates: gates,
      allSelectionGatesPass: true,
      limitations: [
        'Controlled white-background FEI images are not product-camera canonical truth.',
        '640x480 is below the product resolution gate.',
        'Numeric identity quartiles spread publisher numbering but do not prove demographic subgroup balance.',
        'The batch tests annotation workflow and inter-annotator consistency only.',
      ],
      retention: {
        pilotBatchPresent: true,
        imagesRetainedTemporarily: true,
        sourceExtractionRetained: false,
        individualIdentifiersInAggregate: false,
        individualHashesInAggregate: false,
        mustRunCleanup: true,
      },
    }
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ batchDir, manifestPath, resultPath, gates, coverage }, null, 2)}\n`)
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true })
    throw error
  }
}

async function status() {
  const verified = await verifyBatch()
  process.stdout.write(`${JSON.stringify({
    status: 'prepared_transient_batch',
    batchDir,
    images: verified.files.length,
    manifestImages: verified.manifest.images.length,
    hashFailures: verified.hashFailures,
    trainingUseAllowed: verified.manifest.trainingUseAllowed,
    mustCleanup: true,
  }, null, 2)}\n`)
  if (verified.hashFailures) process.exitCode = 1
}

async function cleanup() {
  if (!(await exists(stagingDir))) {
    process.stdout.write(`${JSON.stringify({ status: 'already_clean', stagingDir }, null, 2)}\n`)
    return
  }
  const verified = await verifyBatch()
  if (verified.hashFailures) throw new Error(`Refusing cleanup report with ${verified.hashFailures} hash failures`)
  const summary = { images: verified.files.length, hashFailures: verified.hashFailures }
  await rm(stagingDir, { recursive: true, force: true })
  await updateResultAfterCleanup(summary)
  process.stdout.write(`${JSON.stringify({ status: 'cleaned', ...summary, stagingDir, recoverable: false }, null, 2)}\n`)
}

if (command === 'prepare') await prepare()
else if (command === 'status') await status()
else await cleanup()
