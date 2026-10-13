import {MeasurementOverlay} from './MeasurementOverlay'
import {resolveProfileDisplayPaths} from './lib/profileDisplayPolicy'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Download, Eye, Info, RefreshCcw, Save, Maximize2, X } from 'lucide-react'
import type { Capture, CaptureId, Mode } from './types'
import { PortraitReference } from './PortraitReference'
import { buildConsumerReport, captureResult, readingUncertainty, type ConsumerReading } from './lib/consumerReport'
import { buildFrontLandmarkOverlay } from './lib/frontLandmarkOverlay'
import { profileSemanticPathD } from './lib/nativeProfilePresentation'
import { evaluateMeasurementAgainstPhotoReference } from './lib/photoReferenceEvaluation'
import { formatMetricErrorEvidenceList } from './lib/errorEvidence'
import { twoLevelRssUncertainty } from './lib/metricUncertainty'
import { reportVersion } from './data/report'
import { captureRetakeAssessment } from './lib/captureRetakeGuidance'
import { reportFromRecord, serializeReportRecord, type ReportRecord } from './lib/reportRecord'
import { searchReadings } from './lib/readingSearch'
import { REPORT_FILE_ACTIONS_ENABLED } from './lib/productFeatures'
import { ResultSymbols, ReadingSymbol, shortUncertainty } from './ResultSymbols'
import { PLAIN_HINTS, plainIssue, plainLabel, plainValue, readingTag } from './lib/plainResult'

type ReportData = ReturnType<typeof buildConsumerReport>
type Props = { visibleView?:'front'|'profile';embedded?:boolean;hideFooter?:boolean;captures:Capture[];isExample?:boolean;mode:Mode;record?:ReportRecord;frozenReport?:ReportData;generatedAt?:string;onStart:()=>void;onRetake:(id?:CaptureId)=>void;onPrivacy:()=>void }

function Comparison({reading}:{reading:ConsumerReading}) {
  const reference=evaluateMeasurementAgainstPhotoReference(reading)
  if(reference){
    const point=reference.markerPercent<reference.bandStartPercent?'本次读数低于参考范围':reference.markerPercent>reference.bandEndPercent?'本次读数高于参考范围':'本次读数在参考范围内'
    const contained=reference.intervalStartPercent!==undefined&&reference.intervalEndPercent!==undefined&&reference.intervalStartPercent>=reference.bandStartPercent&&reference.intervalEndPercent<=reference.bandEndPercent
    return <div className="v2-comparison">
      <div className="v2-range" aria-label={`${point}；参考范围${reference.referenceLabel}`}><i style={{left:`${reference.bandStartPercent}%`,width:`${reference.bandEndPercent-reference.bandStartPercent}%`}}/>{reference.intervalStartPercent!==undefined&&reference.intervalEndPercent!==undefined&&<em style={{left:`${reference.intervalStartPercent}%`,width:`${reference.intervalEndPercent-reference.intervalStartPercent}%`}}/>}<b style={{left:`${reference.markerPercent}%`}}/></div>
      <p className="v2-range-caption">参考 {reference.referenceLabel}</p>
      <p className="v2-interval">{reference.uncertaintyLabel?.replace('两级 RSS 区间','区间')??'本次仅显示单次观测位置'}</p>
      <div className="visual-position" title={point}><span>{reference.markerPercent<reference.bandStartPercent?'↓ 读数低于参考':reference.markerPercent>reference.bandEndPercent?'↑ 读数高于参考':'— 读数在参考内'}</span>{reference.direction==='indeterminate'&&!contained&&<small title="考虑误差后，测量区间与参考范围重叠">≈ 范围交叠</small>}</div>
    </div>
  }
  if(reading.view==='profile')return null
  const value=Number.parseFloat(reading.value),unit=reading.value.includes('%')?'percent':'ratio'
  const u=twoLevelRssUncertainty(value,reading.errors??[],unit)
  if(!Number.isFinite(value)||u===null)return null
  const low=value-u,high=value+u,min=Math.min(0,low),max=Math.max(high,unit==='percent'?100:1),pct=(n:number)=>(n-min)/(max-min)*100
  const format=(n:number)=>`${n.toFixed(unit==='percent'?2:3)}${unit==='percent'?'%':''}`
  return <div className="v2-comparison"><div className="v2-range v2-range--neutral" aria-label="本次测量值与误差范围"><em style={{left:`${pct(low)}%`,width:`${pct(high)-pct(low)}%`}}/><b style={{left:`${pct(value)}%`}}/></div><p className="v2-interval">区间 {format(low)}–{format(high)}</p><p className="v2-range-caption">仅记录值</p></div>
}

