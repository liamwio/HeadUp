import { describe, expect, it } from 'vitest'
import { featureRangeCoverage, selectMaximin, selectStratifiedPilot } from './menton-pilot-selection.mjs'

describe('menton pilot selection', () => {
  it('uses deterministic maximin coverage with stable tie breaks', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      subjectIndex: index + 1,
      features: [index, index % 3],
      tiebreaker: String(100 - index).padStart(3, '0'),
    }))
    const first = selectMaximin(items, 4).map((item) => item.subjectIndex)
    const second = selectMaximin([...items].reverse(), 4).map((item) => item.subjectIndex)
    expect(first).toEqual(second)
    expect(new Set(first).size).toBe(4)
  })

  it('selects fifteen identities from every FEI subject quartile', () => {
    const subjects = Array.from({ length: 200 }, (_, index) => ({
      subjectIndex: index + 1,
      features: [index / 199, (index * 17) % 41, (index * 23) % 37, index % 11, index % 7],
      tiebreaker: String((index * 97) % 211).padStart(3, '0'),
    }))
    const selected = selectStratifiedPilot(subjects)
    expect(selected).toHaveLength(60)
    for (let quartile = 1; quartile <= 4; quartile++) {
      expect(selected.filter((item) => item.quartile === quartile)).toHaveLength(15)
    }
  })

  it('reports selected visual feature range coverage', () => {
    const all = Array.from({ length: 20 }, (_, index) => ({ subjectIndex: index + 1, features: [index, index * 2, index * 3, index * 4, index * 5] }))
    const selected = [all[0], all[19]]
    const coverage = featureRangeCoverage(all, selected)
    expect(Object.values(coverage).every((item) => item.rangeCoverage === 1)).toBe(true)
  })
})
