import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: node scripts/prepare-assisted-neck-redo.mjs <assisted-review.json>')
const value = JSON.parse(await readFile(inputPath, 'utf8'))
if (value.policyVersion !== 'HEADUP-PROFILE-REGION-ASSISTED-REVIEW-1.1' || value.cases?.length !== 30) throw new Error('Unexpected assisted review file')
for (const item of value.cases) item.neckContour = { status: 'manual_required', points: [], angleDegrees: null, visualBand: null, note: '上次颈线因Me–Cer–Np近水平/近共线被系统拒绝；请将Np标在Cer明显下方的前颈切线上。' }
value.createdAt = new Date().toISOString()
value.migration = {
  policyVersion: 'HEADUP-ASSISTED-NECK-REDO-MIGRATION-1.0',
  preservedFaceRegions: 120,
  resetNeckContours: 30,
  reason: 'Previous neck traces were near-horizontal or near-collinear and cannot support an interpretable submental-cervical angle.',
}
const outputPath = join(projectDir, 'data', 'manual-test', 'profile-region-assisted-v1', 'neck-redo-session.json')
await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ outputPath, preservedFaceRegions: 120, resetNeckContours: 30 }, null, 2)}\n`)
