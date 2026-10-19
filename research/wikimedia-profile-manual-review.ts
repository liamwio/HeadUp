type Candidate = {
  reviewId: string
  pairId: string
  view: 'left_profile' | 'right_profile'
  relativePath: string
  width: number
  height: number
  license: string
  attribution: string
}
type Manifest = {
  policyVersion: string
  source: { name: string; sourceUrl: string; license: string }
  counts: { images: number; subjects: number; leftProfiles: number; rightProfiles: number }
  records: Candidate[]
}
type Decision = 'standard_profile' | 'retake' | 'exclude'
type Review = { decision?: Decision; issue?: string; note?: string }

declare global { interface Window { __HEADUP_STANDARD_PROFILE_MANUAL_REVIEW__?: unknown } }

const projectRoot = ''
const manifestPath = 'data/manual-test/standard-profile-manual-v2/manifest.json'
const manifest = await fetch(`${projectRoot}/${manifestPath}`, { cache: 'no-store' }).then((response) => response.json()) as Manifest
if (manifest.policyVersion !== 'HEADUP-STANDARD-PROFILE-MANUAL-2.0' || manifest.records.length !== 40) throw new Error('标准侧面人工测试清单异常')

const grid = document.querySelector<HTMLElement>('#grid')!
const status = document.querySelector<HTMLElement>('#status')!
const reviews = new Map<string, Review>()
let activeFilter = 'all'
const issues = [
  ['', '选择主要原因'], ['oblique', '斜侧/双眼明显可见'], ['pitch', '低头或抬头'],
  ['expression', '张口或明显表情'], ['quality', '清晰度、曝光或分辨率不足'],
  ['occlusion', '头发、胡须或物体遮挡'], ['glasses', '眼镜影响点位'],
  ['incomplete_contour', '额鼻唇颏/下颌轮廓不完整'], ['contour_suspicious', 'HeadUp描线与真实轮廓不符'],
  ['unrepresentative', '不具测试代表性'], ['other', '其他'],
]
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)
const viewLabel = (view: Candidate['view']) => view === 'left_profile' ? '左侧面' : '右侧面'

function updateStatus() {
  const decisions = [...reviews.values()].map((review) => review.decision).filter(Boolean)
  const count = (decision: Decision) => decisions.filter((value) => value === decision).length
  status.innerHTML = `<span>标准候选 ${manifest.records.length}</span><span>20人 × 左右侧</span><span>已审核 ${decisions.length} / ${manifest.records.length}</span><span>标准侧面 ${count('standard_profile')}</span><span>需重拍 ${count('retake')}</span><span>排除 ${count('exclude')}</span>`
  window.__HEADUP_STANDARD_PROFILE_MANUAL_REVIEW__ = { loaded: manifest.records.length, reviewed: decisions.length, complete: decisions.length === manifest.records.length }
}
function applyFilter() {
  for (const card of grid.querySelectorAll<HTMLElement>('.card')) {
    const decision = reviews.get(card.dataset.id!)?.decision
    const visible = activeFilter === 'all' || (activeFilter === 'unreviewed' && !decision) || card.dataset.view === activeFilter || decision === activeFilter
    card.classList.toggle('hidden', !visible)
  }
}

