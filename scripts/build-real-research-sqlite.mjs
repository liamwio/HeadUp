import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const dbDir = fileURLToPath(new URL('../data/face-db-real-research/', import.meta.url))
const databasePath = join(dbDir, 'real-research-face-database.sqlite')
const config = JSON.parse(readFileSync(join(dbDir, 'sources.json'), 'utf8'))
const records = readFileSync(join(dbDir, 'manifest.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const source = config.sources[0]

if (records.some((record) => !record.technicalClassification)) {
  throw new Error('Manifest contains unclassified records. Run pnpm data:real:classify first.')
}
if (existsSync(databasePath)) rmSync(databasePath)

const database = new DatabaseSync(databasePath)
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    article_id INTEGER NOT NULL,
    article_version INTEGER NOT NULL,
    publisher TEXT NOT NULL,
    source_url TEXT NOT NULL,
    license TEXT NOT NULL,
    license_url TEXT NOT NULL,
    consent_basis TEXT NOT NULL,
    attribution TEXT NOT NULL
  ) STRICT;
  CREATE TABLE subjects (
    id TEXT PRIMARY KEY,
    partition_name TEXT NOT NULL CHECK (partition_name IN ('engineering_qa', 'holdout')),
    source_id TEXT NOT NULL REFERENCES sources(id)
  ) STRICT;
  CREATE TABLE images (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES subjects(id),
    source_id TEXT NOT NULL REFERENCES sources(id),
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type = 'image/jpeg'),
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    view_name TEXT NOT NULL CHECK (view_name IN ('front', 'left_profile', 'right_profile')),
    expression_name TEXT NOT NULL CHECK (expression_name = 'neutral'),
    resolution_tier TEXT NOT NULL,
    brightness REAL NOT NULL,
    brightness_band TEXT NOT NULL,
    contrast REAL NOT NULL,
    contrast_band TEXT NOT NULL,
    sharpness REAL NOT NULL,
    sharpness_band TEXT NOT NULL,
    entropy REAL NOT NULL,
    aspect TEXT NOT NULL,
    quality_status TEXT NOT NULL CHECK (quality_status IN ('pass', 'review')),
    collected_at TEXT NOT NULL,
    classified_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    policy_version TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_images_subject ON images(subject_id);
  CREATE INDEX idx_images_view_quality ON images(view_name, quality_status);
  CREATE INDEX idx_subjects_partition ON subjects(partition_name);
`)

database.exec('BEGIN')
const insertMetadata = database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
insertMetadata.run('policyVersion', config.policyVersion)
insertMetadata.run('researchOnly', String(config.researchOnly))
insertMetadata.run('localOnly', String(config.localOnly))
insertMetadata.run('expiresAt', config.expiresAt)
insertMetadata.run('builtAt', new Date().toISOString())
insertMetadata.run('recordCount', String(records.length))

database.prepare(`
  INSERT INTO sources (id, name, article_id, article_version, publisher, source_url, license, license_url, consent_basis, attribution)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  source.id, source.name, source.articleId, source.articleVersion, source.publisher, source.sourceUrl,
  source.license, source.licenseUrl, source.consentBasis, source.attribution,
)

const insertSubject = database.prepare('INSERT INTO subjects (id, partition_name, source_id) VALUES (?, ?, ?)')
const subjectPartitions = new Map()
for (const record of records) subjectPartitions.set(record.pseudonymousSubjectId, record.partition)
for (const [subjectId, partition] of subjectPartitions) insertSubject.run(subjectId, partition, source.id)

const insertImage = database.prepare(`
  INSERT INTO images (
    id, subject_id, source_id, relative_path, sha256, bytes, mime_type, width, height,
    view_name, expression_name, resolution_tier, brightness, brightness_band, contrast,
    contrast_band, sharpness, sharpness_band, entropy, aspect, quality_status,
    collected_at, classified_at, expires_at, policy_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
for (const record of records) {
  const tech = record.technicalClassification
  insertImage.run(
    record.id, record.pseudonymousSubjectId, record.sourceId, record.relativePath, record.sha256,
    record.bytes, record.mimeType, record.width, record.height, record.view, record.expression,
    record.resolutionTier, tech.brightness, tech.brightnessBand, tech.contrast, tech.contrastBand,
    tech.sharpness, tech.sharpnessBand, tech.entropy, tech.aspect, record.qualityStatus,
    record.collectedAt, record.classifiedAt, record.expiresAt, record.policyVersion,
  )
}
database.exec('COMMIT')

const summary = {
  databasePath,
  subjects: database.prepare('SELECT COUNT(*) AS count FROM subjects').get().count,
  images: database.prepare('SELECT COUNT(*) AS count FROM images').get().count,
  byView: database.prepare('SELECT view_name AS view, COUNT(*) AS count FROM images GROUP BY view_name ORDER BY view_name').all(),
  byQuality: database.prepare('SELECT quality_status AS quality, COUNT(*) AS count FROM images GROUP BY quality_status ORDER BY quality_status').all(),
}
database.close()
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
