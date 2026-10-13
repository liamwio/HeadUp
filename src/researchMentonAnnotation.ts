import {
  aggregateMentonAgreement,
  buildCanonicalMentonSession,
  buildMentonAnnotationSession,
  compareMentonAnnotationSessions,
  parseMentonAnnotationSession,
  type MentonAnnotationRecord,
  type MentonAnnotationSession,
  type ProfileDirection,
} from './lib/mentonAnnotationStudy'
import { preflightImageFile } from './lib/imageInputPreflight'

interface ImageEntry {
  file: File
  sha256: string
  width: number
  height: number
}

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!

async function sha256Bytes(data: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256Text(value: string) {
  return sha256Bytes(new TextEncoder().encode(value).buffer as ArrayBuffer)
}

async function prepareImages(files: File[]) {
  if (!files.length) throw new Error('未选择图片')
  if (files.length > 500) throw new Error('单次最多处理500张图片')
  const entries: ImageEntry[] = []
  for (const file of files) {
    if (file.size > 30 * 1024 * 1024) throw new Error('单张图片不能超过30 MB')
    const [sha256, bitmap] = await Promise.all([
      sha256Bytes(await file.arrayBuffer()),
      preflightImageFile(file).then(() => createImageBitmap(file)),
    ])
    entries.push({ file, sha256, width: bitmap.width, height: bitmap.height })
    bitmap.close()
  }
  if (new Set(entries.map((entry) => entry.sha256)).size !== entries.length) {
    throw new Error('选择的图片包含重复内容')
  }
  return entries
}

async function readJson(file: File) {
  if (file.size > 10 * 1024 * 1024) throw new Error('标注JSON不能超过10 MB')
  return JSON.parse(await file.text()) as unknown
}

function downloadJson(value: unknown, fileName: string) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

class BlindCanvasPicker {
  private bitmap: ImageBitmap | null = null
  private entry: ImageEntry | null = null
  private faceClicks: Array<{ x: number; y: number }> = []
  private menton: { x: number; y: number } | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private instruction: HTMLElement,
    private changed: () => void,
  ) {
    this.canvas.addEventListener('click', (event) => this.onClick(event))
    this.drawEmpty()
  }

  private drawEmpty() {
    const context = this.canvas.getContext('2d')!
    context.fillStyle = '#111713'
    context.fillRect(0, 0, this.canvas.width, this.canvas.height)
    context.fillStyle = '#aeb9b2'
    context.font = '18px sans-serif'
    context.textAlign = 'center'
    context.fillText('选择图片后开始盲标', this.canvas.width / 2, this.canvas.height / 2)
  }

  private updateInstruction() {
    if (!this.entry) this.instruction.textContent = '请先选择图片。'
    else if (this.faceClicks.length === 0) this.instruction.textContent = '第1步：点击可见软组织脸框的一个角。'
    else if (this.faceClicks.length === 1) this.instruction.textContent = '第2步：点击脸框对角，覆盖完整可见面部轮廓。'
    else if (!this.menton) this.instruction.textContent = '第3步：点击软组织下颏轮廓最低点。'
    else this.instruction.textContent = '标注完整。可保存，或再次点击调整menton；“重画”可重置脸框。'
  }

  async load(entry: ImageEntry) {
    this.bitmap?.close()
    await preflightImageFile(entry.file)
    this.bitmap = await createImageBitmap(entry.file)
    this.entry = entry
    this.faceClicks = []
    this.menton = null
    const scale = Math.min(1, 1000 / entry.width, 760 / entry.height)
    this.canvas.width = Math.max(1, Math.round(entry.width * scale))
    this.canvas.height = Math.max(1, Math.round(entry.height * scale))
    this.render()
    this.updateInstruction()
    this.changed()
  }

  resetPoint() {
    if (!this.entry) return
    this.faceClicks = []
    this.menton = null
    this.render()
    this.updateInstruction()
    this.changed()
  }

  clear() {
    this.bitmap?.close()
    this.bitmap = null
    this.entry = null
    this.faceClicks = []
    this.menton = null
    this.canvas.width = 800
    this.canvas.height = 520
    this.drawEmpty()
    this.updateInstruction()
    this.changed()
  }

  complete() {
    return this.entry !== null && this.faceClicks.length === 2 && this.menton !== null
  }

  record(direction: ProfileDirection): MentonAnnotationRecord {
    if (!this.entry || this.faceClicks.length !== 2 || !this.menton) throw new Error('当前图标注不完整')
    const x1 = Math.min(this.faceClicks[0].x, this.faceClicks[1].x)
    const y1 = Math.min(this.faceClicks[0].y, this.faceClicks[1].y)
    const x2 = Math.max(this.faceClicks[0].x, this.faceClicks[1].x)
    const y2 = Math.max(this.faceClicks[0].y, this.faceClicks[1].y)
    if (x2 - x1 < 0.1 || y2 - y1 < 0.1) throw new Error('脸框过小，请覆盖完整可见面部')
    if (this.menton.x < x1 - 0.02 || this.menton.x > x2 + 0.02
      || this.menton.y < y1 - 0.02 || this.menton.y > y2 + 0.02) {
      throw new Error('menton必须位于完整脸框内；请重画当前图')
    }
    return {
      imageSha256: this.entry.sha256,
      width: this.entry.width,
      height: this.entry.height,
      direction,
      faceBox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
      menton: { ...this.menton },
    }
  }

  private onClick(event: MouseEvent) {
    if (!this.entry) return
    const rect = this.canvas.getBoundingClientRect()
    const point = {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
    if (this.faceClicks.length < 2) this.faceClicks.push(point)
    else this.menton = point
    this.render()
    this.updateInstruction()
    this.changed()
  }

  private render() {
    const context = this.canvas.getContext('2d')!
    context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (!this.bitmap) { this.drawEmpty(); return }
    context.drawImage(this.bitmap, 0, 0, this.canvas.width, this.canvas.height)
    if (this.faceClicks.length) {
      context.fillStyle = '#e5b858'
      for (const point of this.faceClicks) {
        context.beginPath()
        context.arc(point.x * this.canvas.width, point.y * this.canvas.height, 5, 0, Math.PI * 2)
        context.fill()
      }
    }
    if (this.faceClicks.length === 2) {
      const first = this.faceClicks[0]
      const second = this.faceClicks[1]
      context.strokeStyle = '#e5b858'
      context.lineWidth = 2
      context.strokeRect(
        Math.min(first.x, second.x) * this.canvas.width,
        Math.min(first.y, second.y) * this.canvas.height,
        Math.abs(second.x - first.x) * this.canvas.width,
        Math.abs(second.y - first.y) * this.canvas.height,
      )
    }
    if (this.menton) {
      context.strokeStyle = '#5ce092'
      context.lineWidth = 3
      const x = this.menton.x * this.canvas.width
      const y = this.menton.y * this.canvas.height
      context.beginPath(); context.moveTo(x - 10, y); context.lineTo(x + 10, y); context.stroke()
      context.beginPath(); context.moveTo(x, y - 10); context.lineTo(x, y + 10); context.stroke()
      context.beginPath(); context.arc(x, y, 5, 0, Math.PI * 2); context.stroke()
    }
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((item) => item.classList.toggle('active', item === button))
    document.querySelectorAll<HTMLElement>('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${button.dataset.tab}`))
  })
})

