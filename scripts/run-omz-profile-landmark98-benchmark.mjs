import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'omz-profile-landmarks98')
const runtimeDir = join(stagingDir, 'python-runtime')
const modelName = 'facial-landmarks-98-detection-0001'
const modelBaseUrl = `https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/${modelName}/FP32`
const modelXml = join(stagingDir, `${modelName}.xml`)
const modelBin = join(stagingDir, `${modelName}.bin`)
const expected = {
  xml: '71d4c898728e85a8c3b1085c5b55e87852611b28ba18de5b91c610d1102f7117',
  bin: 'b1df418f590fdebbfcbfabb05ba57e0e25b5b68b55d91c107a3a62f548bcf621',
}
const resultPath = join(projectDir, 'data', 'face-benchmark', 'omz-profile-landmarks98-result.json')
const pythonExecutable = process.env.HEADUP_PYTHON || 'py'
const pythonPrefix = process.env.HEADUP_PYTHON ? [] : ['-3.11']

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe staging path')
async function download(extension, path) {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '180', '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', path, `${modelBaseUrl}/${modelName}.${extension}`], { maxBuffer: 2 * 1024 * 1024 })
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  await Promise.all([download('xml', modelXml), download('bin', modelBin)])
  const [xmlBytes, binBytes] = await Promise.all([readFile(modelXml), readFile(modelBin)])
  const hashes = { xml: createHash('sha256').update(xmlBytes).digest('hex'), bin: createHash('sha256').update(binBytes).digest('hex') }
  if (hashes.xml !== expected.xml || hashes.bin !== expected.bin) throw new Error(`OMZ98 checksum mismatch: ${JSON.stringify(hashes)}`)
  process.stdout.write(`Verified transient OMZ98 model: ${JSON.stringify(hashes)}\n`)
  await execFileAsync(pythonExecutable, [...pythonPrefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--target', runtimeDir, 'openvino==2025.4.1', 'opencv-python-headless==4.12.0.88', 'numpy==2.2.6'], { maxBuffer: 20 * 1024 * 1024 })
  const { stdout, stderr } = await execFileAsync(pythonExecutable, [
    ...pythonPrefix, join(projectDir, 'scripts', 'benchmark-omz-profile-landmarks98.py'),
    join(projectDir, 'data', 'face-db-real-research', 'manifest.jsonl'), join(projectDir, 'data', 'face-db-real-research'),
    modelXml, modelBin, join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx'), resultPath,
  ], { env: { ...process.env, PYTHONPATH: runtimeDir }, maxBuffer: 20 * 1024 * 1024 })
  if (stderr.trim()) process.stderr.write(stderr)
  process.stdout.write(stdout)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
