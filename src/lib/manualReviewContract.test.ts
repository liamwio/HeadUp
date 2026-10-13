import { describe, expect, it } from 'vitest'
import { buildManualReviewPayload, evaluateManualReviewCompletion, parseManualReviewPayload, type ManualReviewValue } from './manualReviewContract'

const records = [
  { reviewId: 'MANUAL-001', caseId: 'case-1', view: 'front' },
  { reviewId: 'BOUNDARY-001', caseId: 'case-2', view: 'front', transformation: 'brightness_25' },
]

describe('manual review import/export contract', () => {
  it('round-trips anonymous decisions and optional automatic evidence', () => {
    const reviews = new Map([['MANUAL-001', { decision: 'fail' as const, issue: 'measurement_suspicious', note: '复核点位', auto: { measurementCount: 12 } }]])
    const payload = buildManualReviewPayload('MANIFEST-1', records, reviews, new Date('2026-08-20T00:00:00Z'))
    const parsed = parseManualReviewPayload(payload, 'MANIFEST-1', records)
    expect(payload.summary).toMatchObject({ total: 2, reviewed: 1, fail: 1 })
    expect(payload.privacy).toEqual({ imagesIncluded: false, pathsIncluded: false, hashesIncluded: false, populationAttributesIncluded: false })
    expect(parsed.get('MANUAL-001')).toMatchObject({ decision: 'fail', issue: 'measurement_suspicious', note: '复核点位' })
  })

  it('rejects unknown, duplicate, mismatched or invalid review entries', () => {
    const base = buildManualReviewPayload('MANIFEST-1', records, new Map())
    expect(() => parseManualReviewPayload({ ...base, reviews: [{ reviewId: 'UNKNOWN', caseId: 'x', view: 'front' }] }, 'MANIFEST-1', records)).toThrow('未知审核ID')
    expect(() => parseManualReviewPayload({ ...base, reviews: [base.reviews[0], base.reviews[0]] }, 'MANIFEST-1', records)).toThrow('重复审核ID')
    expect(() => parseManualReviewPayload({ ...base, reviews: [{ ...base.reviews[0], caseId: 'wrong' }] }, 'MANIFEST-1', records)).toThrow('与清单不匹配')
    expect(() => parseManualReviewPayload({ ...base, reviews: [{ ...base.reviews[0], decision: 'maybe' }] }, 'MANIFEST-1', records)).toThrow('非法审核决策')
    expect(() => parseManualReviewPayload({ ...base, reviews: [{ ...base.reviews[0], note: 'x'.repeat(501) }] }, 'MANIFEST-1', records)).toThrow('不超过500字')
  })

  it('fails closed on image paths, hashes or nested forbidden fields', () => {
    const base = buildManualReviewPayload('MANIFEST-1', records, new Map())
    expect(() => parseManualReviewPayload({ ...base, relativePath: 'images/person.jpg' }, 'MANIFEST-1', records)).toThrow('relativePath')
    expect(() => parseManualReviewPayload({ ...base, reviews: [{ ...base.reviews[0], auto: { sha256: 'secret' } }] }, 'MANIFEST-1', records)).toThrow('sha256')
  })

  it('separates review coverage from release approval and creates anonymous defects', () => {
    const fullRecords = [
      ...Array.from({ length: 30 }, (_, index) => ({ reviewId: `F-${index}`, caseId: `f-${index}`, view: 'front' })),
      ...Array.from({ length: 20 }, (_, index) => ({ reviewId: `P-${index}`, caseId: `p-${index}`, view: index < 10 ? 'left_profile' : 'right_profile' })),
      ...Array.from({ length: 8 }, (_, index) => ({ reviewId: `B-${index}`, caseId: `b-${index}`, view: 'front', transformation: 'blur_1' })),
    ]
    const reviews = new Map<string, ManualReviewValue>(fullRecords.map(record => [record.reviewId, { decision: 'pass' as const }]))
    reviews.set('F-0', { decision: 'fail', issue: 'measurement_suspicious', note: '点位偏移' })
    const result = evaluateManualReviewCompletion(reviews, fullRecords)
    expect(result.coverageComplete).toBe(true)
    expect(result.manualReleasePass).toBe(false)
    expect(result.unresolvedCount).toBe(1)
    expect(result.defects[0]).toMatchObject({ reviewId: 'F-0', issue: 'measurement_suspicious' })
    expect(result.gates).toEqual({ front30Reviewed: true, profiles20Reviewed: true, qualityBoundary8Reviewed: true, everyCaseHasDecision: true, everyNonPassHasIssue: true })
  })

  it('reports missing decisions and missing issue classifications', () => {
    const reviewRecords = [{ reviewId: 'A', caseId: 'a', view: 'front' }, { reviewId: 'B', caseId: 'b', view: 'front' }]
    const result = evaluateManualReviewCompletion(new Map([['A', { decision: 'needs_review' as const }]]), reviewRecords)
    expect(result.coverageComplete).toBe(false)
    expect(result.missingDecisionIds).toEqual(['B'])
    expect(result.missingIssueIds).toEqual(['A'])
    expect(result.manualReleasePass).toBe(false)
  })
})
