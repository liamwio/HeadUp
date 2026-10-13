import { ScanFace, Ruler, ImageOff } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Capture } from './types'
import { PLAIN_HINTS, plainLabel, plainValue, readingTag } from './lib/plainResult'
import type { ConsumerReading, buildConsumerReport } from './lib/consumerReport'
import { readingUncertainty } from './lib/consumerReport'
import { buildFrontLandmarkOverlay } from './lib/frontLandmarkOverlay'

/** Symbols encode the observed value only, never an attractiveness score. */
export function ReadingSymbol({reading}:{reading?:ConsumerReading}) {
  if(!reading)return <ImageOff aria-hidden="true"/>
  const single=reading.value.match(/^(-?\d+(?:\.\d+)?)(%|°)?$/)
  if(!single)return <Ruler aria-hidden="true"/>
  const value=Number(single[1]),unit=single[2]
  if(reading.code==='FRONT-RATIO-01'&&Number.isFinite(value)&&value>0){
    const h=48,w=Math.min(44,h/value)
    return <svg viewBox="0 0 80 80" role="img" aria-label={`${reading.label} ${reading.value}长宽示意图`}><ellipse cx="36" cy="38" rx={w/2} ry={h/2} className="result-symbol-track"/><path d={`M ${36-w/2} 67 H ${36+w/2} M ${36-w/2} 63 V 71 M ${36+w/2} 63 V 71 M 66 14 V 62 M 62 14 H 70 M 62 62 H 70`} className="result-symbol-ray"/></svg>
  }
  if(unit==='%'&&value>=0&&value<=100){
    const length=2*Math.PI*28
    return <svg viewBox="0 0 80 80" role="img" aria-label={`${reading.label} ${reading.value}比例图`}><circle className="result-symbol-track" cx="40" cy="40" r="28"/><circle className="result-symbol-fill" cx="40" cy="40" r="28" strokeDasharray={`${length*value/100} ${length}`} transform="rotate(-90 40 40)"/><circle cx="40" cy="40" r="3" fill="currentColor"/></svg>
  }
  if(unit==='°'&&Math.abs(value)<=180){
    const theta=value*Math.PI/180,sign=value<0?0:1
    const x=40+Math.sin(theta)*28,y=40-Math.cos(theta)*28
    const ax=40+Math.sin(theta)*15,ay=40-Math.cos(theta)*15
    return <svg viewBox="0 0 80 80" role="img" aria-label={`${reading.label} ${reading.value}角度图`}><path className="result-symbol-ray" d={`M40 12 L40 40 L${x} ${y}`}/><path className="result-symbol-arc" d={`M40 25 A15 15 0 0 ${sign} ${ax} ${ay}`}/><circle cx="40" cy="40" r="3" fill="currentColor"/></svg>
  }
  return <Ruler aria-hidden="true"/>
}

function FaceSymbol({capture,shape}:{capture?:Capture;shape:string}) {
  const pose=capture?.poseValidation
  if(!pose?.landmarks||!pose.landmarkImageWidth||!pose.landmarkImageHeight){
    const outline=shape.includes('椭圆')?<ellipse cx="40" cy="40" rx="23" ry="31"/>:shape.includes('圆')?<circle cx="40" cy="40" r="28"/>:shape.includes('菱形')?<polygon points="40,9 67,40 40,71 13,40"/>:shape.includes('方')?<rect x="15" y="12" width="50" height="56" rx="12"/>:null
    return outline?<svg viewBox="0 0 80 80" role="img" aria-label={`${shape}类别示意`}><g className="result-symbol-category">{outline}</g></svg>:<ScanFace aria-hidden="true"/>
  }
  try {
    const points=buildFrontLandmarkOverlay(pose.landmarks,pose.landmarkImageWidth,pose.landmarkImageHeight)?.contours.find(c=>c.code==='face_oval')?.points
    if(!points?.length)return <ScanFace aria-hidden="true"/>
    const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y)),w=Math.max(...points.map(p=>p.x))-x,h=Math.max(...points.map(p=>p.y))-y
    if(!Number.isFinite(w+h)||Math.min(w,h)<=0)return <ScanFace aria-hidden="true"/>
    const pad=Math.max(w,h)*.12
    return <svg viewBox={`${x-pad} ${y-pad} ${w+2*pad} ${h+2*pad}`} role="img" aria-label="本次照片的面部轮廓"><polyline className="result-symbol-face" points={points.map(p=>`${p.x},${p.y}`).join(' ')}/></svg>
  }catch{return <ScanFace aria-hidden="true"/>}
}

export function shortUncertainty(reading?:ConsumerReading){
  if(!reading)return ''
  const result=readingUncertainty(reading)
  if(result?.uncertainty===null||result?.uncertainty===undefined)return reading.origin==='experimental'?'实验读数':''
  const suffix=reading.value.includes('°')?'°':reading.value.includes('%')?'个百分点':''
  return `± ${result.uncertainty.toFixed(suffix?2:3)}${suffix}`
}

/** Three core readings: plain name, rounded value, at most one tag. Exact values stay in the accessible name. */
export function ResultSymbols({visibleView,report,capture,onSelect,onReading}:{visibleView?:'front'|'profile';report:ReturnType<typeof buildConsumerReport>;capture?:Capture;onSelect:(id:string)=>void;onReading?:(reading:ConsumerReading)=>void}) {
  const lower=report.front.find(r=>r.code==='FRONT-RATIO-07'&&r.available)
  const second=report.front.find(r=>r.code==='FRONT-RATIO-01'&&r.available)??report.front.find(r=>r.code==='FRONT-RATIO-05'&&r.available)
  const profile=report.profile.find(r=>r.code==='PROFILE-ANGLE-01'&&r.available)??report.profile.find(r=>r.available)
  const card=(reading:ConsumerReading|undefined,fallbackLabel:string,fallbackValue:string,symbol:ReactNode)=>reading
    ?{key:reading.code??fallbackLabel,label:plainLabel(reading),value:plainValue(reading.value),exact:`${reading.label} ${reading.value}${shortUncertainty(reading)?' '+shortUncertainty(reading):''}`,hint:PLAIN_HINTS[reading.code??'']??'',tag:readingTag(reading),reading,symbol:<ReadingSymbol reading={reading}/>}
    :{key:fallbackLabel,label:fallbackLabel,value:fallbackValue,exact:fallbackValue,hint:'',tag:'',reading:undefined,symbol}
  const results=[
    card(lower,'正面检测',report.summaries[1].value,<ReadingSymbol/>),
    card(second,'脸型',report.summaries[0].value.replace(/^(.+)轮廓近似$/,'近$1').replace(/^接近(.+)$/,'近$1'),<FaceSymbol capture={capture} shape={report.summaries[0].value}/>),
    card(profile,'侧面检测',report.summaries[2].value,<ReadingSymbol/>),
  ]
  return <div className={`result-symbols ${visibleView?'result-symbols--filtered':''}`}>{(visibleView==='front'?results.slice(0,2):visibleView==='profile'?results.slice(2):results).map(r=><button type="button" key={r.key} onClick={()=>r.reading&&onReading?onReading(r.reading):onSelect('v2-photos')} className="result-symbol-card" aria-label={`${r.label}：${r.exact}，在照片上查看`}><span className="result-symbol-picture">{r.symbol}</span><span className="result-symbol-label">{r.label}</span><strong>{r.value}</strong>{r.hint&&<small>{r.hint}</small>}{r.tag&&<em className="plain-tag">{r.tag}</em>}</button>)}</div>
}
