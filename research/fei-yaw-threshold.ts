import { estimateWideHeadPoseFromBitmap } from '../src/lib/wideHeadPose'

const root = '/@fs/D:/AICodex/HeadUp/data/manual-test/fei-front-profile-v1/extracted-source'
const status = document.querySelector<HTMLElement>('#status')!
const cards = document.querySelector<HTMLElement>('#cards')!
const resultNode = document.querySelector<HTMLElement>('#result')!
const values: number[] = []
const failures: string[] = []

const quantile = (input: readonly number[], q: number) => {
  const sorted = [...input].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

for (let subject = 1; subject <= 200; subject += 1) {
  status.textContent = `分析 ${subject}/200`
  try {
    const response = await fetch(`${root}/${subject}-10.jpg`)
    if (!response.ok) throw new Error(String(response.status))
    const bitmap = await createImageBitmap(await response.blob())
    try {
      const pose = await estimateWideHeadPoseFromBitmap(bitmap)
      values.push(Math.abs(pose.yaw))
    } finally {
      bitmap.close()
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
}

const thresholds = [35, 55, 65, 70, 75]
const counts = Object.fromEntries(
  thresholds.map((threshold) => [threshold, values.filter((value) => value >= threshold).length]),
)
const output = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-FEI-RIGHT-PROFILE-YAW-THRESHOLD-1.0',
  source: { dataset: 'FEI Face Database', view: 10, publisherMeaning: 'extreme right profile', images: 200 },
  runtime: navigator.userAgent,
  distribution: {
    min: quantile(values, 0),
    p05: quantile(values, 0.05),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: quantile(values, 1),
  },
  thresholdRecall: Object.fromEntries(
    thresholds.map((threshold) => [
      threshold,
      { accepted: counts[threshold], total: values.length, rate: counts[threshold] / values.length },
    ]),
  ),
  failures: failures.length,
  privacy: { subjectIdsIncluded: false, individualYawIncluded: false },
}

status.textContent = `完成 · ${values.length}/200 · 错误${failures.length}`
cards.innerHTML = thresholds
  .map((threshold) => `<span>≥${threshold}°<strong>${counts[threshold]}/200</strong></span>`)
  .join('')
resultNode.textContent = JSON.stringify(output, null, 2)
;(window as typeof window & { __HEADUP_FEI_YAW_RESULT__?: unknown }).__HEADUP_FEI_YAW_RESULT__ = output
