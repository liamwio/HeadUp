import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingDir = join(projectDir, 'data', 'face-benchmark', '.staging', 'head-detector-eval')
const modelPath = join(stagingDir, 'yolov7_tiny_head_0.768_post_480x640.onnx')
const modelUrl = 'https://github.com/PINTO0309/DMHead/releases/download/1.1.2/yolov7_tiny_head_0.768_post_480x640.onnx'
const expectedSha256 = '2cec68f5272927cbccf6c4bd80ac6135cd5b453b239716f007563bb731ec98eb'
if (!resolve(stagingDir).startsWith(resolve(join(projectDir, 'data', 'face-benchmark', '.staging')))) throw new Error('Unsafe staging path')

await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '180', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', modelPath, modelUrl,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const sha256 = createHash('sha256').update(await readFile(modelPath)).digest('hex')
  if (sha256 !== expectedSha256) throw new Error(`Head detector checksum mismatch: ${sha256}`)
  const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/benchmark-head-detector.mjs', 'yolov7'], {
    cwd: projectDir,
    maxBuffer: 5 * 1024 * 1024,
  })
  process.stdout.write(stdout)
  process.stderr.write(stderr)
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
