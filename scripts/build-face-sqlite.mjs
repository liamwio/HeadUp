import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const dbDir = fileURLToPath(new URL('../data/face-db/', import.meta.url))
const databasePath = join(dbDir, 'face-database.sqlite')
const sources = JSON.parse(readFileSync(join(dbDir, 'sources.json'), 'utf8'))
const records = readFileSync(join(dbDir, 'manifest.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

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
    dataset TEXT,
    subject_type TEXT NOT NULL,
    license_claim TEXT NOT NULL,
    commercial_decision TEXT NOT NULL CHECK (commercial_decision IN ('conditional', 'approved', 'blocked')),
    download_enabled INTEGER NOT NULL CHECK (download_enabled IN (0, 1)),
    legal_notes TEXT NOT NULL
  ) STRICT;
  CREATE TABLE faces (
    id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(id),
    source_row_index INTEGER NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type = 'synthetic'),
    consent_basis TEXT NOT NULL,
    license_decision TEXT NOT NULL,
    permitted_use_json TEXT NOT NULL,
    pose_weak_label TEXT NOT NULL,
    expression_weak_label TEXT NOT NULL,
    weak_label_basis TEXT NOT NULL,
    resolution_tier TEXT NOT NULL,
    brightness REAL NOT NULL,
    brightness_band TEXT NOT NULL,
    contrast REAL NOT NULL,
    contrast_band TEXT NOT NULL,
    sharpness REAL NOT NULL,
    sharpness_band TEXT NOT NULL,
    entropy REAL NOT NULL,
    aspect TEXT NOT NULL,
    dominant_tone TEXT NOT NULL,
    quality_status TEXT NOT NULL,
    partition_name TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    classified_at TEXT NOT NULL,
    policy_version TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_faces_source ON faces(source_id);
  CREATE INDEX idx_faces_partition_quality ON faces(partition_name, quality_status);
  CREATE INDEX idx_faces_pose ON faces(pose_weak_label);
`)

database.exec('BEGIN')
const insertMetadata = database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
insertMetadata.run('policyVersion', sources.policyVersion)
insertMetadata.run('builtAt', new Date().toISOString())
insertMetadata.run('recordCount', String(records.length))

const insertSource = database.prepare(`
  INSERT INTO sources (id, name, dataset, subject_type, license_claim, commercial_decision, download_enabled, legal_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
for (const source of sources.sources) {
  insertSource.run(source.id, source.name, source.dataset || null, source.subjectType, source.licenseClaim, source.commercialDecision, source.downloadEnabled ? 1 : 0, source.legalNotes)
}

const insertFace = database.prepare(`
  INSERT INTO faces (
    id, relative_path, sha256, bytes, mime_type, width, height, source_id, source_row_index,
    subject_type, consent_basis, license_decision, permitted_use_json, pose_weak_label,
    expression_weak_label, weak_label_basis, resolution_tier, brightness, brightness_band,
    contrast, contrast_band, sharpness, sharpness_band, entropy, aspect, dominant_tone,
    quality_status, partition_name, collected_at, classified_at, policy_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
for (const record of records) {
  const tech = record.technicalClassification
  insertFace.run(
    record.id, record.relativePath, record.sha256, record.bytes, record.mimeType, record.width, record.height,
    record.sourceId, record.sourceRowIndex, record.subjectType, record.consentBasis, record.licenseDecision,
    JSON.stringify(record.permittedUse), record.poseWeakLabel, record.expressionWeakLabel, record.weakLabelBasis,
    record.resolutionTier, tech.brightness, tech.brightnessBand, tech.contrast, tech.contrastBand,
    tech.sharpness, tech.sharpnessBand, tech.entropy, tech.aspect, tech.dominantTone,
    record.qualityStatus, record.partition, record.collectedAt, record.classifiedAt, record.policyVersion,
  )
}
database.exec('COMMIT')
const summary = database.prepare(`
  SELECT quality_status, COUNT(*) AS count
  FROM faces GROUP BY quality_status ORDER BY quality_status
`).all()
database.close()
process.stdout.write(JSON.stringify({ databasePath, records: records.length, quality: summary }, null, 2) + '\n')
