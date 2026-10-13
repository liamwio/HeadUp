import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const run = (args) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, args, { cwd: projectDir, windowsHide: true }, (error) => error ? reject(error) : resolve())
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
})
try {
  await run(['--max-old-space-size=4096', 'scripts/prepare-transient-demographic-coverage.mjs'])
  await run(['scripts/run-demographic-coverage-browser-benchmark.mjs'])
} finally {
  await run(['scripts/cleanup-transient-demographic-coverage.mjs'])
}
