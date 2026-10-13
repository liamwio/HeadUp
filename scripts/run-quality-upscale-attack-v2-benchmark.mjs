import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const integrated = process.argv.includes('--integrated')
const manualDir = join(projectDir, 'data', 'manual-test', 'aflw2000-yaw-v1')
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'quality-upscale-attack-v2')
const londonDir = join(stagingDir, 'london')
const attackDir = join(stagingDir, 'attacks')
const resultPath = join(benchmarkDir, integrated ? 'quality-upscale-attack-v3-result.json' : 'quality-upscale-attack-v2-result.json')
const FROZEN_PERIODIC_GRADIENT_THRESHOLD = 1.19081898
const allowedRoot = resolve(stagingRoot) + sep
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe V2 upscale staging path')

const londonArchive = {
  name: 'neutral_front.zip',
  url: 'https://ndownloader.figshare.com/files/8541961',
  bytes: 33_860_607,
  md5: '236c1c94defbb34a79074b195841cfd6',
}
const variants = [
  { name: 'nearest_1080', resize: { kernel: sharp.kernel.nearest } },
  { name: 'linear_1080', resize: { kernel: sharp.kernel.linear } },
  { name: 'cubic_1080', resize: { kernel: sharp.kernel.cubic } },
  { name: 'lanczos3_1080', resize: { kernel: sharp.kernel.lanczos3 } },
  { name: 'lanczos3_sharpened_1080', resize: { kernel: sharp.kernel.lanczos3 }, sharpen: { sigma: 1.2, m1: 1.2, m2: 2 } },
]

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex')
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits))
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.round((ordered.length - 1) * fraction)]
}

function distribution(values) {
  return {
    min: round(Math.min(...values)), p05: round(percentile(values, 0.05)),
    median: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values)),
  }
}

async function recursiveFiles(dir) {
  const output = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) output.push(...await recursiveFiles(path))
    else output.push(path)
  }
  return output
}

async function repeatMetrics(path) {
  const metadata = await sharp(path).metadata()
  if (!metadata.width || !metadata.height) throw new Error('Unable to inspect repeat metric dimensions')
  const scale = Math.min(1, 360 / Math.max(metadata.width, metadata.height))
  const width = Math.max(1, Math.round(metadata.width * scale))
  const height = Math.max(1, Math.round(metadata.height * scale))
  const { data, info } = await sharp(path).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  let near = 0
  let adjacent = 0
  let flatTriplets = 0
  let triplets = 0
  const horizontalGradients = []
  const verticalGradients = []
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const index = y * info.width + x
      if (x > 0) {
        const gradient = Math.abs(data[index] - data[index - 1])
        adjacent++; if (gradient <= 1) near++
        horizontalGradients.push({ position: x, gradient })
      }
      if (y > 0) {
        const gradient = Math.abs(data[index] - data[index - info.width])
        adjacent++; if (gradient <= 1) near++
        verticalGradients.push({ position: y, gradient })
      }
      if (x > 1) {
        triplets++
        if (Math.max(data[index], data[index - 1], data[index - 2]) - Math.min(data[index], data[index - 1], data[index - 2]) <= 2) flatTriplets++
      }
      if (y > 1) {
        triplets++
        if (Math.max(data[index], data[index - info.width], data[index - 2 * info.width]) - Math.min(data[index], data[index - info.width], data[index - 2 * info.width]) <= 2) flatTriplets++
      }
    }
  }
  const phasePeak = (gradients) => {
    let maximum = 1
    for (let period = 2; period <= 6; period++) {
      const sums = Array(period).fill(0)
      const counts = Array(period).fill(0)
      for (const item of gradients) {
        const phase = item.position % period
        sums[phase] += item.gradient
        counts[phase]++
      }
      const means = sums.map((sum, index) => sum / Math.max(1, counts[index]))
      for (let phase = 0; phase < period; phase++) {
        const otherMean = means.filter((_, index) => index !== phase).reduce((sum, value) => sum + value, 0) / (period - 1)
        maximum = Math.max(maximum, means[phase] / Math.max(0.01, otherMean))
      }
    }
    return maximum
  }
  return {
    adjacentRepeatRatio: near / adjacent,
    flatTripletRatio: flatTriplets / triplets,
    periodicGradientPeak: Math.max(phasePeak(horizontalGradients), phasePeak(verticalGradients)),
  }
}

