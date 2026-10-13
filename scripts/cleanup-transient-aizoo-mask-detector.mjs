import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'aizoo-mask-detector')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe AIZOO mask staging path')
await rm(stagingDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
process.stdout.write('Removed AIZOO model, Python runtime, all downloaded images, manifests and per-image scores.\n')