for (const candidate of manifest.records) {
  const imageUrl = `${projectRoot}/data/face-db-real-research/${candidate.relativePath}`
  const options = issues.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
  grid.insertAdjacentHTML('beforeend', `<article class="card" data-id="${candidate.reviewId}" data-view="${candidate.view}"><div class="photo"><img src="${escapeHtml(imageUrl)}" alt="${candidate.reviewId} ${viewLabel(candidate.view)}" loading="lazy" /></div><div class="body"><div class="head"><h2>${candidate.reviewId} · ${viewLabel(candidate.view)}</h2><span class="badge">${candidate.pairId}</span></div><p class="meta">${candidate.width} × ${candidate.height} · 中性表情 · 高分辨率</p><p class="source">${escapeHtml(candidate.license)} · <a href="${escapeHtml(manifest.source.sourceUrl)}" target="_blank" rel="noreferrer">数据集来源</a></p><div class="decisions"><button class="decision standard" data-decision="standard_profile">标准侧面</button><button class="decision retake" data-decision="retake">需重拍</button><button class="decision exclude" data-decision="exclude">排除</button></div><div class="fields"><select>${options}</select><textarea maxlength="500" placeholder="可选备注：轮廓、点位、质量或实际APP表现"></textarea></div></div></article>`)
  const card = grid.lastElementChild as HTMLElement
  card.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach((button) => button.addEventListener('click', () => {
    const review = reviews.get(candidate.reviewId) ?? {}
    review.decision = button.dataset.decision as Decision
    reviews.set(candidate.reviewId, review)
    card.querySelectorAll('.decision').forEach((item) => item.classList.toggle('active', item === button))
    card.classList.add('reviewed'); updateStatus(); applyFilter()
  }))
  card.querySelector('select')!.addEventListener('change', (event) => { const review = reviews.get(candidate.reviewId) ?? {}; review.issue = (event.target as HTMLSelectElement).value; reviews.set(candidate.reviewId, review) })
  card.querySelector('textarea')!.addEventListener('input', (event) => { const review = reviews.get(candidate.reviewId) ?? {}; review.note = (event.target as HTMLTextAreaElement).value; reviews.set(candidate.reviewId, review) })
}

document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter!
  document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button))
  applyFilter()
}))
document.querySelector('#export')!.addEventListener('click', () => {
  const decisions = manifest.records.map((candidate) => ({ reviewId: candidate.reviewId, pairId: candidate.pairId, view: candidate.view, decision: reviews.get(candidate.reviewId)?.decision ?? null, issue: reviews.get(candidate.reviewId)?.issue ?? '', note: reviews.get(candidate.reviewId)?.note ?? '' }))
  const payload = {
    policyVersion: 'HEADUP-STANDARD-PROFILE-MANUAL-REVIEW-2.0', exportedAt: new Date().toISOString(), sourceManifestPolicyVersion: manifest.policyVersion,
    criteria: { leftAndRightAccepted: true, directionIsNotARejectionReason: true, clearCompleteNear90DegreeProfileRequired: true },
    summary: { total: decisions.length, reviewed: decisions.filter((item) => item.decision).length, standardProfile: decisions.filter((item) => item.decision === 'standard_profile').length, retake: decisions.filter((item) => item.decision === 'retake').length, exclude: decisions.filter((item) => item.decision === 'exclude').length },
    privacy: { imagesIncluded: false, pathsIncluded: false, hashesIncluded: false, sourceSubjectIdsIncluded: false }, decisions,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `headup-standard-profile-manual-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0)
})
try {
  const saved = await fetch(`${projectRoot}/data/manual-test/standard-profile-manual-v2/manual-review.json`, { cache: 'no-store' }).then((response) => response.ok ? response.json() : null) as null | { policyVersion: string; decisions: Array<{ reviewId: string; decision: Decision; issue: string; note: string }> }
  if (saved?.policyVersion === 'HEADUP-STANDARD-PROFILE-MANUAL-REVIEW-2.0') {
    for (const decision of saved.decisions) {
      if (!manifest.records.some((record) => record.reviewId === decision.reviewId)) continue
      reviews.set(decision.reviewId, { decision: decision.decision, issue: decision.issue, note: decision.note })
      const card = grid.querySelector<HTMLElement>(`.card[data-id="${decision.reviewId}"]`)
      if (!card) continue
      card.classList.add('reviewed')
      card.querySelectorAll<HTMLElement>('.decision').forEach((button) => button.classList.toggle('active', button.dataset.decision === decision.decision))
      ;(card.querySelector('select') as HTMLSelectElement).value = decision.issue
      ;(card.querySelector('textarea') as HTMLTextAreaElement).value = decision.note
    }
  }
} catch { /* optional persisted human review */ }
updateStatus()
