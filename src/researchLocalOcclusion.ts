import { isPhotoQualityAcceptable } from './lib/imageQuality'
import { inspectCaptureFile } from './lib/captureAnalysis'
import {
  buildLocalOcclusionStudyAggregate,
  LOCAL_OCCLUSION_CONDITIONS,
  type LocalOcclusionCaptureResult,
  type LocalOcclusionCondition,
  type LocalOcclusionStudyMetadata,
} from './lib/localOcclusionStudy'

const labels: Record<LocalOcclusionCondition, { title: string; instruction: string }> = {
  open: { title: '无遮挡基线', instruction: '摘下口罩和墨镜；普通透明镜片如有强反光也请摘下。' },
  mask: { title: '真实口罩', instruction: '佩戴日常口罩，完整覆盖口鼻；其他条件保持不变。' },
  sunglasses: { title: '真实墨镜', instruction: '佩戴日常墨镜；摘下口罩；其他条件保持不变。' },
}

const results = new Map<string, LocalOcclusionCaptureResult>()
const grid = document.querySelector<HTMLElement>('#condition-grid')!
const progress = document.querySelector<HTMLElement>('#progress')!
const summary = document.querySelector<HTMLElement>('#summary')!
const exportButton = document.querySelector<HTMLButtonElement>('#export')!
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!
const deviceClass = document.querySelector<HTMLSelectElement>('#device-class')!
const lighting = document.querySelector<HTMLSelectElement>('#lighting')!
const sessionId = crypto.randomUUID()

function key(condition: LocalOcclusionCondition, repeat: number) {
  return `${condition}:${repeat}`
}

function metadata(): LocalOcclusionStudyMetadata {
  return {
    sessionId,
    deviceClass: deviceClass.value as LocalOcclusionStudyMetadata['deviceClass'],
    lighting: lighting.value as LocalOcclusionStudyMetadata['lighting'],
  }
}

function currentAggregate() {
  return buildLocalOcclusionStudyAggregate([...results.values()], metadata())
}

function renderSummary() {
  progress.textContent = `${results.size} / 9 已完成`
  exportButton.disabled = results.size !== 9
  if (results.size !== 9) {
    summary.textContent = `还需完成 ${9 - results.size} 次分析。只有无遮挡基线先通过的同序号配对，才能用于判断口罩或墨镜是否被阻断。`
    return
  }
  const aggregate = currentAggregate()
  const open = aggregate.byCondition.open
  const mask = aggregate.pairedTransitions.mask
  const sunglasses = aggregate.pairedTransitions.sunglasses
  summary.textContent = [
    `协议完整：${aggregate.protocol.protocolComplete ? '是' : '否'}`,
    `无遮挡联合通过：${open.combinedPassed} / 3`,
    `口罩：基线可用 ${mask.baselineCombinedEligible} 对，阻断 ${mask.blockedByCombinedGateAfterBaselineCombinedPass} 对；明确口鼻遮挡提示 ${aggregate.byCondition.mask.explicitMouthNoseOcclusionFlags} / 3`,
    `墨镜：基线可用 ${sunglasses.baselineCombinedEligible} 对，阻断 ${sunglasses.blockedByCombinedGateAfterBaselineCombinedPass} 对；明确眼部遮挡提示 ${aggregate.byCondition.sunglasses.explicitEyeOcclusionFlags} / 3`,
    open.combinedPassed < 3 ? '结论：无遮挡基线未全部通过，请先按提示重拍基线；当前不能估计遮挡阻断率。' : '结论：这是单设备、单受试者的诊断结果，需汇总多个独立会话后才能估计可靠性。',
  ].join('\n')
}

async function analyze(condition: LocalOcclusionCondition, repeat: number, file: File, input: HTMLInputElement, output: HTMLOutputElement) {
  input.disabled = true
  output.className = ''
  output.textContent = '正在运行生产质量、姿态与遮挡门禁…'
  try {
    const inspected = await inspectCaptureFile('front', file)
    const dimensions = { width: inspected.width, height: inspected.height }
    const { quality, pose } = inspected
    const qualityPass = isPhotoQualityAcceptable(quality)
    const posePass = pose.status === 'pass'
    const combinedPass = qualityPass && posePass
    results.set(key(condition, repeat), {
      condition,
      repeat,
      ...dimensions,
      qualityPass,
      posePass,
      combinedPass,
      qualityFlags: quality.flags,
      poseFlags: pose.flags,
    })
    const flags = [...quality.flags, ...pose.flags]
    output.className = combinedPass ? 'pass' : 'reject'
    output.textContent = `${dimensions.width}×${dimensions.height} · ${combinedPass ? '联合通过' : '已阻断'}${flags.length ? ` · ${flags.join('；')}` : ''}`
  } catch (error) {
    results.delete(key(condition, repeat))
    output.className = 'reject'
    output.textContent = `分析失败：${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    input.value = ''
    input.disabled = false
    renderSummary()
  }
}

for (const condition of LOCAL_OCCLUSION_CONDITIONS) {
  const section = document.createElement('article')
  section.className = 'condition'
  section.innerHTML = `<h2>${labels[condition].title}</h2><p>${labels[condition].instruction}</p>`
  for (let repeat = 1; repeat <= 3; repeat++) {
    const slot = document.createElement('div')
    slot.className = 'slot'
    const row = document.createElement('div')
    row.className = 'slot__row'
    const strong = document.createElement('strong')
    strong.textContent = `第 ${repeat} 次`
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/jpeg,image/png,image/webp'
    input.setAttribute('capture', 'environment')
    const output = document.createElement('output')
    output.textContent = '尚未分析'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) void analyze(condition, repeat, file, input, output)
    })
    row.append(strong, input)
    slot.append(row, output)
    section.append(slot)
  }
  grid.append(section)
}

exportButton.addEventListener('click', () => {
  const aggregate = currentAggregate()
  if (!aggregate.protocol.protocolComplete) return
  const blob = new Blob([`${JSON.stringify(aggregate, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `headup-local-occlusion-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`
  link.click()
  URL.revokeObjectURL(url)
})

resetButton.addEventListener('click', () => {
  results.clear()
  document.querySelectorAll<HTMLOutputElement>('.slot output').forEach((output) => {
    output.className = ''
    output.textContent = '尚未分析'
  })
  renderSummary()
})

deviceClass.addEventListener('change', renderSummary)
lighting.addEventListener('change', renderSummary)
renderSummary()
