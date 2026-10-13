import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'physical-replay')

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) {
  throw new Error('Unsafe physical-replay staging path')
}

await rm(stagingDir, { recursive: true, force: true })
process.stdout.write('Removed all transient physical replay videos and their manifest.\n')
