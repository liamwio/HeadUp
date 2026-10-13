import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'spiga-menpo-profile')
const repoDir = join(stagingDir, 'repo')
const runtimeDir = join(stagingDir, 'python-runtime')
const archivePath = join(stagingDir, 'menpo_challenge_trainset.zip')
const extractDir = join(stagingDir, 'extract')
const argumentsList = process.argv.slice(2)
const semanticCalibration = argumentsList.includes('--semantic-calibration')
const merlrav = argumentsList.includes('--merlrav')
if (semanticCalibration && merlrav) throw new Error('--semantic-calibration and --merlrav are mutually exclusive')
const unknownArguments = argumentsList.filter((argument) => !['--semantic-calibration', '--merlrav'].includes(argument))
if (unknownArguments.length) throw new Error(`Unknown arguments: ${unknownArguments.join(', ')}`)
const mode = merlrav ? 'merlrav' : semanticCalibration ? 'semantic-calibration' : 'groundtruth'
const resultNames = {
  groundtruth: 'spiga-menpo-profile-groundtruth-result.json',
  'semantic-calibration': 'spiga-menpo-profile-semantic-calibration-result.json',
  merlrav: 'spiga-merlrav-menpo-profile-groundtruth-result.json',
}
const benchmarkScripts = {
  groundtruth: 'benchmark-spiga-menpo-profile-groundtruth.py',
  'semantic-calibration': 'benchmark-spiga-menpo-profile-semantic-calibration.py',
  merlrav: 'benchmark-spiga-merlrav-menpo-profile-groundtruth.py',
}
const resultPath = join(projectDir, 'data', 'face-benchmark', resultNames[mode])
const benchmarkScript = join(projectDir, 'scripts', benchmarkScripts[mode])
const repositoryUrl = 'https://github.com/andresprados/SPIGA.git'
const repositoryCommit = '656f90a76a6800e6091bbce519550e86e04cf17f'
// Pinned official URLs from this repository commit's spiga/inference/config.py.
const weightName = merlrav ? 'spiga_merlrav.pt' : 'spiga_wflw.pt'
const weightPath = join(stagingDir, weightName)
const weightUrl = `https://huggingface.co/aprados/spiga/resolve/main/${weightName}?download=true`
const expectedWeightSha256 = merlrav
  ? '52559b750c07fcf8478c6b8f11ce79beda1c067b577ac6c6d9f2a06be73d0a18'
  : 'e9eee56e132c269c350225059a3ccc31b278b0bf7e3d475bbd38aebba2cac5b1'
const menpoUrl = 'https://drive.usercontent.google.com/download?id=1CUqs0n135lye6J6RM5FQXT_DIT45dKvP&export=download&confirm=t'
const expectedMenpoSha256 = '2b702bc178e88e1802506e1e7c4c5b78a07b86a4854b7918de3e040532723ea4'
const bundledPython = 'C:\\Users\\oliam\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe staging path')
async function digestFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function exists(path) {
  try { await access(path); return true } catch { return false }
}
const pythonExecutable = process.env.HEADUP_PYTHON || ((await exists(bundledPython)) ? bundledPython : 'py')
const pythonPrefix = process.env.HEADUP_PYTHON || pythonExecutable === bundledPython ? [] : ['-3.11']
async function download(url, path, maximumSeconds = '1200') {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', maximumSeconds, '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', path, url], { maxBuffer: 2 * 1024 * 1024 })
}

await mkdir(stagingDir, { recursive: true })
try {
  if (!(await exists(repoDir))) {
    await execFileAsync('git', ['clone', '--quiet', repositoryUrl, repoDir], { maxBuffer: 10 * 1024 * 1024 })
    await execFileAsync('git', ['checkout', '--quiet', repositoryCommit], { cwd: repoDir, maxBuffer: 10 * 1024 * 1024 })
  }
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
  if (head.trim() !== repositoryCommit) throw new Error(`Unexpected SPIGA commit: ${head.trim()}`)

  if (!(await exists(weightPath)) || await digestFile(weightPath) !== expectedWeightSha256) {
    await download(weightUrl, weightPath, '900')
  }
  if (await digestFile(weightPath) !== expectedWeightSha256) throw new Error('SPIGA weight checksum mismatch')
  process.stdout.write(`Verified SPIGA commit and weight: ${repositoryCommit} / ${expectedWeightSha256}\n`)

  if (!(await exists(join(runtimeDir, 'torch'))) || !(await exists(join(runtimeDir, 'cv2')))) {
    await mkdir(runtimeDir, { recursive: true })
    await execFileAsync(pythonExecutable, [...pythonPrefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--target', runtimeDir, 'torch==2.7.1', 'torchvision==0.22.1', 'opencv-python-headless==4.12.0.88', 'pillow==11.3.0', 'scipy==1.16.1', 'setuptools==80.9.0'], { maxBuffer: 30 * 1024 * 1024 })
  }

  await mkdir(extractDir, { recursive: true })
  await download(menpoUrl, archivePath)
  const archiveSha256 = await digestFile(archivePath)
  if (archiveSha256 !== expectedMenpoSha256) throw new Error(`Menpo archive checksum mismatch: ${archiveSha256}`)
  process.stdout.write(`Verified Menpo archive transport hash: ${archiveSha256}\n`)
  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 50 * 1024 * 1024 })
  const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe Menpo archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir], { maxBuffer: 5 * 1024 * 1024 })
  await rm(archivePath, { force: true })

  const { stdout, stderr } = await execFileAsync(pythonExecutable, [
    ...pythonPrefix, benchmarkScript,
    repoDir, weightPath, extractDir, resultPath, repositoryCommit,
  ], {
    env: {
      ...process.env,
      PYTHONPATH: [runtimeDir, repoDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      HEADUP_MENPO_ARCHIVE_SHA256: archiveSha256,
    },
    maxBuffer: 30 * 1024 * 1024,
  })
  if (stderr.trim()) process.stderr.write(stderr)
  process.stdout.write(stdout)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
