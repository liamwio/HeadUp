import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'silent-face-pad')
const repoDir = join(stagingDir, 'repo')
const sourceArchivePath = join(stagingDir, 'source.tar.gz')
const runtimeDir = join(stagingDir, 'python-runtime')
const scoresPath = join(stagingDir, 'scores.json')
const manifestPath = join(stagingDir, 'manifest.json')
const physicalManifestPath = join(stagingRoot, 'physical-replay', 'manifest.json')
const londonDir = join(projectDir, 'data', 'face-db-real-research', 'images', 'face-research-lab-london-v5')
const sourceCommit = 'b6d5f04ad78778917853b25c778acef6d5626d15'
const verifiedAssets = [
  { path: 'resources/anti_spoof_models/2.7_80x80_MiniFASNetV2.pth', bytes: 1849453, sha256: 'a5eb02e1843f19b5386b953cc4c9f011c3f985d0ee2bb9819eea9a142099bec0' },
  { path: 'resources/anti_spoof_models/4_0_0_80x80_MiniFASNetV1SE.pth', bytes: 1856130, sha256: '84ee1d37d96894d5e82de5a57df044ef80a58be2b218b5ed7cdfd875ec2f5990' },
  { path: 'resources/detection_model/Widerface-RetinaFace.caffemodel', bytes: 1866013, sha256: 'd08338a2c207df16a9c566f767fea67fb43ba6fff76ce11e938fe3fabefb9402' },
  { path: 'resources/detection_model/deploy.prototxt', bytes: 40787, sha256: '9fe2f141b4baee039ed9442da2833e216af40a6ff3e639e7b39258812bcda808' },
]

async function resolveCompatiblePython() {
  const bundled = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')
    : undefined
  const candidates = process.env.HEADUP_PYTHON
    ? [{ executable: process.env.HEADUP_PYTHON, prefixArgs: [] }]
    : process.platform === 'win32'
      ? [
          ...(bundled ? [{ executable: bundled, prefixArgs: [] }] : []),
          { executable: 'py', prefixArgs: ['-3.13'] }, { executable: 'py', prefixArgs: ['-3.12'] },
          { executable: 'py', prefixArgs: ['-3.11'] }, { executable: 'py', prefixArgs: ['-3.10'] },
        ]
      : [
          { executable: 'python3.13', prefixArgs: [] }, { executable: 'python3.12', prefixArgs: [] },
          { executable: 'python3.11', prefixArgs: [] }, { executable: 'python3.10', prefixArgs: [] },
        ]
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.executable, [...candidate.prefixArgs, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'])
      const [major, minor] = stdout.trim().split('.').map(Number)
      if (major === 3 && minor >= 10 && minor <= 13) return { ...candidate, version: stdout.trim() }
    } catch { /* next */ }
  }
  throw new Error('Silent-Face research evaluation requires CPython 3.10-3.13; set HEADUP_PYTHON')
}

async function digestFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe Silent-Face staging path')

