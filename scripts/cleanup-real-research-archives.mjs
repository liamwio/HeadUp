import { readFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dbDir = resolve(fileURLToPath(new URL('../data/face-db-real-research/', import.meta.url)))
const stagingDir = resolve(join(dbDir, '.staging'))
const allowedRoot = stagingDir + sep
const config = JSON.parse(await readFile(join(dbDir, 'sources.json'), 'utf8'))
const removed = []

for (const selected of config.sources[0].selectedFiles) {
  const target = resolve(stagingDir, selected.name)
  if (!target.startsWith(allowedRoot)) throw new Error(`Refusing to remove outside staging: ${target}`)
  await rm(target, { force: true })
  removed.push(target)
}

process.stdout.write(JSON.stringify({ removed, retainedDatabaseImages: true }, null, 2) + '\n')
