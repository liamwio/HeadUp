import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'cew-eye-closure-highres')
const manifestPath = join(stagingDir, 'manifest.json')
const modelDir = join(stagingDir, 'model')
const modelPath = join(modelDir, 'open-closed-eye-0001.onnx')
const model = {
  name: 'Open Model Zoo open-closed-eye-0001',
  sourcePage: 'https://github.com/openvinotoolkit/open_model_zoo/tree/master/models/public/open-closed-eye-0001',
  sourceCommit: '7cc29a91472b4cb1289a11e655ba3e188e1d4a31',
  url: 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/open-closed-eye-0001/open_closed_eye.onnx',
  bytes: 46164,
  sha256: '4daa100034482525a26c9afb9297c16580a531189e66e3d2b2ac7d32becfd593',
  sha384: '2615bce53b55620c629db21b043057600ccc53466f053c0a8277c43577c2db21e48f330cf9b15213016d17cddb8cba27',
  license: 'Apache-2.0',
}

function digest(algorithm, value) { return createHash(algorithm).update(value).digest('hex') }
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe eye-state staging path')

try {
  await import('./prepare-transient-cew-eye-closure-highres-benchmark.mjs')
  await mkdir(modelDir, { recursive: true })
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '8', '--retry-all-errors',
    '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '180',
    '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', modelPath, model.url,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const bytes = await readFile(modelPath)
  if (bytes.length !== model.bytes || digest('sha256', bytes) !== model.sha256 || digest('sha384', bytes) !== model.sha384) {
    throw new Error('Open/closed-eye ONNX integrity mismatch')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.policyVersion = 'HEADUP-OPENVINO-EYE-STATE-PREPARE-1.0'
  manifest.eyeStateModel = {
    ...model,
    relativePath: 'model/open-closed-eye-0001.onnx',
    input: '1x3x32x32 BGR eye crop',
    officialOutput: '[open, closed]',
    officialMrlAccuracy: 0.9584,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write('Prepared transient CEW/LFW images and verified Apache-2.0 eye-state ONNX candidate.\n')
} catch (error) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  await rm(stagingDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  throw error
}