function ReadingCard({reading,onSelect}:{reading:ConsumerReading;onSelect?:(r:ConsumerReading)=>void}){
  const uncertainty=readingUncertainty(reading)
  const uncertaintyLabel=shortUncertainty(reading),tag=readingTag(reading),hint=PLAIN_HINTS[reading.code??''],value=plainValue(reading.value)
  return <article className="v2-reading" data-code={reading.code}>
    <div className="v2-reading-main"><div className="visual-reading-top"><span className="visual-reading-symbol"><ReadingSymbol reading={reading}/></span><h3>{plainLabel(reading)}</h3>{tag&&<em className="plain-tag">{tag}</em>}</div><strong className={`v2-value ${value.length>22?'v2-value--long':''}`}>{value}</strong>
      {hint&&<span className="plain-hint">{hint}</span>}
      {reading.evidence&&onSelect&&<button type="button" className="v2-show-evidence" onClick={()=>onSelect(reading)}>看测量线</button>}
    </div>
    <details><summary>依据</summary><div><p><strong>{reading.label}</strong>：{reading.value}{uncertaintyLabel&&uncertaintyLabel!=='实验读数'?` · ${uncertaintyLabel}`:''}{tag?' · 误差待校准，仅作参考':''}</p><Comparison reading={reading}/>{reading.view==='profile'&&uncertainty?.uncertainty===null&&<p>{uncertainty.display}</p>}<p>{reading.note}</p><p>指标编号：{reading.code}</p>{reading.formula&&<code>{reading.formula}</code>}{reading.landmarkIndices&&<p>点位：{reading.landmarkIndices}</p>}{uncertainty&&<p>含误差读数：{uncertainty.display}；数值分档：{uncertainty.gradeLabel}</p>}{reading.errors?.length?<p>{formatMetricErrorEvidenceList(reading.errors)}</p>:<p>当前没有对应的误差校准记录。</p>}{reading.confidenceBasis&&<p>{reading.confidenceBasis}</p>}<p>图形表示本次读数的位置，误差区间重叠时不等同于稳定的外观方向。</p></div></details>
  </article>
}

