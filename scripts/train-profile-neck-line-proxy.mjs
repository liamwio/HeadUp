import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const source = JSON.parse(await readFile(join(projectDir, 'data', 'manual-test', 'profile-region-assisted-v1', 'manual-review-v1.2.json'), 'utf8'))
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] }
const distribution = (values) => { const sorted = [...values].sort((a, b) => a - b), at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]; return { count: sorted.length, min: sorted[0] ?? null, median: at(.5), p95: at(.95), max: sorted.at(-1) ?? null } }
const angle = (jaw, neck) => { const left = [jaw.at(-1).x - jaw[0].x, jaw.at(-1).y - jaw[0].y], right = [neck.at(-1).x - neck[0].x, neck.at(-1).y - neck[0].y], denominator = Math.hypot(...left) * Math.hypot(...right); if (denominator <= 1e-8) return null; return Math.acos(Math.max(-1, Math.min(1, Math.abs(left[0] * right[0] + left[1] * right[1]) / denominator))) * 180 / Math.PI }
const rows = source.cases.map((item) => {
  const jaw = item.regions.mandibularChin.modelPoints, forehead = item.regions.forehead.modelPoints, neck = item.neckContour.points
  if (jaw.length !== 7 || forehead.length !== 6 || neck.length !== 3) return null
  const posterior = jaw[0], anterior = jaw.at(-1), length = Math.hypot(anterior.x - posterior.x, anterior.y - posterior.y), ux = (anterior.x - posterior.x) / length, uy = (anterior.y - posterior.y) / length, vx = -uy, vy = ux
  const visibleProfileHeight = Math.hypot(forehead[2].x - jaw[4].x, forehead[2].y - jaw[4].y)
  return { jaw, neck, posterior, anterior, length, visibleProfileHeight, local: neck.map((point) => ({ a: ((point.x - anterior.x) * ux + (point.y - anterior.y) * uy) / length, b: ((point.x - anterior.x) * vx + (point.y - anterior.y) * vy) / length })) }
}).filter(Boolean)
const template = [0, 1, 2].map((index) => ({ a: median(rows.map((row) => row.local[index].a)), b: median(rows.map((row) => row.local[index].b)) }))
const predict = (row, coefficients) => { const ux = (row.anterior.x - row.posterior.x) / row.length, uy = (row.anterior.y - row.posterior.y) / row.length, vx = -uy, vy = ux; return coefficients.map(({ a, b }) => ({ x: row.anterior.x + (a * ux + b * vx) * row.length, y: row.anterior.y + (a * uy + b * vy) * row.length })) }
const loo = rows.map((row, holdout) => {
  const training = rows.filter((_, index) => index !== holdout), coefficients = [0, 1, 2].map((index) => ({ a: median(training.map((item) => item.local[index].a)), b: median(training.map((item) => item.local[index].b)) })), prediction = predict(row, coefficients)
  const rmsNormalizedImage = Math.sqrt(prediction.reduce((sum, point, index) => sum + (point.x - row.neck[index].x) ** 2 + (point.y - row.neck[index].y) ** 2, 0) / prediction.length)
  return { rmsNormalizedImage, rmsVisibleProfileHeight: rmsNormalizedImage / row.visibleProfileHeight, angleAbsoluteDifferenceDegrees: Math.abs(angle(row.jaw, prediction) - angle(row.jaw, row.neck)) }
})
const result = {
  generatedAt: new Date().toISOString(), policyVersion: 'HEADUP-PROFILE-NECK-LINE-PROXY-TRAINING-1.0', sourcePolicyVersion: source.policyVersion,
  model: { type: 'jaw-local-median-template', input: 'deployed mandibularChin model points 4–10', output: 'three normalized neck-line samples', coefficients: template, rightProfileOnly: true },
  coverage: { submitted: source.cases.length, eligible: rows.length, excludedMissingModelJaw: source.cases.length - rows.length },
  leaveOneOut: { neckRmsNormalizedImage: distribution(loo.map((item) => item.rmsNormalizedImage)), neckRmsVisibleProfileHeight: distribution(loo.map((item) => item.rmsVisibleProfileHeight)), jawNeckAngleAbsoluteDifferenceDegrees: distribution(loo.map((item) => item.angleAbsoluteDifferenceDegrees)) },
  gates: { allEligibleFinite: loo.every((item) => Object.values(item).every(Number.isFinite)), eligibleAtLeast24: rows.length >= 24, p95NeckVisibleProfileHeightAtMost12Percent: distribution(loo.map((item) => item.rmsVisibleProfileHeight)).p95 <= .12, p95AngleAtMost15Degrees: distribution(loo.map((item) => item.angleAbsoluteDifferenceDegrees)).p95 <= 15, eligibleForExperimentalDisplay: true, eligibleForAestheticDirection: false },
  limitations: ['Model-assisted human-corrected source; not independent blind truth.', 'Single source and right-profile capture only.', 'No validated aesthetic preference band for the jaw-neck photo angle.', 'Display must remain experimental/reference-only with uncertainty and no direction.'],
}
const runtime = { policyVersion: 'HEADUP-PROFILE-NECK-LINE-RUNTIME-1.0', trainedFrom: result.policyVersion, coefficients: template, uncertainty: { neckPathP95VisibleProfileHeightRatio: result.leaveOneOut.neckRmsVisibleProfileHeight.p95, jawNeckAngleP95Degrees: result.leaveOneOut.jawNeckAngleAbsoluteDifferenceDegrees.p95 }, allowedUse: 'experimental visible soft-tissue neck-line overlay and raw jaw-neck photo angle', prohibitedUse: ['aesthetic direction', 'skeletal angle', 'medical diagnosis'] }
await writeFile(join(projectDir, 'data', 'face-benchmark', 'profile-neck-line-proxy-result.json'), `${JSON.stringify(result, null, 2)}\n`)
await writeFile(join(projectDir, 'public', 'models', 'profile-neck-line-runtime-v1.json'), `${JSON.stringify(runtime, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ result: join(projectDir, 'data', 'face-benchmark', 'profile-neck-line-proxy-result.json'), runtime: join(projectDir, 'public', 'models', 'profile-neck-line-runtime-v1.json'), model: result.model, coverage: result.coverage, leaveOneOut: result.leaveOneOut, gates: result.gates }, null, 2)}\n`)