const annotationFilesInput = $<HTMLInputElement>('#annotation-files')
const annotationCode = $<HTMLInputElement>('#annotation-code')
const annotationSession = $<HTMLSelectElement>('#annotation-session')
const annotationDirection = $<HTMLSelectElement>('#annotation-direction')
const annotationProgress = $<HTMLElement>('#annotation-progress')
const annotationSave = $<HTMLButtonElement>('#annotation-save')
const annotationExport = $<HTMLButtonElement>('#annotation-export')
let annotationEntries: ImageEntry[] = []
let annotationIndex = 0
let annotationRecords: MentonAnnotationRecord[] = []
const annotationPicker = new BlindCanvasPicker(
  $<HTMLCanvasElement>('#annotation-canvas'),
  $<HTMLElement>('#annotation-instruction'),
  () => { annotationSave.disabled = !annotationPicker?.complete() },
)

function renderAnnotationProgress(message?: string) {
  annotationProgress.textContent = message ?? `${annotationRecords.length} / ${annotationEntries.length} 已完成${annotationEntries.length ? ` · 当前 ${Math.min(annotationIndex + 1, annotationEntries.length)}` : ''}`
  annotationExport.disabled = annotationEntries.length === 0 || annotationRecords.length !== annotationEntries.length || annotationCode.value.trim().length < 4
}

