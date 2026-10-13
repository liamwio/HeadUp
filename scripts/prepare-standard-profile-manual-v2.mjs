import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const sourcePath = join(projectDir, 'data', 'face-db-real-research', 'manifest.jsonl')
const outputPath = join(projectDir, 'data', 'manual-test', 'standard-profile-manual-v2', 'manifest.json')
const seed = 'HeadUp-standard-profile-manual-v2-2026-08-27'
const rows = (await readFile(sourcePath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line))
const eligible = rows.filter((record) =>
  (record.view === 'left_profile' || record.view === 'right_profile')
  && record.expression === 'neutral'
  && record.qualityStatus === 'pass'
  && record.resolutionTier === 'high'
  && record.width >= 1200
  && record.height >= 1200,
)
const bySubject = Map.groupBy(eligible, (record) => record.pseudonymousSubjectId)
const rankedCompleteSubjects = [...bySubject.entries()]
  .filter(([, records]) => records.some((record) => record.view === 'left_profile') && records.some((record) => record.view === 'right_profile'))
  .sort(([left], [right]) => createHash('sha256').update(`${seed}/${left}`).digest('hex').localeCompare(createHash('sha256').update(`${seed}/${right}`).digest('hex')))
const completeSubjects = rankedCompleteSubjects.slice(0, 20)
const records = completeSubjects.flatMap(([, subjectRecords], subjectIndex) =>
  ['left_profile', 'right_profile'].map((view) => {
    const source = subjectRecords.find((record) => record.view === view)
    if (!source) throw new Error(`Missing ${view}`)
    const side = view === 'left_profile' ? 'L' : 'R'
    return {
      reviewId: `standard-${String(subjectIndex + 1).padStart(2, '0')}-${side}`,
      pairId: `standard-${String(subjectIndex + 1).padStart(2, '0')}`,
      view,
      relativePath: source.relativePath,
      width: source.width,
      height: source.height,
      sha256: source.sha256,
      license: source.license,
      attribution: source.attribution,
      qualityStatus: source.qualityStatus,
      resolutionTier: source.resolutionTier,
    }
  }),
)
const output = {
  createdAt: new Date().toISOString(),
  policyVersion: 'HEADUP-STANDARD-PROFILE-MANUAL-2.0',
  source: {
    name: 'Face Research Lab London Set',
    articleId: 5047666,
    articleVersion: 5,
    sourceUrl: 'https://figshare.com/articles/dataset/Face_Research_Lab_London_Set/5047666',
    license: 'CC BY 4.0',
    researchOnly: true,
    localOnly: true,
  },
  selection: {
    seed,
    eligibleSubjects: rankedCompleteSubjects.length,
    selectedSubjects: completeSubjects.length,
    imagesPerSubject: 2,
    requiredViews: ['left_profile', 'right_profile'],
    requiredExpression: 'neutral',
    requiredQualityStatus: 'pass',
    requiredResolutionTier: 'high',
    minimumDimensions: '1200x1200',
    orientationIsNotARejectionReason: true,
    expectedCapture: 'clear complete near-90-degree profile, eye-level, neutral mouth, unobstructed forehead-nose-lips-chin-jaw contour',
  },
  counts: { images: records.length, subjects: completeSubjects.length, leftProfiles: records.filter((record) => record.view === 'left_profile').length, rightProfiles: records.filter((record) => record.view === 'right_profile').length },
  retention: { expiresAt: '2026-11-13', copiedImages: false, sourceImagesRemainInLocalResearchDatabase: true, bundledWithApp: false },
  records,
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ outputPath, counts: output.counts }, null, 2)}\n`)
