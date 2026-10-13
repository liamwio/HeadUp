import{describe,expect,it}from'vitest'
import{absoluteP95,descriptiveRepeatabilityP95,evidenceForComponent,pairedDifferenceP95,relativeP95}from'./errorEvidence'
import{confidenceGrade,summarizeMetricValue,twoLevelRssUncertainty}from'./metricUncertainty'

describe('metric uncertainty presentation',()=>{
  it('uses two-level RSS and keeps decimal uncertainty inline',()=>{
    const errors=[relativeP95('MUCT','机位',7.42),relativeP95('MUCT','光照',24.31),relativeP95('WFLW','留出',17.43,'error')]
    expect(twoLevelRssUncertainty(34,errors,'percent')).toBeCloseTo(10.4786,3)
    expect(summarizeMetricValue('34.00%',errors).display).toBe('34.00% ± 10.48 个百分点')
  })

  it('uses a domain scale for meaningful zero instead of dividing by the observation',()=>{
    const errors=[absoluteP95('MUCT','机位',2.17,'degrees','drift'),absoluteP95('MUCT','光照',1.37,'degrees','drift')]
    const summary=summarizeMetricValue('0.20°',errors,[10])
    expect(summary.display).toBe('0.20° ± 2.57°')
    expect(summary.normalizedUncertainty).toBeCloseTo(.2566,3)
    expect(summary.gradeLabel).toBe('仅参考')
  })

  it('grades confidence as comparable, recordable, or reference only',()=>{
    expect(confidenceGrade(1,.08,.05).gradeLabel).toBe('可比较')
    expect(confidenceGrade(1,.18,.05).gradeLabel).toBe('可记录')
    expect(confidenceGrade(1,.30,.05).gradeLabel).toBe('仅参考')
  })

  it('pairs upper and lower E-Line values with their own absolute uncertainties',()=>{
    const result=summarizeMetricValue('上唇 0.20% · 下唇 -0.10%',[absoluteP95('Menpo','上唇',4.1,'percentage_points'),absoluteP95('Menpo','下唇',4.4,'percentage_points')],[5,5])
    expect(result.display).toBe('上唇 0.20% ± 4.10 个百分点 · 下唇 -0.10% ± 4.40 个百分点')
    expect(result.gradeLabel).toBe('仅参考')
  })

  it('RSS-combines multiple sources for each component of a composite reading',()=>{
    const errors=[
      evidenceForComponent(absoluteP95('Menpo','上唇',4.1,'percentage_points'),0),
      evidenceForComponent(pairedDifferenceP95('London','上唇',1.5,'percentage_points'),0),
      evidenceForComponent(absoluteP95('Menpo','下唇',4.4,'percentage_points'),1),
      evidenceForComponent(pairedDifferenceP95('London','下唇',1.5,'percentage_points'),1),
    ]
    const result=summarizeMetricValue('上唇 0.20% · 下唇 -0.10%',errors,[5,5])
    expect(result.display).toBe('上唇 0.20% ± 4.37 个百分点 · 下唇 -0.10% ± 4.65 个百分点')
  })

  it('uses paired differences only as conservative radii and excludes descriptive path repeatability from numeric RSS',()=>{
    expect(summarizeMetricValue('25.00°',[pairedDifferenceP95('London','下颌缘',5.37,'degrees')]).display).toBe('25.00° ± 5.37°')
    const pathOnly=summarizeMetricValue('25.00°',[descriptiveRepeatabilityP95('London','路径',3.06,'visible_profile_height_percent')])
    expect(pathOnly.uncertainty).toBeNull()
    expect(pathOnly.gradeLabel).toBe('仅参考')
  })
})
