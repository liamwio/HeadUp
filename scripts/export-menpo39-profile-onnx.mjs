import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingDir = join(projectDir, 'data', 'face-benchmark', '.staging', 'menpo39-onnx-export')
const runtimeDir = join(projectDir, 'data', 'face-benchmark', '.runtime', 'menpo39-onnx-export')
const markerPath = join(stagingDir, '.headup-profile-onnx-export.json')
const checkpoint = join(projectDir, 'data', 'face-benchmark', 'research-models', 'menpo39-mobilenetv3-small-research-only.pth')
const output = join(projectDir, 'public', 'models', 'menpo39-profile-v1.onnx')
const manifest = join(projectDir, 'public', 'models', 'menpo39-profile-v1.manifest.json')
const result = join(projectDir, 'data', 'face-benchmark', 'menpo39-onnx-export-result.json')
const converter = join(projectDir, 'scripts', 'export-menpo39-profile-onnx.py')
const python = process.env.HEADUP_PYTHON || 'py'
const prefix = process.env.HEADUP_PYTHON ? [] : ['-3.11']
const exists = async path => access(path, constants.F_OK).then(() => true, () => false)

await mkdir(runtimeDir, { recursive: true })
await mkdir(stagingDir, { recursive: true })
await writeFile(markerPath, JSON.stringify({ policyVersion: 'HEADUP-PROFILE-ONNX-STAGING-1.0', createdAt: new Date().toISOString() }, null, 2))
try {
  if (!(await exists(join(runtimeDir, 'torch'))) || !(await exists(join(runtimeDir, 'onnxruntime')))) {
    console.log('Preparing isolated ONNX export runtime...')
    await execFileAsync(python, [...prefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--target', runtimeDir,
      'torch==2.7.1', 'torchvision==0.22.1', 'onnx==1.18.0', 'onnxruntime==1.22.1', 'setuptools==80.9.0'], {
      maxBuffer: 30 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    })
  }
  await mkdir(dirname(output), { recursive: true })
  const { stdout, stderr } = await execFileAsync(python, [...prefix, converter, checkpoint, output, manifest, result], {
    env: { ...process.env, PYTHONPATH: [runtimeDir, process.env.PYTHONPATH].filter(Boolean).join(';') },
    maxBuffer: 30 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  })
  if (stderr.trim()) process.stderr.write(stderr)
  process.stdout.write(stdout)
  const parsed = JSON.parse(await readFile(result, 'utf8'))
  if (!parsed.passes) throw new Error('ONNX export result did not pass')
} finally {
  const marker = JSON.parse(await readFile(markerPath, 'utf8').catch(() => '{}'))
  if (marker.policyVersion === 'HEADUP-PROFILE-ONNX-STAGING-1.0') await rm(stagingDir, { recursive: true, force: true })
}
