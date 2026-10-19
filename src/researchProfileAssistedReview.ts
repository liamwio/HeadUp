import { inspectCaptureFile } from './lib/captureAnalysis'
import { buildNativeProfilePresentation } from './lib/nativeProfilePresentation'
import { profileRegionAnnotationDefinitions, type NormalizedAnnotationPoint, type ProfileRegionName } from './lib/profileRegionAnnotationStudy'
import { PROFILE_REGION_ASSISTED_POLICY, assistedRegionWasCorrected, jawNeckLineAngle, neckContourGeometryIssues, profileRegionAssistedCoverage, validateProfileRegionAssistedExport, type AssistedReviewCase, type AssistedRegionReview, type ProfileRegionAssistedExport } from './lib/profileRegionAssistedReview'

type ManifestCase = { reviewId: string; dataset: string; view: string; path: string; sourceResolution: string }
const root = ''
const manifest = await fetch(`${root}/data/manual-test/profile-region-truth-v1/manifest.json`).then((response) => response.json()) as { cases: ManifestCase[] }
const cases = manifest.cases.filter((item) => item.dataset === 'london_highres_confirmation' && item.view === 'right_profile')
if (cases.length !== 30) throw new Error(`Expected 30 profile cases, found ${cases.length}`)
const names = Object.keys(profileRegionAnnotationDefinitions) as ProfileRegionName[]
const colors: Record<ProfileRegionName, string> = { forehead: '#4baeea', nasalDorsum: '#e6ae2c', maxillarySupport: '#a76bd5', mandibularChin: '#36b873' }
const records = new Map<string, AssistedReviewCase>()
const eLineEvidence = new Map<string, { line: NormalizedAnnotationPoint[]; upperLip?: NormalizedAnnotationPoint; lowerLip?: NormalizedAnnotationPoint }>()
const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const photo = $<HTMLImageElement>('#photo'), overlay = $<SVGSVGElement>('#overlay'), progress = $('#progress'), caseJump = $<HTMLSelectElement>('#case-jump'), regionsNode = $('#regions'), instruction = $('#instruction'), stateNode = $('#region-state'), output = $('#output'), note = $<HTMLTextAreaElement>('#note')
type ActiveRegion = ProfileRegionName | 'neckContour'
let currentIndex = 0, activeRegion: ActiveRegion = 'forehead', draggingIndex: number | null = null

const clonePoints = (points: readonly NormalizedAnnotationPoint[]) => points.map((point) => ({ ...point }))
const currentCase = () => cases[currentIndex]
const currentRecord = () => records.get(currentCase().reviewId)!
const currentRegion = () => currentRecord().regions[activeRegion as ProfileRegionName]
const pointsAttribute = (points: readonly NormalizedAnnotationPoint[]) => points.map((point) => `${point.x},${point.y}`).join(' ')
const normalizedPointer = (event: PointerEvent) => { const rect = overlay.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) } }
const statusLabel = (region: AssistedRegionReview) => ({ pending: '机器预标注 · 待人工确认', confirmed: '人工确认机器线', corrected: '人工已修正', manual_from_scratch: '模型失败 · 人工补画完成', occluded: '人工标记不可见', model_unavailable: '模型不可用 · 请从零点击' })[region.status]
const updateNeckAngle = (neck: AssistedReviewCase['neckContour']) => { neck.angleDegrees = jawNeckLineAngle(currentRecord().regions.mandibularChin.points, neck.points); neck.visualBand = null }

async function predict(item: ManifestCase): Promise<AssistedReviewCase> {
  const blob = await fetch(`${root}/${item.path}`).then((response) => response.blob())
  const inspected = await inspectCaptureFile('profile', new File([blob], `${item.reviewId}.jpg`, { type: blob.type || 'image/jpeg' }))
  const presentation = buildNativeProfilePresentation(inspected.pose.nativeProfile, inspected.width, inspected.height)
  const byPath = Object.fromEntries((presentation?.paths ?? []).map((path) => [path.code, path.points.map((point) => ({ x: point.x / inspected.width, y: point.y / inspected.height }))])) as Record<string, NormalizedAnnotationPoint[]>
  const upperLip = presentation?.points[27], lowerLip = presentation?.points[33]
  eLineEvidence.set(item.reviewId, { line: byPath.eline ?? [], upperLip: upperLip ? { x: upperLip.x / inspected.width, y: upperLip.y / inspected.height } : undefined, lowerLip: lowerLip ? { x: lowerLip.x / inspected.width, y: lowerLip.y / inspected.height } : undefined })
  const regions = Object.fromEntries(names.map((name) => {
    const definition = profileRegionAnnotationDefinitions[name], modelPoints = byPath[definition.pathCode] ?? []
    const valid = modelPoints.length === definition.pointCount
    return [name, { status: valid ? 'pending' : 'model_unavailable', points: valid ? clonePoints(modelPoints) : [], modelPoints: valid ? clonePoints(modelPoints) : [] }]
  })) as AssistedReviewCase['regions']
  return { reviewId: item.reviewId, width: inspected.width, height: inspected.height, regions, neckContour: { status: 'manual_required', points: [], angleDegrees: null, angleDefinition: 'acute_angle_between_endpoint_fit(mandibularChin,neckContour)', visualBand: null } }
}

