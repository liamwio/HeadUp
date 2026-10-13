import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const dbDir = fileURLToPath(new URL('../data/face-db/', import.meta.url))
const manifestPath = join(dbDir, 'manifest.jsonl')
const records = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

function band(value, low, high) {
  return value < low ? 'low' : value > high ? 'high' : 'normal'
}

function aspect(width, height) {
  const ratio = width / Math.max(height, 1)
  return ratio < 0.9 ? 'portrait' : ratio > 1.1 ? 'landscape' : 'square'
}

for (const record of records) {
  const path = join(dbDir, record.relativePath)
  const image = sharp(path, { failOn: 'warning' })
  const [metadata, stats] = await Promise.all([image.metadata(), image.stats()])
  const channels = stats.channels.slice(0, 3)
  const means = channels.map((channel) => channel.mean)
  const stdevs = channels.map((channel) => channel.stdev)
  const brightness = means.length >= 3
    ? means[0] * 0.299 + means[1] * 0.587 + means[2] * 0.114
    : means[0]
  const contrast = stdevs.reduce((sum, value) => sum + value, 0) / Math.max(stdevs.length, 1)
  const dominantLuminance = (stats.dominant.r * 0.299) + (stats.dominant.g * 0.587) + (stats.dominant.b * 0.114)
  const technicalClassification = {
    version: 'HEADUP-TECH-CLASSIFIER-1.0',
    brightness: Number(brightness.toFixed(2)),
    brightnessBand: band(brightness, 75, 190),
    contrast: Number(contrast.toFixed(2)),
    contrastBand: band(contrast, 32, 75),
    sharpness: Number(stats.sharpness.toFixed(3)),
    sharpnessBand: band(stats.sharpness, 0.6, 1.3),
    entropy: Number(stats.entropy.toFixed(3)),
    aspect: aspect(metadata.width || record.width, metadata.height || record.height),
    dominantTone: band(dominantLuminance, 80, 185),
  }
  record.width = metadata.width || record.width
  record.height = metadata.height || record.height
  record.technicalClassification = technicalClassification
  record.qualityStatus = (
    record.resolutionTier === 'low' ||
    technicalClassification.brightnessBand !== 'normal' ||
    technicalClassification.sharpnessBand === 'low'
  ) ? 'review' : 'pass'
  record.classifiedAt = new Date().toISOString()
}

await writeFile(manifestPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''))
process.stdout.write(JSON.stringify({ classified: records.length, classifier: 'HEADUP-TECH-CLASSIFIER-1.0' }, null, 2) + '\n')
