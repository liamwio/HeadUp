import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'
import type { PhotoQuality, PoseValidation } from '../src/types'

type SampleRecord = {
  file: string
  race: string
  genderPresentation: string
  ageBucket: string
  sourceAgeLabel: string
}

type Case = SampleRecord & {
  quality: PhotoQuality
  pose: PoseValidation
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/fairface'
const manifest = await fetch(`${stagingRoot}/sample-manifest.json`).then((response) => response.json()) as {
  policyVersion: string
  source: string
  selection: string
  images: number
  perStratum: number
  records: SampleRecord[]
}

function quantiles(values: number[], digits = 2) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(digits))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

function counts(values: string[]) {
  return Object.fromEntries(Object.entries(Object.groupBy(values, (value) => value)).map(([key, items]) => [key, items.length]))
}

function wilson95(successes: number, total: number) {
  const z = 1.959963984540054
  const proportion = successes / total
  const denominator = 1 + z * z / total
  const center = (proportion + z * z / (2 * total)) / denominator
  const margin = z * Math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total)) / denominator
  return { low: Number((center - margin).toFixed(4)), high: Number((center + margin).toFixed(4)) }
}

function summarize(items: Case[]) {
  const posePasses = items.filter((item) => item.pose.status === 'pass').length
  const qualityPasses = items.filter((item) => isPhotoQualityAcceptable(item.quality)).length
  const nonResolutionQualityClean = items.filter((item) => item.quality.flags.every((flag) => flag === '分辨率偏低')).length
  return {
    images: items.length,
    mediaPipeFaceDetected: items.filter((item) => item.pose.detectedFaces > 0).length,
    frontPoseGatePassed: posePasses,
    frontPoseGatePassRate: Number((posePasses / items.length).toFixed(4)),
    frontPoseGateWilson95: wilson95(posePasses, items.length),
    qualityGatePassed: qualityPasses,
    qualityGatePassRate: Number((qualityPasses / items.length).toFixed(4)),
    nonResolutionQualityClean,
    qualityScore: quantiles(items.map((item) => item.quality.score)),
    yaw: quantiles(items.map((item) => item.pose.yaw ?? Number.NaN).filter(Number.isFinite), 2),
    roll: quantiles(items.map((item) => item.pose.roll ?? Number.NaN).filter(Number.isFinite), 2),
    poseStatus: counts(items.map((item) => item.pose.status)),
    estimatedPose: counts(items.map((item) => item.pose.estimatedPose)),
    poseFlags: counts(items.flatMap((item) => item.pose.flags.length ? item.pose.flags : ['none'])),
    qualityFlags: counts(items.flatMap((item) => item.quality.flags.length ? item.quality.flags : ['none'])),
  }
}

function groupSummary(cases: Case[], key: (item: Case) => string) {
  return Object.fromEntries(Object.entries(Object.groupBy(cases, key)).map(([name, items]) => [name, summarize(items)]))
}

const cases: Case[] = []
for (const [index, record] of manifest.records.entries()) {
  status.textContent = `处理 ${index + 1} / ${manifest.records.length}`
  const url = `${stagingRoot}/sample/${record.file}`
  const blob = await fetch(url).then((response) => response.blob())
  const file = new File([blob], 'fairface-sample.jpg', { type: blob.type || 'image/jpeg' })
  const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
  cases.push({ ...record, quality, pose })
}

const result = {
  testedAt: new Date().toISOString(),
  policyVersion: manifest.policyVersion,
  source: manifest.source,
  sourceParquetSha256: 'd0cfac2888356b3d3fa3d837bc30961d8c860934e4c5df862e8cb87812bfa137',
  license: 'CC BY 4.0',
  selection: manifest.selection,
  perIntersectionStratum: manifest.perStratum,
  labelsWarning: 'Race, gender presentation and age are dataset labels used only for aggregate robustness evaluation; HeadUp does not infer these traits.',
  resolutionWarning: 'FairFace config 0.25 images are 224x224 and intentionally fail the production resolution hard gate; pose-gate results are reported separately.',
  productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  overall: summarize(cases),
  byRace: groupSummary(cases, (item) => item.race),
  byGenderPresentation: groupSummary(cases, (item) => item.genderPresentation),
  byAgeBucket: groupSummary(cases, (item) => item.ageBucket),
  retention: {
    imagesRetainedAfterBenchmark: false,
    individualPredictionsRetained: false,
    identifiersRetained: false,
    aggregateOnly: true,
  },
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成'
