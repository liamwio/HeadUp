import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'cmu-sunglasses')

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe CMU sunglasses staging path')
await rm(stagingDir, { recursive: true, force: true })
process.stdout.write('Removed all transient CMU sunglasses/open images and their manifest.\n')
