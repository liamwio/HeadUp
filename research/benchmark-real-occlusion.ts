import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'

type ManifestRecord = {
  subjectId: string
  category: 'masked'
  relativePath: string
  width: number
  height: number
  bytes: number
  sha256: string
}
type Manifest = {
  source: string
  sourceRepository: string
  sourceCommit: string
  sourceImagesAvailable: number
  selection: string
  selectedSubjects: number
  imagesPerSubject: number
  selectedImages: number
  verification: string
  records: ManifestRecord[]
}
type ImageResult = {
  qualityPass: boolean
  posePass: boolean
  combinedPass: boolean
  qualityFlags: string[]
  poseFlags: string[]
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/real-occlusion'
const manifest = await fetch(`${stagingRoot}/manifest.json`).then(async (response) => {
  if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
  return response.json() as Promise<Manifest>
})

function counts(values: string[]) {
  const output: Record<string, number> = {}
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)).toFixed(2))
}

const imageResults: ImageResult[] = []
for (const [index, record] of manifest.records.entries()) {
  status.textContent = `处理真实口罩图 ${index + 1} / ${manifest.records.length}`
  const response = await fetch(`${stagingRoot}/${record.relativePath}`)
  if (!response.ok) throw new Error(`Image load failed: ${response.status}`)
  const blob = await response.blob()
  const file = new File([blob], `masked-${index}.jpg`, { type: 'image/jpeg' })
  const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
  const qualityPass = isPhotoQualityAcceptable(quality)
  const posePass = pose.status === 'pass'
  imageResults.push({
    qualityPass,
    posePass,
    combinedPass: qualityPass && posePass,
    qualityFlags: quality.flags,
    poseFlags: pose.flags,
  })
}

const qualityPassed = imageResults.filter((item) => item.qualityPass).length
const posePassed = imageResults.filter((item) => item.posePass).length
const combinedPassed = imageResults.filter((item) => item.combinedPass).length
const mouthNoseOcclusionFlags = imageResults.filter((item) => item.poseFlags.some((flag) => flag.includes('口鼻区域存在大面积明显遮挡'))).length
const eyeOcclusionFlags = imageResults.filter((item) => item.poseFlags.some((flag) => flag.includes('眼部存在大面积明显遮挡'))).length
const dimensions = manifest.records.map((record) => Math.min(record.width, record.height))
const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-REAL-MASK-AUDIT-1.0',
  source: manifest.source,
  sourceRepository: manifest.sourceRepository,
  sourceCommit: manifest.sourceCommit,
  selection: {
    sourceImagesAvailable: manifest.sourceImagesAvailable,
    subjects: manifest.selectedSubjects,
    imagesPerSubject: manifest.imagesPerSubject,
    images: manifest.selectedImages,
    deterministicSubjectStratification: true,
    verification: manifest.verification,
    shortestSidePixels: {
      min: Math.min(...dimensions),
      p05: quantile(dimensions, 0.05),
      median: quantile(dimensions, 0.5),
      p95: quantile(dimensions, 0.95),
      max: Math.max(...dimensions),
    },
  },
  productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  results: {
    images: imageResults.length,
    qualityPassed,
    posePassed,
    combinedPassed,
    blockedByQualityOrPose: imageResults.length - combinedPassed,
    mouthNoseOcclusionFlags,
    eyeOcclusionFlags,
    qualityFlags: counts(imageResults.flatMap((item) => item.qualityFlags.length ? item.qualityFlags : ['none'])),
    poseFlags: counts(imageResults.flatMap((item) => item.poseFlags.length ? item.poseFlags : ['none'])),
  },
  interpretation: 'Every image contains a real face mask and should be blocked from formal front analysis. Pose results are reported separately because native RMFD crops are below the product resolution protocol.',
  scope: `Real-world web-sourced mask crops from ${manifest.selectedSubjects} identities and no paired unmasked controls. This is a blocking audit, not a population false-reject estimate.`,
  retention: { imagesDeletedAfterRun: false, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true },
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成；请保存聚合结果后立即运行清理脚本'
