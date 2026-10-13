import { describe, expect, it } from 'vitest'
import type { Measurement } from '../types'
import { absoluteP95, relativeP95 } from './errorEvidence'
// Preserve historical numerical contracts, independently of product release gates.
import { evaluateResearchPhotoReference as evaluateMeasurementAgainstPhotoReference } from './photoReferenceEvaluation'

function measurement(code: string, value: string, errors:Measurement['errors']=[]): Measurement {
  return { code, label: code, value, score: 90, note: '', group: '比例', errors }
}

describe('visible-photo external reference evaluation', () => {
  it('classifies percent, ratio and degree values without turning the band into a beauty score', () => {
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-07', '39.4%'))?.direction).toBe('within')
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-08', '0.61'))?.direction).toBe('below')
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-ANGLE-01', '8.1°'))?.direction).toBe('above')
  })

  it('does not invent a reference for formulas that are not mapped', () => {
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-SYM-01', '4.2%'))).toBeNull()
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-10','0.33'))).toBeNull()
  })

  it('maps only formula-compatible Face Report bands for face length, pupil width and jaw width',()=>{
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-01','1.230'))?.referenceLabel).toBe('1.18–1.28')
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-02','48.00%'))?.referenceLabel).toBe('46%–50%')
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-03','1.200'))?.referenceLabel).toBe('1.05–1.35')
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-04','79.00%'))?.referenceLabel).toBe('76%–82%')
  })

  it('keeps the high-error eye-spacing direction indeterminate when RSS crosses the band',()=>{
    const result=evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-03','0.900',[relativeP95('MUCT','机位',13.12),relativeP95('MUCT','光照',10.48),relativeP95('WFLW','留出',34.99,'error')]))!
    expect(result.direction).toBe('indeterminate')
    expect(result.uncertaintyLabel).toContain('两级 RSS 区间')
  })

  it('withdraws a new mapped direction when its RSS interval reaches the external band',()=>{
    const result=evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-01','1.100',[relativeP95('MUCT','机位',6.9),relativeP95('MUCT','光照',4.52)]))!
    expect(result.direction).toBe('indeterminate')
    expect(result.interpretation).toBe('本张照片无法区分')
  })

  it('combines same-source components then independent sources with two-level RSS',()=>{
    const result=evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-05','34%',[
      relativeP95('MUCT','机位',7.42),relativeP95('MUCT','光照',24.31),relativeP95('WFLW','留出',17.43,'error'),
    ]))!
    expect(result.direction).toBe('indeterminate')
    expect(result.interpretation).toBe('本张照片无法区分')
    expect(result.uncertaintyLabel).toBe('两级 RSS 区间 23.52%–44.48%')
  })

  it.each([
    ['FRONT-RATIO-05','34%',[relativeP95('MUCT','机位',7.42),relativeP95('MUCT','光照',24.31),relativeP95('WFLW','留出',17.43,'error')]],
    ['FRONT-RATIO-07','34%',[relativeP95('MUCT','机位',11.42),relativeP95('MUCT','光照',8.83)]],
    ['FRONT-RATIO-08','0.65',[relativeP95('MUCT','机位',12.09),relativeP95('MUCT','光照',12.39),relativeP95('WFLW','留出',46.37,'error')]],
    ['FRONT-RATIO-09','18%',[relativeP95('MUCT','机位',17.79),relativeP95('MUCT','光照',11.93),absoluteP95('Menpo','鼻尖',4.06,'face_box_diagonal_percent')]],
  ])('%s hides direction when its RSS interval overlaps the band',(code,value,errors)=>{
    expect(evaluateMeasurementAgainstPhotoReference(measurement(code,value,errors))?.direction).toBe('indeterminate')
  })

  it('does not map the glabella-anchored HeadUp midface share to the external brow-peak-midpoint band',()=>{
    expect(evaluateMeasurementAgainstPhotoReference(measurement('FRONT-RATIO-06','29.00%',[relativeP95('MUCT','机位',10.32),relativeP95('MUCT','光照',9.43)]))).toBeNull()
  })
})