function summarize(items, threshold = null) {
  const productionAccepted = items.filter((item) => item.productionAccepted).length
  const acceptedAfterRepeat = threshold === null ? productionAccepted : items.filter((item) => item.productionAccepted && item.repeat.adjacentRepeatRatio < threshold).length
  return {
    images: items.length,
    productionAccepted,
    acceptedAfterRepeat,
    acceptedAfterRepeatRate: round(acceptedAfterRepeat / items.length, 4),
    adjacentRepeatRatio: distribution(items.map((item) => item.repeat.adjacentRepeatRatio)),
    flatTripletRatio: distribution(items.map((item) => item.repeat.flatTripletRatio)),
    periodicGradientPeak: distribution(items.map((item) => item.repeat.periodicGradientPeak)),
  }
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(londonDir, { recursive: true })
await mkdir(attackDir, { recursive: true })
try {
  const archivePath = join(stagingDir, londonArchive.name)
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-Upscale-V2/1.0',
    '--output', archivePath, londonArchive.url,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const archive = await readFile(archivePath)
  if (archive.length !== londonArchive.bytes || digest('md5', archive) !== londonArchive.md5) throw new Error('London archive integrity mismatch')
  const { stdout } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 5 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe London archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', londonDir])
  await rm(archivePath, { force: true })
  const londonFiles = (await recursiveFiles(londonDir)).filter((path) => /^\d{3}_\d{2}\.jpg$/i.test(basename(path)))
    .sort((left, right) => digest('sha256', basename(left)).localeCompare(digest('sha256', basename(right))))
  if (londonFiles.length !== 102) throw new Error(`Unexpected London neutral count: ${londonFiles.length}`)

  const manifest = JSON.parse(await readFile(join(manualDir, 'manifest.json'), 'utf8'))
  if (manifest.cases.length !== 50) throw new Error('Unexpected manual attack source count')
  const orderedSources = [...manifest.cases].sort((left, right) => left.sha256.localeCompare(right.sha256))
  const harness = await createProductionQualityHarness(projectDir)
  const attacks = []
  for (const [index, item] of orderedSources.entries()) {
    const sourcePath = join(manualDir, item.image)
    const source = await readFile(sourcePath)
    if (digest('sha256', source) !== item.sha256) throw new Error('Manual source hash mismatch')
    for (const variant of variants) {
      let pipeline = sharp(source).resize(1080, 1080, { fit: 'fill', ...variant.resize })
      if (variant.sharpen) pipeline = pipeline.sharpen(variant.sharpen)
      const outputPath = join(attackDir, `${String(index + 1).padStart(3, '0')}-${variant.name}.jpg`)
      await pipeline.jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toFile(outputPath)
      const [quality, repeat] = await Promise.all([harness.inspect(outputPath), repeatMetrics(outputPath)])
      attacks.push({ partition: index < 25 ? 'engineering' : 'holdout', variant: variant.name, productionAccepted: quality.accepted, repeat })
    }
  }
  const london = []
  for (const [index, path] of londonFiles.entries()) {
    const [quality, repeat] = await Promise.all([harness.inspect(path), repeatMetrics(path)])
    london.push({ partition: index < 85 ? 'engineering' : 'holdout', productionAccepted: quality.accepted, repeat })
  }
  const attackEngineering = attacks.filter((item) => item.partition === 'engineering')
  const londonEngineering = london.filter((item) => item.partition === 'engineering')
  const candidates = [...new Set([...attackEngineering, ...londonEngineering].map((item) => round(item.repeat.periodicGradientPeak, 8)))].sort((a, b) => a - b)
  const ranked = candidates.map((threshold) => {
    const londonFalseRejects = londonEngineering.filter((item) => item.productionAccepted && item.repeat.periodicGradientPeak >= threshold).length
    const attackBlocked = attackEngineering.filter((item) => item.productionAccepted && item.repeat.periodicGradientPeak >= threshold).length
    return { threshold, londonFalseRejects, attackBlocked }
  }).filter((item) => item.londonFalseRejects <= 1)
    .sort((left, right) => right.attackBlocked - left.attackBlocked || left.londonFalseRejects - right.londonFalseRejects || right.threshold - left.threshold)
  if (!ranked.length) throw new Error('No adjacent-repeat threshold met the London engineering false-reject constraint')
  const selected = integrated ? {
    threshold: FROZEN_PERIODIC_GRADIENT_THRESHOLD,
    londonFalseRejects: londonEngineering.filter((item) => item.productionAccepted && item.repeat.periodicGradientPeak >= FROZEN_PERIODIC_GRADIENT_THRESHOLD).length,
    attackBlocked: attackEngineering.filter((item) => item.productionAccepted && item.repeat.periodicGradientPeak >= FROZEN_PERIODIC_GRADIENT_THRESHOLD).length,
  } : ranked[0]
  const attackHoldout = attacks.filter((item) => item.partition === 'holdout')
  const londonHoldout = london.filter((item) => item.partition === 'holdout')
  const summarizeWithPeriodic = (items) => {
    const summary = summarize(items)
    const acceptedAfterRepeat = items.filter((item) => item.productionAccepted && item.repeat.periodicGradientPeak < selected.threshold).length
    return { ...summary, acceptedAfterRepeat, acceptedAfterRepeatRate: round(acceptedAfterRepeat / items.length, 4) }
  }
  const byVariantHoldout = Object.fromEntries(variants.map((variant) => [variant.name, summarizeWithPeriodic(attackHoldout.filter((item) => item.variant === variant.name))]))
  const gates = {
    engineeringLondonHasAtLeast80ClearImages: londonEngineering.filter((item) => item.productionAccepted).length >= 80,
    engineeringLondonRepeatFalseRejectAtMost1Image: selected.londonFalseRejects <= 1,
    holdoutLondonHasAtLeast15ClearImages: londonHoldout.filter((item) => item.productionAccepted).length >= 15,
    holdoutLondonRepeatFalseRejectIsZero: londonHoldout.filter((item) => item.productionAccepted && item.repeat.periodicGradientPeak >= selected.threshold).length === 0,
    eachUpscaleVariantHoldoutAcceptanceAtMost5Percent: Object.values(byVariantHoldout).every((item) => item.acceptedAfterRepeatRate <= 0.05),
  }
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: integrated ? 'HEADUP-QUALITY-UPSCALE-ATTACK-3.0' : 'HEADUP-QUALITY-UPSCALE-ATTACK-2.0',
    source: {
      attacks: '50 anonymous AFLW2000 manual-review crops, hash-ranked 25 engineering / 25 holdout',
      clearControls: 'Face Research Lab London Set neutral front, filename-hash-ranked 85 engineering / 17 holdout',
      londonArchive: { bytes: archive.length, md5: londonArchive.md5, license: 'CC BY 4.0 research control' },
    },
    feature: {
      name: 'periodicGradientPeak',
      definition: 'maximum ratio of one gradient phase mean to other phase means across horizontal/vertical periods 2–6 after production-equivalent max-360 downsampling',
      candidateSelection: integrated
        ? 'threshold frozen by V2 engineering selection; no V3 reselection'
        : 'maximize blocked production-accepted engineering attacks subject to at most one production-accepted London engineering false reject',
      selectedThreshold: selected.threshold,
    },
    engineering: {
      attacks: summarizeWithPeriodic(attackEngineering),
      london: summarizeWithPeriodic(londonEngineering),
      selected,
    },
    holdout: {
      byAttackVariant: byVariantHoldout,
      london: summarizeWithPeriodic(londonHoldout),
    },
    predeclaredGates: gates,
    passesDevelopmentAndHoldoutGates: Object.values(gates).every(Boolean),
    productionIntegrationRecommended: !integrated && Object.values(gates).every(Boolean),
    productionIntegrationVerified: integrated && Object.values(gates).every(Boolean),
    limitations: [
      'The feature targets block replication and does not detect all interpolation, neural super-resolution or generative restoration.',
      'London controls are clear studio portraits, not the full phone/device distribution.',
      'A passing result requires a second benchmark after production integration using the frozen threshold.',
    ],
    retention: {
      generatedAttackImagesRetained: false,
      londonImagesRetained: false,
      sourceImagesChanged: false,
      individualResultsRetained: false,
      identifiersRetained: false,
      aggregateOnly: true,
    },
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ resultPath, selected, engineering: result.engineering, holdout: result.holdout, gates, passes: result.passesDevelopmentAndHoldoutGates }, null, 2)}\n`)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