function Photo({capture,kind,report,showLines,showELine,onRetake,selectedCode,onSelectCode}:{selectedCode:string;onSelectCode:(code:string)=>void;capture?:Capture;kind:'front'|'profile';report:ReportData;showLines:boolean;showELine:boolean;onRetake:()=>void}){
  const supported=[...report[kind],...report.extended.filter(r=>r.view===kind)].filter(r=>r.available&&r.evidence)
  const selected=supported.find(r=>r.code===selectedCode),evidence=selected?.evidence
  const [showOriginal,setShowOriginal]=useState(false),[expanded,setExpanded]=useState(false),[detailLines,setDetailLines]=useState(true)
  const detailDialog=useRef<HTMLDialogElement>(null)
  useEffect(()=>{
    if(!expanded)return
    const dialog=detailDialog.current,overflow=document.body.style.overflow
    dialog?.showModal();document.body.style.overflow='hidden'
    return()=>{dialog?.close();document.body.style.overflow=overflow}
  },[expanded])
  useEffect(()=>setShowOriginal(false),[capture?.url,report.isExample])
  const overlay=useMemo(()=>{
    const p=capture?.poseValidation
    if(kind!=='front'||!p?.landmarks||!p.landmarkImageWidth||!p.landmarkImageHeight)return null
    try{return buildFrontLandmarkOverlay(p.landmarks,p.landmarkImageWidth,p.landmarkImageHeight)}catch{return null}
  },[capture,kind])
  const detection=kind==='front'?report.frontDetection:report.profileDetection
  const native=kind==='profile'?report.native:null,proxy=kind==='profile'?report.proxy:null
  const profilePaths=useMemo(()=>native?resolveProfileDisplayPaths(native):[],[native])
  const [showNeck,setShowNeck]=useState(false)
  const width=evidence?.width??overlay?.width??native?.width??proxy?.width,height=evidence?.height??overlay?.height??native?.height??proxy?.height
  const hasPhoto=report.isExample||Boolean(capture?.url)
  const viewingOriginal=Boolean(!report.isExample&&showOriginal&&capture?.originalUrl)
  const profileLabel=capture?.poseValidation?.estimatedPose==='left_profile'?'左侧面':capture?.poseValidation?.estimatedPose==='right_profile'?'右侧面':'侧面'
  const renderPhoto=(lines:boolean,eLine:boolean,labels=false)=>(report.isExample?<PortraitReference profile={kind==='profile'} focusFace showLines={lines}/>:capture?.url?<>
        <img src={viewingOriginal?capture.originalUrl:capture.url} alt={`本次${kind==='front'?'正面':'侧面'}${viewingOriginal?'扶正前对照':'分析用'}照片`}/>
        {!viewingOriginal&&!evidence&&width&&height&&<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-label={`${kind==='front'?'正面':'侧面'}照片测量轮廓`}>
          {lines&&overlay?.contours.map(c=><polyline key={c.code} points={c.points.map(p=>`${p.x},${p.y}`).join(' ')} className="v2-front-line"/>)}
          {profilePaths.filter(p=>lines&&p.category==='region'&&(p.code!=='neck_aesthetic_line'||showNeck)||eLine&&p.code==='eline').map(p=><path key={p.code} d={profileSemanticPathD(p.points)} strokeDasharray={p.provisional?'8 6':undefined} className={`v2-profile-line v2-profile-line--${p.code}`}><title>{p.label}</title></path>)}
          {!native&&lines&&proxy?.paths.filter(p=>p.category==='contour').map(p=><polyline key={p.code} points={p.points.map(p=>`${p.x},${p.y}`).join(' ')} className="v2-front-line"/>)}
        </svg>}{!viewingOriginal&&lines&&evidence&&<MeasurementOverlay evidence={evidence} showLabels={labels}/>}
      </>:<div className="v2-photo-empty"><Info size={28}/><strong>{detection.title}</strong><p>{detection.issues[0]}</p><button type="button" onClick={onRetake}>添加{kind==='front'?'正面':'侧面'}照片</button></div>)
  return <figure className="v2-photo"><figcaption>{kind==='front'?'正面':report.isExample?'侧面':profileLabel}{capture?.acceptedWithBias&&!report.isExample&&<span>已保留拍摄偏差提醒</span>}{kind==='profile'&&capture?.poseValidation?.nativeProfile?.neckEdge&&<span>{capture.poseValidation.nativeProfile.neckEdge.status==='traced'?'颈线仅供参考':'颈部轮廓待确认'}</span>}</figcaption>
    {supported.length>0&&<label className="v2-metric-select">查看测量<select value={selected?.code??''} onChange={e=>onSelectCode(e.target.value)}><option value="">轮廓总览</option>{supported.map(r=><option key={r.code} value={r.code}>{plainLabel(r)}</option>)}</select></label>}
    <div className="v2-photo-stage">
      {renderPhoto(showLines,showELine)}
    </div>
    {selected&&<div className="v2-construction-caption"><strong>{plainLabel(selected)} · {plainValue(selected.value)}</strong><p>{evidence?.formula}</p><span><i className="evidence-swatch evidence-swatch--measure"/>测量线 <i className="evidence-swatch evidence-swatch--reference"/>参考线</span></div>}
    {!report.isExample&&hasPhoto&&<div className="v2-photo-actions"><button type="button" onClick={()=>{setDetailLines(showLines||showELine);setExpanded(true)}}><Maximize2 size={15}/>放大查看</button>{kind==='profile'&&profilePaths.some(p=>p.code==='neck_aesthetic_line')&&<button type="button" aria-pressed={showNeck} onClick={()=>setShowNeck(v=>!v)}>{showNeck?'隐藏颈线':'颈线参考'}</button>}</div>}
    {expanded&&<dialog ref={detailDialog} className="v2-photo-detail" aria-label={`${kind==='front'?'正面':profileLabel}照片放大查看`} onCancel={e=>{e.preventDefault();setExpanded(false)}} onClose={()=>setExpanded(false)}><header><strong>{selected?plainLabel(selected):(kind==='front'?'正面':profileLabel)}{selected&&<small>{plainValue(selected.value)}</small>}</strong><div><button type="button" aria-pressed={detailLines} onClick={()=>setDetailLines(v=>!v)}>{detailLines?'隐藏测绘线':'显示测绘线'}</button><button type="button" aria-label="关闭放大查看" onClick={()=>setExpanded(false)}><X size={20}/></button></div></header><div className="v2-photo-stage v2-photo-stage--detail">{renderPhoto(detailLines,detailLines&&showELine,true)}</div></dialog>}
    {!report.isExample&&capture?.originalUrl&&<div className="v2-method-note"><button type="button" aria-pressed={showOriginal} onClick={()=>setShowOriginal(v=>!v)}>{showOriginal?'返回扶正后照片':'对照扶正前照片'}</button><p>{showOriginal?'扶正前原图（不画测量线）':`已自动扶正 ${Math.abs(capture.straightening?.rotationDegrees??0).toFixed(1)}°`}</p></div>}
    {report.isExample&&<span className="visual-demo-tag">示例</span>}
    {!report.isExample&&<details className="v2-detection"><summary>拍摄信息</summary><ul>{detection.facts.map(s=><li key={s}>{s}</li>)}{detection.issues.map(s=><li key={s}>{s}</li>)}</ul>{capture?.poseValidation?.nativeProfile?.reason&&kind==='profile'&&<p>模型记录：{capture.poseValidation.nativeProfile.reason}</p>}</details>}
  </figure>
}

