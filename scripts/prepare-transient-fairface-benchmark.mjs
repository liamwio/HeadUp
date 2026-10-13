import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'fairface')
const parquetPath = join(stagingDir, 'fairface-validation-0.25.parquet')
const sampleDir = join(stagingDir, 'sample')
const manifestPath = join(stagingDir, 'sample-manifest.json')
const runtimeDir = join(stagingDir, 'pyarrow-runtime')
const extractor = join(projectDir, 'scripts', 'extract-transient-fairface-sample.py')
const sourceUrl = 'https://huggingface.co/datasets/HuggingFaceM4/FairFace/resolve/7ffbb95b9e83dadbe0c61f001b06a43ea6225370/0.25/validation/0000.parquet'
const expectedBytes = 63189799
const expectedSha256 = 'd0cfac2888356b3d3fa3d837bc30961d8c860934e4c5df862e8cb87812bfa137'

async function resolveCompatiblePython() {
  const candidates = process.env.HEADUP_PYTHON
    ? [{ executable: process.env.HEADUP_PYTHON, prefixArgs: [] }]
    : process.platform === 'win32'
      ? [
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
          { executable: 'python', prefixArgs: [] },
        ]

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.executable, [
        ...candidate.prefixArgs,
        '-c',
        'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")',
      ], { maxBuffer: 1024 * 1024 })
      const [major, minor] = stdout.trim().split('.').map(Number)
      if (major === 3 && minor >= 10 && minor <= 13) {
        return { ...candidate, version: stdout.trim() }
      }
    } catch {
      // Try the next interpreter. PyArrow 21 has no CPython 3.14 wheel.
    }
  }

  throw new Error(
    'FairFace preparation requires CPython 3.10-3.13. Set HEADUP_PYTHON to a compatible interpreter.',
  )
}

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe FairFace staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })

try {
  const python = await resolveCompatiblePython()
  const runPython = (args, options = {}) => execFileAsync(
    python.executable,
    [...python.prefixArgs, ...args],
    options,
  )

  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', parquetPath, sourceUrl,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const parquet = await readFile(parquetPath)
  if (parquet.byteLength !== expectedBytes) throw new Error(`FairFace parquet size mismatch: ${parquet.byteLength}`)
  const sha256 = createHash('sha256').update(parquet).digest('hex')
  if (sha256 !== expectedSha256) throw new Error(`FairFace parquet checksum mismatch: ${sha256}`)

  await runPython([
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--quiet', '--only-binary=:all:',
    '--target', runtimeDir, 'pyarrow==21.0.0',
  ], { maxBuffer: 10 * 1024 * 1024 })
  const { stdout } = await runPython([extractor, parquetPath, sampleDir, manifestPath, '15'], {
    env: { ...process.env, PYTHONPATH: runtimeDir },
    maxBuffer: 2 * 1024 * 1024,
  })
  await rm(parquetPath, { force: true })
  await rm(runtimeDir, { recursive: true, force: true })
  process.stdout.write(`${stdout.trim()}\n`)
  process.stdout.write(`Used CPython ${python.version}.\n`)
  process.stdout.write(`Verified source SHA-256 ${sha256}; removed source parquet and PyArrow runtime.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
