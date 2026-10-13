import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'anti-spoof-mn3')
const modelDir = join(stagingDir, 'model')
const modelPath = join(modelDir, 'anti-spoof-mn3.onnx')
const manifestPath = join(stagingDir, 'manifest.json')
const londonDir = join(projectDir, 'data', 'face-db-real-research', 'images', 'face-research-lab-london-v5')
const model = {
  name: 'Open Model Zoo anti-spoof-mn3',
  sourcePage: 'https://github.com/openvinotoolkit/open_model_zoo/tree/7cc29a91472b4cb1289a11e655ba3e188e1d4a31/models/public/anti-spoof-mn3',
  originalRepository: 'https://github.com/kprokofi/light-weight-face-anti-spoofing',
  sourceCommit: '7cc29a91472b4cb1289a11e655ba3e188e1d4a31',
  url: 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/anti-spoof-mn3/anti-spoof-mn3.onnx',
  bytes: 12270179,
  sha384: '6de4534964b723397b3e8c995cadcf43bc007cc2f9930b95ae25f76adccece5d1d4d058d0b15117b9e4a9f758424f92a',
  license: 'MIT (original model); Open Model Zoo packaging Apache-2.0',
}

async function digestFile(algorithm, path) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe anti-spoof staging path')

try {
  await import('./prepare-transient-physical-replay-benchmark.mjs')
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(modelDir, { recursive: true })
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '8', '--retry-all-errors',
    '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '300',
    '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', modelPath, model.url,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const modelStat = await stat(modelPath)
  const sha384 = await digestFile('sha384', modelPath)
  if (modelStat.size !== model.bytes || sha384 !== model.sha384) throw new Error('anti-spoof-mn3 ONNX integrity mismatch')
  const sha256 = await digestFile('sha256', modelPath)

  const londonFiles = (await readdir(londonDir))
    .filter((name) => /^\d{3}_front\.jpg$/i.test(name))
    .sort()
  if (londonFiles.length !== 102) throw new Error(`Expected 102 authorized London front images, found ${londonFiles.length}`)
  const bonaFideRecords = londonFiles.map((name, index) => ({
    split: index < 85 ? 'engineering' : 'holdout',
    assetUrl: `/@fs/${join(londonDir, name).replaceAll('\\', '/')}`,
  }))
  const replayManifest = JSON.parse(await readFile(join(stagingRoot, 'physical-replay', 'manifest.json'), 'utf8'))
  const engineeringVideoIds = new Set(['pc_display_01', 'galaxy_a54_to_honor70', 'honor70_to_pixel7'])
  const replayRecords = replayManifest.samples.map((sample) => ({
    split: engineeringVideoIds.has(sample.id) ? 'engineering' : 'holdout',
    captureGroup: sample.captureGroup,
    assetUrl: `/@fs/${join(stagingRoot, 'physical-replay', sample.relativePath).replaceAll('\\', '/')}`,
    bytes: sample.bytes,
    sha256: sample.sha256,
  }))
  if (replayRecords.filter((item) => item.split === 'engineering').length !== 3 || replayRecords.filter((item) => item.split === 'holdout').length !== 3) {
    throw new Error('Physical replay video split is not 3/3')
  }

  await writeFile(manifestPath, `${JSON.stringify({
    policyVersion: 'HEADUP-ANTI-SPOOF-MN3-PREPARE-1.0',
    model: {
      ...model,
      sha256,
      relativePath: 'model/anti-spoof-mn3.onnx',
      input: '1x3x128x128 RGB exact YuNet face crop; channel mean/std normalization',
      mean: [151.2405, 119.5950, 107.8395],
      scale: [63.0105, 56.4570, 55.0035],
      officialOutput: '[real, spoof]',
      officialCelebASpoofAcer: 0.0381,
    },
    source: {
      bonaFide: 'Face Research Lab London Set, authorized local research fronts',
      attacks: replayManifest.source,
      attackSourceCommit: replayManifest.sourceCommit,
      attackLicense: replayManifest.license,
    },
    sampleFractions: [0.15, 0.3, 0.45, 0.6, 0.75, 0.9],
    bonaFideRecords,
    replayRecords,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared verified anti-spoof model, ${bonaFideRecords.length} authorized bona-fide controls and ${replayRecords.length} verified replay videos.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  await rm(join(stagingRoot, 'physical-replay'), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  throw error
}
