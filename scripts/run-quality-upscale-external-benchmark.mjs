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
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'quality-upscale-external')
const feiDir = join(stagingDir, 'fei')
const londonDir = join(stagingDir, 'london-right')
const resultPath = join(benchmarkDir, 'quality-upscale-external-result.json')
const allowedRoot = resolve(stagingRoot) + sep
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe external upscale staging path')

const feiArchives = [
  { name: 'originalimages_part1.zip', bytes: 86_857_988, sha256: '1d0b0ebe94278a5677edc450251f91450dadb821d9774edc111ad1be0e7475ed' },
  { name: 'originalimages_part2.zip', bytes: 89_176_109, sha256: '993c2a48ac38c64824c619cbcdb0700598786aa2fa20a76f4b199457c8662e69' },
  { name: 'originalimages_part3.zip', bytes: 88_206_682, sha256: '65d282b338001e4ece78944b751d5d78d94eddfacf2c734cf8530bcd6435e252' },
  { name: 'originalimages_part4.zip', bytes: 89_251_729, sha256: 'dd82ed2b475781dd4e829fb964923eb3a69e6f413f0e05ae694e65fce9fbe44f' },
].map((item) => ({ ...item, url: `https://fei.edu.br/~cet/${item.name}` }))
const londonArchive = {
  name: 'neutral_right_profile.zip',
  url: 'https://ndownloader.figshare.com/files/8545684',
  bytes: 25_823_276,
  md5: '37bf4690eb44ad21d352dceb4accadc8',
}
const variants = [
  { name: 'nearest_1080', resize: { kernel: sharp.kernel.nearest } },
  { name: 'linear_1080', resize: { kernel: sharp.kernel.linear } },
  { name: 'cubic_1080', resize: { kernel: sharp.kernel.cubic } },
  { name: 'lanczos3_1080', resize: { kernel: sharp.kernel.lanczos3 } },
  { name: 'lanczos3_sharpened_1080', resize: { kernel: sharp.kernel.lanczos3 }, sharpen: { sigma: 1.2, m1: 1.2, m2: 2 } },
]

function digest(algorithm, value) { return createHash(algorithm).update(value).digest('hex') }
function round(value, digits = 4) { return Number(value.toFixed(digits)) }
function percentile(values, fraction) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values) { return { min: round(Math.min(...values)), p05: round(percentile(values, .05)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } }

async function download(url, path, maximumSeconds = '900') {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '--max-time', maximumSeconds, '--user-agent', 'HeadUp-Upscale-External/1.0', '--output', path, url], { maxBuffer: 2 * 1024 * 1024 })
}

async function safeExtract(path, destination, expectedEntries) {
  const { stdout } = await execFileAsync('tar.exe', ['-tf', path], { maxBuffer: 5 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe || (expectedEntries !== null && entries.length !== expectedEntries)) throw new Error(`Unsafe or unexpected archive listing: ${unsafe ?? entries.length}`)
  await execFileAsync('tar.exe', ['-xf', path, '-C', destination])
  return entries
}

async function recursiveFiles(dir) {
  const output = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) output.push(...await recursiveFiles(path)); else output.push(path)
  }
  return output
}

