import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: node scripts/migrate-assisted-neck-line-v12.mjs <assisted-review-v1.1.json>')
const value = JSON.parse(await readFile(inputPath, 'utf8'))
if (value.policyVersion !== 'HEADUP-PROFILE-REGION-ASSISTED-REVIEW-1.1' || value.cases?.length !== 30) throw new Error('Unexpected assisted review file')
const angle = (jaw, neck) => {
  const left = { x: jaw.at(-1).x - jaw[0].x, y: jaw.at(-1).y - jaw[0].y }, right = { x: neck.at(-1).x - neck[0].x, y: neck.at(-1).y - neck[0].y }
  const denominator = Math.hypot(left.x, left.y) * Math.hypot(right.x, right.y)
  if (denominator <= 1e-8) return null
  return Math.acos(Math.max(-1, Math.min(1, Math.abs(left.x * right.x + left.y * right.y) / denominator))) * 180 / Math.PI
}
for (const item of value.cases) {
  item.neckContour.angleDegrees = angle(item.regions.mandibularChin.points, item.neckContour.points)
  item.neckContour.angleDefinition = 'acute_angle_between_endpoint_fit(mandibularChin,neckContour)'
  item.neckContour.visualBand = null
}
value.policyVersion = 'HEADUP-PROFILE-REGION-ASSISTED-REVIEW-1.2'
value.createdAt = new Date().toISOString()
value.migration = {
  policyVersion: 'HEADUP-ASSISTED-NECK-LINE-V12-MIGRATION-1.0',
  preservedFaceRegions: 120,
  preservedNeckLines: 30,
  correction: 'Three neck points are line samples, not Me-Cer-Np angle landmarks. Recomputed the acute angle between the endpoint direction of mandibularChin and the endpoint direction of neckContour.',
  aestheticBandApplied: false,
}
const outputPath = join(projectDir, 'data', 'manual-test', 'profile-region-assisted-v1', 'manual-review-v1.2.json')
await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`)
const values = value.cases.map((item) => item.neckContour.angleDegrees).filter(Number.isFinite).sort((a, b) => a - b)
process.stdout.write(`${JSON.stringify({ outputPath, preservedFaceRegions: 120, preservedNeckLines: 30, angleDegrees: { min: values[0], median: values[Math.floor((values.length - 1) / 2)], mean: values.reduce((sum, item) => sum + item, 0) / values.length, max: values.at(-1) } }, null, 2)}\n`)
