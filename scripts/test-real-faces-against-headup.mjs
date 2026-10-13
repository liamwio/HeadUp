import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const dbDir = join(projectDir, 'data', 'face-db-real-research')
const manifestPath = join(dbDir, 'manifest.jsonl')
const resultPath = join(dbDir, 'headup-real-test-result.json')
const casePath = join(dbDir, 'headup-real-test-cases.jsonl')
const records = (await readFile(manifestPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const harness = await createProductionQualityHarness(projectDir)

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[index]
}

const cases = []
for (const record of records) {
  const metrics = await harness.inspect(join(dbDir, record.relativePath))
  cases.push({
    id: record.id,
    pseudonymousSubjectId: record.pseudonymousSubjectId,
    view: record.view,
    partition: record.partition,
    ...metrics,
    uiAccepted: metrics.accepted,
  })
}

const byView = Object.fromEntries(Object.entries(Object.groupBy(cases, (item) => item.view)).map(([view, items]) => {
  const scores = items.map((item) => item.quality.score)
  return [view, {
    images: items.length,
    accepted: items.filter((item) => item.uiAccepted).length,
    flagged: items.filter((item) => item.quality.flags.length > 0).length,
    score: { min: Math.min(...scores), median: percentile(scores, 0.5), p95: percentile(scores, 0.95), max: Math.max(...scores) },
  }]
}))

const scoreValues = cases.map((item) => item.quality.score)
const flagCounts = {}
for (const item of cases) for (const flag of item.quality.flags) flagCounts[flag] = (flagCounts[flag] || 0) + 1
const perSubject = Object.groupBy(cases, (item) => item.pseudonymousSubjectId)
const leftRightScoreDifferences = Object.values(perSubject).map((items) => {
  const left = items.find((item) => item.view === 'left_profile')
  const right = items.find((item) => item.view === 'right_profile')
  return Math.abs(left.quality.score - right.quality.score)
})

const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-REAL-RESEARCH-1.0',
  scorerSource: harness.scorerSource,
  subjects: Object.keys(perSubject).length,
  images: cases.length,
  uiQualityGate: {
    accepted: cases.filter((item) => item.uiAccepted).length,
    rejected: cases.filter((item) => !item.uiAccepted).length,
    flagged: cases.filter((item) => item.quality.flags.length > 0).length,
    score: {
      min: Math.min(...scoreValues),
      p05: percentile(scoreValues, 0.05),
      median: percentile(scoreValues, 0.5),
      p95: percentile(scoreValues, 0.95),
      max: Math.max(...scoreValues),
    },
    flags: flagCounts,
    byView,
  },
  pairedProfileStability: {
    subjects: leftRightScoreDifferences.length,
    absoluteScoreDifferenceMedian: percentile(leftRightScoreDifferences, 0.5),
    absoluteScoreDifferenceP95: percentile(leftRightScoreDifferences, 0.95),
    absoluteScoreDifferenceMax: Math.max(...leftRightScoreDifferences),
  },
  unsupportedByCurrentApp: [
    'verified top-view validation',
    'profile landmark detection',
    'validated profile and top-view geometric measurements',
    'population reference intervals for data-derived report values',
    'top-view evaluation because the consented corpus has no top-view images',
  ],
}

await writeFile(casePath, cases.map((item) => JSON.stringify(item)).join('\n') + '\n')
await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ...result, resultPath, casePath }, null, 2) + '\n')
