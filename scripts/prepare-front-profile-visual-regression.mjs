import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const londonDir = join(projectDir, 'data', 'face-db-real-research', 'images', 'face-research-lab-london-v5')
const oldManifestPath = join(projectDir, 'data', 'manual-test', 'headup-typical-v1', 'manifest.json')
const outputPath = join(projectDir, 'data', 'manual-test', 'front-profile-new-v1', 'manifest.json')

const oldManifest = JSON.parse(await readFile(oldManifestPath, 'utf8'))
const excluded = new Set(oldManifest.records.map((record) => record.pseudonymousSubjectId).filter(Boolean))
const fileNames = new Set(await readdir(londonDir))
const candidateIds = [...fileNames]
  .filter((name) => /^\d{3}_front\.jpg$/.test(name))
  .map((name) => name.slice(0, 3))
  .filter((id) => ['front', 'left_profile', 'right_profile'].every((view) => fileNames.has(`${id}_${view}.jpg`)))
  .filter((id) => !excluded.has(`london-v5-${id}`))
  .sort((left, right) => createHash('sha256').update(`HEADUP-FRONT-PROFILE-V1:${left}`).digest('hex').localeCompare(createHash('sha256').update(`HEADUP-FRONT-PROFILE-V1:${right}`).digest('hex')))
  .slice(0, 8)

if (candidateIds.length !== 8) throw new Error(`Expected 8 new paired London subjects, found ${candidateIds.length}`)

const cases = []
for (const [subjectIndex, sourceId] of candidateIds.entries()) {
  const subjectGroup = `LON-P${String(subjectIndex + 1).padStart(2, '0')}`
  for (const view of ['front', 'left_profile', 'right_profile']) {
    cases.push({
      reviewId: `${subjectGroup}-${view}`,
      subjectGroup,
      dataset: 'london_highres',
      view,
      path: `data/face-db-real-research/images/face-research-lab-london-v5/${sourceId}_${view}.jpg`,
      sourceResolution: '1350x1350',
      expectedUse: view === 'front' ? 'production_full_pipeline_and_measurement' : 'production_quality_pose_and_direction',
    })
  }
}

const manifest = {
  policyVersion: 'HEADUP-FRONT-PROFILE-VISUAL-REGRESSION-1.0',
  createdAt: new Date().toISOString(),
  purpose: 'real-image automatic and manual regression for current HeadUp frontal/profile production pipeline',
  sources: [
    { id: 'london_highres', description: 'existing local authorized research set; eight deterministic subjects absent from prior 58-case manual package', copied: false },
    { id: 'fei_aggregate_only', description: 'FEI controlled portraits are downloaded by the benchmark and fully deleted; only aggregate JSON is retained', copied: false },
  ],
  counts: { subjects: 8, images: 24, londonHighresSubjects: 8, londonHighresImages: 24, feiLowresSubjects: 0, feiLowresImages: 0 },
  expectedContract: {
    front: 'quality acceptable + front pose pass + 478 landmarks + 12 measurements for suitable high-resolution inputs',
    right_profile: 'profile pose pass when quality and framing are suitable',
    left_profile: 'left direction recognized and rejected with direction-opposite guidance',
    fei_lowres: 'resolution rejection is expected; pose/direction remains a structural control, not measurement evidence',
  },
  privacy: { researchTestOnly: true, originalSubjectIndicesInReviewIds: false, exportContainsImages: false, exportContainsPaths: false },
  cases,
}

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ outputPath, selectedLondonSubjects: candidateIds.length, totalSubjects: manifest.counts.subjects, totalImages: manifest.counts.images }, null, 2))