annotationFilesInput.addEventListener('change', async () => {
  try {
    annotationPicker.clear()
    annotationRecords = []
    annotationIndex = 0
    renderAnnotationProgress('正在计算图片SHA-256；图片不会上传…')
    annotationEntries = await prepareImages(Array.from(annotationFilesInput.files ?? []))
    if (!annotationEntries.length) throw new Error('未选择图片')
    await annotationPicker.load(annotationEntries[0])
    renderAnnotationProgress()
  } catch (error) {
    annotationEntries = []
    renderAnnotationProgress(error instanceof Error ? error.message : '读取图片失败')
  }
})

annotationSave.addEventListener('click', async () => {
  try {
    annotationRecords.push(annotationPicker.record(annotationDirection.value as ProfileDirection))
    annotationIndex++
    if (annotationIndex < annotationEntries.length) await annotationPicker.load(annotationEntries[annotationIndex])
    else annotationPicker.clear()
    renderAnnotationProgress()
  } catch (error) {
    renderAnnotationProgress(error instanceof Error ? error.message : '保存失败')
  }
})

annotationExport.addEventListener('click', async () => {
  const code = annotationCode.value.trim()
  if (code.length < 4) return
  const session = buildMentonAnnotationSession(
    annotationRecords,
    await sha256Text(code),
    annotationSession.value as 'A' | 'B',
  )
  downloadJson(session, `headup-menton-annotation-${session.sessionLabel}-${timestamp()}.json`)
  annotationEntries = []; annotationRecords = []; annotationIndex = 0
  annotationFilesInput.value = ''; annotationCode.value = ''
  annotationPicker.clear(); renderAnnotationProgress('会话已导出，图片与标注队列已从页面内存清空。')
})

$('#annotation-reset-point').addEventListener('click', () => annotationPicker.resetPoint())
$('#annotation-clear').addEventListener('click', () => {
  annotationEntries = []; annotationRecords = []; annotationIndex = 0
  annotationFilesInput.value = ''; annotationCode.value = ''
  annotationPicker.clear(); renderAnnotationProgress()
})
annotationCode.addEventListener('input', () => renderAnnotationProgress())

const compareA = $<HTMLInputElement>('#compare-a')
const compareB = $<HTMLInputElement>('#compare-b')
const compareOutput = $<HTMLElement>('#compare-output')
const compareExport = $<HTMLButtonElement>('#compare-export')
let agreementAggregate: ReturnType<typeof aggregateMentonAgreement> | null = null

async function sessionsFromInputs(a: HTMLInputElement, b: HTMLInputElement) {
  const aFile = a.files?.[0]
  const bFile = b.files?.[0]
  if (!aFile || !bFile) throw new Error('需要两份会话JSON')
  return [
    parseMentonAnnotationSession(await readJson(aFile)),
    parseMentonAnnotationSession(await readJson(bFile)),
  ] as const
}

