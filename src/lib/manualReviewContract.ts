export const MANUAL_REVIEW_POLICY = 'HEADUP-MANUAL-REGRESSION-REVIEW-1.1'
export const manualDecisions = ['pass', 'fail', 'needs_review'] as const
export const manualIssues = ['', 'quality_guidance_inaccurate', 'face_count_inaccurate', 'pose_or_direction_inaccurate', 'landmark_overlay_suspicious', 'measurement_suspicious', 'image_not_representative', 'other'] as const
export type ManualDecision = typeof manualDecisions[number]
export type ManualReviewValue = { decision?: ManualDecision; issue?: string; note?: string; auto?: unknown }
export type ManualReviewRecord = { reviewId: string; caseId: string; view: string; transformation?: string | null }

const forbiddenKeys = new Set(['relativePath', 'path', 'imagePath', 'sha256', 'hash', 'populationAttributes'])
function assertNoForbiddenKeys(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenKeys.has(key)) throw new Error(`审核JSON包含禁止字段: ${key}`)
    assertNoForbiddenKeys(nested)
  }
}

function normalizeReview(value: unknown): ManualReviewValue {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  if (source.decision !== undefined && !manualDecisions.includes(source.decision as ManualDecision)) throw new Error(`非法审核决策: ${String(source.decision)}`)
  if (source.issue !== undefined && !manualIssues.includes(source.issue as typeof manualIssues[number])) throw new Error(`非法问题类型: ${String(source.issue)}`)
  if (source.note !== undefined && (typeof source.note !== 'string' || source.note.length > 500)) throw new Error('审核备注必须为不超过500字的文本')
  return { ...(source.decision ? { decision: source.decision as ManualDecision } : {}), ...(typeof source.issue === 'string' ? { issue: source.issue } : {}), ...(typeof source.note === 'string' ? { note: source.note } : {}), ...(source.auto !== undefined ? { auto: source.auto } : {}) }
}

export function buildManualReviewPayload(manifestPolicyVersion: string, records: ManualReviewRecord[], reviews: Map<string, ManualReviewValue>, now = new Date()) {
  const values = [...reviews.values()]
  return {
    policyVersion: MANUAL_REVIEW_POLICY,
    exportedAt: now.toISOString(),
    manifestPolicyVersion,
    summary: { total: records.length, reviewed: values.filter(value => value.decision).length, pass: values.filter(value => value.decision === 'pass').length, fail: values.filter(value => value.decision === 'fail').length, needsReview: values.filter(value => value.decision === 'needs_review').length },
    privacy: { imagesIncluded: false, pathsIncluded: false, hashesIncluded: false, populationAttributesIncluded: false },
    reviews: records.map(record => ({ reviewId: record.reviewId, caseId: record.caseId, view: record.view, transformation: record.transformation || null, ...(reviews.get(record.reviewId) || {}) })),
  }
}

export function parseManualReviewPayload(input: unknown, manifestPolicyVersion: string, records: ManualReviewRecord[]) {
  const payload = typeof input === 'string' ? JSON.parse(input) : input
  assertNoForbiddenKeys(payload)
  if (!payload || typeof payload !== 'object') throw new Error('审核JSON必须为对象')
  const source = payload as Record<string, unknown>
  if (source.policyVersion !== MANUAL_REVIEW_POLICY) throw new Error('审核JSON版本不兼容')
  if (source.manifestPolicyVersion !== manifestPolicyVersion) throw new Error('审核JSON与当前样本清单版本不一致')
  if (!Array.isArray(source.reviews)) throw new Error('审核JSON缺少reviews数组')
  const known = new Map(records.map(record => [record.reviewId, record]))
  const parsed = new Map<string, ManualReviewValue>()
  for (const item of source.reviews) {
    if (!item || typeof item !== 'object') throw new Error('审核条目必须为对象')
    const record = item as Record<string, unknown>
    if (typeof record.reviewId !== 'string' || !known.has(record.reviewId)) throw new Error(`未知审核ID: ${String(record.reviewId)}`)
    if (parsed.has(record.reviewId)) throw new Error(`重复审核ID: ${record.reviewId}`)
    const expected = known.get(record.reviewId)!
    if (record.caseId !== expected.caseId || record.view !== expected.view || (record.transformation || null) !== (expected.transformation || null)) throw new Error(`审核条目与清单不匹配: ${record.reviewId}`)
    parsed.set(record.reviewId, normalizeReview(record))
  }
  return parsed
}

export function evaluateManualReviewCompletion(reviews: Map<string, ManualReviewValue>, records: ManualReviewRecord[]) {
  const groupFor = (record: ManualReviewRecord) => record.transformation ? 'quality_boundary' : record.view === 'front' ? 'front' : 'profile'
  const groups = ['front', 'profile', 'quality_boundary'] as const
  const byGroup = Object.fromEntries(groups.map(group => {
    const items = records.filter(record => groupFor(record) === group)
    return [group, { total: items.length, reviewed: items.filter(record => reviews.get(record.reviewId)?.decision).length }]
  })) as Record<typeof groups[number], { total: number; reviewed: number }>
  const missingDecisionIds = records.filter(record => !reviews.get(record.reviewId)?.decision).map(record => record.reviewId)
  const missingIssueIds = records.filter(record => {
    const review = reviews.get(record.reviewId)
    return (review?.decision === 'fail' || review?.decision === 'needs_review') && !review.issue
  }).map(record => record.reviewId)
  const defects = records.flatMap(record => {
    const review = reviews.get(record.reviewId)
    return review?.decision === 'fail' || review?.decision === 'needs_review'
      ? [{ reviewId: record.reviewId, caseId: record.caseId, view: record.view, transformation: record.transformation || null, decision: review.decision, issue: review.issue || '', note: review.note || '', ...(review.auto !== undefined ? { auto: review.auto } : {}) }]
      : []
  })
  const counts = { pass: records.filter(record => reviews.get(record.reviewId)?.decision === 'pass').length, fail: records.filter(record => reviews.get(record.reviewId)?.decision === 'fail').length, needsReview: records.filter(record => reviews.get(record.reviewId)?.decision === 'needs_review').length }
  const coverageComplete = missingDecisionIds.length === 0 && missingIssueIds.length === 0
  return {
    total: records.length,
    reviewed: records.length - missingDecisionIds.length,
    counts,
    byGroup,
    missingDecisionIds,
    missingIssueIds,
    defects,
    gates: {
      front30Reviewed: byGroup.front.total === 30 && byGroup.front.reviewed === 30,
      profiles20Reviewed: byGroup.profile.total === 20 && byGroup.profile.reviewed === 20,
      qualityBoundary8Reviewed: byGroup.quality_boundary.total === 8 && byGroup.quality_boundary.reviewed === 8,
      everyCaseHasDecision: missingDecisionIds.length === 0,
      everyNonPassHasIssue: missingIssueIds.length === 0,
    },
    coverageComplete,
    unresolvedCount: counts.fail + counts.needsReview,
    manualReleasePass: coverageComplete && counts.fail === 0 && counts.needsReview === 0,
  }
}
