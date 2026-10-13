import{describe,expect,it}from'vitest'
import{absoluteP95,descriptiveRepeatabilityP95,formatMetricErrorEvidence,pairedDifferenceP95,relativeP95}from'./errorEvidence'

describe('metric error evidence',()=>{
  it('renders relative and absolute units without ambiguous bare percentages',()=>{
    expect(formatMetricErrorEvidence(relativeP95('MUCT','机位',3.34))).toBe('MUCT（机位） P95 相对漂移 3.34%')
    expect(formatMetricErrorEvidence(absoluteP95('MUCT','光照',16.23,'percentage_points','drift'))).toBe('MUCT（光照） P95 漂移 ±16.23 个百分点')
    expect(formatMetricErrorEvidence(absoluteP95('Menpo450','面凸角',16.3,'degrees'))).toBe('Menpo450（面凸角） P95 误差 ±16.30°')
    expect(formatMetricErrorEvidence(descriptiveRepeatabilityP95('London 101组左右配对','下颌—颏部路径',3.06,'visible_profile_height_percent'))).toBe('London 101组左右配对（下颌—颏部路径） P95 左右配对重复性差 3.06% 可见侧貌高度（非人工真值）')
    expect(formatMetricErrorEvidence(pairedDifferenceP95('London 101组左右配对','下颌缘',5.37,'degrees'))).toBe('London 101组左右配对（下颌缘） P95 左右配对差 5.37°（作为区间保守半径）')
  })
})