$('#compare-run').addEventListener('click', async () => {
  try {
    const [a, b] = await sessionsFromInputs(compareA, compareB)
    const comparison = compareMentonAnnotationSessions(a, b)
    agreementAggregate = aggregateMentonAgreement(comparison)
    compareExport.disabled = false
    const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(2)}%`
    compareOutput.className = comparison.passesDevelopmentAgreementGate ? 'pass' : 'reject'
    compareOutput.textContent = [
      `匹配：${comparison.matched}；左/右：${comparison.byDirection.left}/${comparison.byDirection.right}`,
      `缺失A/B：${comparison.missingFromA}/${comparison.missingFromB}；方向冲突：${comparison.directionMismatches}`,
      `标注者独立：${comparison.distinctAnnotators ? '是' : '否'}`,
      `分歧中位/P95：${percent(comparison.disagreement.median)} / ${percent(comparison.disagreement.p95)}`,
      `需要第三方盲裁决：${comparison.adjudicationRequired}`,
      `开发一致性门：${comparison.passesDevelopmentAgreementGate ? '通过' : '未通过'}`,
      ...Object.entries(comparison.gates).map(([name, passed]) => `${passed ? '✓' : '✗'} ${name}`),
    ].join('\n')
  } catch (error) {
    agreementAggregate = null; compareExport.disabled = true; compareOutput.className = 'reject'
    compareOutput.textContent = error instanceof Error ? error.message : '比较失败'
  }
})
compareExport.addEventListener('click', () => {
  if (agreementAggregate) downloadJson(agreementAggregate, `headup-menton-agreement-${timestamp()}.json`)
})

const adjudicateAInput = $<HTMLInputElement>('#adjudicate-a')
const adjudicateBInput = $<HTMLInputElement>('#adjudicate-b')
const adjudicateFilesInput = $<HTMLInputElement>('#adjudicate-files')
const adjudicatorCode = $<HTMLInputElement>('#adjudicator-code')
const adjudicationProgress = $<HTMLElement>('#adjudication-progress')
const adjudicationOutput = $<HTMLElement>('#adjudication-output')
const adjudicationSave = $<HTMLButtonElement>('#adjudication-save')
const adjudicationExport = $<HTMLButtonElement>('#adjudication-export')
let adjudicationA: MentonAnnotationSession | null = null
let adjudicationB: MentonAnnotationSession | null = null
let adjudicationQueue: ImageEntry[] = []
let adjudicationIndex = 0
let adjudicationRecords: MentonAnnotationRecord[] = []
let canonicalResult: ReturnType<typeof buildCanonicalMentonSession> | null = null
const adjudicationPicker = new BlindCanvasPicker(
  $<HTMLCanvasElement>('#adjudication-canvas'),
  $<HTMLElement>('#adjudication-instruction'),
  () => { adjudicationSave.disabled = !adjudicationPicker?.complete() },
)

function clearAdjudication() {
  adjudicationA = null; adjudicationB = null; adjudicationQueue = []; adjudicationIndex = 0
  adjudicationRecords = []; canonicalResult = null
  adjudicationPicker.clear(); adjudicationSave.disabled = true; adjudicationExport.disabled = true
  adjudicationProgress.textContent = '0 / 0'; adjudicationOutput.textContent = '尚未准备.'
}

$('#adjudicate-prepare').addEventListener('click', async () => {
  try {
    clearAdjudication()
    const [a, b] = await sessionsFromInputs(adjudicateAInput, adjudicateBInput)
    adjudicationA = a; adjudicationB = b
    const comparison = compareMentonAnnotationSessions(a, b)
    const required = comparison.cases.filter((item) => item.requiresAdjudication)
    if (!required.length) {
      canonicalResult = buildCanonicalMentonSession(a, b, null)
      adjudicationExport.disabled = false
      adjudicationOutput.textContent = 'A/B没有超过2%的分歧，无需第三人。已生成A/B中点canonical结果。'
      return
    }
    if (adjudicatorCode.value.trim().length < 4) throw new Error('裁决者匿名口令至少4个字符')
    adjudicationProgress.textContent = '正在按SHA-256匹配原图；图片不会上传…'
    const entries = await prepareImages(Array.from(adjudicateFilesInput.files ?? []))
    const entryByHash = new Map(entries.map((entry) => [entry.sha256, entry]))
    adjudicationQueue = required.map((item) => {
      const entry = entryByHash.get(item.imageSha256)
      if (!entry) throw new Error(`缺少 ${required.length} 张裁决图中的至少一张；请重新选择完整原图集合`)
      return entry
    })
    await adjudicationPicker.load(adjudicationQueue[0])
    adjudicationProgress.textContent = `0 / ${adjudicationQueue.length} 已裁决`
    adjudicationOutput.textContent = `A/B匹配${comparison.matched}张，其中${required.length}张分歧>2%。裁决页不会显示A/B点。`
  } catch (error) {
    adjudicationOutput.className = 'reject'
    adjudicationOutput.textContent = error instanceof Error ? error.message : '准备裁决失败'
  }
})

adjudicationSave.addEventListener('click', async () => {
  try {
    if (!adjudicationA || !adjudicationB) throw new Error('裁决会话未准备')
    const current = adjudicationQueue[adjudicationIndex]
    const sourceRecord = adjudicationA.records.find((record) => record.imageSha256 === current.sha256)
    if (!sourceRecord) throw new Error('裁决图与A会话不匹配')
    adjudicationRecords.push(adjudicationPicker.record(sourceRecord.direction))
    adjudicationIndex++
    if (adjudicationIndex < adjudicationQueue.length) {
      await adjudicationPicker.load(adjudicationQueue[adjudicationIndex])
      adjudicationProgress.textContent = `${adjudicationRecords.length} / ${adjudicationQueue.length} 已裁决`
      return
    }
    adjudicationPicker.clear()
    const sessionC = buildMentonAnnotationSession(
      adjudicationRecords,
      await sha256Text(adjudicatorCode.value.trim()),
      'C',
    )
    canonicalResult = buildCanonicalMentonSession(adjudicationA, adjudicationB, sessionC)
    adjudicationExport.disabled = false
    adjudicationProgress.textContent = `${adjudicationRecords.length} / ${adjudicationQueue.length} 已裁决`
    adjudicationOutput.className = canonicalResult.agreement.passesDevelopmentAgreementGate ? 'pass' : 'reject'
    adjudicationOutput.textContent = `canonical记录：${canonicalResult.records.length}\n三人medoid裁决：${adjudicationRecords.length}\nA/B开发一致性门：${canonicalResult.agreement.passesDevelopmentAgreementGate ? '通过' : '未通过'}`
  } catch (error) {
    adjudicationOutput.className = 'reject'
    adjudicationOutput.textContent = error instanceof Error ? error.message : '保存裁决失败'
  }
})

$('#adjudication-reset-point').addEventListener('click', () => adjudicationPicker.resetPoint())
$('#adjudication-clear').addEventListener('click', () => {
  clearAdjudication()
  adjudicateAInput.value = ''; adjudicateBInput.value = ''; adjudicateFilesInput.value = ''; adjudicatorCode.value = ''
})
adjudicationExport.addEventListener('click', () => {
  if (!canonicalResult) return
  downloadJson(canonicalResult, `headup-menton-canonical-${timestamp()}.json`)
  clearAdjudication()
  adjudicateAInput.value = ''; adjudicateBInput.value = ''; adjudicateFilesInput.value = ''; adjudicatorCode.value = ''
  adjudicationOutput.textContent = 'canonical JSON已导出，图片与裁决队列已从页面内存清空。'
})

window.addEventListener('beforeunload', () => {
  annotationPicker.clear()
  adjudicationPicker.clear()
  annotationEntries = []; annotationRecords = []; adjudicationQueue = []; adjudicationRecords = []
})

renderAnnotationProgress()
clearAdjudication()
