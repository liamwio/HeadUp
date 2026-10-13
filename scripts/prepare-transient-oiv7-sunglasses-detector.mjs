import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'oiv7-sunglasses-detector')
const runtimeDir = join(stagingDir, 'python-runtime')
const modelPath = join(stagingDir, 'yolov8n-oiv7.pt')
const manifestPath = join(stagingDir, 'manifest.json')
const config = JSON.parse(await readFile(join(benchmarkDir, 'sources.json'), 'utf8'))
const source = config.sources.find((item) => item.id === 'ultralytics-yolov8n-oiv7-research-detector')

async function resolveCompatiblePython() {
  const bundled = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')
    : undefined
  const candidates = process.env.HEADUP_PYTHON
    ? [{ executable: process.env.HEADUP_PYTHON, prefixArgs: [] }]
    : process.platform === 'win32'
      ? [
          ...(bundled ? [{ executable: bundled, prefixArgs: [] }] : []),
          { executable: 'py', prefixArgs: ['-3.13'] },
          { executable: 'py', prefixArgs: ['-3.12'] },
          { executable: 'py', prefixArgs: ['-3.11'] },
          { executable: 'py', prefixArgs: ['-3.10'] },
          { executable: 'python', prefixArgs: [] },
        ]
      : [
          { executable: 'python3.13', prefixArgs: [] },
          { executable: 'python3.12', prefixArgs: [] },
          { executable: 'python3.11', prefixArgs: [] },
          { executable: 'python3.10', prefixArgs: [] },
          { executable: 'python3', prefixArgs: [] },
        ]
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.executable, [...candidate.prefixArgs, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'])
      const [major, minor] = stdout.trim().split('.').map(Number)
      if (major === 3 && minor >= 10 && minor <= 13) return { ...candidate, version: stdout.trim() }
    } catch { /* try next interpreter */ }
  }
  throw new Error('YOLO research evaluation requires CPython 3.10-3.13; set HEADUP_PYTHON to a compatible interpreter')
}

if (!source) throw new Error('YOLOv8n OIV7 source configuration is missing')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe YOLO research staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })

try {
  const python = await resolveCompatiblePython()
  const runPython = (args, options = {}) => execFileAsync(python.executable, [...python.prefixArgs, ...args], options)
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '300', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', modelPath, source.modelUrl,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const model = await readFile(modelPath)
  const modelSha256 = createHash('sha256').update(model).digest('hex')
  if (model.length !== source.modelBytes || modelSha256 !== source.modelSha256) throw new Error(`YOLO model verification failed: ${model.length} bytes, ${modelSha256}`)
  const additionalModels = []
  for (const candidate of source.additionalModels ?? []) {
    const candidatePath = join(stagingDir, `yolov8${candidate.variant}-oiv7.pt`)
    await execFileAsync('curl.exe', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
      '--connect-timeout', '20', '--max-time', '300', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
      '--output', candidatePath, candidate.url,
    ], { maxBuffer: 2 * 1024 * 1024 })
    const bytes = await readFile(candidatePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== candidate.bytes || sha256 !== candidate.sha256) throw new Error(`YOLOv8${candidate.variant} model verification failed`)
    additionalModels.push({ variant: candidate.variant, name: candidate.name, bytes: bytes.length, sha256 })
  }
  process.stdout.write(`Installing transient ${source.runtimePackage}; this runtime will be deleted after the benchmark.\n`)
  await runPython([
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--prefer-binary', '--quiet',
    '--target', runtimeDir, source.runtimePackage,
  ], { maxBuffer: 20 * 1024 * 1024 })
  const environment = { ...process.env, PYTHONPATH: runtimeDir, YOLO_CONFIG_DIR: stagingDir }
  const { stdout: verification } = await runPython([
    '-c',
    'import json, ultralytics, torch; from ultralytics import YOLO; m=YOLO(r"' + modelPath.replaceAll('\\', '\\\\') + '"); names=m.names; matches=[int(k) for k,v in names.items() if v=="Sunglasses"]; print(json.dumps({"ultralytics":ultralytics.__version__,"torch":torch.__version__,"sunglassesClassIds":matches}))',
  ], { env: environment, maxBuffer: 5 * 1024 * 1024 })
  const verifiedRuntime = JSON.parse(verification.trim().split(/\r?\n/).at(-1))
  if (verifiedRuntime.sunglassesClassIds.length !== 1) throw new Error('Sunglasses class is missing or ambiguous in the OIV7 model')
  await writeFile(manifestPath, `${JSON.stringify({
    model: source.name,
    sourcePage: source.sourcePage,
    modelSha256,
    modelBytes: model.length,
    additionalModels,
    runtimeRequested: source.runtimePackage,
    runtimeResolved: verifiedRuntime,
    python: { executable: python.executable, prefixArgs: python.prefixArgs, version: python.version },
    licenseBoundary: source.licenseBoundary,
    retention: { modelDeletedAfterRun: false, runtimeDeletedAfterRun: false },
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ python: python.version, ...verifiedRuntime, modelSha256 }, null, 2)}\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
