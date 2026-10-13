import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceId = process.argv[2]
if (!sourceId || !/^[a-z0-9-]+$/.test(sourceId)) throw new Error('Provide a safe source id')
const dbDir = fileURLToPath(new URL('../data/face-db/', import.meta.url))
const imageRoot = resolve(dbDir, 'images')
const target = resolve(imageRoot, sourceId)
if (dirname(target) !== imageRoot) throw new Error('Target escaped image root')

const manifestPath = resolve(dbDir, 'manifest.jsonl')
const records = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const kept = records.filter((record) => record.sourceId !== sourceId)
const removed = records.length - kept.length
await writeFile(manifestPath, kept.map((record) => JSON.stringify(record)).join('\n') + (kept.length ? '\n' : ''))
await rm(target, { recursive: true, force: true })
process.stdout.write(JSON.stringify({ sourceId, removedRecords: removed, removedDirectory: target }, null, 2) + '\n')
