import { describe, expect, it } from 'vitest'
import { obviousOcclusionFlags } from './frontOcclusion'

describe('obvious front occlusion rules', () => {
  it('allows textured eye and lower-face regions', () => {
    expect(obviousOcclusionFlags(
      { meanLuminance: 110, luminanceStdDev: 34, dominantColorFraction: 0.22 },
      { meanLuminance: 145, luminanceStdDev: 31, dominantColorFraction: 0.27 },
    )).toEqual([])
  })

  it('rejects a dark uniform eye band', () => {
    expect(obviousOcclusionFlags(
      { meanLuminance: 8, luminanceStdDev: 4, dominantColorFraction: 0.91 },
      { meanLuminance: 145, luminanceStdDev: 31, dominantColorFraction: 0.27 },
    )).toContain('眼部存在大面积明显遮挡，请摘下墨镜或遮挡物')
  })

  it('rejects a nearly uniform lower-face mask', () => {
    expect(obviousOcclusionFlags(
      { meanLuminance: 110, luminanceStdDev: 34, dominantColorFraction: 0.22 },
      { meanLuminance: 155, luminanceStdDev: 8, dominantColorFraction: 0.82 },
    )).toContain('口鼻区域存在大面积明显遮挡，请摘下口罩或遮挡物')
  })
})
