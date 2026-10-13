import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const dbDir = fileURLToPath(new URL('../data/face-db-real-research/', import.meta.url))
const manifestPath = join(dbDir, 'manifest.jsonl')
const reviewQueuePath = join(dbDir, 'review-queue.jsonl')
const records = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

function band(value, low, high) {
  return value < low ? 'low' : value > high ? 'high' : 'normal'
}

for (const record of records) {
  const path = join(dbDir, record.relativePath)
  const image = sharp(path, { failOn: 'warning' })
  const [metadata, stats] = await Promise.all([image.metadata(), image.stats()])
  const means = stats.channels.slice(0, 3).map((channel) => channel.mean)
  const stdevs = stats.channels.slice(0, 3).map((channel) => channel.stdev)
  const brightness = means.length >= 3
    ? means[0] * 0.299 + means[1] * 0.587 + means[2] * 0.114
    : means[0]
  const contrast = stdevs.reduce((sum, value) => sum + value, 0) / Math.max(stdevs.length, 1)
  const width = metadata.width || 0
  const height = metadata.height || 0
  const ratio = width / Math.max(height, 1)
  record.width = width
  record.height = height
  record.resolutionTier = Math.min(width, height) >= 1000 ? 'high' : Math.min(width, height) >= 640 ? 'medium' : 'low'
  record.technicalClassification = {
    version: 'HEADUP-REAL-TECH-CLASSIFIER-1.1',
    brightness: Number(brightness.toFixed(2)),
    brightnessBand: band(brightness, 70, 210),
    contrast: Number(contrast.toFixed(2)),
    contrastBand: band(contrast, 28, 80),
    sharpness: Number(stats.sharpness.toFixed(3)),
    sharpnessBand: band(stats.sharpness, 0.55, 1.5),
    entropy: Number(stats.entropy.toFixed(3)),
    aspect: ratio < 0.9 ? 'portrait' : ratio > 1.1 ? 'landscape' : 'square',
  }
  record.qualityStatus = (
    record.resolutionTier === 'low' ||
    record.technicalClassification.brightnessBand !== 'normal' ||
    record.technicalClassification.sharpnessBand === 'low'
  ) ? 'review' : 'pass'
  record.classifiedAt = new Date().toISOString()
}

await writeFile(manifestPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
const reviewQueue = records.filter((record) => record.qualityStatus === 'review').map((record) => ({
  id: record.id,
  pseudonymousSubjectId: record.pseudonymousSubjectId,
  relativePath: record.relativePath,
  view: record.view,
  partition: record.partition,
  technicalClassification: record.technicalClassification,
  reviewReason: [
    record.technicalClassification.brightnessBand !== 'normal' ? `brightness_${record.technicalClassification.brightnessBand}` : null,
    record.technicalClassification.sharpnessBand === 'low' ? 'sharpness_low' : null,
  ].filter(Boolean),
}))
await writeFile(reviewQueuePath, reviewQueue.map((record) => JSON.stringify(record)).join('\n') + (reviewQueue.length ? '\n' : ''))
process.stdout.write(JSON.stringify({
  classified: records.length,
  classifier: 'HEADUP-REAL-TECH-CLASSIFIER-1.1',
  quality: Object.fromEntries(Object.entries(Object.groupBy(records, (record) => record.qualityStatus)).map(([key, value]) => [key, value.length])),
  reviewQueuePath,
}, null, 2) + '\n')
