import type { Measurement } from '../types'
import type{MetricErrorEvidence}from'./errorEvidence'
import{twoLevelRssUncertainty}from'./metricUncertainty'
import { VALIDATED_PHOTO_REFERENCE_CODES } from './measurementValidity'

export type PhotoReferenceDirection = 'below' | 'within' | 'above' | 'indeterminate'
export type PhotoReferenceEvaluation = {
  direction: PhotoReferenceDirection
  interpretation: string
  referenceLabel: string
  markerPercent: number
  intervalStartPercent?: number
  intervalEndPercent?: number
  uncertaintyLabel?: string
  bandStartPercent: number
  bandEndPercent: number
  sourceUrl: string
  limitation: string
}

type MeasurementInterval = { minimum:number;maximum:number;uncertainty:number }

type ReferenceBand = {
  minimum: number
  maximum: number
  below: string
  within: string
  above: string
  digits: number
  suffix: string
}

const SOURCE_URL = 'https://thefacereport.com/tools/facial-ratios'

// These are external calculator bands, not HeadUp population norms. Only
// measurements with materially corresponding visible-photo formulas are mapped.
const BANDS: Partial<Record<string, ReferenceBand>> = {
  'FRONT-RATIO-01': { minimum: 1.18, maximum: 1.28, below: '可见脸长相对颧宽较短', within: '可见脸长宽比落在外部计算器参考带', above: '可见脸长相对颧宽较长', digits: 2, suffix: '' },
  'FRONT-RATIO-02': { minimum: 0.46, maximum: 0.50, below: '瞳距占可见脸宽相对较小', within: '瞳距脸宽占比落在外部计算器参考带', above: '瞳距占可见脸宽相对较大', digits: 0, suffix: '%' },
  'FRONT-RATIO-03': { minimum: 1.05, maximum: 1.35, below: '内眼角距相对平均眼宽较小', within: '眼间距比落在外部计算器参考带', above: '内眼角距相对平均眼宽较大', digits: 2, suffix: '' },
  'FRONT-ANGLE-01': { minimum: 2, maximum: 7, below: '眼角轴相对更平或向下', within: '落在外部计算器的轻度上扬参考带', above: '眼角轴上扬幅度高于该参考带', digits: 1, suffix: '°' },
  'FRONT-RATIO-04': { minimum: 0.76, maximum: 0.82, below: '可见下颌宽相对颧宽较窄', within: '下颌颧宽比落在外部计算器参考带', above: '可见下颌宽相对颧宽较宽', digits: 0, suffix: '%' },
  'FRONT-RATIO-05': { minimum: 0.38, maximum: 0.45, below: '口宽占可见脸宽相对较小', within: '口宽占比落在外部计算器参考带', above: '口宽占可见脸宽相对较大', digits: 0, suffix: '%' },
  'FRONT-RATIO-07': { minimum: 0.36, maximum: 0.42, below: '下面部可见高度占比相对较短', within: '下面部高度占比落在外部计算器参考带', above: '下面部可见高度占比相对较长', digits: 0, suffix: '%' },
  'FRONT-RATIO-08': { minimum: 0.72, maximum: 0.86, below: '鼻翼宽相对口宽较小', within: '鼻嘴宽度比落在外部计算器参考带', above: '鼻翼宽相对口宽较大', digits: 2, suffix: '' },
  'FRONT-RATIO-09': { minimum: 0.20, maximum: 0.24, below: '鼻长代理占可见脸高相对较短', within: '鼻长占比落在外部计算器参考带', above: '鼻长代理占可见脸高相对较长', digits: 0, suffix: '%' },
}

function numericValue(measurement: Measurement): number | null {
  const parsed = Number.parseFloat(measurement.value)
  if (!Number.isFinite(parsed)) return null
  return measurement.value.includes('%') ? parsed / 100 : parsed
}

function display(value: number, band: ReferenceBand) {
  if (band.suffix === '%') return `${(value * 100).toFixed(band.digits)}%`
  return `${value.toFixed(band.digits)}${band.suffix}`
}

function displayObserved(value:number,band:ReferenceBand){
  if(band.suffix==='%')return`${(value*100).toFixed(2)}%`
  if(band.suffix==='°')return`${value.toFixed(2)}°`
  return value.toFixed(3)
}

function clamp(value: number) { return Math.max(0, Math.min(100, value)) }

/**
 * Two-level root-sum-square interval:
 * 1. combine P95 components belonging to the same validation source;
 * 2. combine the resulting independent source totals.
 */
export function measurementIntervalByTwoLevelRss(measured:number,errors:readonly MetricErrorEvidence[],band:ReferenceBand):MeasurementInterval|null {
  const displayUnit=band.suffix==='°'?'degrees':band.suffix==='%'?'percent':'ratio'
  const displayObserved=band.suffix==='%'?measured*100:measured
  const displayUncertainty=twoLevelRssUncertainty(displayObserved,errors,displayUnit)
  if(displayUncertainty===null)return null
  const uncertainty=band.suffix==='%'?displayUncertainty/100:displayUncertainty
  return{minimum:measured-uncertainty,maximum:measured+uncertainty,uncertainty}
}

/** Historical calculator comparison, for research only. */
export function evaluateResearchPhotoReference(measurement: Measurement): PhotoReferenceEvaluation | null {
  if (!measurement.code) return null
  const band = BANDS[measurement.code]
  const measured = numericValue(measurement)
  if (!band || measured === null) return null
  const span = band.maximum - band.minimum
  const domainMinimum = band.minimum - span * 2
  const domainMaximum = band.maximum + span * 2
  const percent = (value: number) => clamp((value - domainMinimum) / (domainMaximum - domainMinimum) * 100)
  const interval=measurementIntervalByTwoLevelRss(measured,measurement.errors??[],band)
  const overlapsBand=interval!==null&&interval.maximum>=band.minimum&&interval.minimum<=band.maximum
  const pointDirection:Exclude<PhotoReferenceDirection,'indeterminate'>=measured < band.minimum ? 'below' : measured > band.maximum ? 'above' : 'within'
  const direction:PhotoReferenceDirection=overlapsBand?'indeterminate':pointDirection
  return {
    direction,
    interpretation: direction==='indeterminate'?'本张照片无法区分':band[direction],
    referenceLabel: `${display(band.minimum, band)}–${display(band.maximum, band)}`,
    markerPercent: percent(measured),
    intervalStartPercent:interval?percent(interval.minimum):undefined,
    intervalEndPercent:interval?percent(interval.maximum):undefined,
    uncertaintyLabel:interval?`两级 RSS 区间 ${displayObserved(interval.minimum,band)}–${displayObserved(interval.maximum,band)}`:undefined,
    bandStartPercent: percent(band.minimum),
    bandEndPercent: percent(band.maximum),
    sourceUrl: SOURCE_URL,
    limitation: direction==='indeterminate'
      ? '测量区间与参考带重叠，因此隐藏偏大/偏小方向；外部参考带不是HeadUp人群常模、颜值分、医学界值或治疗建议。'
      : '两级RSS测量区间未与参考带重叠，才显示本张2D照片的方向；外部参考带不是HeadUp人群常模、颜值分、医学界值或治疗建议。',
  }
}

/** Product callers must not display unvalidated reference bands or directions. */
export function evaluateMeasurementAgainstPhotoReference(measurement: Measurement): PhotoReferenceEvaluation | null {
  if (!measurement.code || !VALIDATED_PHOTO_REFERENCE_CODES.has(measurement.code)) return null
  return evaluateResearchPhotoReference(measurement)
}
