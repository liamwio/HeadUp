import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'menpo39-asymmetric-specialist-refiners')
const runtimeDir = join(stagingDir, 'python-runtime')
const extractDir = join(stagingDir, 'extract')
const checkpointDir = join(stagingDir, 'checkpoints')
const archivePath = join(stagingDir, 'menpo_challenge_trainset.zip')
const modelTmp = join(stagingDir, 'v9-model.pth')
const sourceModelPath = join(projectDir, 'data', 'face-benchmark', 'research-models', 'menpo39-mobilenetv3-small-research-only.pth')
const candidateModelPath = join(projectDir, 'data', 'face-benchmark', 'research-models', 'menpo39-asymmetric-specialist-refiners-v9-research-only.pth')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'menpo39-asymmetric-specialist-refiners-result.json')
const menpoUrl = 'https://drive.usercontent.google.com/download?id=1CUqs0n135lye6J6RM5FQXT_DIT45dKvP&export=download&confirm=t'
const expectedMenpoSha256 = '2b702bc178e88e1802506e1e7c4c5b78a07b86a4854b7918de3e040532723ea4'
const bundledPython = 'C:\\Users\\oliam\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe staging path')
async function exists(path) { try { await access(path); return true } catch { return false } }
async function digestFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function runStreaming(executable, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { ...options, stdio: 'inherit' })
    child.on('error', rejectPromise)
    child.on('exit', (code, signal) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`Asymmetric specialist training failed with code ${code}, signal ${signal}`)))
  })
}

if (!(await exists(sourceModelPath))) throw new Error('V1 research model is missing')
const pythonExecutable = process.env.HEADUP_PYTHON || ((await exists(bundledPython)) ? bundledPython : 'py')
const pythonPrefix = process.env.HEADUP_PYTHON || pythonExecutable === bundledPython ? [] : ['-3.11']
await rm(stagingDir, { recursive: true, force: true })
await rm(candidateModelPath, { force: true })
await mkdir(extractDir, { recursive: true })
try {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '1200', '--user-agent', 'HeadUp-Research-Asymmetric-Specialist/1.0',
    '--output', archivePath, menpoUrl,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const archiveSha256 = await digestFile(archivePath)
  if (archiveSha256 !== expectedMenpoSha256) throw new Error(`Menpo archive checksum mismatch: ${archiveSha256}`)
  process.stdout.write(`Verified Menpo archive transport hash: ${archiveSha256}\n`)
  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 50 * 1024 * 1024 })
  const unsafe = listing.split(/\r?\n/).filter(Boolean)
    .find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe Menpo archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir], { maxBuffer: 5 * 1024 * 1024 })
  await rm(archivePath, { force: true })
  await mkdir(runtimeDir, { recursive: true })
  await execFileAsync(pythonExecutable, [
    ...pythonPrefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--target', runtimeDir,
    'torch==2.7.1', 'torchvision==0.22.1', 'opencv-python-headless==4.12.0.88',
    'pillow==11.3.0', 'setuptools==80.9.0',
  ], { maxBuffer: 30 * 1024 * 1024 })
  await runStreaming(pythonExecutable, [
    ...pythonPrefix,
    join(projectDir, 'scripts', 'train-menpo39-asymmetric-specialist-refiners.py'),
    extractDir, sourceModelPath, checkpointDir, candidateModelPath, resultPath, modelTmp,
  ], {
    cwd: projectDir,
    env: {
      ...process.env,
      PYTHONPATH: [runtimeDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      HEADUP_MENPO_ARCHIVE_SHA256: archiveSha256,
    },
  })
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
