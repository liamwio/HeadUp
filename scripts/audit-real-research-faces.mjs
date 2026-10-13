import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dbDir = fileURLToPath(new URL('../data/face-db-real-research/', import.meta.url))
const config = JSON.parse(await readFile(join(dbDir, 'sources.json'), 'utf8'))
const records = (await readFile(join(dbDir, 'manifest.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const errors = []
const forbidden = new Set(config.prohibitedLabels.map((key) => key.toLowerCase()))

function scanKeys(value, path = '') {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/g, '')
    if (forbidden.has(normalized)) errors.push(`Forbidden field at ${path}${key}`)
    scanKeys(child, `${path}${key}.`)
  }
}

if (!config.researchOnly || !config.localOnly) errors.push('Database must remain researchOnly and localOnly')
if (new Date(config.expiresAt + 'T23:59:59Z') < new Date()) errors.push(`Database expired on ${config.expiresAt}`)
if (records.length !== 306) errors.push(`Expected 306 records, found ${records.length}`)

const subjects = new Map()
const hashes = new Set()
for (const record of records) {
  scanKeys(record)
  if (record.subjectType !== 'real-consented-adult-research-participant') errors.push(`Invalid subject type: ${record.id}`)
  if (record.policyVersion !== config.policyVersion) errors.push(`Policy mismatch: ${record.id}`)
  if (!['front', 'left_profile', 'right_profile'].includes(record.view)) errors.push(`Unexpected view: ${record.id}`)
  if (record.expression !== 'neutral') errors.push(`Unexpected expression: ${record.id}`)
  if (!record.technicalClassification) errors.push(`Unclassified record: ${record.id}`)
  if (record.width !== 1350 || record.height !== 1350) errors.push(`Unexpected dimensions: ${record.id}`)
  if (hashes.has(record.sha256)) errors.push(`Duplicate image hash: ${record.id}`)
  hashes.add(record.sha256)

  const state = subjects.get(record.pseudonymousSubjectId) || { views: new Set(), partitions: new Set() }
  state.views.add(record.view)
  state.partitions.add(record.partition)
  subjects.set(record.pseudonymousSubjectId, state)

  const path = join(dbDir, record.relativePath)
  try {
    const bytes = await readFile(path)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== record.sha256) errors.push(`SHA-256 mismatch: ${record.id}`)
  } catch {
    errors.push(`Missing image: ${record.relativePath}`)
  }
}

if (subjects.size !== 102) errors.push(`Expected 102 subjects, found ${subjects.size}`)
for (const [subject, state] of subjects) {
  if (state.views.size !== 3) errors.push(`Incomplete views for ${subject}`)
  if (state.partitions.size !== 1) errors.push(`Partition leakage for ${subject}`)
}
for (const excluded of config.sources[0].excludedFiles) {
  try {
    await access(join(dbDir, excluded))
    errors.push(`Excluded sensitive metadata file exists: ${excluded}`)
  } catch {}
}

const counts = (key) => Object.fromEntries(Object.entries(Object.groupBy(records, (record) => record[key])).map(([name, rows]) => [name, rows.length]))
const result = {
  ok: errors.length === 0,
  policyVersion: config.policyVersion,
  expiresAt: config.expiresAt,
  subjects: subjects.size,
  images: records.length,
  views: counts('view'),
  partitions: counts('partition'),
  quality: counts('qualityStatus'),
  errors,
}
await writeFile(join(dbDir, 'audit-result.json'), JSON.stringify({ ...result, auditedAt: new Date().toISOString() }, null, 2) + '\n')
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (errors.length) process.exitCode = 1
