import { describe, expect, it } from 'vitest'
import { cannotDetermine, reportVersion } from './report'

describe('report safety boundary contract', () => {
  it('covers all six unavailable categories from the V1 requirements appendix', () => {
    expect(cannotDetermine).toHaveLength(6)
    expect(cannotDetermine.join(' ')).toMatch(/骨龄.*颅缝.*ANB.*牙根.*髁突.*偏颌/)
  })

  it('binds every report to algorithm, norm and copy versions', () => {
    expect(reportVersion.algorithm).toBeTruthy()
    expect(reportVersion.norm).toBeTruthy()
    expect(reportVersion.copy).toBeTruthy()
  })
})
