import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dbDir = fileURLToPath(new URL('../data/face-db/', import.meta.url))
const catalog = JSON.parse(await readFile(join(dbDir, 'sources.json'), 'utf8'))
const sourceMap = new Map(catalog.sources.map((source) => [source.id, source]))
const lines = (await readFile(join(dbDir, 'manifest.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean)
const records = lines.map((line, index) => {
  try { return JSON.parse(line) } catch { throw new Error(`Invalid JSON at manifest line ${index + 1}`) }
})

const forbiddenKeys = new Set(['identity', 'name', 'account', 'race', 'ethnicity', 'health', 'diagnosis', 'attractiveness', 'social_value'])
const hashes = new Set()
const errors = []
for (const record of records) {
  const source = sourceMap.get(record.sourceId)
  if (!source || !source.downloadEnabled || source.commercialDecision === 'blocked') errors.push(`${record.id}: blocked or unknown source`)
  if (record.subjectType !== 'synthetic') errors.push(`${record.id}: non-synthetic subject`)
  if (!record.technicalClassification) errors.push(`${record.id}: missing technical classification`)
  for (const key of Object.keys(record)) if (forbiddenKeys.has(key)) errors.push(`${record.id}: forbidden field ${key}`)
  if (hashes.has(record.sha256)) errors.push(`${record.id}: duplicate sha256`)
  hashes.add(record.sha256)
  const filePath = join(dbDir, record.relativePath)
  try {
    const bytes = await readFile(filePath)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== record.sha256) errors.push(`${record.id}: checksum mismatch`)
    const fileStat = await stat(filePath)
    if (fileStat.size !== record.bytes) errors.push(`${record.id}: byte size mismatch`)
  } catch {
    errors.push(`${record.id}: missing image`)
  }
}

function countsBy(select) {
  return Object.fromEntries([...new Set(records.map(select))].map((value) => [value, records.filter((record) => select(record) === value).length]))
}

const summary = {
  policyVersion: catalog.policyVersion,
  records: records.length,
  sources: [...new Set(records.map((record) => record.sourceId))],
  partitions: countsBy((record) => record.partition),
  qualityStatus: countsBy((record) => record.qualityStatus),
  aspect: countsBy((record) => record.technicalClassification?.aspect || 'missing'),
  brightnessBands: countsBy((record) => record.technicalClassification?.brightnessBand || 'missing'),
  poseWeakLabels: countsBy((record) => record.poseWeakLabel),
  errors,
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
if (errors.length) process.exitCode = 1