export function ReportPageV2({visibleView,captures,embedded=false,hideFooter=false,isExample=false,mode,record,frozenReport,generatedAt,onStart,onRetake,onPrivacy}:Props){
  const report=useMemo(()=>{
    if(frozenReport)return frozenReport
    if(record)return reportFromRecord(record)
    const current=buildConsumerReport(captures,isExample)
    return !isExample&&generatedAt?{...current,createdAt:generatedAt}:current
  },[captures,isExample,record,frozenReport,generatedAt])
  const [showLines,setShowLines]=useState(true),[showELine,setShowELine]=useState(false),[saved,setSaved]=useState(false)
  const photoSection=useRef<HTMLElement>(null)
  const [selectedCodes,setSelectedCodes]=useState({front:'FRONT-RATIO-07',profile:'PROFILE-RATIO-07'})
  const selectEvidence=(r:ConsumerReading)=>{setSelectedCodes(v=>({...v,[r.view]:r.code??''}));setShowLines(true);photoSection.current?.scrollIntoView({behavior:'smooth',block:'start'})}
  const [query,setQuery]=useState(''),[readingView,setReadingView]=useState<'all'|'front'|'profile'>('all')
  useEffect(()=>{
    if(!REPORT_FILE_ACTIONS_ENABLED)return
    const opened=new Set<HTMLDetailsElement>()
    const before=()=>document.querySelectorAll<HTMLDetailsElement>('.report-v2 details:not([open])').forEach(e=>{opened.add(e);e.open=true})
    const after=()=>{opened.forEach(e=>e.open=false);opened.clear()}
    window.addEventListener('beforeprint',before);window.addEventListener('afterprint',after)
    return()=>{window.removeEventListener('beforeprint',before);window.removeEventListener('afterprint',after);after()}
  },[])
  const front=report.front.filter(r=>r.available&&visibleView!=='profile'),profile=report.profile.filter(r=>r.available&&visibleView!=='front')
  const extended=report.extended.filter(r=>r.available&&r.code!=='PROFILE-REGION-FOREHEAD'&&(!visibleView||r.view===visibleView))
  const unavailable=report.profile.filter(r=>!r.available&&visibleView!=='front')
  const captureWarnings=isExample||record?[]:captures.filter(c=>(!visibleView||c.id===visibleView)&&c.quality&&!captureRetakeAssessment(c).strictPass)
  const allReadings=front.concat(profile,extended)
  const visibleReadings=searchReadings(allReadings,query,readingView)
  const jump=(id:string)=>{const target=document.getElementById(id);target?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});target?.focus({preventScroll:true})}
  const save=()=>{
    if(!REPORT_FILE_ACTIONS_ENABLED)return
    const url=URL.createObjectURL(new Blob([serializeReportRecord(report,mode,record?record.version??null:reportVersion)],{type:'application/json'}))
    const a=document.createElement('a');a.href=url;a.download=`headup-report-${report.createdAt.slice(0,10)}-${report.createdAt.slice(11,19).replaceAll(':','')}.json`;a.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);setSaved(true)
  }
  return <section className="report-v2"><div className="v2-report-shell">
    {embedded?<h2 className="report-accessible-title">面部结构报告</h2>:<h1 className="report-accessible-title">面部结构报告</h1>}
    <section id="v2-summary" aria-label="结果摘要" tabIndex={-1} className="v2-section"><ResultSymbols visibleView={visibleView} report={report} capture={record?undefined:captures.find(c=>c.id==='front')} onSelect={jump} onReading={selectEvidence}/></section>
    {captureWarnings.length>0&&<details className="visual-alert"><summary><Info size={16}/>拍摄提醒 · {captureWarnings.map(c=>c.label).join('、')}</summary><p>{captureWarnings.map(c=>`${c.label}：${plainIssue(c).headline}`).join('；')}</p></details>}
    {report.issues.length>0&&<details className="visual-alert"><summary><Info size={16}/>检测提示 · {report.issues.length}</summary><div>{report.issues.map(s=><p key={s}>{s}</p>)}</div></details>}
    <section ref={photoSection} id="v2-photos" tabIndex={-1} className="v2-section"><div className="v2-section-heading">{!record&&<div><button type="button" role="switch" aria-checked={showLines} onClick={()=>setShowLines(v=>!v)}>轮廓 <i/></button>{visibleView!=='front'&&report.native&&<button type="button" aria-pressed={showELine} onClick={()=>{setSelectedCodes(v=>({...v,profile:''}));setShowELine(v=>!v)}}><Eye size={16}/>嘴唇参考线</button>}</div>}</div>{record?<div className="v2-record-photos"><Info size={22}/><div><strong>这份记录未包含照片</strong><p>已恢复原有读数与检测说明。照片不会随测量记录自动保存。</p><details><summary>查看原照片检测信息</summary>{[['正面',report.frontDetection],['侧面',report.profileDetection]].map(([label,entry])=>{const detection=entry as ReportData['frontDetection'];return <div key={String(label)}><strong>{String(label)} · {detection.title}</strong><ul>{detection.facts.concat(detection.issues).map((s,i)=><li key={i}>{s}</li>)}</ul></div>})}</details></div></div>:<><div className={`v2-photos ${visibleView?'v2-photos--single':''}`}>{visibleView!=='profile'&&<Photo selectedCode={selectedCodes.front} onSelectCode={code=>setSelectedCodes(v=>({...v,front:code}))} kind="front" capture={captures.find(c=>c.id==='front')} report={report} showLines={showLines} showELine={false} onRetake={()=>onRetake('front')}/>} {visibleView!=='front'&&<Photo selectedCode={selectedCodes.profile} onSelectCode={code=>setSelectedCodes(v=>({...v,profile:code}))} kind="profile" capture={captures.find(c=>c.id==='profile')} report={report} showLines={showLines} showELine={showELine} onRetake={()=>onRetake('profile')}/>}</div></>}</section>
    {visibleView!=='profile'&&!front.length&&(record||captures.find(c=>c.id==='front')?.url||isExample)&&(()=>{const capture=captures.find(c=>c.id==='front'),issue=capture?.url?plainIssue(capture):{headline:report.frontDetection.title,tip:report.frontDetection.issues[0]??'',detail:''};return <section id="v2-front" tabIndex={-1} className="v2-section"><div className="v2-detection-result plain-issue" role="status"><h3>正面：{issue.headline}</h3>{issue.tip&&<p>{issue.tip}</p>}{issue.detail&&<details><summary>详细原因</summary><p>{issue.detail}</p></details>}<button onClick={()=>onRetake('front')}>重拍正面 <RefreshCcw size={16}/></button></div></section>})()}
    {visibleView!=='front'&&!profile.length&&(record||captures.find(c=>c.id==='profile')?.url||isExample)&&(()=>{const capture=captures.find(c=>c.id==='profile'),issue=capture?.url?plainIssue(capture):{headline:report.profileDetection.title,tip:report.profileDetection.issues[0]??'',detail:''};return <section id="v2-profile" tabIndex={-1} className="v2-section"><div className="v2-detection-result plain-issue" role="status"><h3>侧面：{issue.headline}</h3>{issue.tip&&<p>{issue.tip}</p>}{issue.detail&&<details><summary>详细原因</summary><p>{issue.detail}</p></details>}<button onClick={()=>onRetake('profile')}>重拍侧面 <RefreshCcw size={16}/></button></div></section>})()}
    {allReadings.length>0&&<details id="v2-all" tabIndex={-1} className="v2-accordion"><summary><strong>更多指标（{allReadings.length}）</strong><span>每项的名称、数值和测量依据</span></summary><div className="v2-search-tools"><label htmlFor="reading-search">查找指标</label><div><input id="reading-search" type="search" value={query} maxLength={100} placeholder="例如：嘴宽、下巴、鼻唇" onChange={e=>setQuery(e.target.value)}/>{query&&<button onClick={()=>setQuery('')}>清空</button>}</div><nav aria-label="测量视角筛选">{([['all','全部'],['front','正面'],['profile','侧面']] as const).map(([value,label])=><button key={value} aria-pressed={readingView===value} onClick={()=>setReadingView(value)}>{label}</button>)}</nav></div><div className="v2-reading-grid">{allReadings.map(r=><div key={r.code} className="v2-search-item" hidden={!visibleReadings.includes(r)}><ReadingCard reading={r} onSelect={selectEvidence}/></div>)}</div>{visibleReadings.length===0&&<div className="v2-search-empty"><strong>没有找到</strong><p>换个名称，或选择“全部”。</p><button onClick={()=>{setQuery('');setReadingView('all')}}>查看全部</button></div>}</details>}
    <details className="v2-accordion"><summary><strong>测量说明</strong></summary><div className="v2-method-note"><p>数值来自照片上的关键点连线，会受距离、光线和姿态影响；只和自己以前的记录对比才有意义。</p>{visibleView!=='profile'&&report.coverage.referenceOnly.length>0&&<><h3>{report.coverage.referenceOnly.length} 项正面读数需谨慎参考</h3><ul>{report.coverage.referenceOnly.map(r=><li key={r.code}><strong>{plainLabel(r)}</strong>：{r.reason}</li>)}</ul></>}{unavailable.length>0&&<><h3>本次没有测出的项目</h3>{unavailable.map(r=><p key={r.code}><strong>{plainLabel(r)}{plainLabel(r)!==r.label?`（${r.label}）`:''}</strong>：{r.note}</p>)}</>}{mode==='youth'&&<p>只记录外观变化，不打分。</p>}</div></details>
    <section className="v2-next"><div><button className="v2-primary" onClick={isExample||record?onStart:()=>onRetake()}><RefreshCcw size={16}/>{isExample?'开始我的分析':'重新拍摄'}</button>{REPORT_FILE_ACTIONS_ENABLED&&<button onClick={save}><Save size={16}/>下载记录</button>}</div></section>{REPORT_FILE_ACTIONS_ENABLED&&<p className="v2-save-status" role="status">{saved?'记录已下载。下次点击顶部“打开记录”即可查看；文件不包含照片。':''}</p>}
    {!hideFooter&&<footer className="v2-footer"><span><Info size={14}/>只描述照片外观，不是医学诊断</span><button onClick={onPrivacy}>隐私与数据 <ArrowRight size={14}/></button></footer>}
  </div></section>
}
