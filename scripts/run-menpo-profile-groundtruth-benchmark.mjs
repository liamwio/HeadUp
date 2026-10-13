import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'menpo-profile-groundtruth')
const archivePath = join(stagingDir, 'menpo_challenge_trainset.zip')
const extractDir = join(stagingDir, 'extract')
const runtimeDir = join(stagingDir, 'python-runtime')
const menpoUrl = 'https://drive.usercontent.google.com/download?id=1CUqs0n135lye6J6RM5FQXT_DIT45dKvP&export=download&confirm=t'
const expectedMenpoArchiveSha256 = '2b702bc178e88e1802506e1e7c4c5b78a07b86a4854b7918de3e040532723ea4'
const models = {
  omz35: { name: 'facial-landmarks-35-adas-0002', xml: '85c5bbc71d0cdb4e815b64507ac5d0d5355f3d5faaca54b575743415a3df7ca4', bin: 'caf9b17a7dea89984f07a5c903bab256208c832a19b1cc2b3b675e2d534e24f5' },
  omz98: { name: 'facial-landmarks-98-detection-0001', xml: '71d4c898728e85a8c3b1085c5b55e87852611b28ba18de5b91c610d1102f7117', bin: 'b1df418f590fdebbfcbfabb05ba57e0e25b5b68b55d91c107a3a62f548bcf621' },
}
const resultPath = join(projectDir, 'data', 'face-benchmark', 'menpo-profile-groundtruth-result.json')
const pythonExecutable = process.env.HEADUP_PYTHON || 'py'
const pythonPrefix = process.env.HEADUP_PYTHON ? [] : ['-3.11']

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe staging path')
async function download(url, path, maximumSeconds = '900') {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', maximumSeconds, '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', path, url], { maxBuffer: 2 * 1024 * 1024 })
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

await rm(stagingDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
try {
  await download(menpoUrl, archivePath)
  const archiveBytes = await readFile(archivePath)
  const archiveSha256 = digest(archiveBytes)
  if (archiveSha256 !== expectedMenpoArchiveSha256) throw new Error(`Menpo archive checksum mismatch: ${archiveSha256}`)
  process.stdout.write(`Verified Menpo archive transport hash: ${archiveSha256}\n`)
  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 50 * 1024 * 1024 })
  const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe Menpo archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir], { maxBuffer: 5 * 1024 * 1024 })
  await rm(archivePath, { force: true })

  const modelPaths = {}
  for (const [key, model] of Object.entries(models)) {
    const base = `https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/${model.name}/FP32`
    const xmlPath = join(stagingDir, `${model.name}.xml`)
    const binPath = join(stagingDir, `${model.name}.bin`)
    await Promise.all([download(`${base}/${model.name}.xml`, xmlPath, '180'), download(`${base}/${model.name}.bin`, binPath, '180')])
    const [xmlBytes, binBytes] = await Promise.all([readFile(xmlPath), readFile(binPath)])
    if (digest(xmlBytes) !== model.xml || digest(binBytes) !== model.bin) throw new Error(`${model.name} checksum mismatch`)
    modelPaths[key] = { xmlPath, binPath }
  }
  await execFileAsync(pythonExecutable, [...pythonPrefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--target', runtimeDir, 'openvino==2025.4.1', 'opencv-python-headless==4.12.0.88', 'numpy==2.2.6'], { maxBuffer: 20 * 1024 * 1024 })
  const { stdout, stderr } = await execFileAsync(pythonExecutable, [
    ...pythonPrefix, join(projectDir, 'scripts', 'benchmark-menpo-profile-groundtruth.py'), extractDir,
    modelPaths.omz35.xmlPath, modelPaths.omz35.binPath, modelPaths.omz98.xmlPath, modelPaths.omz98.binPath, resultPath,
  ], { env: { ...process.env, PYTHONPATH: runtimeDir, HEADUP_MENPO_ARCHIVE_SHA256: archiveSha256 }, maxBuffer: 30 * 1024 * 1024 })
  if (stderr.trim()) process.stderr.write(stderr)
  process.stdout.write(stdout)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
