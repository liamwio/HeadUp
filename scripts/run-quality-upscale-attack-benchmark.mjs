import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const manualDir = join(projectDir, 'data', 'manual-test', 'aflw2000-yaw-v1')
const manifestPath = join(manualDir, 'manifest.json')
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'quality-upscale-attack')
const resultPath = join(benchmarkDir, 'quality-upscale-attack-result.json')
const allowedRoot = resolve(stagingRoot) + sep
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe upscale attack staging path')

const variants = [
  { name: 'nearest_1080', resize: { kernel: sharp.kernel.nearest } },
  { name: 'linear_1080', resize: { kernel: sharp.kernel.linear } },
  { name: 'cubic_1080', resize: { kernel: sharp.kernel.cubic } },
  { name: 'lanczos3_1080', resize: { kernel: sharp.kernel.lanczos3 } },
  { name: 'lanczos3_sharpened_1080', resize: { kernel: sharp.kernel.lanczos3 }, sharpen: { sigma: 1.2, m1: 1.2, m2: 2 } },
]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits))
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.round((ordered.length - 1) * fraction)]
}

function distribution(values) {
  return {
    min: round(Math.min(...values)),
    p05: round(percentile(values, 0.05)),
    median: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
  }
}

function summarize(cases) {
  const flags = {}
  for (const item of cases) for (const flag of item.quality.flags) flags[flag] = (flags[flag] ?? 0) + 1
  return {
    images: cases.length,
    accepted: cases.filter((item) => item.accepted).length,
    acceptanceRate: round(cases.filter((item) => item.accepted).length / cases.length),
    score: distribution(cases.map((item) => item.quality.score)),
    rawSharpness: distribution(cases.map((item) => item.raw.sharpness)),
    qualitySharpnessScore: distribution(cases.map((item) => item.quality.sharpness)),
    flags,
  }
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.policyVersion !== 'HEADUP-LOCAL-MANUAL-REVIEW-1.0' || manifest.cases.length !== 50) {
    throw new Error('Unexpected manual review manifest contract')
  }
  const harness = await createProductionQualityHarness(projectDir)
  const cases = []
  for (const [index, item] of manifest.cases.entries()) {
    const sourcePath = join(manualDir, item.image)
    const source = await readFile(sourcePath)
    if (sha256(source) !== item.sha256) throw new Error(`Manual source hash mismatch at case ${index + 1}`)
    const metadata = await sharp(source).metadata()
    if (metadata.width !== 120 || metadata.height !== 120) throw new Error('Unexpected AFLW2000 manual source dimensions')
    const original = await harness.inspect(sourcePath)
    cases.push({ variant: 'original_120', accepted: original.accepted, quality: original.quality, raw: original.raw })
    for (const variant of variants) {
      let pipeline = sharp(source).resize(1080, 1080, { fit: 'fill', ...variant.resize })
      if (variant.sharpen) pipeline = pipeline.sharpen(variant.sharpen)
      const buffer = await pipeline.jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer()
      const outputPath = join(stagingDir, `${String(index + 1).padStart(3, '0')}-${variant.name}.jpg`)
      await writeFile(outputPath, buffer)
      const inspected = await harness.inspect(outputPath)
      cases.push({ variant: variant.name, accepted: inspected.accepted, quality: inspected.quality, raw: inspected.raw })
    }
  }
  const byVariant = Object.fromEntries(['original_120', ...variants.map((item) => item.name)].map((variant) => [
    variant, summarize(cases.filter((item) => item.variant === variant)),
  ]))
  const gates = {
    allOriginalsBlockedForResolution: byVariant.original_120.accepted === 0
      && byVariant.original_120.flags['分辨率偏低'] === 50,
    eachUpscaleVariantAcceptanceAtMost5Percent: variants.every((variant) => byVariant[variant.name].acceptanceRate <= 0.05),
    noUpscaleVariantMajorityAccepted: variants.every((variant) => byVariant[variant.name].accepted < 25),
  }
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-QUALITY-UPSCALE-ATTACK-1.0',
    source: {
      name: '50 retained anonymous AFLW2000 manual-review crops',
      images: 50,
      sourceResolution: '120x120',
      manifestPolicy: manifest.policyVersion,
      sourceHashesVerified: true,
    },
    attack: {
      targetResolution: '1080x1080',
      variants: variants.map((item) => item.name),
      jpegQuality: 96,
      purpose: 'test whether interpolation and optional sharpening can convert a known low-detail crop into a production-quality accepted image',
    },
    byVariant,
    predeclaredGates: gates,
    passesUpscaleAttackResistance: Object.values(gates).every(Boolean),
    productionDecision: Object.values(gates).every(Boolean) ? 'retain_quality_gate' : 'quality_gate_fix_required',
    limitations: [
      'AFLW2000 crops are already face-aligned and only 120x120; they are a strong low-detail attack, not a phone-camera distribution.',
      'Upscaling algorithms tested here do not cover neural super-resolution or generative restoration.',
      'This benchmark isolates pixel-quality acceptance and does not test pose or face detection.',
    ],
    retention: {
      generatedAttackImagesRetained: false,
      sourceImagesChanged: false,
      individualResultsRetained: false,
      identifiersRetained: false,
      aggregateOnly: true,
    },
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ resultPath, byVariant, gates, passes: result.passesUpscaleAttackResistance }, null, 2)}\n`)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