function updateCoverage() {
  const coverage = profileRegionAssistedCoverage({ cases: [...records.values()] })
  progress.textContent = `面部区域 ${coverage.total} · 已确认 ${coverage.confirmed} · 已修正 ${coverage.corrected} · 待确认 ${coverage.pending} · 模型失败 ${coverage.modelUnavailable}；颈线 ${coverage.neck.manualFromScratch}/${coverage.neck.total} · 待画 ${coverage.neck.pending}`
  const exportValue = buildExport(), errors = validateProfileRegionAssistedExport(exportValue)
  output.textContent = JSON.stringify({ policyVersion: PROFILE_REGION_ASSISTED_POLICY, coverage, validationErrors: errors }, null, 2)
}
function buildExport(): ProfileRegionAssistedExport { return { policyVersion: PROFILE_REGION_ASSISTED_POLICY, createdAt: new Date().toISOString(), workflow: 'model_preannotation_then_human_review', eligibleForBlindCanonical: false, cases: [...records.values()] } }
function renderRegions() {
  const neck = currentRecord().neckContour, neckLabel = neck.status === 'manual_from_scratch' ? `${neck.angleDegrees?.toFixed(1)}° · 已完成` : neck.status === 'occluded' ? '不可见' : `人工描3点 · ${neck.points.length}/3`
  regionsNode.innerHTML = `${names.map((name) => { const region = currentRecord().regions[name]; return `<button class="region-button ${name === activeRegion ? 'active' : ''}" data-region="${name}"><span>${profileRegionAnnotationDefinitions[name].label}</span><small>${statusLabel(region)}</small></button>` }).join('')}<button class="region-button ${activeRegion === 'neckContour' ? 'active' : ''}" data-region="neckContour"><span>颏下—颈部线</span><small>${neckLabel}</small></button>`
  regionsNode.querySelectorAll<HTMLButtonElement>('[data-region]').forEach((button) => button.addEventListener('click', () => { activeRegion = button.dataset.region as ActiveRegion; render() }))
}
function renderOverlay() {
  const record = currentRecord(), lines = names.map((name) => { const region = record.regions[name]; if (!region.points.length) return ''; const active = name === activeRegion; const circles = active ? region.points.map((point, index) => `<circle class="review-point" data-index="${index}" cx="${point.x}" cy="${point.y}" r="0.006" fill="${colors[name]}"/>`).join('') : ''; return `<polyline class="model-line ${active ? 'active' : ''}" stroke="${colors[name]}" points="${pointsAttribute(region.points)}"/>${circles}` }).join('')
  const neck = record.neckContour, neckCircles = activeRegion === 'neckContour' ? neck.points.map((point, index) => `<circle class="review-point" data-index="${index}" cx="${point.x}" cy="${point.y}" r="0.006" fill="#52c7c1"/>`).join('') : '', neckLine = neck.points.length ? `<polyline class="model-line ${activeRegion === 'neckContour' ? 'active' : ''}" stroke="#52c7c1" points="${pointsAttribute(neck.points)}"><title>人工颈线三点拟合</title></polyline>${neckCircles}` : ''
  const evidence = eLineEvidence.get(currentCase().reviewId), eLine = evidence?.line.length === 2 ? `<polyline points="${pointsAttribute(evidence.line)}" fill="none" stroke="#ff9f43" stroke-width="3" stroke-dasharray="0.014 0.010" vector-effect="non-scaling-stroke"><title>鼻尖—颏前点 E-Line</title></polyline>${[evidence.upperLip, evidence.lowerLip].filter(Boolean).map((point) => `<circle cx="${point!.x}" cy="${point!.y}" r="0.005" fill="#fff" stroke="#ff9f43" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('')}` : ''
  overlay.innerHTML = `${lines}${neckLine}${eLine}`
  overlay.querySelectorAll<SVGCircleElement>('.review-point').forEach((circle) => circle.addEventListener('pointerdown', (event) => { draggingIndex = Number(circle.dataset.index); circle.setPointerCapture(event.pointerId); event.stopPropagation() }))
}
function render() {
  const item = currentCase()
  $('#case-title').textContent = item.reviewId; $('#case-index').textContent = `${currentIndex + 1} / ${cases.length} · ${currentRecord().width}×${currentRecord().height}`; caseJump.value = String(currentIndex)
  if (activeRegion === 'neckContour') {
    const neck = currentRecord().neckContour
    instruction.innerHTML = '<strong>沿可见颈线依次点击3个采样点：</strong><ol><li>颈线靠近颏下的一端</li><li>颈线中部</li><li>颈线后端/下端</li></ol><small>三点只用于拟合颈线，不分别代表Me、Cer、Np解剖角点。程序将颈线与绿色下颌—颏部线的首尾拟合方向计算照片夹角。</small>'
    const neckIssues = neckContourGeometryIssues(neck.points)
    note.value = neck.note ?? ''; stateNode.textContent = neck.status === 'manual_from_scratch' && neckIssues.length === 0 ? `颈线已完成 · 下颌线—颈线夹角 ${neck.angleDegrees?.toFixed(1)}°\n这是两条照片拟合线的实验夹角，尚无经过HeadUp验证的通用美学参考带，不直接输出好看/不好看。` : neck.status === 'occluded' ? '颈部轮廓已标记不可见。' : `请沿同一条颈线点击3个采样点，当前 ${neck.points.length}/3。${neckIssues.length ? `\n阻断：${neckIssues.join('；')}` : ''}`
    $('#confirm').textContent = '确认颈线与角度'; $('#reset').textContent = '清空颈线'
  } else {
    const region = currentRegion(), definition = profileRegionAnnotationDefinitions[activeRegion]
    instruction.innerHTML = `<strong>${definition.instruction}</strong><ol>${definition.pointLabels.map((label) => `<li>${label}</li>`).join('')}</ol>`
    note.value = region.note ?? ''; stateNode.textContent = `${statusLabel(region)}\n${region.modelPoints.length ? '拖动圆点即可修正' : `请按说明依次点击 ${definition.pointCount} 个点，当前 ${region.points.length}/${definition.pointCount}`}；确认前不会计入已完成人工复核。\n橙色虚线为鼻尖—颏前点E-Line参考，不属于四条轮廓线。`
    $('#confirm').textContent = '确认当前机器线'; $('#reset').textContent = '恢复机器线'
  }
  renderRegions(); renderOverlay(); updateCoverage()
}
async function show(index: number) {
  currentIndex = Math.max(0, Math.min(cases.length - 1, index)); const item = currentCase()
  await new Promise<void>((resolve, reject) => { photo.onload = () => resolve(); photo.onerror = () => reject(new Error('Unable to load image')); photo.src = `${root}/${item.path}` })
  render()
}
function nextPending() {
  const allNames: ActiveRegion[] = [...names, 'neckContour']
  const cells = [...records.values()].flatMap((record, caseIndex) => allNames.map((region) => ({ caseIndex, region, status: region === 'neckContour' ? record.neckContour.status : record.regions[region].status })))
  const current = currentIndex * allNames.length + allNames.indexOf(activeRegion), next = [...cells.slice(current + 1), ...cells.slice(0, current + 1)].find((cell) => cell.status === 'pending' || cell.status === 'model_unavailable' || cell.status === 'manual_required')
  if (!next) { render(); return }
  activeRegion = next.region; void show(next.caseIndex)
}

overlay.addEventListener('pointermove', (event) => { if (draggingIndex === null) return; const target = activeRegion === 'neckContour' ? currentRecord().neckContour : currentRegion(); target.points[draggingIndex] = normalizedPointer(event); if (activeRegion === 'neckContour') updateNeckAngle(currentRecord().neckContour); renderOverlay() })
overlay.addEventListener('pointerup', () => { if (draggingIndex === null) return; draggingIndex = null; if (activeRegion === 'neckContour') { const neck = currentRecord().neckContour; updateNeckAngle(neck); neck.status = neck.points.length === 3 && neckContourGeometryIssues(neck.points).length === 0 ? 'manual_from_scratch' : 'manual_required' } else { const region = currentRegion(); region.status = assistedRegionWasCorrected(region) ? 'corrected' : 'pending' } render() })
overlay.addEventListener('pointercancel', () => { draggingIndex = null })
overlay.addEventListener('pointerdown', (event) => { if (draggingIndex !== null) return; if (activeRegion === 'neckContour') { const neck = currentRecord().neckContour; if (neck.points.length >= 3) return; neck.points.push(normalizedPointer(event)); updateNeckAngle(neck); if (neck.points.length === 3 && neckContourGeometryIssues(neck.points).length === 0) neck.status = 'manual_from_scratch'; render(); return } const region = currentRegion(), expected = profileRegionAnnotationDefinitions[activeRegion].pointCount; if (region.modelPoints.length || region.points.length >= expected) return; region.points.push(normalizedPointer(event)); if (region.points.length === expected) region.status = 'manual_from_scratch'; render() })
$('#confirm').addEventListener('click', () => { if (activeRegion === 'neckContour') { const neck = currentRecord().neckContour; if (neck.points.length !== 3 || neckContourGeometryIssues(neck.points).length) { render(); return } updateNeckAngle(neck); neck.status = 'manual_from_scratch'; nextPending(); return } const region = currentRegion(), expected = profileRegionAnnotationDefinitions[activeRegion].pointCount; if (region.modelPoints.length === 0) { if (region.points.length !== expected) return; region.status = 'manual_from_scratch' } else region.status = assistedRegionWasCorrected(region) ? 'corrected' : 'confirmed'; nextPending() })
$('#reset').addEventListener('click', () => { if (activeRegion === 'neckContour') { const neck = currentRecord().neckContour; neck.points = []; neck.angleDegrees = null; neck.visualBand = null; neck.status = 'manual_required'; render(); return } const region = currentRegion(); region.points = clonePoints(region.modelPoints); region.status = region.modelPoints.length ? 'pending' : 'model_unavailable'; render() })
$('#occluded').addEventListener('click', () => { if (activeRegion === 'neckContour') { const neck = currentRecord().neckContour; neck.status = 'occluded'; neck.points = []; neck.angleDegrees = null; neck.visualBand = null; nextPending(); return } const region = currentRegion(); region.status = 'occluded'; region.points = []; nextPending() })
note.addEventListener('input', () => { if (activeRegion === 'neckContour') currentRecord().neckContour.note = note.value.trim() || undefined; else currentRegion().note = note.value.trim() || undefined })
$('#previous').addEventListener('click', () => void show(currentIndex - 1)); $('#next').addEventListener('click', () => void show(currentIndex + 1)); caseJump.addEventListener('change', () => void show(Number(caseJump.value)))
$('#export').addEventListener('click', () => { const value = buildExport(), blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `headup-profile-region-assisted-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0) })
$('#resume').addEventListener('click', async () => { const file = $<HTMLInputElement>('#resume-file').files?.[0]; if (!file) return; const value = JSON.parse(await file.text()) as ProfileRegionAssistedExport, errors = validateProfileRegionAssistedExport(value); if (errors.length) { output.textContent = `恢复失败：${errors.join('；')}`; return } records.clear(); value.cases.forEach((item) => records.set(item.reviewId, item)); const first = value.cases.findIndex((item) => names.some((name) => item.regions[name].status === 'pending' || item.regions[name].status === 'model_unavailable') || item.neckContour.status === 'manual_required'); activeRegion = 'forehead'; await show(first < 0 ? 0 : first) })

caseJump.innerHTML = cases.map((item, index) => `<option value="${index}">${String(index + 1).padStart(2, '0')} · ${item.reviewId}</option>`).join('')
for (const [index, item] of cases.entries()) { progress.textContent = `正在生成机器预标注 ${index + 1}/30 · ${item.reviewId}`; try { records.set(item.reviewId, await predict(item)) } catch { const dimensions = item.sourceResolution.match(/(\d+)\s*[×x]\s*(\d+)/i); records.set(item.reviewId, { reviewId: item.reviewId, width: Number(dimensions?.[1] ?? 0), height: Number(dimensions?.[2] ?? 0), regions: Object.fromEntries(names.map((name) => [name, { status: 'model_unavailable', points: [], modelPoints: [] }])) as unknown as AssistedReviewCase['regions'], neckContour: { status: 'manual_required', points: [], angleDegrees: null, angleDefinition: 'acute_angle_between_endpoint_fit(mandibularChin,neckContour)', visualBand: null } }) } }
await show(0)
