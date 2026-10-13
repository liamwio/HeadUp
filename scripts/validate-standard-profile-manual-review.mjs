import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const reviewPath = process.argv[2]
if (!reviewPath) throw new Error('Usage: node scripts/validate-standard-profile-manual-review.mjs <review.json>')
const manifestPath = join(projectDir, 'data', 'manual-test', 'standard-profile-manual-v2', 'manifest.json')
const reviewBytes = await readFile(reviewPath)
const manifestBytes = await readFile(manifestPath)
const review = JSON.parse(reviewBytes.toString('utf8'))
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const errors = []
if (review.policyVersion !== 'HEADUP-STANDARD-PROFILE-MANUAL-REVIEW-2.0') errors.push('review policy mismatch')
if (review.sourceManifestPolicyVersion !== manifest.policyVersion) errors.push('manifest policy mismatch')
if (!review.criteria?.leftAndRightAccepted || !review.criteria?.directionIsNotARejectionReason || !review.criteria?.clearCompleteNear90DegreeProfileRequired) errors.push('criteria mismatch')
if (!Array.isArray(review.decisions) || review.decisions.length !== 40) errors.push('expected 40 decisions')
const manifestById = new Map(manifest.records.map((record) => [record.reviewId, record]))
const seen = new Set()
for (const decision of review.decisions ?? []) {
  if (seen.has(decision.reviewId)) errors.push(`duplicate review id ${decision.reviewId}`)
  seen.add(decision.reviewId)
  const source = manifestById.get(decision.reviewId)
  if (!source) errors.push(`unknown review id ${decision.reviewId}`)
  else if (decision.pairId !== source.pairId || decision.view !== source.view) errors.push(`source mismatch ${decision.reviewId}`)
  if (decision.decision !== 'standard_profile') errors.push(`non-pass decision ${decision.reviewId}`)
}
if (seen.size !== manifest.records.length) errors.push('incomplete review coverage')
const pairGroups = Map.groupBy(review.decisions ?? [], (decision) => decision.pairId)
if (pairGroups.size !== 20 || [...pairGroups.values()].some((items) => items.length !== 2 || items.map((item) => item.view).sort().join('|') !== 'left_profile|right_profile')) errors.push('left/right pair coverage mismatch')
if (review.summary?.total !== 40 || review.summary?.reviewed !== 40 || review.summary?.standardProfile !== 40 || review.summary?.retake !== 0 || review.summary?.exclude !== 0) errors.push('summary mismatch')
if (review.privacy?.imagesIncluded !== false || review.privacy?.pathsIncluded !== false || review.privacy?.hashesIncluded !== false || review.privacy?.sourceSubjectIdsIncluded !== false) errors.push('privacy contract mismatch')

const pass = errors.length === 0
const gate = {
  generatedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-STANDARD-PROFILE-MANUAL-GATE-2.0',
  pass,
  sourceReviewSha256: createHash('sha256').update(reviewBytes).digest('hex'),
  sourceManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  reviewPolicyVersion: review.policyVersion,
  manifestPolicyVersion: manifest.policyVersion,
  coverage: { images: review.summary?.total ?? 0, reviewed: review.summary?.reviewed ?? 0, subjects: pairGroups.size, leftProfiles: review.decisions?.filter((item) => item.view === 'left_profile').length ?? 0, rightProfiles: review.decisions?.filter((item) => item.view === 'right_profile').length ?? 0 },
  decisions: { standardProfile: review.summary?.standardProfile ?? 0, retake: review.summary?.retake ?? 0, exclude: review.summary?.exclude ?? 0 },
  criteria: review.criteria,
  privacy: review.privacy,
  errors,
  conclusion: pass ? 'Human review confirms all 40 selected left/right images are clear complete standard profiles.' : 'Human review gate failed.',
}
const outputDir = join(projectDir, 'data', 'manual-test', 'standard-profile-manual-v2')
await writeFile(join(outputDir, 'manual-review.json'), `${JSON.stringify(review, null, 2)}\n`)
await writeFile(join(outputDir, 'manual-review-gate.json'), `${JSON.stringify(gate, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`)
if (!pass) process.exitCode = 1
