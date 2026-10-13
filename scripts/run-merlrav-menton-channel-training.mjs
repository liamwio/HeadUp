import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'merlrav-menton-channel-v13')
const extractDir = join(stagingDir, 'extract')
const runtimeDir = join(stagingDir, 'python-runtime')
const aflwArchive = join(stagingDir, 'test.data.zip')
const merlArchive = join(stagingDir, 'merl-rav.zip')
const roiPath = join(stagingDir, 'AFLW2000-3D_crop.roi_box.npy')
const referencePath = join(stagingDir, 'AFLW2000-3D-Reannotated.pts68.npy')
const sourcePath = join(stagingDir, 'source.json')
const bestPath = join(stagingDir, 'best-menton-state.pth')
const resultPath = join(benchmarkDir, 'merlrav-menton-channel-v13-result.json')
const v1Path = join(benchmarkDir, 'research-models', 'menpo39-mobilenetv3-small-research-only.pth')
const researchPath = join(benchmarkDir, 'research-models', 'menpo39-menton-merlrav-v13-research-only.pth')
const bundledPython = 'C:\\Users\\oliam\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'

const sources = {
  aflw2000Crops: {
    name: '3DDFA author-published AFLW2000-3D 120x120 crop transport',
    url: 'https://drive.usercontent.google.com/download?id=1r_ciJ1M0BSRTwndIBt42GlPFRv6CvvEP&export=download&confirm=t',
    repository: 'https://github.com/cleardusk/3DDFA',
    pinnedCommit: '3545f355bfc71e5748fa915b13932958363135d7',
    bytes: 158_854_200,
    sha256: 'c33b6c472baa0aca22fc21f456bcdfb5da964459208166eb93c8fffc720ddbad',
    expectedEntries: 23_085,
  },
  merlRavLabels: {
    name: 'MERL-RAV professional 68-point labels and visibility classes',
    url: 'https://github.com/abhi1kumar/MERL-RAV_dataset/archive/6e68cc8d009924b31b4b96d01579017dc28b00cf.zip',
    repository: 'https://github.com/abhi1kumar/MERL-RAV_dataset',
    pinnedCommit: '6e68cc8d009924b31b4b96d01579017dc28b00cf',
    bytes: 24_699_161,
    sha256: 'ceb932571b6ad93b09cb910d18b22fc9676c694799cd853eb1d164cac504a12f',
    expectedLabels: 19_314,
    licenseUse: 'non-commercial research training and evaluation only',
  },
  roiTransform: {
    url: 'https://raw.githubusercontent.com/cleardusk/3DDFA/3545f355bfc71e5748fa915b13932958363135d7/test.configs/AFLW2000-3D_crop.roi_box.npy',
    bytes: 32_128,
    sha256: 'c82153524e8339e8e15a73d3f2ba4db69a5e664b5c2e840826b4ae8668e52bd2',
  },
  coordinateRegistrationReference: {
    url: 'https://raw.githubusercontent.com/cleardusk/3DDFA/3545f355bfc71e5748fa915b13932958363135d7/test.configs/AFLW2000-3D-Reannotated.pts68.npy',
    bytes: 1_088_128,
    sha256: 'b5710c0c9e17cd7c0ee84274736e3ab3ff6a499bf220dfc6124f12a399506d2f',
  },
}

const allowedRoot = resolve(stagingRoot) + sep
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe staging path')
async function exists(path) {
  try { await access(path); return true } catch { return false }
}
async function digestFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function verify(path, expected, label) {
  const bytes = (await readFile(path)).length
  const hash = await digestFile(path)
  if (bytes !== expected.bytes) throw new Error(`${label} size mismatch: ${bytes}`)
  if (hash !== expected.sha256) throw new Error(`${label} SHA-256 mismatch: ${hash}`)
  process.stdout.write(`Verified ${label}: ${bytes} bytes, ${hash}\n`)
}
async function download(url, path, maximumSeconds = '1200') {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', maximumSeconds,
    '--user-agent', 'HeadUp-Research-Menton-V13/1.0', '--output', path, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}