function summarize(items) {
  const flags = {}
  for (const item of items) for (const flag of item.quality.flags) flags[flag] = (flags[flag] ?? 0) + 1
  const accepted = items.filter((item) => item.accepted).length
  return {
    images: items.length,
    accepted,
    acceptanceRate: round(accepted / items.length),
    explicitUpscaleFlags: items.filter((item) => item.quality.flags.includes('疑似低清放大')).length,
    resamplingRisk: distribution(items.map((item) => item.quality.resamplingRisk ?? 0)),
    score: distribution(items.map((item) => item.quality.score)),
    flags,
  }
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(feiDir, { recursive: true })
await mkdir(londonDir, { recursive: true })
try {
  const feiSource = []
  for (const archive of feiArchives) {
    const path = join(stagingDir, archive.name)
    await download(archive.url, path)
    const bytes = await readFile(path)
    if (bytes.length !== archive.bytes || digest('sha256', bytes) !== archive.sha256) throw new Error(`FEI fixed transport mismatch: ${archive.name}`)
    const entries = await safeExtract(path, feiDir, 700)
    if (entries.some((entry) => !/^\d{1,3}-\d{2}\.jpg$/i.test(entry))) throw new Error('Unexpected FEI entry name')
    feiSource.push({ name: archive.name, bytes: bytes.length, sha256: archive.sha256 })
    await rm(path, { force: true })
  }
  const londonPath = join(stagingDir, londonArchive.name)
  await download(londonArchive.url, londonPath, '600')
  const londonBytes = await readFile(londonPath)
  if (londonBytes.length !== londonArchive.bytes || digest('md5', londonBytes) !== londonArchive.md5) throw new Error('London right-profile transport mismatch')
  await safeExtract(londonPath, londonDir, null)
  await rm(londonPath, { force: true })

  const selectedIdentities = Array.from({ length: 200 }, (_, index) => index + 1)
    .sort((left, right) => digest('sha256', `HeadUp-Upscale-External/${left}`).localeCompare(digest('sha256', `HeadUp-Upscale-External/${right}`)))
    .slice(0, 50)
  const harness = await createProductionQualityHarness(projectDir)
  const attacks = []
  for (const subject of selectedIdentities) {
    for (const view of ['01', '10']) {
      const sourcePath = join(feiDir, `${subject}-${view}.jpg`)
      const low = await sharp(sourcePath).extract({ left: 80, top: 0, width: 480, height: 480 }).resize(120, 120, { kernel: sharp.kernel.lanczos3 }).toBuffer()
      for (const variant of variants) {
        let pipeline = sharp(low).resize(1080, 1080, { fit: 'fill', ...variant.resize })
        if (variant.sharpen) pipeline = pipeline.sharpen(variant.sharpen)
        const attack = await pipeline.jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer()
        const quality = await harness.inspect(attack)
        attacks.push({ variant: variant.name, direction: view === '01' ? 'left' : 'right', quality: quality.quality, accepted: quality.accepted })
      }
    }
  }
  const londonFiles = (await recursiveFiles(londonDir)).filter((path) => /^\d{3}_\d{2}\.jpg$/i.test(basename(path)))
    .sort((left, right) => digest('sha256', basename(left)).localeCompare(digest('sha256', basename(right))))
  if (londonFiles.length !== 102) throw new Error(`Unexpected London right-profile control count: ${londonFiles.length}`)
  const controls = []
  for (const path of londonFiles) {
    const quality = await harness.inspect(path)
    controls.push({ quality: quality.quality, accepted: quality.accepted })
  }
  const byVariant = Object.fromEntries(variants.map((variant) => [variant.name, summarize(attacks.filter((item) => item.variant === variant.name))]))
  const byDirection = Object.fromEntries(['left', 'right'].map((direction) => [direction, summarize(attacks.filter((item) => item.direction === direction))]))
  const controlSummary = summarize(controls)
  const gates = {
    selectedExactly50IdentitiesAnd100SourceViews: selectedIdentities.length === 50 && attacks.length === 500,
    eachAttackVariantHas100Images: Object.values(byVariant).every((item) => item.images === 100),
    eachAttackVariantAcceptanceAtMost5Percent: Object.values(byVariant).every((item) => item.acceptanceRate <= 0.05),
    nearestExplicitUpscaleFlagRateAtLeast95Percent: byVariant.nearest_1080.explicitUpscaleFlags >= 95,
    londonRightProfileHasAtLeast80AcceptedControls: controlSummary.accepted >= 80,
    londonRightProfileUpscaleFalseRejectAtMost1Percent: controlSummary.explicitUpscaleFlags <= 1,
  }
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-QUALITY-UPSCALE-EXTERNAL-1.0',
    source: {
      attack: { name: 'FEI views 01/10, 50 hash-selected identities', sourceArchives: feiSource, sourceResolution: '640x480 center-cropped/downsampled to 120x120 before attacks' },
      clearControl: { name: 'Face Research Lab London Set neutral right profile', archiveBytes: londonBytes.length, archiveMd5: londonArchive.md5, images: 102 },
    },
    protocol: { productionThresholdFrozen: true, threshold: 1.19081898, generatedAttackImages: 500, variants: variants.map((item) => item.name) },
    attacks: { byVariant, byDirection },
    clearControls: controlSummary,
    predeclaredGates: gates,
    passesExternalUpscaleResistance: Object.values(gates).every(Boolean),
    productionDecision: Object.values(gates).every(Boolean) ? 'retain_integrated_upscale_gate' : 'reopen_or_revert_upscale_gate',
    limitations: [
      'FEI is controlled 640x480 imagery; attacks are synthetic low-detail derivatives, not adversarial phone sessions.',
      'London right profiles are studio controls and do not span phone devices or backgrounds.',
      'Neural super-resolution and generative restoration remain outside scope.',
    ],
    retention: { generatedAttackImagesRetained: false, feiImagesRetained: false, londonImagesRetained: false, identifiersRetained: false, individualResultsRetained: false, aggregateOnly: true },
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ resultPath, byVariant, clearControls: controlSummary, gates, passes: result.passesExternalUpscaleResistance }, null, 2)}\n`)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
