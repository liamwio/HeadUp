import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const manualDir = join(projectDir, 'data', 'manual-test', 'aflw2000-yaw-v1')
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'quality-neural-super-resolution')
const modelPath = join(stagingDir, 'super-resolution-10.onnx')
const resultPath = join(benchmarkDir, 'quality-neural-super-resolution-result.json')
const allowedRoot = resolve(stagingRoot) + sep
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe neural super-resolution staging path')

const model = {
  name: 'ONNX Model Zoo Super Resolution with sub-pixel CNN, opset 10',
  repository: 'https://huggingface.co/onnxmodelzoo/super-resolution-10',
  commit: '395472c4b6b92f788357237983d83fd913cfe7e3',
  url: 'https://huggingface.co/onnxmodelzoo/super-resolution-10/resolve/395472c4b6b92f788357237983d83fd913cfe7e3/super-resolution-10.onnx?download=true',
  bytes: 240_078,
  sha256: '85f36ff88cc504a24af5e0602148bc56a8aa09a58eca8c0da2756f3e8186035e',
  license: 'Apache-2.0',
}

function digest(value) { return createHash('sha256').update(value).digest('hex') }
function round(value, digits = 4) { return Number(value.toFixed(digits)) }
function percentile(values, fraction) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values) { return { min: round(Math.min(...values)), p05: round(percentile(values, .05)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } }
function clamp(value) { return Math.max(0, Math.min(255, Math.round(value))) }

async function neuralUpscale(session, source) {
  const { data, info } = await sharp(source).resize(224, 224, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== 224 || info.height !== 224 || info.channels !== 3) throw new Error('Unexpected neural preprocessing shape')
  const yInput = new Float32Array(224 * 224)
  const chroma = Buffer.alloc(224 * 224 * 3)
  for (let index = 0; index < 224 * 224; index++) {
    const r = data[index * 3]
    const g = data[index * 3 + 1]
    const b = data[index * 3 + 2]
    yInput[index] = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    chroma[index * 3] = clamp(-0.168736 * r - 0.331264 * g + 0.5 * b + 128)
    chroma[index * 3 + 1] = clamp(0.5 * r - 0.418688 * g - 0.081312 * b + 128)
    chroma[index * 3 + 2] = 0
  }
  const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', yInput, [1, 1, 224, 224]) })
  const tensor = output[session.outputNames[0]]
  if (tensor.dims.join('x') !== '1x1x672x672' || !(tensor.data instanceof Float32Array)) throw new Error(`Unexpected neural output: ${tensor.dims.join('x')}`)
  const upChroma = await sharp(chroma, { raw: { width: 224, height: 224, channels: 3 } }).resize(672, 672, { kernel: sharp.kernel.cubic }).raw().toBuffer()
  const rgb = Buffer.alloc(672 * 672 * 3)
  for (let index = 0; index < 672 * 672; index++) {
    const y = Math.max(0, Math.min(1, tensor.data[index])) * 255
    const cb = upChroma[index * 3] - 128
    const cr = upChroma[index * 3 + 1] - 128
    rgb[index * 3] = clamp(y + 1.402 * cr)
    rgb[index * 3 + 1] = clamp(y - 0.344136 * cb - 0.714136 * cr)
    rgb[index * 3 + 2] = clamp(y + 1.772 * cb)
  }
  return sharp(rgb, { raw: { width: 672, height: 672, channels: 3 } })
    .resize(1080, 1080, { kernel: sharp.kernel.lanczos3 })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer()
}

function summarize(items) {
  const accepted = items.filter((item) => item.accepted).length
  const flags = {}
  for (const item of items) for (const flag of item.quality.flags) flags[flag] = (flags[flag] ?? 0) + 1
  return {
    images: items.length,
    accepted,
    acceptanceRate: round(accepted / items.length),
    explicitUpscaleFlags: items.filter((item) => item.quality.flags.includes('疑似低清放大')).length,
    resamplingRisk: distribution(items.map((item) => item.quality.resamplingRisk ?? 0)),
    sharpnessScore: distribution(items.map((item) => item.quality.sharpness)),
    score: distribution(items.map((item) => item.quality.score)),
    flags,
  }
}

ort.env.wasm.numThreads = 1
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '300', '--user-agent', 'HeadUp-Neural-Upscale-Audit/1.0', '--output', modelPath, model.url], { maxBuffer: 2 * 1024 * 1024 })
  const modelBytes = await readFile(modelPath)
  if (modelBytes.length !== model.bytes || digest(modelBytes) !== model.sha256) throw new Error('Official super-resolution model integrity mismatch')
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] })
  const manifest = JSON.parse(await readFile(join(manualDir, 'manifest.json'), 'utf8'))
  if (manifest.cases.length !== 50) throw new Error('Unexpected neural attack source count')
  const harness = await createProductionQualityHarness(projectDir)
  const cases = []
  for (const item of manifest.cases) {
    const source = await readFile(join(manualDir, item.image))
    if (digest(source) !== item.sha256) throw new Error('Manual source hash mismatch')
    const [neural, lanczos] = await Promise.all([
      neuralUpscale(session, source),
      sharp(source).resize(1080, 1080, { kernel: sharp.kernel.lanczos3 }).jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer(),
    ])
    for (const [variant, buffer] of [['subpixel_cnn_x3_then_1080', neural], ['lanczos3_1080_control', lanczos]]) {
      const inspected = await harness.inspect(buffer)
      cases.push({ variant, quality: inspected.quality, accepted: inspected.accepted })
    }
  }
  const neuralSummary = summarize(cases.filter((item) => item.variant === 'subpixel_cnn_x3_then_1080'))
  const controlSummary = summarize(cases.filter((item) => item.variant === 'lanczos3_1080_control'))
  const gates = {
    officialModelHashAndShapeVerified: true,
    evaluatedExactly50NeuralAttacks: neuralSummary.images === 50,
    lanczosControlAcceptanceAtMost5Percent: controlSummary.acceptanceRate <= 0.05,
    neuralSuperResolutionAcceptanceAtMost5Percent: neuralSummary.acceptanceRate <= 0.05,
    neuralExplicitUpscaleFlagRateAtLeast95Percent: neuralSummary.explicitUpscaleFlags >= 48,
  }
  const passesAcceptanceResistance = gates.lanczosControlAcceptanceAtMost5Percent && gates.neuralSuperResolutionAcceptanceAtMost5Percent
  const passesAllGates = Object.values(gates).every(Boolean)
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-QUALITY-NEURAL-SUPER-RESOLUTION-1.0',
    source: { images: 50, name: 'anonymous retained AFLW2000 manual-review crops', sourceResolution: '120x120', sourceHashesVerified: true },
    model,
    protocol: { input: '224x224 Y channel', output: '672x672 Y plus bicubic Cb/Cr, then Lanczos to 1080x1080', thresholdFrozen: 1.19081898 },
    neuralAttack: neuralSummary,
    traditionalControl: controlSummary,
    predeclaredGates: gates,
    passesAcceptanceResistance,
    passesAllNeuralUpscaleGates: passesAllGates,
    explicitAttributionComplete: gates.neuralExplicitUpscaleFlagRateAtLeast95Percent,
    productionDecision: passesAllGates
      ? 'retain_quality_gate_for_this_neural_model'
      : passesAcceptanceResistance
        ? 'retain_acceptance_gate_but_explicit_upscale_attribution_remains_incomplete'
        : 'neural_super_resolution_bypass_requires_new_research',
    limitations: [
      'One small sub-pixel CNN trained on BSD300 does not represent modern face restoration or generative super-resolution.',
      'The source images are aligned 120x120 crops, not phone-session attacks.',
      'No individual enhanced image or prediction is retained.',
    ],
    retention: { modelRetained: false, generatedImagesRetained: false, sourceImagesChanged: false, individualResultsRetained: false, identifiersRetained: false, aggregateOnly: true },
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ resultPath, neuralAttack: neuralSummary, traditionalControl: controlSummary, gates, passesAcceptanceResistance, passesAllGates }, null, 2)}\n`)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
