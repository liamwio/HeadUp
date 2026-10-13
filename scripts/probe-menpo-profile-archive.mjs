import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'menpo-profile-probe')
const archivePath = join(stagingDir, 'menpo_challenge_trainset.zip')
const url = 'https://drive.usercontent.google.com/download?id=1CUqs0n135lye6J6RM5FQXT_DIT45dKvP&export=download&confirm=t'

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', archivePath, url], { maxBuffer: 2 * 1024 * 1024 })
  const { stdout } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 50 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const extensions = Object.groupBy(entries, (entry) => /\.([^.\/]+)$/.exec(entry)?.[1]?.toLowerCase() || '<directory>')
  process.stdout.write(JSON.stringify({
    entries: entries.length,
    byExtension: Object.fromEntries(Object.entries(extensions).map(([extension, items]) => [extension, items.length])),
    firstEntries: entries.slice(0, 60),
  }, null, 2) + '\n')
} finally {
  await rm(stagingDir, { recursive: true, force: true })
}
