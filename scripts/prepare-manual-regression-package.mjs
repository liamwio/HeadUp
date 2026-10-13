import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const realRoot = join(projectDir, 'data', 'face-db-real-research')
const outputDir = join(projectDir, 'data', 'manual-test', 'headup-typical-v1')
const outputPath = join(outputDir, 'manifest.json')
const nodeCases = (await readFile(join(realRoot, 'headup-real-test-cases.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse)
const nodeById = new Map(nodeCases.map((item) => [item.id, item]))
const browserResult = JSON.parse(await readFile(join(projectDir, 'data', 'face-benchmark', 'quality-runtime-parity-result.json'), 'utf8'))
const cases = browserResult.browserCases.map((item) => {
  const node = nodeById.get(item.caseId)
  if (!node) throw new Error(`Missing auxiliary Node case: ${item.caseId}`)
  return { id: item.caseId, pseudonymousSubjectId: node.pseudonymousSubjectId, view: item.view, dimensions: node.dimensions, raw: node.raw, quality: item.quality, uiAccepted: item.accepted }
})
const sourceRecords = (await readFile(join(realRoot, 'manifest.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse)
const sourceById = new Map(sourceRecords.map((record) => [record.id, record]))

function evenly(items, count) {
  if (count >= items.length) return [...items]
  const selected = []
  for (let index = 0; index < count; index += 1) selected.push(items[Math.round(index * (items.length - 1) / (count - 1))])
  return [...new Map(selected.map((item) => [item.id, item])).values()]
}

const front = cases.filter((item) => item.view === 'front')
const rejected = front.filter((item) => !item.uiAccepted).sort((left, right) => left.quality.score - right.quality.score)
const flaggedAccepted = front.filter((item) => item.uiAccepted && item.quality.flags.length).sort((left, right) => left.quality.score - right.quality.score)
const clear = front.filter((item) => item.uiAccepted && !item.quality.flags.length).sort((left, right) => left.quality.score - right.quality.score || left.raw.brightness - right.raw.brightness)
const selectedFront = [...rejected, ...flaggedAccepted]
const fillCount = 30 - selectedFront.length
selectedFront.push(...evenly(clear, fillCount))
if (selectedFront.length !== 30 || new Set(selectedFront.map((item) => item.id)).size !== 30) throw new Error(`Unexpected front selection: ${selectedFront.length}`)

const left = evenly(cases.filter((item) => item.view === 'left_profile').sort((a, b) => a.quality.score - b.quality.score), 10)
const right = evenly(cases.filter((item) => item.view === 'right_profile').sort((a, b) => a.quality.score - b.quality.score), 10)
const selected = [...selectedFront, ...left, ...right]
const records = selected.map((item, index) => {
  const source = sourceById.get(item.id)
  if (!source?.relativePath) throw new Error(`Missing source record: ${item.id}`)
  return {
    reviewId: `MANUAL-${String(index + 1).padStart(3, '0')}`,
    caseId: item.id,
    pseudonymousSubjectId: item.pseudonymousSubjectId,
    view: item.view,
    relativePath: source.relativePath,
    expectedUse: item.view === 'front' ? 'front_full_pipeline_visual_review' : 'profile_quality_and_direction_visual_review',
    selectionReason: !item.uiAccepted ? 'production_quality_reject' : item.quality.flags.length ? 'quality_flag_boundary' : 'quality_score_range_control',
    precomputed: { runtime: 'chromium_production', dimensions: item.dimensions, quality: item.quality, raw: item.raw, rawMetricRuntime: 'node_sharp_auxiliary_only', accepted: item.uiAccepted },
  }
})
const boundaryResult = JSON.parse(await readFile(join(projectDir, 'data', 'face-benchmark', 'quality-boundary-gradient-result.json'), 'utf8'))
const frontSources = sourceRecords.filter((record) => record.view === 'front')
const blockingFlags = new Set(['分辨率偏低','光线不足','画面过曝','对比度偏低','画面模糊','疑似低清放大','无法完成像素质检'])
for (const [index, candidate] of boundaryResult.manualBoundaryCandidates.entries()) {
  const source = frontSources[candidate.sourceOrdinal - 1]
  if (!source?.relativePath) throw new Error(`Missing boundary source ordinal: ${candidate.sourceOrdinal}`)
  records.push({
    reviewId: `BOUNDARY-${String(index + 1).padStart(3, '0')}`,
    caseId: candidate.caseId,
    pseudonymousSubjectId: `boundary-source-${String(candidate.sourceOrdinal).padStart(3, '0')}`,
    view: 'front',
    relativePath: source.relativePath,
    expectedUse: 'quality_boundary_visual_review',
    selectionReason: 'quality_boundary_gradient',
    transformation: candidate.variant,
    boundaryCategory: candidate.category,
    precomputed: { dimensions: { width: 1080, height: 1080 }, quality: candidate.quality, raw: null, accepted: candidate.quality.score >= 60 && !candidate.quality.flags.some((flag) => blockingFlags.has(flag)) },
  })
}
const byView = Object.fromEntries(['front','left_profile','right_profile'].map((view) => {
  const items = records.filter((record) => record.view === view && !record.transformation)
  return [view, { images: items.length, scoreMin: Math.min(...items.map((item) => item.precomputed.quality.score)), scoreMax: Math.max(...items.map((item) => item.precomputed.quality.score)), rejected: items.filter((item) => !item.precomputed.accepted).length, flagged: items.filter((item) => item.precomputed.quality.flags.length).length }]
}))
const boundaryItems = records.filter((record) => record.transformation)
byView.quality_boundary = { images: boundaryItems.length, scoreMin: Math.min(...boundaryItems.map((item) => item.precomputed.quality.score)), scoreMax: Math.max(...boundaryItems.map((item) => item.precomputed.quality.score)), rejected: boundaryItems.filter((item) => !item.precomputed.accepted).length, flagged: boundaryItems.filter((item) => item.precomputed.quality.flags.length).length }
const manifest = {
  policyVersion: 'HEADUP-MANUAL-REGRESSION-1.2',
  createdAt: new Date().toISOString(),
  source: 'existing local Face Research Lab London Set; no image copied',
  selectionPolicy: 'all front rejects + all accepted flagged fronts + deterministic score-range controls; 10 evenly spaced quality scores per profile direction',
  counts: { total: records.length, front: 30, leftProfile: 10, rightProfile: 10, qualityBoundary: boundaryResult.manualBoundaryCandidates.length },
  coverage: byView,
  reviewContract: { decisions: ['pass','fail','needs_review'], statePersistence: 'memory_only', exportContainsImages: false, exportContainsPaths: false, everyCaseRequiredForCompletion: true, boundaryVariantsGeneratedInMemory: true },
  records,
}
await mkdir(outputDir, { recursive: true })
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ outputPath, counts: manifest.counts, coverage: manifest.coverage, imagesCopied: 0 }, null, 2)}\n`)
