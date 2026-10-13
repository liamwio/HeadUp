import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'

type ManifestRecord = {
  sampleId: string; split: 'validation' | 'test'; relativePath: string; width: number; height: number
  sizeBand: 'close' | 'standard' | 'context'; positionBand: 'centered' | 'off_center'
  annotationOcclusion: 'clear' | 'occluded'; stratum: string
}
type Result = ManifestRecord & { qualityPass: boolean; posePass: boolean; combinedPass: boolean; qualityFlags: string[]; poseFlags: string[] }
type Manifest = { source: string; publisher: string; sourcePage: string; annotations: unknown[]; selection: { [key: string]: unknown; selectedImages: number }; records: ManifestRecord[]; privacy: { [key: string]: boolean } }

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
window.addEventListener('error', (event) => { resultElement.dataset.error = event.message })
window.addEventListener('unhandledrejection', (event) => { resultElement.dataset.error = event.reason instanceof Error ? event.reason.message : String(event.reason) })
const root = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/openimages-glasses'
const manifest = await fetch(`${root}/manifest.json`).then(async (response) => {
  if (!response.ok) throw new Error(`Manifest load failed: ${response.status}`)
  return response.json() as Promise<Manifest>
})

function counts(values: string[]) {
  const output: Record<string, number> = {}
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

function summarize(items: Result[]) {
  return {
    images: items.length,
    qualityPassed: items.filter((item) => item.qualityPass).length,
    posePassed: items.filter((item) => item.posePass).length,
    combinedPassed: items.filter((item) => item.combinedPass).length,
    explicitEyeOcclusionFalseFlags: items.filter((item) => item.poseFlags.some((flag) => flag.includes('眼部存在大面积明显遮挡'))).length,
    explicitMouthNoseOcclusionFalseFlags: items.filter((item) => item.poseFlags.some((flag) => flag.includes('口鼻区域存在大面积明显遮挡'))).length,
    qualityFlags: counts(items.flatMap((item) => item.qualityFlags.length ? item.qualityFlags : ['none'])),
    poseFlags: counts(items.flatMap((item) => item.poseFlags.length ? item.poseFlags : ['none'])),
  }
}

const imageResults: Result[] = []
for (const [index, record] of manifest.records.entries()) {
  status.textContent = `处理普通眼镜图 ${index + 1} / ${manifest.records.length}`
  const response = await fetch(`${root}/${record.relativePath}`)
  if (!response.ok) throw new Error(`Image load failed: ${response.status}`)
  const file = new File([await response.blob()], `ordinary-glasses-${index}.jpg`, { type: 'image/jpeg' })
  const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
  const qualityPass = isPhotoQualityAcceptable(quality)
  const posePass = pose.status === 'pass'
  imageResults.push({ ...record, qualityPass, posePass, combinedPass: qualityPass && posePass, qualityFlags: quality.flags, poseFlags: pose.flags })
}

const grouped = <K extends keyof Result, T extends Extract<Result[K], string>>(key: K, items: readonly T[]) => Object.fromEntries(items.map((value) => [value, summarize(imageResults.filter((item) => item[key] === value))]))
const result = {
  testedAt: new Date().toISOString(), policyVersion: 'HEADUP-OPENIMAGES-GLASSES-CONTROL-AUDIT-1.0',
  source: manifest.source, publisher: manifest.publisher, sourcePage: manifest.sourcePage,
  selection: manifest.selection, productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  overall: summarize(imageResults),
  bySplit: grouped('split', ['validation', 'test'] as const),
  bySizeBand: grouped('sizeBand', ['close', 'standard', 'context'] as const),
  byPositionBand: grouped('positionBand', ['centered', 'off_center'] as const),
  byAnnotationOcclusion: grouped('annotationOcclusion', ['clear', 'occluded'] as const),
  interpretation: 'Nominal ordinary-glasses controls should not receive an explicit sunglasses/eye-occlusion flag. Combined pass is diagnostic because web photos may still violate product pose and framing requirements.',
  limitations: manifest.selection.labelLimitation,
  privacy: manifest.privacy,
  retention: { imagesDeletedAfterRun: false, individualPredictionsRetained: false, sourceImageIdsRetained: false, sourceUrlsRetained: false, aggregateOnly: true },
}
resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成；请保存聚合结果后立即运行清理脚本'
