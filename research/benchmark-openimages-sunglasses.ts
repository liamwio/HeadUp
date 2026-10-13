import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'

type ManifestRecord = {
  sampleId: string
  split: 'validation' | 'test'
  relativePath: string
  width: number
  height: number
  faceArea: number
  faceCenterDistance: number
  sizeBand: 'close' | 'standard' | 'context'
  positionBand: 'centered' | 'off_center'
  annotationOcclusion: 'clear' | 'occluded'
  stratum: string
}
type Manifest = {
  source: string
  publisher: string
  sourcePage: string
  annotations: Array<{ split: string; md5: string; bytes: number }>
  annotationVersion: string
  selection: Record<string, unknown> & { selectedImages: number }
  records: ManifestRecord[]
  privacy: Record<string, boolean>
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
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/openimages-sunglasses'
window.addEventListener('error', (event) => { resultElement.dataset.error = event.message })
window.addEventListener('unhandledrejection', (event) => { resultElement.dataset.error = event.reason instanceof Error ? event.reason.message : String(event.reason) })
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

function summarize(items: ImageResult[]) {
  const images = items.length
  const qualityPassed = items.filter((item) => item.qualityPass).length
  const posePassed = items.filter((item) => item.posePass).length
  const combinedPassed = items.filter((item) => item.combinedPass).length
  return {
    images,
    qualityPassed,
    posePassed,
    combinedPassed,
    falseAcceptRate: images ? Number((combinedPassed / images).toFixed(4)) : null,
    explicitEyeOcclusionFlags: items.filter((item) => item.poseFlags.some((flag) => flag.includes('眼部存在大面积明显遮挡'))).length,
    explicitMouthNoseOcclusionFlags: items.filter((item) => item.poseFlags.some((flag) => flag.includes('口鼻区域存在大面积明显遮挡'))).length,
    qualityFlags: counts(items.flatMap((item) => item.qualityFlags.length ? item.qualityFlags : ['none'])),
    poseFlags: counts(items.flatMap((item) => item.poseFlags.length ? item.poseFlags : ['none'])),
  }
}

const imageResults: ImageResult[] = []
for (const [index, record] of manifest.records.entries()) {
  status.textContent = `处理真实彩色墨镜图 ${index + 1} / ${manifest.records.length}`
  const response = await fetch(`${stagingRoot}/${record.relativePath}`)
  if (!response.ok) throw new Error(`Image load failed: ${response.status}`)
  const blob = await response.blob()
  const file = new File([blob], `openimages-sunglasses-${index}.jpg`, { type: 'image/jpeg' })
  const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
  const qualityPass = isPhotoQualityAcceptable(quality)
  const posePass = pose.status === 'pass'
  imageResults.push({ ...record, qualityPass, posePass, combinedPass: qualityPass && posePass, qualityFlags: quality.flags, poseFlags: pose.flags })
}

const shortEdges = manifest.records.map((record) => Math.min(record.width, record.height))
const dimensions = ['close', 'standard', 'context'] as const
const positions = ['centered', 'off_center'] as const
const occlusions = ['clear', 'occluded'] as const
const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-OPENIMAGES-SUNGLASSES-AUDIT-1.0',
  source: manifest.source,
  publisher: manifest.publisher,
  sourcePage: manifest.sourcePage,
  annotations: manifest.annotations,
  annotationVersion: manifest.annotationVersion,
  selection: {
    ...manifest.selection,
    shortestSidePixels: {
      min: Math.min(...shortEdges),
      p05: quantile(shortEdges, 0.05),
      median: quantile(shortEdges, 0.5),
      p95: quantile(shortEdges, 0.95),
      max: Math.max(...shortEdges),
    },
  },
  productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  overall: summarize(imageResults),
  bySizeBand: Object.fromEntries(dimensions.map((value) => [value, summarize(imageResults.filter((item) => item.sizeBand === value))])),
  byPositionBand: Object.fromEntries(positions.map((value) => [value, summarize(imageResults.filter((item) => item.positionBand === value))])),
  byAnnotationOcclusion: Object.fromEntries(occlusions.map((value) => [value, summarize(imageResults.filter((item) => item.annotationOcclusion === value))])),
  byStratum: Object.fromEntries([...new Set(imageResults.map((item) => item.stratum))].sort().map((value) => [value, summarize(imageResults.filter((item) => item.stratum === value))])),
  interpretation: 'Every selected image has official Human face and Sunglasses boxes with the sunglasses box spatially contained by a single face. A combined pass is a false accept for the product capture protocol.',
  scope: 'Real color web photographs with official Open Images box annotations. This is an unpaired blocking audit; it cannot estimate false rejects on unobstructed faces or verify subject independence.',
  privacy: manifest.privacy,
  retention: { imagesDeletedAfterRun: false, individualPredictionsRetained: false, sourceImageIdsRetained: false, sourceUrlsRetained: false, aggregateOnly: true },
  transientIndividualResults: imageResults.map((item) => ({
    sampleId: item.sampleId,
    split: item.split,
    qualityPass: item.qualityPass,
    posePass: item.posePass,
    combinedPass: item.combinedPass,
  })),
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成；请保存聚合结果后立即运行清理脚本'