async function safeListing(path, maximumBuffer = 64 * 1024 * 1024) {
  const { stdout } = await execFileAsync('tar.exe', ['-tf', path], { maxBuffer: maximumBuffer })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\')
    || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe archive entry: ${unsafe}`)
  return entries
}
function runStreaming(executable, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { ...options, stdio: 'inherit' })
    child.on('error', rejectPromise)
    child.on('exit', (code, signal) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`V13 menton training failed with code ${code}, signal ${signal}`)))
  })
}

if (!(await exists(v1Path))) throw new Error('Retained Menpo39 V1 checkpoint is missing')
if (await digestFile(v1Path) !== '8e4d322881647a408ab05d98b0b9191d6e1b16695e06a493a227af5b01aa14dc') {
  throw new Error('Retained Menpo39 V1 checkpoint hash mismatch')
}
const pythonExecutable = process.env.HEADUP_PYTHON || ((await exists(bundledPython)) ? bundledPython : 'py')
const pythonPrefix = process.env.HEADUP_PYTHON || pythonExecutable === bundledPython ? [] : ['-3.11']

await rm(stagingDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
try {
  await download(sources.aflw2000Crops.url, aflwArchive)
  await verify(aflwArchive, sources.aflw2000Crops, 'AFLW2000 crop archive')
  await download(sources.merlRavLabels.url, merlArchive, '600')
  await verify(merlArchive, sources.merlRavLabels, 'MERL-RAV label archive')
  await download(sources.roiTransform.url, roiPath, '180')
  await verify(roiPath, sources.roiTransform, '3DDFA ROI tensor')
  await download(sources.coordinateRegistrationReference.url, referencePath, '180')
  await verify(referencePath, sources.coordinateRegistrationReference, '3DDFA coordinate-registration reference')
  const aflwEntries = await safeListing(aflwArchive)
  if (aflwEntries.length !== sources.aflw2000Crops.expectedEntries) throw new Error('AFLW2000 entry count mismatch')
  const merlEntries = await safeListing(merlArchive)
  const labelCount = merlEntries.filter((entry) => /\/labels\/image\d+(?:_\d+)?\.pts$/i.test(entry)).length
  if (labelCount !== sources.merlRavLabels.expectedLabels) throw new Error(`MERL-RAV label count mismatch: ${labelCount}`)
  await execFileAsync('tar.exe', [
    '-xf', aflwArchive, '-C', extractDir,
    'test.data/AFLW2000-3D_crop.list', 'test.data/AFLW2000-3D_crop/',
  ], { maxBuffer: 5 * 1024 * 1024 })
  await execFileAsync('tar.exe', ['-xf', merlArchive, '-C', extractDir], { maxBuffer: 5 * 1024 * 1024 })
  await rm(aflwArchive, { force: true })
  await rm(merlArchive, { force: true })
  await writeFile(sourcePath, `${JSON.stringify(sources, null, 2)}\n`, 'utf8')
  await mkdir(runtimeDir, { recursive: true })
  await execFileAsync(pythonExecutable, [
    ...pythonPrefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--target', runtimeDir,
    'torch==2.7.1', 'torchvision==0.22.1', 'opencv-python-headless==4.12.0.88',
    'pillow==11.3.0', 'setuptools==80.9.0',
  ], { maxBuffer: 30 * 1024 * 1024, timeout: 1_200_000 })
  const labelsRoot = join(
    extractDir, 'MERL-RAV_dataset-6e68cc8d009924b31b4b96d01579017dc28b00cf', 'merl_rav_labels',
  )
  await runStreaming(pythonExecutable, [
    ...pythonPrefix,
    join(projectDir, 'scripts', 'train-merlrav-menton-channel.py'),
    join(extractDir, 'test.data', 'AFLW2000-3D_crop'),
    join(extractDir, 'test.data', 'AFLW2000-3D_crop.list'),
    roiPath,
    referencePath,
    labelsRoot,
    v1Path,
    bestPath,
    researchPath,
    resultPath,
    sourcePath,
  ], {
    cwd: projectDir,
    env: {
      ...process.env,
      PYTHONPATH: [runtimeDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      TORCH_HOME: join(stagingDir, 'torch-cache'),
    },
  })
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
