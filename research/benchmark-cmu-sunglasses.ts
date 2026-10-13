import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'

type Pose = 'straight' | 'left' | 'right' | 'up'
type Expression = 'neutral' | 'happy' | 'sad' | 'angry'
type EyeCondition = 'open' | 'sunglasses'
type ManifestRecord = {
  subjectId: string
  pose: Pose
  expression: Expression
  eyeCondition: EyeCondition
  relativePath: string
  width: number
  height: number
  bytes: number
  sha256: string
}
type Manifest = {
  source: string
  publisher: string
  sourcePage: string
  sourceArchiveSha256: string
  subjects: number
  images: number
  resolution: string
  records: ManifestRecord[]
}
type ImageResult = ManifestRecord & {
  qualityPass: boolean
  posePass: boolean
  combinedPass: boolean
  qualityFlags: string[]
  poseFlags: string[]
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/cmu-sunglasses'
const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
  if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
  return response.json() as Promise<Manifest>
})

function counts(values: string[]) {
  const output: Record<string, number> = {}
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

function summarize(items: ImageResult[]) {
  const images = items.length
  const qualityPassed = items.filter((item) => item.qualityPass).length
  const posePassed = items.filter((item) => item.posePass).length
  const combinedPassed = items.filter((item) => item.combinedPass).length
  const explicitEyeOcclusionFlags = items.filter((item) => item.poseFlags.some((flag) => flag.includes('眼部存在大面积明显遮挡'))).length
  return {
    images,
    qualityPassed,
    posePassed,
    posePassRate: Number((posePassed / images).toFixed(4)),
    combinedPassed,
    explicitEyeOcclusionFlags,
    qualityFlags: counts(items.flatMap((item) => item.qualityFlags.length ? item.qualityFlags : ['none'])),
    poseFlags: counts(items.flatMap((item) => item.poseFlags.length ? item.poseFlags : ['none'])),
  }
}

const imageResults: ImageResult[] = []
for (const [index, record] of manifest.records.entries()) {
  status.textContent = `处理墨镜配对图 ${index + 1} / ${manifest.records.length}`
  const response = await fetch(`${stagingRoot}/${record.relativePath}`)
  if (!response.ok) throw new Error(`Image load failed: ${response.status}`)
  const blob = await response.blob()
  const file = new File([blob], `cmu-${index}.png`, { type: 'image/png' })
  const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
  const qualityPass = isPhotoQualityAcceptable(quality)
  const posePass = pose.status === 'pass'
  imageResults.push({ ...record, qualityPass, posePass, combinedPass: qualityPass && posePass, qualityFlags: quality.flags, poseFlags: pose.flags })
}

const eyeConditions: EyeCondition[] = ['open', 'sunglasses']
const poses: Pose[] = ['straight', 'left', 'right', 'up']
const byEyeCondition = Object.fromEntries(eyeConditions.map((condition) => [condition, summarize(imageResults.filter((item) => item.eyeCondition === condition))]))
const byPoseAndEyeCondition = Object.fromEntries(poses.map((pose) => [pose, Object.fromEntries(eyeConditions.map((condition) => [
  condition,
  summarize(imageResults.filter((item) => item.pose === pose && item.eyeCondition === condition)),
]))]))

const pairs = Object.values(Object.groupBy(imageResults, (item) => `${item.subjectId}:${item.pose}:${item.expression}`))
  .filter((items): items is ImageResult[] => Boolean(items?.some((item) => item.eyeCondition === 'open') && items.some((item) => item.eyeCondition === 'sunglasses')))

function pairTransitions(items: ImageResult[][]) {
  const openPoseEligible = items.filter((pair) => pair.find((item) => item.eyeCondition === 'open')!.posePass)
  const sunglassesBlockedAfterOpenPass = openPoseEligible.filter((pair) => !pair.find((item) => item.eyeCondition === 'sunglasses')!.posePass).length
  const openBlockedButSunglassesPassed = items.filter((pair) => {
    const open = pair.find((item) => item.eyeCondition === 'open')!
    const sunglasses = pair.find((item) => item.eyeCondition === 'sunglasses')!
    return !open.posePass && sunglasses.posePass
  }).length
  return {
    pairs: items.length,
    openPoseEligible: openPoseEligible.length,
    sunglassesBlockedAfterOpenPass,
    sunglassesBlockedAfterOpenPassRate: openPoseEligible.length ? Number((sunglassesBlockedAfterOpenPass / openPoseEligible.length).toFixed(4)) : null,
    openBlockedButSunglassesPassed,
  }
}

const straightPairs = pairs.filter((pair) => pair[0].pose === 'straight')
const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-CMU-SUNGLASSES-AUDIT-1.0',
  source: manifest.source,
  publisher: manifest.publisher,
  sourcePage: manifest.sourcePage,
  sourceArchiveSha256: manifest.sourceArchiveSha256,
  selection: {
    subjects: manifest.subjects,
    images: manifest.images,
    resolution: manifest.resolution,
    pairedOpenSunglassesCases: pairs.length,
    straightPairedCases: straightPairs.length,
    poseCoverage: poses,
    expressionCoverage: ['neutral', 'happy', 'sad', 'angry'],
  },
  productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  byEyeCondition,
  byPoseAndEyeCondition,
  pairedTransitions: {
    allPoses: pairTransitions(pairs),
    straightOnly: pairTransitions(straightPairs),
  },
  interpretation: 'Sunglasses images should be blocked from formal front analysis. Pose-gate comparisons are separated from the production quality gate because all images are 128x120.',
  scope: 'Small grayscale controlled dataset from roughly twenty subjects. It provides paired real-sunglasses evidence but cannot represent modern phone resolution, color, skin-tone appearance or diverse eyewear.',
  retention: { imagesDeletedAfterRun: false, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true },
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成；请保存聚合结果后立即运行清理脚本'
