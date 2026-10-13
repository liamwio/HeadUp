import { computeFrontGeometry } from './lib/faceMeasurements'
import { isPhotoQualityAcceptable } from './lib/imageQuality'
import { inspectCaptureFile } from './lib/captureAnalysis'
import { buildLocalRetakeStudySession, type LocalRetakeCaptureResult, type LocalRetakeStudyMetadata } from './lib/localRetakeStudy'

const results = new Map<number, LocalRetakeCaptureResult>()
const progress = document.querySelector<HTMLElement>('#progress')!
const summary = document.querySelector<HTMLElement>('#summary')!
const exportButton = document.querySelector<HTMLButtonElement>('#export')!
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!
const tokenInput = document.querySelector<HTMLInputElement>('#pairing-token')!
const newTokenButton = document.querySelector<HTMLButtonElement>('#new-token')!
const copyTokenButton = document.querySelector<HTMLButtonElement>('#copy-token')!
const sessionLabel = document.querySelector<HTMLSelectElement>('#session-label')!
const deviceClass = document.querySelector<HTMLSelectElement>('#device-class')!
const lighting = document.querySelector<HTMLSelectElement>('#lighting')!
const grid = document.querySelector<HTMLElement>('#repeat-grid')!

function newPairingToken() {
  tokenInput.value = crypto.randomUUID()
}

function metadata(): LocalRetakeStudyMetadata {
  return {
    pairingToken: tokenInput.value.trim(),
    sessionLabel: sessionLabel.value as LocalRetakeStudyMetadata['sessionLabel'],
    deviceClass: deviceClass.value as LocalRetakeStudyMetadata['deviceClass'],
    lighting: lighting.value as LocalRetakeStudyMetadata['lighting'],
  }
}

function tokenIsValid() {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(tokenInput.value.trim())
}

function currentSession() {
  return buildLocalRetakeStudySession([...results.values()], metadata())
}

function renderSummary() {
  progress.textContent = `${results.size} / 3 已完成`
  exportButton.disabled = results.size !== 3 || !tokenIsValid()
  if (!tokenIsValid()) {
    summary.textContent = '配对令牌无效。请生成随机令牌；第二时段必须使用完全相同的令牌。'
    return
  }
  if (results.size !== 3) {
    summary.textContent = `还需完成 ${3 - results.size} 次真正重拍。每次都应把人脸移出画面，再重新站位、对准和对焦。`
    return
  }
  const session = currentSession()
  summary.textContent = [
    `协议完整：${session.protocol.protocolComplete ? '是' : '否'}`,
    `质量通过：${session.summary.qualityPassed} / 3`,
    `姿态通过：${session.summary.posePassed} / 3`,
    `可用几何测量：${session.summary.usableMeasurements} / 3`,
    session.summary.usableMeasurements >= 2
      ? '本时段可计算时段内重复误差。请在至少 24 小时后的另一时段使用相同令牌、设备和光线再采集 3 次。'
      : '可用测量少于 2 次，本时段不能估计重复误差；请根据失败原因重新完成对应序号。',
  ].join('\n')
}

async function analyze(repeat: number, file: File, input: HTMLInputElement, output: HTMLOutputElement) {
  input.disabled = true
  output.className = ''
  output.textContent = '正在运行生产质量、姿态和正面几何分析…'
  try {
    const inspected = await inspectCaptureFile('front', file)
    const dimensions = { width: inspected.width, height: inspected.height }
    const { quality, pose } = inspected
    const qualityPass = isPhotoQualityAcceptable(quality)
    const posePass = pose.status === 'pass'
    const combinedPass = qualityPass && posePass
    const geometry = combinedPass && pose.landmarks
      ? computeFrontGeometry(pose.landmarks, pose.landmarkImageWidth, pose.landmarkImageHeight)
      : null
    results.set(repeat, {
      repeat,
      ...dimensions,
      qualityScore: quality.score,
      qualityPass,
      posePass,
      combinedPass: combinedPass && geometry !== null,
      qualityFlags: quality.flags,
      poseFlags: pose.flags,
      geometry,
    })
    const flags = [...quality.flags, ...pose.flags]
    output.className = combinedPass && geometry ? 'pass' : 'reject'
    output.textContent = `${dimensions.width}×${dimensions.height} · ${combinedPass && geometry ? '测量完成' : '未形成测量'}${flags.length ? ` · ${flags.join('；')}` : ''}`
  } catch (error) {
    results.delete(repeat)
    output.className = 'reject'
    output.textContent = `分析失败：${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    input.value = ''
    input.disabled = false
    renderSummary()
  }
}

for (let repeat = 1; repeat <= 3; repeat++) {
  const article = document.createElement('article')
  article.className = 'repeat-card'
  article.innerHTML = `<span class="repeat-index">0${repeat}</span><h2>第 ${repeat} 次真正重拍</h2><p>摘下口罩和所有眼镜；先完全移出画面，再回到 40–60 cm 标记处，重新居中、直视镜头、自然睁眼、不微笑、闭唇但不抿嘴，并等待自动对焦。</p>`
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/jpeg,image/png,image/webp'
  input.setAttribute('capture', deviceClass.value === 'smartphone_front' ? 'user' : 'environment')
  const output = document.createElement('output')
  output.textContent = '尚未分析'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void analyze(repeat, file, input, output)
  })
  article.append(input, output)
  grid.append(article)
}

function updateCaptureMode() {
  const mode = deviceClass.value === 'smartphone_front' ? 'user' : 'environment'
  grid.querySelectorAll<HTMLInputElement>('input[type=file]').forEach((input) => input.setAttribute('capture', mode))
  renderSummary()
}

exportButton.addEventListener('click', () => {
  const session = currentSession()
  if (!session.protocol.protocolComplete || !tokenIsValid()) return
  const blob = new Blob([`${JSON.stringify(session, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `headup-local-retake-session-${session.session.label}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`
  link.click()
  URL.revokeObjectURL(url)
})

resetButton.addEventListener('click', () => {
  results.clear()
  grid.querySelectorAll<HTMLOutputElement>('output').forEach((output) => {
    output.className = ''
    output.textContent = '尚未分析'
  })
  renderSummary()
})

newTokenButton.addEventListener('click', () => {
  newPairingToken()
  renderSummary()
})
copyTokenButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(tokenInput.value)
  copyTokenButton.textContent = '已复制'
  window.setTimeout(() => { copyTokenButton.textContent = '复制令牌' }, 1500)
})
tokenInput.addEventListener('input', renderSummary)
sessionLabel.addEventListener('change', renderSummary)
deviceClass.addEventListener('change', updateCaptureMode)
lighting.addEventListener('change', renderSummary)

newPairingToken()
renderSummary()
