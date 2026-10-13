import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'omz-profile-landmarks')
const runtimeDir = join(stagingDir, 'python-runtime')
const modelBaseUrl = 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/facial-landmarks-35-adas-0002/FP32'
const modelXml = join(stagingDir, 'facial-landmarks-35-adas-0002.xml')
const modelBin = join(stagingDir, 'facial-landmarks-35-adas-0002.bin')
const expectedModelHashes = {
  xml: '85c5bbc71d0cdb4e815b64507ac5d0d5355f3d5faaca54b575743415a3df7ca4',
  bin: 'caf9b17a7dea89984f07a5c903bab256208c832a19b1cc2b3b675e2d534e24f5',
}
const resultPath = join(projectDir, 'data', 'face-benchmark', 'omz-profile-landmarks-result.json')
const pythonExecutable = process.env.HEADUP_PYTHON || 'py'
const pythonPrefix = process.env.HEADUP_PYTHON ? [] : ['-3.11']

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe staging path')

async function download(name, path) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '180', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', path, `${modelBaseUrl}/${name}`,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  await Promise.all([
    download('facial-landmarks-35-adas-0002.xml', modelXml),
    download('facial-landmarks-35-adas-0002.bin', modelBin),
  ])
  const [xmlBytes, binBytes] = await Promise.all([readFile(modelXml), readFile(modelBin)])
  const hashes = {
    xml: createHash('sha256').update(xmlBytes).digest('hex'),
    bin: createHash('sha256').update(binBytes).digest('hex'),
  }
  if (hashes.xml !== expectedModelHashes.xml || hashes.bin !== expectedModelHashes.bin) {
    throw new Error(`OMZ model checksum mismatch: ${JSON.stringify(hashes)}`)
  }
  process.stdout.write(`Verified transient OMZ model: ${JSON.stringify(hashes)}\n`)
  await execFileAsync(pythonExecutable, [
    ...pythonPrefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--target', runtimeDir,
    'openvino==2025.4.1', 'opencv-python-headless==4.12.0.88', 'numpy==2.2.6',
  ], { maxBuffer: 20 * 1024 * 1024 })
  const { stdout, stderr } = await execFileAsync(pythonExecutable, [
    ...pythonPrefix, join(projectDir, 'scripts', 'benchmark-omz-profile-landmarks.py'),
    join(projectDir, 'data', 'face-db-real-research', 'manifest.jsonl'),
    join(projectDir, 'data', 'face-db-real-research'), modelXml, modelBin,
    join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx'), resultPath,
  ], { env: { ...process.env, PYTHONPATH: runtimeDir }, maxBuffer: 20 * 1024 * 1024 })
  if (stderr.trim()) process.stderr.write(stderr)
  process.stdout.write(stdout)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
