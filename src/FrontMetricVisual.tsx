import type { Measurement } from './types'
import { evaluateMeasurementAgainstPhotoReference } from './lib/photoReferenceEvaluation'
import { twoLevelRssUncertainty } from './lib/metricUncertainty'

export const frontMetricLabel = (item: Measurement) => item.code === 'FRONT-SYM-01' ? '左右对称偏差' : item.label

export function FrontMetricVisual({ item }: { item: Measurement }) {
  const reference = evaluateMeasurementAgainstPhotoReference(item)
  if (reference) return <div className={`reference-reading reference-reading--${reference.direction}`}>
    <div className="reference-axis" aria-label="观测值、测量区间与参考范围"><i style={{left:`${reference.bandStartPercent}%`,width:`${reference.bandEndPercent-reference.bandStartPercent}%`}}/>{reference.intervalStartPercent!==undefined&&reference.intervalEndPercent!==undefined&&<em style={{left:`${reference.intervalStartPercent}%`,width:`${reference.intervalEndPercent-reference.intervalStartPercent}%`}}/>}<b style={{left:`${reference.markerPercent}%`}}/></div>
    <p><strong>{reference.direction==='indeterminate'?'暂不能确定偏大或偏小':reference.interpretation}</strong><span>参考范围 {reference.referenceLabel}</span></p>
    {reference.uncertaintyLabel&&<small>{reference.uncertaintyLabel.replace('两级 RSS 区间','测量区间')}</small>}
  </div>

  const value = Number.parseFloat(item.value)
  if (!Number.isFinite(value)) return null
  const percentage = item.value.includes('%')
  const uncertainty = twoLevelRssUncertainty(value,item.errors??[],percentage?'percent':'ratio')
  if (uncertainty===null) return null
  const lower=value-uncertainty, upper=value+uncertainty
  const minimum=Math.min(0,lower), maximum=Math.max(percentage?100:1,upper)
  const percent=(number:number)=>(number-minimum)/(maximum-minimum)*100
  const format=(number:number)=>`${number.toFixed(percentage?2:3)}${percentage?'%':''}`
  return <div className="reference-reading reference-reading--ungraded">
    <div className="reference-axis" aria-label="仅显示观测值与测量区间，无评价参考带"><em style={{left:`${percent(lower)}%`,width:`${percent(upper)-percent(lower)}%`}}/><b style={{left:`${percent(value)}%`}}/></div>
    <p><strong>测量区间</strong><span>{format(lower)}–{format(upper)}</span></p>
    <small>暂无适配此公式的评价参考范围</small>
  </div>
}
