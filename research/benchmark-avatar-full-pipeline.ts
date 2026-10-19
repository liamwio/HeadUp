import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { analyzeCaptures } from '../src/lib/faceMeasurements'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import type { Capture } from '../src/types'

declare global { interface Window { __HEADUP_AVATAR_FULL_PIPELINE__?: unknown } }

type ManifestRecord = {
  id: string
  pseudonymousSubjectId: string
  relativePath: string
  width: number
  height: number
  externalAssetId?: string
}

const projectRoot = ''
const datasetId = new URLSearchParams(location.search).get('dataset') || 'nasa-highres'
if (!/^[a-z0-9-]+$/.test(datasetId)) throw new Error(`非法数据集标识: ${datasetId}`)
const manifestUrl = `${projectRoot}/data/face-db-real-research/avatar-smoke/${datasetId}/manifest.jsonl`
const statusElement = document.querySelector<HTMLParagraphElement>('#status')!
const summaryElement = document.querySelector<HTMLElement>('#summary')!
const cardsElement = document.querySelector<HTMLElement>('#cards')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function round(value: number | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

const manifestResponse = await fetch(manifestUrl)
if (!manifestResponse.ok) throw new Error(`无法读取新头像manifest: ${manifestResponse.status}`)
const records = (await manifestResponse.text()).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ManifestRecord)
const cases = [] as Array<Record<string, unknown>>

for (const [index, record] of records.entries()) {
  statusElement.textContent = `处理 ${index + 1} / ${records.length}`
  const imageUrl = `${projectRoot}/${record.relativePath.replaceAll('\\', '/')}`
  const response = await fetch(imageUrl)
  if (!response.ok) throw new Error(`无法读取图片 ${record.id}: ${response.status}`)
  const blob = await response.blob()
  const file = new File([blob], `${record.id}.jpg`, { type: blob.type || 'image/jpeg' })
  const startedAt = performance.now()
  const inspected = await inspectCaptureFile('front', file)
  const capture: Capture = { id: 'front', label: '正面', eyebrow: '', hint: '', quality: inspected.quality, poseValidation: inspected.pose }
  const pose = inspected.pose
  const qualityAcceptable = isPhotoQualityAcceptable(inspected.quality)
  const analysis = qualityAcceptable && pose.status === 'pass'
    ? analyzeCaptures([capture])
    : { status: 'insufficient' as const, dataQuality: inspected.quality.score, measurements: [], summary: '生产门拒绝，未生成测量。', limitation: '拒绝输入不得形成分析结果。' }
  const elapsedMs = performance.now() - startedAt
  const item = {
    id: record.id,
    subject: record.pseudonymousSubjectId,
    externalAssetId: record.externalAssetId || null,
    input: { width: inspected.width, height: inspected.height },
    quality: inspected.quality,
    pose: {
      status: pose.status,
      estimatedPose: pose.estimatedPose,
      detectedFaces: pose.detectedFaces,
      yaw: round(pose.yaw, 1),
      pitch: round(pose.pitch, 1),
      roll: round(pose.roll, 1),
      faceDetectorScore: round(pose.faceDetectorScore, 4),
      faceAreaRatio: round(pose.faceAreaRatio, 4),
      faceCenterDistance: round(pose.faceCenterDistance, 4),
      landmarkCount: pose.landmarks?.length || 0,
      flags: pose.flags,
    },
    analysis: {
      status: analysis.status,
      dataQuality: analysis.dataQuality,
      measurementCount: analysis.measurements.length,
      measurements: analysis.measurements.map(({ code, label, value, reliability }) => ({ code, label, value, reliability })),
    },
    elapsedMs: round(elapsedMs, 1),
  }
  cases.push(item)

  const accepted = qualityAcceptable && pose.status === 'pass' && analysis.measurements.length === 12
  const flags = pose.flags.length ? pose.flags.join('；') : accepted ? '完整管线通过，已生成12项正面测量' : '质量或测量门未通过'
  const measurements = analysis.measurements.map((measurement) => `<li>${escapeHtml(measurement.label)}：<strong>${escapeHtml(measurement.value)}</strong></li>`).join('')
  cardsElement.insertAdjacentHTML('beforeend', `<article class="card ${accepted ? 'pass' : 'reject'}" data-index="${index}" data-status="${accepted ? 'pass' : 'reject'}" data-reason="${escapeHtml(pose.flags[0] || '')}">
    <div class="photo"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(record.id)}" /></div><div class="body">
    <div class="state">${accepted ? '完整管线通过' : '生产门拒绝'} · 质量分 ${inspected.quality.score}</div><h2>${escapeHtml(record.externalAssetId || record.id)}</h2>
    <div class="metrics"><div><span>人脸数</span><strong>${pose.detectedFaces}</strong></div><div><span>478关键点</span><strong>${pose.landmarks?.length || 0}</strong></div>
    <div><span>Yaw</span><strong>${round(pose.yaw, 1) ?? '—'}°</strong></div><div><span>Pitch</span><strong>${round(pose.pitch, 1) ?? '—'}°</strong></div>
    <div><span>Roll</span><strong>${round(pose.roll, 1) ?? '—'}°</strong></div><div><span>脸框占比</span><strong>${round(pose.faceAreaRatio, 4) ?? '—'}</strong></div>
    <div><span>检测分</span><strong>${round(pose.faceDetectorScore, 4) ?? '—'}</strong></div><div><span>耗时</span><strong>${round(elapsedMs, 0)} ms</strong></div></div>
    <p class="flags">${escapeHtml(flags)}</p>${measurements ? `<ul class="measurements">${measurements}</ul>` : ''}</div></article>`)
}

