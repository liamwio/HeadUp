import { describe, expect, it } from 'vitest'
import {
  aggregateMentonAgreement,
  buildCanonicalMentonSession,
  buildMentonAnnotationSession,
  compareMentonAnnotationSessions,
  mentonDisagreementNme,
  type MentonAnnotationRecord,
} from './mentonAnnotationStudy'

const hash = (value: number) => value.toString(16).padStart(64, '0')
const record = (id: number, x: number, direction: 'left' | 'right' = 'left'): MentonAnnotationRecord => ({
  imageSha256: hash(id), width: 1000, height: 800, direction,
  faceBox: { x: 0.2, y: 0.1, width: 0.6, height: 0.75 },
  menton: { x, y: 0.75 },
})

describe('menton annotation contract', () => {
  it('normalizes disagreement by the averaged face-box diagonal', () => {
    const a = record(1, 0.5)
    const b = record(1, 0.506)
    expect(mentonDisagreementNme(a, b)).toBeCloseTo(6 / Math.hypot(600, 600), 8)
  })

  it('matches sessions without leaking hashes in the aggregate', () => {
    const recordsA = Array.from({ length: 120 }, (_, index) => record(index + 1, 0.5, index < 60 ? 'left' : 'right'))
    const recordsB = recordsA.map((item) => ({ ...item, menton: { ...item.menton, x: item.menton.x + 0.006 } }))
    const a = buildMentonAnnotationSession(recordsA, hash(9001), 'A', '2026-01-01T00:00:00.000Z')
    const b = buildMentonAnnotationSession(recordsB, hash(9002), 'B', '2026-01-01T00:00:00.000Z')
    const comparison = compareMentonAnnotationSessions(a, b)
    expect(comparison.matched).toBe(120)
    expect(comparison.passesDevelopmentAgreementGate).toBe(true)
    expect(comparison.adjudicationRequired).toBe(0)
    const aggregate = aggregateMentonAgreement(comparison)
    expect(JSON.stringify(aggregate)).not.toContain(hash(1))
    expect(aggregate.retention.imageContentHashesIncluded).toBe(false)
  })

  it('requires adjudication above two percent and selects a real annotation medoid', () => {
    const aRecord = record(1, 0.40)
    const bRecord = record(1, 0.46)
    const cRecord = record(1, 0.455)
    const a = buildMentonAnnotationSession([aRecord], hash(1001), 'A')
    const b = buildMentonAnnotationSession([bRecord], hash(1002), 'B')
    const c = buildMentonAnnotationSession([cRecord], hash(1003), 'C')
    expect(compareMentonAnnotationSessions(a, b).adjudicationRequired).toBe(1)
    const canonical = buildCanonicalMentonSession(a, b, c)
    expect(canonical.records[0].resolution).toBe('three_annotator_medoid')
    expect(canonical.records[0].sourceAnnotator).toBe('C')
    expect(canonical.records[0].menton.x).toBe(0.455)
  })

  it('rejects duplicate images and reused annotators', () => {
    expect(() => buildMentonAnnotationSession([record(1, 0.4), record(1, 0.5)], hash(1), 'A')).toThrow(/重复/)
    const a = buildMentonAnnotationSession([record(1, 0.4)], hash(77), 'A')
    const b = buildMentonAnnotationSession([record(1, 0.46)], hash(78), 'B')
    const c = buildMentonAnnotationSession([record(1, 0.45)], hash(77), 'C')
    expect(() => buildCanonicalMentonSession(a, b, c)).toThrow(/不同匿名/)
  })
})
