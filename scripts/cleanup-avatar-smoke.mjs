import { readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const avatarRoot = resolve(projectDir, 'data', 'face-db-real-research', 'avatar-smoke')
const entries = await readdir(avatarRoot, { withFileTypes: true })
const targets = [join(avatarRoot, 'images'), join(avatarRoot, 'ping-pravatar.jpg')]
for (const entry of entries) if (entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name)) targets.push(join(avatarRoot, entry.name, 'images'))

for (const target of targets) {
  const relativeTarget = relative(avatarRoot, resolve(target))
  const safe = !isAbsolute(relativeTarget) && !relativeTarget.startsWith('..') && (
    relativeTarget === 'images'
    || relativeTarget === 'ping-pravatar.jpg'
    || /^[a-z0-9-]+[\\/]images$/.test(relativeTarget)
  )
  if (!safe) throw new Error(`拒绝清理不安全路径: ${target}`)
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}

const remaining = []
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await scan(path)
    else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) remaining.push(path)
  }
}
await scan(avatarRoot)
if (remaining.length) throw new Error(`头像原图清理未完成: ${remaining.join(', ')}`)
process.stdout.write(`${JSON.stringify({ avatarRoot, cleanupVerified: true, remainingImages: 0 }, null, 2)}\n`)