const reasonCounts: Record<string, number> = {}
for (const item of cases) for (const flag of (item.pose as { flags: string[] }).flags) reasonCounts[flag] = (reasonCounts[flag] || 0) + 1
const qualityPassed = cases.filter((item) => (item.quality as { score: number; flags: string[] }).score >= 60 && (item.quality as { flags: string[] }).flags.length === 0).length
const measured = cases.filter((item) => (item.analysis as { measurementCount: number }).measurementCount === 12).length
const productionPassed = measured
const rejectedWithoutMeasurements = cases.filter((item) => (item.analysis as { measurementCount: number }).measurementCount === 0).length
const rejected = cases.length - productionPassed
const visibleIndices = new Set<number>()
for (const [index, item] of cases.entries()) {
  if ((item.pose as { status: string }).status === 'pass' && [...visibleIndices].filter((value) => (cases[value].pose as { status: string }).status === 'pass').length < 9) visibleIndices.add(index)
}
for (const reason of Object.keys(reasonCounts)) {
  let selectedForReason = 0
  for (const [index, item] of cases.entries()) {
    if ((item.pose as { flags: string[] }).flags.includes(reason) && selectedForReason < 3) { visibleIndices.add(index); selectedForReason += 1 }
  }
}
for (const card of cardsElement.querySelectorAll<HTMLElement>('.card')) card.hidden = !visibleIndices.has(Number(card.dataset.index))
const summary = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-AVATAR-FULL-PIPELINE-1.1',
  datasetId,
  source: `${datasetId} deterministic real-face candidates`,
  caseCount: cases.length,
  qualityPassed,
  fullPipelinePassed: productionPassed,
  fullPipelineRejected: rejected,
  measured,
  visualizedCaseCount: visibleIndices.size,
  reasonCounts,
  gates: {
    allInputsDecoded: cases.length === records.length,
    everyRejectedHasActionableReason: cases.filter((item) => (item.pose as { status: string }).status !== 'pass').every((item) => (item.pose as { flags: string[] }).flags.length > 0),
    noMeasurementsForRejectedInputs: rejectedWithoutMeasurements === rejected,
    sourceSuitableForStandardFrontRegression: productionPassed >= Math.ceil(cases.length * 0.67),
  },
  interpretation: productionPassed >= Math.ceil(cases.length * 0.67)
    ? 'source_usable_with_manual_screening'
    : 'source_not_suitable_without_stricter_portrait_selection',
  retention: { rawImagesPersistedAfterRun: true, cleanupPending: true, screenshotContainsSourcePhotos: true },
  cases,
}

summaryElement.innerHTML = `<span class="pill">输入 ${summary.caseCount}</span><span class="pill">质量通过 ${qualityPassed}</span><span class="pill">完整通过 ${productionPassed}</span><span class="pill">拒绝 ${rejected}</span><span class="pill">可测量 ${measured}</span>`
window.__HEADUP_AVATAR_FULL_PIPELINE__ = summary
resultElement.textContent = JSON.stringify(summary, null, 2)
statusElement.textContent = `完成 · ${summary.interpretation}`
