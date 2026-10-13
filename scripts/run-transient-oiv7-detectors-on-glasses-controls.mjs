import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const detectorDir = join(projectDir, 'data', 'face-benchmark', '.staging', 'oiv7-sunglasses-detector')
const runtimeDir = join(detectorDir, 'python-runtime')
const manifest = JSON.parse(await readFile(join(detectorDir, 'manifest.json'), 'utf8'))
const script = join(projectDir, 'scripts', 'benchmark-oiv7-detectors-on-glasses-controls.py')
const { stdout, stderr } = await execFileAsync(manifest.python.executable, [...manifest.python.prefixArgs, script], {
  cwd: projectDir,
  env: { ...process.env, PYTHONPATH: runtimeDir, YOLO_CONFIG_DIR: detectorDir },
  maxBuffer: 20 * 1024 * 1024,
  timeout: 20 * 60_000,
})
if (stderr) process.stderr.write(stderr)
process.stdout.write(stdout)
