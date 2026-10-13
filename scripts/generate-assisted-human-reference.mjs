import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const inputPath = join(projectDir, 'data', 'manual-test', 'profile-region-assisted-v1', 'manual-review-v1.2.json')
const input = JSON.parse(await readFile(inputPath, 'utf8'))
if (input.policyVersion !== 'HEADUP-PROFILE-REGION-ASSISTED-REVIEW-1.2' || input.cases?.length !== 30) throw new Error('Unexpected assisted review input')
const regionNames = ['forehead', 'nasalDorsum', 'maxillarySupport', 'mandibularChin']
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b), at = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : null
  return { count: sorted.length, min: sorted[0] ?? null, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null }
}
const rms = (left, right) => left.length === right.length && left.length ? Math.sqrt(left.reduce((sum, point, index) => sum + (point.x - right[index].x) ** 2 + (point.y - right[index].y) ** 2, 0) / left.length) : null
const reference = {
  createdAt: new Date().toISOString(),
  policyVersion: 'HEADUP-PROFILE-REGION-HUMAN-CORRECTED-REFERENCE-1.0',
  sourcePolicyVersion: input.policyVersion,
  referenceType: 'model_assisted_human_confirmed_or_corrected',
  blindIndependentGroundTruth: false,
  userDecision: { skipIndependentABRedraw: true, finalHumanCorrectionIsReference: true, decidedAt: '2026-08-28' },
  allowedClaims: ['human-reviewed region paths', 'machine-to-human correction magnitude', 'engineering comparison against the accepted correction set'],
  prohibitedClaims: ['independent blind accuracy', 'medical landmark truth', 'skeletal diagnosis', 'universal aesthetic correctness'],
  cases: input.cases.map((item) => ({
    reviewId: item.reviewId,
    width: item.width,
    height: item.height,
    regions: Object.fromEntries(regionNames.map((name) => [name, { status: item.regions[name].status === 'occluded' ? 'occluded' : 'annotated', points: item.regions[name].points, method: item.regions[name].status === 'confirmed' ? 'human_confirmed_model_preannotation' : item.regions[name].status === 'corrected' ? 'human_corrected_model_preannotation' : 'human_drawn_after_model_unavailable' }])),
    neckLine: { status: item.neckContour.status, points: item.neckContour.points, jawNeckLineAngleDegrees: item.neckContour.angleDegrees, angleDefinition: item.neckContour.angleDefinition, aestheticBandApplied: false },
  })),
}
const byRegion = Object.fromEntries(regionNames.map((name) => {
  const regions = input.cases.map((item) => item.regions[name]), comparable = regions.map((region) => rms(region.points, region.modelPoints)).filter((value) => value !== null)
  return [name, { total: regions.length, confirmed: regions.filter((item) => item.status === 'confirmed').length, corrected: regions.filter((item) => item.status === 'corrected').length, manualFromScratch: regions.filter((item) => item.status === 'manual_from_scratch').length, comparableToModel: comparable.length, correctionRmsNormalizedImage: distribution(comparable) }]
}))
const result = {
  generatedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-PROFILE-MODEL-VS-HUMAN-CORRECTION-1.0',
  sourceReferencePolicyVersion: reference.policyVersion,
  interpretation: 'Correction magnitude against a model-assisted human review; not an independent accuracy estimate.',
  coverage: { cases: input.cases.length, regions: input.cases.length * regionNames.length, humanReviewed: 120, blindIndependent: false },
  byRegion,
  neckLine: { cases: input.cases.length, humanLocated: input.cases.filter((item) => item.neckContour.status === 'manual_from_scratch').length, angleDefinition: 'acute_angle_between_endpoint_fit(mandibularChin,neckContour)', angleDegrees: distribution(input.cases.map((item) => item.neckContour.angleDegrees).filter(Number.isFinite)), aestheticBandApplied: false },
  gates: { all120HumanReviewed: Object.values(byRegion).every((item) => item.total === 30 && item.confirmed + item.corrected + item.manualFromScratch === 30), atLeast24ComparablePerRegion: Object.values(byRegion).every((item) => item.comparableToModel >= 24), independentBlindTruthAvailable: false, userAcceptedAssistedReferenceInstead: true },
}
const outputDir = join(projectDir, 'data', 'manual-test', 'profile-region-assisted-v1')
await writeFile(join(outputDir, 'human-corrected-reference.json'), `${JSON.stringify(reference, null, 2)}\n`)
await writeFile(join(projectDir, 'data', 'face-benchmark', 'profile-model-vs-human-correction-result.json'), `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ reference: join(outputDir, 'human-corrected-reference.json'), result: join(projectDir, 'data', 'face-benchmark', 'profile-model-vs-human-correction-result.json'), coverage: result.coverage, byRegion: result.byRegion, neckLine: result.neckLine, gates: result.gates }, null, 2)}\n`)
