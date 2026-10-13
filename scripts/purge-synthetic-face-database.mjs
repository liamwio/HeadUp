import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.argv.includes('--confirm')) {
  process.stderr.write('Refusing to purge without --confirm. Run: pnpm data:purge -- --confirm\n')
  process.exit(2)
}

const dbDir = resolve(fileURLToPath(new URL('../data/face-db/', import.meta.url)))
const allowedRoot = dbDir + sep
const targets = [
  join(dbDir, 'images'),
  join(dbDir, '.staging'),
  join(dbDir, 'manifest.jsonl'),
  join(dbDir, 'face-database.sqlite'),
  join(dbDir, 'face-database.sqlite-shm'),
  join(dbDir, 'face-database.sqlite-wal'),
]

for (const target of targets) {
  const resolved = resolve(target)
  if (!resolved.startsWith(allowedRoot)) throw new Error(`Refusing to purge outside database directory: ${resolved}`)
  await rm(resolved, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ purged: targets, retained: ['sources.json', 'DATA_CARD.md'] }, null, 2)}\n`)