try {
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  await mkdir(repoDir, { recursive: true })
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '300', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', sourceArchivePath, `https://codeload.github.com/minivision-ai/Silent-Face-Anti-Spoofing/tar.gz/${sourceCommit}`,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const { stdout: archiveListing } = await execFileAsync('tar.exe', ['-tf', sourceArchivePath], { maxBuffer: 20 * 1024 * 1024 })
  const archivePrefix = archiveListing.split(/\r?\n/).find(Boolean)?.split('/')[0]
  if (!archivePrefix?.endsWith(sourceCommit)) throw new Error(`Unexpected Silent-Face archive prefix: ${archivePrefix}`)
  await execFileAsync('tar.exe', [
    '-xf', sourceArchivePath, '-C', repoDir, '--strip-components=1',
    `${archivePrefix}/src`, `${archivePrefix}/resources`, `${archivePrefix}/LICENSE`, `${archivePrefix}/README.md`,
  ], { maxBuffer: 20 * 1024 * 1024 })
  await rm(sourceArchivePath, { force: true })
  for (const asset of verifiedAssets) {
    const path = join(repoDir, ...asset.path.split('/'))
    const fileStat = await stat(path)
    const sha256 = await digestFile(path)
    if (fileStat.size !== asset.bytes || sha256 !== asset.sha256) throw new Error(`Silent-Face asset mismatch: ${asset.path}`)
  }

  const python = await resolveCompatiblePython()
  const runPython = (args, options = {}) => execFileAsync(python.executable, [...python.prefixArgs, ...args], options)
  process.stdout.write('Installing transient CPU inference runtime; it will be deleted after the benchmark.\n')
  await runPython([
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--quiet', '--target', runtimeDir,
    '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.8.0',
  ], { maxBuffer: 30 * 1024 * 1024, env: { ...process.env, PIP_NO_CACHE_DIR: '1' } })
  await runPython([
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--quiet', '--target', runtimeDir,
    'numpy==2.2.6', 'opencv-python-headless==4.12.0.88',
  ], { maxBuffer: 30 * 1024 * 1024, env: { ...process.env, PIP_NO_CACHE_DIR: '1' } })
  await import('./prepare-transient-physical-replay-benchmark.mjs')
  const environment = { ...process.env, PYTHONPATH: [runtimeDir, repoDir].join(delimiter), PIP_NO_CACHE_DIR: '1' }
  const { stdout: scoringOutput } = await execFileAsync(python.executable, [...python.prefixArgs,
    join(projectDir, 'scripts', 'run-silent-face-pad-scores.py'),
    '--repo', repoDir, '--london', londonDir, '--physical-manifest', physicalManifestPath, '--output', scoresPath,
  ], { cwd: repoDir, env: environment, maxBuffer: 20 * 1024 * 1024 })
  process.stdout.write(scoringOutput)

  const scores = JSON.parse(await readFile(scoresPath, 'utf8'))
  if (scores.bonaFideScores.length !== 102 || scores.videoScores.length !== 6 || scores.videoScores.some((values) => values.length !== 6)) {
    throw new Error('Silent-Face score output count mismatch')
  }
  const londonFiles = (await readdir(londonDir)).filter((name) => /^\d{3}_front\.jpg$/i.test(name)).sort()
  const physicalManifest = JSON.parse(await readFile(physicalManifestPath, 'utf8'))
  const engineeringVideoSlots = new Set([0, 2, 4])
  const bonaFideRecords = londonFiles.map((name, index) => ({
    split: index < 85 ? 'engineering' : 'holdout',
    assetUrl: `/@fs/${join(londonDir, name).replaceAll('\\', '/')}`,
    spoofScore: scores.bonaFideScores[index],
  }))
  const replayRecords = physicalManifest.samples.map((sample, index) => ({
    split: engineeringVideoSlots.has(index) ? 'engineering' : 'holdout',
    captureGroup: sample.captureGroup,
    assetUrl: `/@fs/${join(stagingRoot, 'physical-replay', sample.relativePath).replaceAll('\\', '/')}`,
    bytes: sample.bytes,
    sha256: sample.sha256,
    spoofScores: scores.videoScores[index],
  }))
  await writeFile(manifestPath, `${JSON.stringify({
    policyVersion: 'HEADUP-SILENT-FACE-PREPARE-1.0',
    model: {
      name: 'Minivision Silent-Face MiniFASNet V2 + V1SE ensemble',
      sourcePage: 'https://github.com/minivision-ai/Silent-Face-Anti-Spoofing', sourceCommit,
      license: 'Apache-2.0', verifiedAssets, runtime: scores.runtime,
      input: 'Official RetinaFace box with 2.7x and 4.0x BGR crops; 80x80; official ToTensor',
      output: 'Three classes; class 1 is real; spoofScore = 1 - mean(class1 probability)',
      officialClaim: 'APK model TPR 97.8% at FPR 1e-5; repository warns camera/device domain affects results',
    },
    source: {
      bonaFide: 'Face Research Lab London Set, authorized local research fronts',
      attacks: physicalManifest.source, attackSourceCommit: physicalManifest.sourceCommit, attackLicense: physicalManifest.license,
    },
    sampleFractions: scores.sampleFractions,
    bonaFideRecords, replayRecords,
    temporaryIndividualScores: true,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared Silent-Face scores with Python ${python.version}; individual scores remain transient until cleanup.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  await rm(join(stagingRoot, 'physical-replay'), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  throw error
}
