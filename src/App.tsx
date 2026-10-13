import { useEffect, useMemo, useRef, useState } from 'react'
import { PortraitReference } from './PortraitReference'
import { ReportPageV2 } from './ReportPageV2'
import { MAX_REPORT_BYTES, parseReportRecord, type ReportRecord } from './lib/reportRecord'
import { createUploadGate } from './lib/uploadGate'
import { REPORT_FILE_ACTIONS_ENABLED } from './lib/productFeatures'
import { FrontMetricVisual, frontMetricLabel } from './FrontMetricVisual'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Camera,
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  FileText,
  Fingerprint,
  HeartHandshake,
  Info,
  Layers3,
  LockKeyhole,
  Menu,
  RefreshCcw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X,
  Zap,
} from 'lucide-react'
import { cannotDetermine, measurements as sampleMeasurements, reportVersion } from './data/report'
import { readCapture } from './lib/readCapture'
import { revokeCaptureImages } from './lib/captureImageUrls'
import { straighteningMessage } from './lib/photoStraightening'
import { analyzeCaptures, buildVisibleFrontTendency } from './lib/faceMeasurements'
import { getCaptureReadiness } from './lib/captureReadiness'
import { captureRetakeAssessment } from './lib/captureRetakeGuidance'
import { frontReportCoverage } from './lib/frontReportCoverage'
import { buildFrontLandmarkOverlay, frontOverlayLineContract } from './lib/frontLandmarkOverlay'
import { evaluateMeasurementAgainstPhotoReference } from './lib/photoReferenceEvaluation'
import { analyzeVisibleProfilePhoto } from './lib/profilePhotoAnalysis'
import { buildNativeProfilePresentation, buildProfileRegionLabelAnchors, buildProfileRenderablePaths,buildVisibleProfileTendency,nativeProfileReadingGrade,orderNativeProfileReadings,profileSemanticPathD,summarizeNativeProfileReadingConfidence,summarizeNativeProfileRegionPrimary } from './lib/nativeProfilePresentation'
import { correctMirroredFrontFile } from './lib/mirrorCorrection'
import { formatMetricErrorEvidenceList } from './lib/errorEvidence'
import { summarizeMetricValue, twoLevelRssUncertainty } from './lib/metricUncertainty'
import type { MetricErrorEvidence } from './lib/errorEvidence'
import type { Capture, CaptureId, Measurement, Mode, PhotoQuality, View } from './types'

const initialCaptures: Capture[] = [
  { id: 'front', label: '正面', eyebrow: '01 · FRONT', hint: '摘下口罩和所有眼镜；直视镜头，双耳可见；相册中的镜像自拍先勾选纠正' },
  { id: 'profile', label: '侧面 90°', eyebrow: '02 · PROFILE', hint: '左侧或右侧均可；镜头与面部同高，完整露出额、鼻、唇、颏' },
  { id: 'top', label: '头顶俯视（可选）', eyebrow: '03 · TOP · OPTIONAL', hint: '当前不参与正侧面报告；如愿意补充，请让头发贴平并保持头部轮廓完整' },
]

const demoQuality: PhotoQuality = {
  score: 94,
  resolution: 100,
  brightness: 92,
  contrast: 88,
  sharpness: 93,
  flags: [],
}
const validationText=(errors:readonly MetricErrorEvidence[],note?:string)=>[errors.length?formatMetricErrorEvidenceList(errors):'',note??''].filter(Boolean).join('；')
const metricScale=(code:string)=>code==='FRONT-ANGLE-01'?[10]:code==='PROFILE-LINE-02'?[5,5]:undefined
function MetricReading({code,value,errors}:{code:string;value:string;errors:readonly MetricErrorEvidence[]}){
  if(!errors.length)return <div className="metric-reading"><strong>{value}</strong></div>
  const summary=summarizeMetricValue(value,errors,metricScale(code))
  return <div className="metric-reading"><strong>{summary.display}</strong><span className={`confidence-grade confidence-grade--${summary.grade}`}>{summary.gradeLabel}</span></div>
}
type ProfileScaleDefinition={label:string;minimum:number;maximum:number;unit:'degrees'|'percent';componentIndex?:number;referenceLabel:string}
const PROFILE_SCALE_DEFINITIONS:Record<string,ProfileScaleDefinition[]>={
  'PROFILE-ANGLE-01':[{label:'面凸角',minimum:165,maximum:175,unit:'degrees',referenceLabel:'165°–175°照片偏好带'}],
  'PROFILE-LINE-02':[
    {label:'上唇E-Line',minimum:-4,maximum:1,unit:'percent',componentIndex:0,referenceLabel:'−4%–1%可见侧貌高度'},
    {label:'下唇E-Line',minimum:-3,maximum:1,unit:'percent',componentIndex:1,referenceLabel:'−3%–1%可见侧貌高度'},
  ],
  'PROFILE-RATIO-05':[{label:'颏投影',minimum:0,maximum:6,unit:'percent',referenceLabel:'0%–6%可见侧貌高度'}],
  'PROFILE-ANGLE-06':[{label:'下颌缘倾斜',minimum:20,maximum:30,unit:'degrees',referenceLabel:'20°–30°照片参考带'}],
  'PROFILE-ANGLE-09':[{label:'下颌线—颈线',minimum:14.511587057289777,maximum:51.03961722974777,unit:'degrees',referenceLabel:'14.5°–51.0°人工全部接受观察范围'}],
}
const profileScaleValues=(value:string)=>[...value.matchAll(/-?\d+(?:\.\d+)?/g)].map(match=>Number(match[0]))
const clampPercent=(value:number)=>Math.max(0,Math.min(100,value))
function ProfileReferenceBars({code,value,errors}:{code:string;value:string;errors:readonly MetricErrorEvidence[]}){
  const definitions=PROFILE_SCALE_DEFINITIONS[code],values=profileScaleValues(value)
  if(!definitions)return null
  return <>{definitions.map((definition,index)=>{
    const observed=values[definition.componentIndex??index]
    if(!Number.isFinite(observed))return null
    const componentErrors=errors.filter(error=>error.componentIndex===undefined||error.componentIndex===(definition.componentIndex??index))
    const uncertainty=twoLevelRssUncertainty(observed,componentErrors,definition.unit)
    const span=definition.maximum-definition.minimum,domainMinimum=definition.minimum-span*2,domainMaximum=definition.maximum+span*2,percent=(input:number)=>clampPercent((input-domainMinimum)/(domainMaximum-domainMinimum)*100)
    const interval=uncertainty===null?null:{minimum:observed-uncertainty,maximum:observed+uncertainty}
    const state=interval===null?'reference_only':interval.minimum>=definition.minimum&&interval.maximum<=definition.maximum?'within':interval.maximum<definition.minimum?'below':interval.minimum>definition.maximum?'above':'indeterminate'
    const interpretation=state==='within'?'完整误差区间落入参考带':state==='below'?'完整误差区间低于参考带':state==='above'?'完整误差区间高于参考带':state==='indeterminate'?'误差区间与参考带重叠，本张照片无法区分':'暂无可换算的误差区间'
    const format=(input:number)=>definition.unit==='degrees'?`${input.toFixed(2)}°`:`${input.toFixed(2)}%`
    return <div key={definition.label} className={`reference-reading reference-reading--${state}`}><div className="reference-axis"><i style={{left:`${percent(definition.minimum)}%`,width:`${percent(definition.maximum)-percent(definition.minimum)}%`}}/>{interval&&<em style={{left:`${percent(interval.minimum)}%`,width:`${percent(interval.maximum)-percent(interval.minimum)}%`}}/>}<b style={{left:`${percent(observed)}%`}}/></div><p><strong>{definition.label} · {interpretation}</strong><span>侧貌参考 {definition.referenceLabel}</span></p>{interval&&<small className="reference-uncertainty">两级 RSS 区间 {format(interval.minimum)}–{format(interval.maximum)}</small>}<small>只用于标准侧面照片的软组织外观比较，不是人群常模、颜值分、骨性诊断或治疗建议。</small></div>
  })}</>
}
const nativeGradeLabel=(grade:ReturnType<typeof nativeProfileReadingGrade>)=>grade==='comparable'?'可比较':grade==='recordable'?'可记录':grade==='reference_only'?'仅参考':'不可用'
const profileRegionShortLabel:Record<string,string>={forehead_aesthetic_line:'额部',nasal_dorsum_line:'鼻背',maxillary_support_line:'上颌支撑',mandibular_aesthetic_line:'下颌—颏部',neck_aesthetic_line:'颈线'}

type ProfileBlueprintStyle = 'soft' | 'angular'
const profileBlueprintTemplates = {
  soft: {
    outline: 'M82 315C92 288 91 262 78 234C58 194 51 150 61 108C69 73 91 44 121 27C153 9 190 14 214 38C231 56 239 84 237 114C236 133 240 143 249 152C256 159 262 166 261 172C260 177 252 180 245 180C249 185 247 190 240 193C248 198 247 204 239 208C243 219 240 233 231 244C223 254 211 262 199 268C188 275 183 289 181 315',
    highlight: 'M120 28C153 12 188 18 211 41C226 57 233 82 232 108', hairline: 'M112 40C138 28 171 30 198 49',
    brow: 'M208 126C216 123 227 125 234 131', eye: 'M207 141C216 135 227 136 235 142C228 147 216 148 207 141Z', pupil: ['223','141'],
    ear: 'M177 153C190 147 200 159 198 176C196 191 187 202 177 196C171 190 175 182 182 177C188 172 188 163 181 162',
    lips: 'M245 180C241 184 239 188 240 192M240 193C247 196 247 201 239 205', neck: 'M118 276C120 292 125 306 132 315',
    forehead: 'M205 55C220 73 231 96 232 119C232 133 237 143 245 150', nasal: 'M245 150C253 157 259 166 258 172C257 176 251 178 245 179', maxilla: 'M244 182C243 187 241 191 239 194', mandible: 'M239 209C242 220 238 233 229 243C221 253 210 261 198 267',
    measure: 'M205 55 245 180 229 243M112 110H236M100 205H239', points: [['205','55'],['245','180'],['229','243'],['100','205'],['112','110']],
  },
  angular: {
    outline: 'M82 315C90 287 88 258 74 229C55 188 49 146 59 106C68 72 90 43 120 27C151 11 187 15 211 37C230 55 239 84 236 116C235 132 239 142 247 150L262 169C266 174 263 179 257 182L240 186C246 191 244 197 236 200C242 205 241 211 234 214C237 226 234 240 226 250C215 259 198 267 178 273C174 287 174 302 176 315',
    highlight: 'M120 28C151 14 185 18 208 40C224 57 231 82 230 108', hairline: 'M115 41C143 29 176 31 199 49',
    brow: 'M207 126L233 130', eye: 'M207 141C217 137 228 137 235 142C227 146 216 147 207 141Z', pupil: ['223','141'],
    ear: 'M178 153C190 148 199 159 197 175C195 190 187 199 177 195C172 188 176 181 182 176C187 171 188 163 181 162',
    lips: 'M240 186L235 191M236 200L232 205', neck: 'M135 278C137 292 142 306 149 315',
    forehead: 'M205 54C219 73 229 95 230 117C230 131 235 141 243 148', nasal: 'M243 148L260 170C263 174 259 179 253 181L240 184', maxilla: 'M239 188L234 199', mandible: 'M234 215C236 226 231 240 222 248C210 258 193 266 176 271',
    measure: 'M205 54 240 186 222 248M112 110H235M101 205H234', points: [['205','54'],['240','186'],['222','248'],['101','205'],['112','110']],
  },
} as const

function Brand({ inverted = false }: { inverted?: boolean }) {
  return (
    <button className={`brand ${inverted ? 'brand--inverted' : ''}`} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="返回顶部">
      <span className="brand__mark">H</span>
      <span>HEADUP</span>
    </button>
  )
}

function Shell({children,view,onNavigate,onOpenRecord,onCurrentReport,hasCurrentReport,busy,reportSource}:{
  children:React.ReactNode;view:View;onNavigate:(view:View)=>void;onOpenRecord:()=>void;onCurrentReport:()=>void;hasCurrentReport:boolean;busy:boolean;reportSource:'current'|'saved'|'example'
}) {
  const [open,setOpen]=useState(false)
  const go=(next:View)=>{onNavigate(next);setOpen(false)}
  return <div className={`app-shell app-shell--${view}`}>
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    <header className="topbar">
      <button disabled={busy} className="brand" onClick={()=>go('home')} aria-label="返回首页"><span className="brand__mark">H</span><span>HEADUP</span></button>
      <nav id="main-navigation" className={open?'nav nav--open':'nav'} aria-label="主导航">
        <button disabled={busy} onClick={()=>go('home')} className={view==='home'?'is-active':''}>首页</button>
        {hasCurrentReport&&<button disabled={busy} onClick={()=>{onCurrentReport();setOpen(false)}} className={view==='report'&&reportSource==='current'?'is-active':''}>本次报告</button>}
        <button disabled={busy} className={view==='report'&&reportSource==='example'?'is-active':''} onClick={()=>go('report')}>示例报告</button>
        {REPORT_FILE_ACTIONS_ENABLED&&<button disabled={busy} className={view==='report'&&reportSource==='saved'?'is-active':''} onClick={()=>{onOpenRecord();setOpen(false)}}>打开记录</button>}
        <button disabled={busy} onClick={()=>go('privacy')} className={view==='privacy'?'is-active':''}>隐私与数据</button>
        <button disabled={busy} className="nav__start" onClick={()=>go('setup')}>开始分析 <ArrowRight size={15}/></button>
      </nav>
      <button className="menu-button" onClick={()=>setOpen(!open)} aria-expanded={open} aria-controls="main-navigation" aria-label={open?'关闭导航':'打开导航'}>{open?<X/>:<Menu/>}</button>
    </header>
    <main id="main-content" tabIndex={-1}>{['setup','capture','processing'].includes(view)&&<ol className="product-steps" aria-label="分析进度">{(['setup','capture','processing'] as const).map((step,index)=><li key={step} aria-current={view===step?'step':undefined}><span>{index+1}</span>{['选择模式','添加照片','生成报告'][index]}</li>)}</ol>}{children}</main>
  </div>
}

function ProfileReferenceArt({ compact = false }: { compact?: boolean }) {
  return <div className={`profile-reference-art ${compact?'profile-reference-art--compact':''}`}>
    <img src="/assets/profile-reference-contour-v3.png" alt="纯外轮廓右侧面参考（左侧面也可上传）"/>
    <svg viewBox="0 0 1217 1293" preserveAspectRatio="xMidYMid meet" aria-label="侧貌四色美学线">
      <g className="profile-reference-grid"><line x1="670" y1="410" x2="1150" y2="410"/><line x1="670" y1="660" x2="1150" y2="660"/><line x1="670" y1="910" x2="1150" y2="910"/><line x1="820" y1="340" x2="820" y2="1030"/><line x1="1010" y1="340" x2="1010" y2="1030"/></g>
      <path className="profile-reference-line profile-reference-line--forehead" d="M1000 420C1037 495 1066 567 1082 625"/>
      <path className="profile-reference-line profile-reference-line--nasal" d="M1082 625C1102 636 1116 650 1100 666"/>
      <path className="profile-reference-line profile-reference-line--maxilla" d="M1089 678C1080 700 1071 722 1062 741"/>
      <path className="profile-reference-line profile-reference-line--mandible" d="M1048 790C1032 836 1005 876 960 900C915 912 865 891 820 861"/>
      <line className="profile-reference-eline" x1="1100" y1="666" x2="960" y2="900"/>
      {[[1000,420],[1100,666],[1062,741],[1048,790],[960,900]].map(([cx,cy])=><circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="9" className="profile-reference-point"/>)}
    </svg>
  </div>
}

function FaceBlueprint({ variant = 'front', compact = false, profileStyle = 'soft' }: { variant?: CaptureId; compact?: boolean; profileStyle?: ProfileBlueprintStyle }) {
  const isProfile = variant === 'profile'
  const isTop = variant === 'top'
  const profileTemplate = profileBlueprintTemplates[profileStyle]
  return (
    <div className={`face-blueprint ${compact ? 'face-blueprint--compact' : ''}`} aria-hidden="true">
      <span className="blueprint-axis blueprint-axis--v" />
      <span className="blueprint-axis blueprint-axis--h" />
      {isProfile ? (
        <svg viewBox="0 0 280 340" role="img" className="profile-blueprint-svg">
          <g className="profile-proportion-grid">
            <line x1="42" y1="82" x2="267" y2="82" />
            <line className="major" x1="42" y1="151" x2="267" y2="151" />
            <line x1="42" y1="220" x2="267" y2="220" />
            <line className="major" x1="42" y1="289" x2="267" y2="289" />
            <line x1="105" y1="32" x2="105" y2="315" />
            <line className="major" x1="174" y1="32" x2="174" y2="315" />
            <line x1="239" y1="32" x2="239" y2="315" />
          </g>
          {profileStyle==='soft'&&<g className="profile-hair">
            <path className="profile-hair-fill profile-hair-ponytail" d="M72 88C54 72 34 73 19 86C34 88 41 99 36 110C19 126 10 151 13 178C20 156 34 145 45 130C30 163 26 204 37 258C43 223 57 199 64 174C72 146 79 113 72 88Z" />
            <path className="profile-hair-fill profile-hair-cap" d="M57 146C47 111 60 70 91 44C124 17 174 13 211 43C224 57 230 75 231 95C209 73 181 63 151 67C116 71 90 91 77 118C70 132 66 148 65 162Z" />
            <path className="profile-hair-strand" d="M205 43C218 65 223 88 218 111M189 36C204 62 208 88 200 115M92 50C70 82 65 119 75 153M77 66C61 101 63 139 81 169M66 91C48 119 45 155 54 190M55 111C39 141 39 177 48 210" />
            <path className="profile-hair-strand profile-hair-side-lock" d="M91 78C75 111 77 151 94 179C104 197 104 220 94 241M109 67C94 105 97 145 112 174C123 195 123 217 114 235" />
            <path className="profile-hair-strand profile-hair-ponytail-strands" d="M70 96C56 130 48 181 42 259M64 99C47 143 37 199 38 278M58 102C40 151 29 216 34 294" />
            <path className="profile-hair-strand profile-hair-fringe" d="M205 50C216 74 216 101 207 124M190 46C204 76 201 109 190 137M175 46C190 78 184 116 170 146M159 51C171 83 166 123 153 153" />
            <circle className="profile-hair-tie" cx="71" cy="91" r="6" />
          </g>}
          <path className="face-fill" d={`${profileTemplate.outline}Z`} />
          <path className="face-line" d={profileTemplate.outline} />
          <path className="profile-blueprint-highlight" d={profileTemplate.highlight} />
          <path className="profile-detail profile-detail--hairline" d={profileTemplate.hairline} />
          <path className="profile-detail profile-detail--brow" d={profileTemplate.brow} />
          <path className="profile-detail profile-detail--eye" d={profileTemplate.eye} />
          <circle className="profile-detail-pupil" cx={profileTemplate.pupil[0]} cy={profileTemplate.pupil[1]} r="1.8" />
          <path className="profile-detail profile-detail--ear" d={profileTemplate.ear} />
          <path className="profile-detail profile-detail--lips" d={profileTemplate.lips} />
          <path className="profile-detail profile-detail--neck" d={profileTemplate.neck} />
          <path className="profile-blueprint-region profile-blueprint-region--forehead" d={profileTemplate.forehead} />
          <path className="profile-blueprint-region profile-blueprint-region--nasal" d={profileTemplate.nasal} />
          <path className="profile-blueprint-region profile-blueprint-region--maxilla" d={profileTemplate.maxilla} />
          <path className="profile-blueprint-region profile-blueprint-region--mandible" d={profileTemplate.mandible} />
          <path className="measure-line" d={profileTemplate.measure} />
          {profileTemplate.points.map(([x,y]) => <circle key={x+y} cx={x} cy={y} r="4" className="landmark" />)}
        </svg>
      ) : isTop ? (
        <svg viewBox="0 0 280 340" role="img">
          <ellipse className="face-fill face-line" cx="140" cy="170" rx="94" ry="132" />
          <ellipse className="measure-line" cx="140" cy="170" rx="82" ry="116" />
          <path className="measure-line" d="M58 170h164M140 52v236M73 99l134 142M207 99 73 241" />
        </svg>
      ) : (
        <svg viewBox="0 0 280 340" role="img">
          <path className="face-fill face-line" d="M140 18c68 0 105 50 101 126-3 64-35 157-101 174C74 301 42 208 39 144 35 68 72 18 140 18Z" />
          <path className="measure-line" d="M69 119h142M54 167h172M69 220h142M140 32v270M79 152l122 0M88 202l104 0" />
          {[['83','119'],['197','119'],['104','167'],['176','167'],['91','220'],['189','220'],['140','96'],['140','189'],['140','272']].map(([x,y]) => <circle key={x+y} cx={x} cy={y} r="4" className="landmark" />)}
        </svg>
      )}
      <span className="blueprint-label">LOCAL GEOMETRY · 478 PTS</span>
    </div>
  )
}

function TrustStrip() {
  return (
    <div className="trust-strip">
      <span><LockKeyhole size={17} /> 原图默认不上传</span>
      <span><ScanFace size={17} /> 本地几何计算</span>
      <span><ShieldCheck size={17} /> 非医学诊断</span>
    </div>
  )
}

function Home({ onStart, onReport }: { onStart: () => void; onReport: () => void }) {
  return (
    <>
      <section className="hero page-grid">
        <div className="hero__copy">
          <p className="eyebrow"><span /> PRIVACY-FIRST FACIAL INSIGHT</p>
          <h1>读懂面部结构，<br /><em>而非定义你。</em></h1>
          <p className="hero__lead">通过正面与侧面两张标准照片，在设备本地记录面部比例与侧面轮廓。每项读数都附有计算依据和使用边界。</p>
          <div className="hero__actions">
            <button className="button button--primary" onClick={onStart}>开始私密分析 <ArrowRight size={18} /></button>
            <button className="text-button" onClick={onReport}>先看示例报告 <span>↗</span></button>
          </div>
          <p className="microcopy"><Check size={14} /> 无需注册 · 先准备正面与侧面照片</p>
        </div>
        <div className="hero__visual">
          <div className="hero__orb" />
          <PortraitReference />
          <div className="floating-card floating-card--top">
            <span>面部结构 · 示例</span><strong>看见依据</strong><i>比例与轮廓，一目了然</i>
          </div>
          <div className="floating-card floating-card--bottom">
            <BadgeCheck size={19} /><span>设备本地分析<br /><small>照片默认不上传</small></span>
          </div>
        </div>
      </section>
      <TrustStrip />

      <section className="section section--cream">
        <div className="section-heading page-grid">
          <div><p className="eyebrow"><span /> WHAT YOU GET</p><h2>不是一个分数，<br />是一套可解释的结构记录。</h2></div>
          <p>用透明测量代替模糊评价。你可以查看关键点、计算方法、可信程度，以及照片无法告诉你的内容。</p>
        </div>
        <div className="feature-grid page-grid">
          <article className="feature-card feature-card--dark">
            <span className="feature-card__index">01</span><ScanFace />
            <h3>外观结构测量</h3><p>查看面部比例与照片角度，每项读数都能找到计算依据。</p>
            <div className="mini-chart"><span style={{ height: '45%' }} /><span style={{ height: '68%' }} /><span style={{ height: '88%' }} /><span style={{ height: '61%' }} /><span style={{ height: '78%' }} /></div>
          </article>
          <article className="feature-card">
            <span className="feature-card__index">02</span><Layers3 />
            <h3>侧面轮廓记录</h3><p>查看三点夹角、E-Line与轮廓线，记录照片中的可见侧面关系。</p>
            <div className="probability"><span>侧貌证据</span><strong>3 项</strong><div><i /></div></div>
          </article>
          <article className="feature-card">
            <span className="feature-card__index">03</span><BarChart3 />
            <h3>拍摄信息与依据</h3><p>查看本次拍摄条件和测量依据。跨次变化的判断仍待真实复拍验证。</p>
            <svg className="trend-line" viewBox="0 0 260 80"><path d="M5 64C45 66 52 38 91 44s55-25 88-17 42-11 76-20" /><circle cx="255" cy="7" r="4" /></svg>
          </article>
        </div>
      </section>

      <section className="process-section page-grid">
        <div className="process-visual process-visual--profile"><PortraitReference profile/><div className="profile-demo-kicker"><span/> PROFILE MAP · 轮廓示意</div><div className="profile-demo-legend"><span><i className="forehead"/>额部</span><span><i className="nasal"/>鼻背</span><span><i className="maxilla"/>鼻唇支撑</span><span><i className="mandible"/>下颌线</span><span>E-Line 虚线</span></div></div>
        <div className="process-copy">
          <p className="eyebrow"><span /> HOW IT WORKS</p><h2>三步，建立你的<br />第一份照片记录。</h2>
          <ol className="step-list">
            <li><span>1</span><div><strong>选择分析模式</strong><p>成人结构记录，或青少年外观记录。</p></div></li>
            <li><span>2</span><div><strong>拍摄正面与侧面</strong><p>建议两个视角各一张；也可先选一张查看检测结果，稍后补充。拍摄问题会说明如何改进。</p></div></li>
            <li><span>3</span><div><strong>在设备本地分析</strong><p>在当前设备查看本次测量读数、轮廓与计算依据。</p></div></li>
          </ol>
          <button className="button button--secondary" onClick={onStart}>开始我的记录 <ArrowRight size={17} /></button>
        </div>
      </section>

      <section className="boundary-section">
        <div className="page-grid boundary-grid">
          <div><p className="eyebrow eyebrow--light"><span /> A CLEAR BOUNDARY</p><h2>照片能告诉你的，<br /><em>与不能告诉你的。</em></h2></div>
          <div className="boundary-columns">
            <div><span className="boundary-icon boundary-icon--yes"><Check /></span><h3>我们可以测量</h3><ul><li>可见面部比例与轮廓</li><li>照片中的三点夹角</li><li>拍摄质量与图像偏差</li></ul></div>
            <div><span className="boundary-icon"><X /></span><h3>我们不会推断</h3><ul><li>真实颅骨形状或骨龄</li><li>骨性Ⅰ / Ⅱ / Ⅲ类诊断</li><li>疾病风险或治疗方案</li></ul></div>
          </div>
        </div>
      </section>

      <footer className="footer page-grid">
        <div><Brand /><p>信息与教育用途，不构成医学诊断。</p></div>
        <div><button onClick={onReport}>示例报告</button><button onClick={onStart}>开始分析</button></div>
        <small>© 2026 HeadUp · Algorithm transparency by design.</small>
      </footer>
    </>
  )
}

function Setup({ mode, setMode, accepted, setAccepted, onBack, onNext }: { mode: Mode; setMode: (mode: Mode) => void; accepted:boolean; setAccepted:(value:boolean)=>void; onBack: () => void; onNext: () => void }) {
  return <section className="flow-page page-grid">
    <button className="back-button" onClick={onBack}><ArrowLeft size={17}/>返回首页</button>
    <div className="flow-heading"><h1>选择这次记录方式</h1><p>接下来添加正面和侧面照片，即可查看本次测量结果。</p></div>
    <div className="mode-grid">
      <button className={`mode-card ${mode==='adult'?'is-selected':''}`} aria-pressed={mode==='adult'} onClick={()=>setMode('adult')}><span className="mode-card__icon"><UserRound/></span><i>{mode==='adult'&&<Check/>}</i><h2>成人结构记录</h2><p>查看轮廓、比例和侧面角度，保留本次读数。</p><small>适合18岁及以上用户</small></button>
      <button className={`mode-card ${mode==='youth'?'is-selected':''}`} aria-pressed={mode==='youth'} onClick={()=>setMode('youth')}><span className="mode-card__icon"><HeartHandshake/></span><i>{mode==='youth'&&<Check/>}</i><h2>青少年外观记录</h2><p>记录可见比例，方便在相同条件下复测。</p><small>建议由监护人陪同使用</small></button>
    </div>
    <p className="setup-simple-note">当前测量不需要填写精确年龄或性别。</p>
    <label className="consent-check"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span><Check/></span><p>我已了解：报告描述照片中的可见外观，不用于医学诊断；照片默认在当前设备处理。</p></label>
    <div className="flow-actions"><p>{accepted?<><LockKeyhole size={15}/>已确认，可以添加照片</>:<><Info size={15}/>请先阅读并勾选上方说明</>}</p><button className="button button--primary" disabled={!accepted} onClick={onNext}>添加照片 <ArrowRight size={17}/></button></div>
  </section>
}

function CaptureIllustration({ id }: { id: CaptureId }) {
  return id==='profile'?<ProfileReferenceArt compact/>:<FaceBlueprint variant={id} compact />
}

function QualityPill({ capture }: { capture: Capture }) {
  const assessment=captureRetakeAssessment(capture)
  const accepted=Boolean(capture.acceptedWithBias&&!assessment.strictPass)
  const optionalPending=capture.id==='top'&&!assessment.strictPass
  return <span className={`quality-pill ${assessment.strictPass?'quality-pill--good':accepted?'quality-pill--bias':'quality-pill--warn'}`}>{assessment.strictPass?<Check size={14}/>:<Info size={14}/>} {assessment.strictPass?'已通过':optionalPending?'可选 · 未参与报告':accepted?'偏差风险升高':'建议重拍'}</span>
}

function CaptureCard({ capture, index, onFile, onClear, onAcceptWithBias, onRetry,focused=false, blocked=false, checking=false, pendingName='', uploadError }: { capture: Capture; index: number; onFile: (id: CaptureId, file: File, correctMirror: boolean, autoStraighten:boolean) => void; onClear: (id: CaptureId) => void;onRetry:(id:CaptureId,auto:boolean)=>void;onAcceptWithBias:(id:CaptureId,accepted:boolean)=>void;focused?:boolean;blocked?:boolean;checking?:boolean;pendingName?:string;uploadError?:string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [correctMirror, setCorrectMirror] = useState(false)
  const [autoStraighten,setAutoStraighten]=useState(true)
  const [showOriginal,setShowOriginal]=useState(false)
  useEffect(()=>setShowOriginal(false),[capture.url])
  const done = Boolean(capture.quality)
  const assessment=captureRetakeAssessment(capture)
  const modelOnlyFailure=Boolean(capture.analysisError&&capture.quality&&isPhotoQualityAcceptable(capture.quality)&&(!capture.poseValidation||isPoseAcceptable(capture.poseValidation)))
  const needsRetake=done&&!assessment.strictPass&&capture.id!=='top'&&!modelOnlyFailure
  const acceptedWithBias=needsRetake&&Boolean(capture.acceptedWithBias)
  return (
    <article id={`capture-${capture.id}`} data-capture-id={capture.id} aria-busy={checking} aria-current={focused?'step':undefined} aria-label={focused?`${capture.label}，当前重拍目标`:undefined} className={`capture-card ${done?'capture-card--done':''} ${needsRetake?'capture-card--retake':''} ${acceptedWithBias?'capture-card--bias':''} ${focused?'capture-card--focused':''}`}>
      {focused&&<span className="capture-card__focus-label">当前重拍目标</span>}
      <div className="capture-card__top"><span>{capture.eyebrow}</span>{checking?<span className="capture-checking">正在检查…</span>:done&&<QualityPill capture={capture}/>}</div>
      <div className="capture-preview">
        {capture.url ? <img src={showOriginal&&capture.originalUrl?capture.originalUrl:capture.url} alt={`${capture.label}${showOriginal?'扶正前':'分析用'}预览`} /> : <CaptureIllustration id={capture.id} />}
        {!done && <button disabled={blocked} onClick={() => inputRef.current?.click()} aria-label={`上传${capture.label}照片`}><Camera /><span>添加{capture.label}照片</span></button>}
        {done && <button disabled={blocked} className="capture-preview__replace" onClick={() => inputRef.current?.click()}><RefreshCcw size={14} /> 更换</button>}
      </div>
      <div className="capture-card__body"><h3>{index + 1}. {capture.label}</h3><p>{capture.hint}</p>{capture.id === 'front' && <label className="mirror-correction"><input type="checkbox" checked={correctMirror} disabled={done||blocked} onChange={(event) => setCorrectMirror(event.target.checked)} /><span><Check size={12} /></span><em>{capture.mirrorCorrected ? '已纠正镜像自拍' : '这是相册中的镜像自拍'}</em></label>}</div>
      {checking&&<p className="capture-file-status" role="status">正在检查：{pendingName}</p>}
      {!checking&&capture.fileName&&<p className="capture-file-status" title={capture.fileName}>{capture.fileName}</p>}
      {capture.id==='front'&&<label className="mirror-correction"><input type="checkbox" checked={autoStraighten} disabled={done||blocked} onChange={e=>setAutoStraighten(e.target.checked)}/><span><Check size={12}/></span><em>上传时自动扶正轻微歪头</em></label>}
      {!checking&&capture.straightening&&<p className="capture-file-status" role="status">{straighteningMessage(capture.straightening)}</p>}
      {capture.originalUrl&&<button type="button" disabled={blocked} className="back-button" aria-pressed={showOriginal} onClick={()=>setShowOriginal(v=>!v)}>{showOriginal?'返回扶正后照片':'对照扶正前照片'}</button>}
      {capture.analysisError&&<div className="capture-file-status" role="status"><p>{capture.analysisError}</p><button type="button" disabled={blocked} onClick={()=>onRetry(capture.id,autoStraighten)}>重试这张照片的检测</button></div>}
      {uploadError&&<p className="capture-file-error" role="alert">{uploadError}</p>}
      {needsRetake&&!acceptedWithBias&&<section className="capture-retake-panel" aria-label={`${capture.label}重拍建议`}><strong><Info size={16}/>{capture.label}建议重拍</strong><div><b>当前照片为何不满足要求</b><ul>{assessment.issues.map(issue=><li key={issue}>{issue}</li>)}</ul></div><div><b>拍摄改进点</b><ul>{assessment.improvements.map(item=><li key={item}>{item}</li>)}</ul></div><nav><button disabled={blocked} className="retake-primary" onClick={()=>inputRef.current?.click()}><RefreshCcw size={14}/>重拍这张</button><button disabled={blocked} className="retake-secondary" onClick={()=>onAcceptWithBias(capture.id,true)}>仍使用当前照片</button></nav><small>继续使用不会隐藏问题：报告会标记该照片的测量偏差风险升高，现有 ± 不确定度可能低估实际偏差。</small></section>}
      {acceptedWithBias&&<section className="capture-bias-panel"><strong><Info size={16}/>已选择继续使用{capture.label}</strong><p>{assessment.issues.join('、')}。本张照片的测量偏差风险升高，方向性结论将更加谨慎。</p><button disabled={blocked} onClick={()=>{onAcceptWithBias(capture.id,false);inputRef.current?.click()}}><RefreshCcw size={14}/>改为重拍</button></section>}
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" disabled={blocked} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(capture.id, file, capture.id === 'front' && correctMirror, autoStraighten); event.currentTarget.value = '' }} />
      {done && <button disabled={blocked} className="capture-card__clear" onClick={() => onClear(capture.id)} aria-label={`删除${capture.label}照片`}><Trash2 size={15} /></button>}
    </article>
  )
}

export function CaptureFlow({ captures, setCaptures, onBack, onAnalyze, onViewExample, onBusyChange, onInvalidate, focusCaptureId=null, backLabel='返回模式选择',externalBusy=false,supplement=false }: {
  captures:Capture[];setCaptures:React.Dispatch<React.SetStateAction<Capture[]>>;onBack:()=>void;onAnalyze:()=>void;onViewExample?:()=>void;
  onBusyChange:(busy:boolean)=>void;onInvalidate:()=>void;focusCaptureId?:CaptureId|null;backLabel?:string;externalBusy?:boolean;supplement?:boolean
}) {
  const [busyId,setBusyId]=useState<CaptureId|null>(null)
  const [pendingName,setPendingName]=useState('')
  const [uploadErrors,setUploadErrors]=useState<Partial<Record<CaptureId,string>>>({})
  const gate=useRef(createUploadGate())
  useEffect(()=>{if(!busyId)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[busyId])
  useEffect(()=>()=>{gate.current.cancel();onBusyChange(false)},[onBusyChange])
  useEffect(()=>{if(!focusCaptureId)return;const frame=requestAnimationFrame(()=>document.getElementById(`capture-${focusCaptureId}`)?.scrollIntoView({behavior:'smooth',block:'center'}));return()=>cancelAnimationFrame(frame)},[focusCaptureId])
  const { complete, missing }=getCaptureReadiness(captures)
  const handleFile=async(id:CaptureId,file:File,correctMirror:boolean,autoStraighten:boolean,retrying?:Capture)=>{
    if(externalBusy)return
    const token=gate.current.begin()
    if(token===null)return
    setBusyId(id);onBusyChange(true);setPendingName(file.name);setUploadErrors(e=>({...e,[id]:undefined}))
    try {
      const analysisFile=id==='front'&&correctMirror?await correctMirroredFrontFile(file):file
      const inspected=await readCapture(id,analysisFile,autoStraighten)
      if(!gate.current.isCurrent(token))return
      const url=URL.createObjectURL(inspected.file)
      const originalUrl=inspected.straightening?.status==='applied'?URL.createObjectURL(analysisFile):undefined
      onInvalidate()
      setCaptures(current=>current.map(c=>{
        if(c.id!==id)return c
        revokeCaptureImages(c)
        return {...c,url,originalUrl,straightening:inspected.straightening,fileName:file.name,inputError:undefined,analysisError:inspected.analysisError,source:retrying?.source??'upload',capturedAt:retrying?.capturedAt,cameraFacing:retrying?.cameraFacing,mirrorCorrected:id==='front'&&(correctMirror||Boolean(retrying?.mirrorCorrected)),acceptedWithBias:false,quality:inspected.quality,poseValidation:inspected.pose}
      }))
    }catch(error){
      if(!gate.current.isCurrent(token))return
      const message=error instanceof Error?error.message:'图片读取失败，请尝试另一张照片。'
      const previous=captures.find(c=>c.id===id)
      setUploadErrors(e=>({...e,[id]:`${file.name}：${message}${previous?.url?' 新照片未采用，已保留上一张照片。':''}`}))
      if(!previous?.url){
        onInvalidate()
        setCaptures(current=>current.map(c=>c.id===id?{...c,fileName:file.name,url:undefined,inputError:message,quality:{score:0,resolution:0,brightness:0,contrast:0,sharpness:0,flags:[message]},poseValidation:undefined}:c))
      }
    }finally{
      if(gate.current.finish(token)){setBusyId(null);setPendingName('');onBusyChange(false)}
    }
  }
  const retry=async(id:CaptureId,auto:boolean)=>{
    const capture=captures.find(c=>c.id===id)
    if(busyId||externalBusy||!capture?.url)return
    try{const response=await fetch(capture.originalUrl??capture.url);if(!response.ok)throw new Error();const blob=await response.blob();await handleFile(id,new File([blob],capture.fileName??"photo",{type:blob.type}),false,auto,capture)}catch{setUploadErrors(e=>({...e,[id]:"照片暂不可读，请重新选择照片。"}))}
  }
  const clear=(id:CaptureId)=>{
    if(busyId||externalBusy)return
    onInvalidate()
    setUploadErrors(e=>({...e,[id]:undefined}))
    setCaptures(current=>current.map(c=>{if(c.id!==id)return c;revokeCaptureImages(c);return {...c,url:undefined,originalUrl:undefined,straightening:undefined,fileName:undefined,inputError:undefined,analysisError:undefined,source:undefined,capturedAt:undefined,cameraFacing:undefined,mirrorCorrected:undefined,acceptedWithBias:undefined,quality:undefined,poseValidation:undefined}}))
  }
  const accept=(id:CaptureId,accepted:boolean)=>{onInvalidate();setCaptures(current=>current.map(c=>c.id===id?{...c,acceptedWithBias:accepted}:c))}
  const hasResult=captures.some(c=>c.quality||c.poseValidation)
  const optional=captures.find(c=>c.id==='top')
  const card=(c:Capture,index:number)=><CaptureCard key={c.id} capture={c} index={index} focused={c.id===focusCaptureId} onFile={handleFile} onRetry={retry} onClear={clear} onAcceptWithBias={accept} blocked={(Boolean(busyId)||externalBusy)} checking={busyId===c.id} pendingName={pendingName} uploadError={uploadErrors[c.id]}/>
  return <section className="flow-page flow-page--wide page-grid">
    <div className="capture-heading"><div><button className="back-button" disabled={(Boolean(busyId)||externalBusy)} onClick={onBack}><ArrowLeft size={17}/>{backLabel}</button><h1>{supplement?'补充缺失的照片':'添加正面与侧面照片'}</h1><p>{supplement?'原记录中的照片已保留，只需添加下方缺少的视角。':'建议提供正面与任意一侧照片。侧面方向自动识别，无需手动翻转；先选一张也能查看检测结果。'}</p></div>{onViewExample&&<button className="demo-button" disabled={(Boolean(busyId)||externalBusy)} onClick={onViewExample}><Sparkles size={16}/>先看报告示例</button>}</div>
    <div className="capture-quick-guide"><span><Check size={16}/>自然光，镜头与脸同高</span><span><Check size={16}/>露出轮廓，闭唇放松</span><span>JPEG / PNG / WebP / AVIF</span></div>
    {busyId&&<div className="inline-status" role="status"><span className="spinner"/>正在检查{captures.find(c=>c.id===busyId)?.label}：{pendingName}。完成后可以继续操作。</div>}
    <div className="capture-grid capture-grid--required">{captures.filter(c=>c.id!=='top').map(card)}</div>
    {optional&&<details className="capture-optional" open={focusCaptureId==='top'?true:undefined}><summary>补充头顶照片（可选）<span>当前不参与正侧面报告</span></summary>{card(optional,2)}</details>}
    <details className="capture-protocol"><summary>查看拍摄方法与重拍建议</summary><p>正面看向镜头，双耳可见；侧面转至约90°，完整露出额、鼻、唇和下巴。使用自然光，摘下遮挡面部的口罩与眼镜，保持自然表情。优先使用后置相机，在约1米处用变焦调整取景，避免伸手近拍。前后拍摄保持相同距离、光线与姿态；变焦本身不能消除近距离透视。</p></details>
    <div className="flow-actions capture-actions"><p role="status">{busyId?'正在检查照片，请稍候':!hasResult?'选择第一张照片后即可生成检测报告':supplement?'补充照片已处理，可继续查看结果并确认保存新版本':complete?'正面与侧面已就绪，可以查看结果':missing>0?'已完成部分照片检测，可以先查看结果或补充另一视角':'照片检测已完成，报告会说明拍摄偏差'}</p><button className="button button--primary" disabled={(Boolean(busyId)||externalBusy)||!hasResult} onClick={onAnalyze}>{busyId?'正在检查照片…':complete?'查看本次分析结果':'查看本次检测结果'}<ArrowRight size={17}/></button></div>
  </section>
}

function Processing({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState(0)
  const stages = ['收集照片检测结果', '整理已有测量读数', '关联轮廓与依据', '生成本次报告']
  useEffect(() => {
    const timers = stages.map((_,index)=>window.setTimeout(()=>setStage(index),index*200))
    timers.push(window.setTimeout(onDone,850))
    return () => timers.forEach(timer=>window.clearTimeout(timer))
  }, [onDone, stages.length])
  return (
    <section className="processing-page">
      <div className="processing-visual"><FaceBlueprint /><span className="scan-line" /></div>
      <div className="processing-copy"><p className="eyebrow eyebrow--light"><span /> ON-DEVICE ANALYSIS</p><h1>正在建立你的<br />外观结构基线。</h1><p>分析在当前设备进行。处理结束后，你可以立即删除照片。</p><ol>{stages.map((item, index) => <li key={item} className={index <= stage ? 'is-done' : ''}><span>{index < stage ? <Check size={15} /> : index === stage ? <i className="spinner" /> : index + 1}</span>{item}</li>)}</ol></div>
    </section>
  )
}

function FrontLandmarkCoverage({ capture }: { capture?: Capture }) {
  const [showContours, setShowContours] = useState(true)
  const [showPoints, setShowPoints] = useState(false)
  const [showMeasurements, setShowMeasurements] = useState(false)
  const [showSymmetry, setShowSymmetry] = useState(false)
  const width = capture?.poseValidation?.landmarkImageWidth
  const height = capture?.poseValidation?.landmarkImageHeight
  const landmarks = capture?.poseValidation?.landmarks
  const overlay = useMemo(() => landmarks && width && height
    ? buildFrontLandmarkOverlay(landmarks, width, height)
    : null, [landmarks, width, height])
  const tendency = useMemo(() => landmarks && width && height
    ? buildVisibleFrontTendency(landmarks, width, height, capture?.poseValidation?.robustLipHeightMouthWidthRatio)
    : null, [landmarks, width, height, capture?.poseValidation?.robustLipHeightMouthWidthRatio])
  if (!capture?.url || !overlay) return null
  const visibleLines = overlay.lines.filter((line) => (
    (line.category === 'measurement' && showMeasurements) || (line.category === 'symmetry' && showSymmetry)
  ))
  const radius = Math.max(1.2, Math.max(overlay.width, overlay.height) * 0.0015)
  return (
    <section id="front-photo-evidence" className="landmark-coverage" aria-label="真人正面478点覆盖图">
      <div className="landmark-coverage__heading">
        <div><p className="eyebrow"><span /> FR-201 · LANDMARK EVIDENCE</p><h2>真人正面 478 点覆盖图</h2></div>
        <span>{overlay.contours.length} 组面部轮廓 · {overlay.points.length} 点 · {overlay.lines.filter((line) => line.category === 'measurement').length} 条测量线 · 12 组镜像对</span>
      </div>
          {tendency && <div className="photo-reading-summary"><span>本图外观结构 · 非诊断</span><strong>{tendency.label}</strong><p>{tendency.description}</p><div>{tendency.evidence.map((item) => <b key={item.label}>{item.label} <em>{item.value}</em></b>)}</div></div>}
      <div className="landmark-coverage__body">
        <div className="landmark-canvas" style={{ aspectRatio: `${overlay.width} / ${overlay.height}` }}>
          <img src={capture.url} alt="本次正面照片的关键点覆盖" />
          <svg viewBox={`0 0 ${overlay.width} ${overlay.height}`} preserveAspectRatio="none" aria-label="478点与测量辅助线">
            {showContours && overlay.contours.map((contour) => <polyline key={contour.code} points={contour.points.map((point) => `${point.x},${point.y}`).join(' ')} className="overlay-contour"><title>{contour.label}</title></polyline>)}
            {visibleLines.map((line) => <line key={line.code} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className={`overlay-line overlay-line--${line.category}`}><title>{line.label}</title></line>)}
            {showPoints && overlay.points.map((point) => <circle key={point.index} cx={point.x} cy={point.y} r={radius} className="overlay-point"><title>MediaPipe {point.index}</title></circle>)}
          </svg>
        </div>
        <div className="landmark-controls">
          <button className={showContours ? 'is-active' : ''} onClick={() => setShowContours((value) => !value)}>{showContours ? <EyeOff size={15} /> : <Eye size={15} />} 面部区域轮廓</button>
          <button className={showPoints ? 'is-active' : ''} onClick={() => setShowPoints((value) => !value)}>{showPoints ? <EyeOff size={15} /> : <Eye size={15} />} 478点</button>
          <button className={showMeasurements ? 'is-active' : ''} onClick={() => setShowMeasurements((value) => !value)}>{showMeasurements ? <EyeOff size={15} /> : <Eye size={15} />} {frontOverlayLineContract.measurementLines}条测量线</button>
          <button className={showSymmetry ? 'is-active' : ''} onClick={() => setShowSymmetry((value) => !value)}>{showSymmetry ? <EyeOff size={15} /> : <Eye size={15} />} 12组镜像对</button>
          <p><i className="legend-contour" />区域轮廓 <i className="legend-dot" />关键点 <i className="legend-line" />测量线 <i className="legend-line legend-line--symmetry" />镜像对</p>
          <small>{tendency?.disclosure ?? '原图和覆盖坐标均留在当前页面内存；导出打印不会上传照片。'}</small>
        </div>
      </div>
    </section>
  )
}

function profileUnavailableMessage(capture: Capture | undefined) {
  const reason = capture?.poseValidation?.nativeProfile?.reason
  if (reason === 'profile_face_score_below_0.85') return '侧貌专用人脸置信度不足。请使用侧面90°、完整露出额头至下颏，并避免面部过小。'
  if (reason === 'native39_confidence_below_threshold') return '侧貌39点置信度不足。请保持侧面接近90°，让鼻、唇、颏边缘清晰可见。'
  if (reason === 'native39_pose_direction_conflict') return '姿态检测与轮廓模型的方向判断不一致。请重新选择完整清晰的左侧面或右侧面照片。'
  if (reason?.startsWith('native39_runtime')) return '侧貌模型本次运行失败。请重试或重新选择侧面照片。'
  return capture?.poseValidation?.flags?.[0] ?? '未获得可复核的侧面轮廓。请重新选择标准侧面照片。'
}

function ProfilePhotoEvidence({ capture, onRetake }: { capture?: Capture; onRetake: () => void }) {
  const [showEvidence, setShowEvidence] = useState(false)
  const [showRegionLabels, setShowRegionLabels] = useState(false)
  const [showContour, setShowContour] = useState(true)
  const [showResearchContour,setShowResearchContour]=useState(false)
  const [showRepeatabilityBands,setShowRepeatabilityBands]=useState(false)
  const [showAestheticRegions, setShowAestheticRegions] = useState(true)
  const [activeAestheticRegion, setActiveAestheticRegion] = useState<string | null>(null)
  const native = useMemo(()=>buildNativeProfilePresentation(capture?.poseValidation?.nativeProfile,capture?.poseValidation?.landmarkImageWidth,capture?.poseValidation?.landmarkImageHeight),[capture?.poseValidation])
  const tendency = useMemo(()=>buildVisibleProfileTendency(capture?.poseValidation?.nativeProfile),[capture?.poseValidation])
  const analysis = useMemo(() => analyzeVisibleProfilePhoto(capture?.poseValidation), [capture?.poseValidation])
  if (!capture?.url || (!native&&!analysis)) return <section id="profile-photo-evidence" className="profile-evidence profile-evidence--unavailable" aria-label="侧貌评价未生成"><div><p className="eyebrow"><span/> PROFILE RESULT · ACTION REQUIRED</p><h2>侧貌评价未生成</h2><p>{profileUnavailableMessage(capture)}</p></div><button className="button button--primary" onClick={onRetake}>重新选择侧面照片 <RefreshCcw size={16}/></button></section>
  if (native) {
    const radius = Math.max(2, Math.max(native.width, native.height) * .0025)
    const profileVisibleHeight=Math.hypot(native.points[14].x-native.points[8].x,native.points[14].y-native.points[8].y)
    const semanticPaths = native.paths.filter((path) => (path.category === 'contour' && showResearchContour) || (path.category === 'evidence' && showEvidence) || (path.category === 'region' && showAestheticRegions && (!activeAestheticRegion || path.code === activeAestheticRegion)))
    const visiblePaths=buildProfileRenderablePaths(semanticPaths,profileVisibleHeight,showRepeatabilityBands)
    const orderedReadings=orderNativeProfileReadings(native.readings)
    const regionLabels=buildProfileRegionLabelAnchors(native.paths,native.regionReadings).flatMap(region=>{
      if(!showAestheticRegions||(activeAestheticRegion&&activeAestheticRegion!==region.pathCode))return[]
      const reviewComparison=native.geometryReviewComparisons.find(item=>item.pathCodes.includes(region.pathCode))
      return[{...region,...summarizeNativeProfileRegionPrimary(region),shortLabel:profileRegionShortLabel[region.pathCode]??region.label,hasModelReview:Boolean(reviewComparison),reviewComparison}]
    })
    return <section id="profile-photo-evidence" className="profile-evidence profile-evidence--native" aria-label="原生39点侧面评价">
      <div className="profile-evidence__heading"><div><p className="eyebrow"><span/> PROFILE NATIVE 39 · VISIBLE SOFT TISSUE</p><h2>侧面关键美学线与外观倾向</h2><p>默认显示额部、鼻背、鼻基底—上唇支撑、下颌—颏部和实验颈线五组可见软组织线；颈线来自人工修正参考训练的下颌局部代理。</p></div><span>直接几何核心7项 + 实验颈线1项 · 彩线/区域卡：39点与颈线代理</span></div>
          {tendency&&<div className="photo-reading-summary"><span>本图外观倾向 · 非诊断</span><strong>{tendency.shortLabel}</strong><details><summary>查看本次判读说明</summary><p>{tendency.description}</p></details><div>{tendency.evidence.map(item=><b key={item.label}>{item.label} <em>{item.value}</em></b>)}</div><small>{tendency.confidenceLabel}</small></div>}
      <div className="profile-evidence__body">
        <div className="profile-evidence__canvas" style={{aspectRatio:`${native.width}/${native.height}`}}>
          <img src={capture.url} alt="本次侧面39点轮廓"/>
          <svg viewBox={`0 0 ${native.width} ${native.height}`} preserveAspectRatio="none" aria-label="原生39点侧貌语义线与实验颈线代理">
            {visiblePaths.map(path=>{
              const band='repeatabilityBandStrokeWidth'in path
              const smooth=path.category==='region'||path.category==='repeatability-band'
              const shared={className:`profile-overlay profile-overlay--${path.category} profile-overlay--${path.code}`,style:band?{strokeWidth:path.repeatabilityBandStrokeWidth,vectorEffect:'none' as const}:undefined}
              return smooth?<path key={path.code} d={profileSemanticPathD(path.points)} {...shared}><title>{path.label}</title></path>:<polyline key={path.code} points={path.points.map(point=>`${point.x},${point.y}`).join(' ')} {...shared}><title>{path.label}</title></polyline>
            })}
            {showEvidence&&native.points.map(point=><circle key={point.index} cx={point.x} cy={point.y} r={radius} className="profile-overlay-point"><title>Menpo39点 {point.index} · 置信度 {point.confidence?.toFixed(3)??'—'}</title></circle>)}
          </svg>
          <div className="profile-region-labels" aria-label="照片上的侧貌区域结果">{showRegionLabels&&regionLabels.map(region=><button type="button" key={region.pathCode} data-region={region.pathCode} aria-pressed={activeAestheticRegion===region.pathCode} aria-label={`高亮${region.shortLabel}彩线读数：${region.display}，${region.gradeLabel}${region.reviewComparison?`；彩线${region.reviewComparison.overlayValue.toFixed(2)}${region.reviewComparison.unit}，核心${region.reviewComparison.coreValue.toFixed(2)}${region.reviewComparison.unit}，差${region.reviewComparison.difference.toFixed(2)}超过RSS ${region.reviewComparison.maximum.toFixed(2)}`:''}`} className={`profile-region-label profile-region-label--${region.pathCode} confidence--${region.grade} ${region.hasModelReview?'has-model-review':''} ${activeAestheticRegion===region.pathCode?'is-active':''}`} style={{left:`${region.anchor.x/native.width*100}%`,top:`${region.anchor.y/native.height*100}%`}} onClick={()=>{setShowAestheticRegions(true);setActiveAestheticRegion(value=>value===region.pathCode?null:region.pathCode)}}><strong><span>{region.shortLabel}</span><em>{region.gradeLabel}{region.hasModelReview?' · 分歧':''}</em></strong><small>{region.display}</small></button>)}</div>
        </div>
        <div className="profile-evidence__controls"><button className={showRegionLabels?'is-active':''} aria-pressed={showRegionLabels} onClick={()=>setShowRegionLabels(value=>!value)}>{showRegionLabels?<EyeOff size={15}/>:<Eye size={15}/>} 照片数值标签</button><button className={showAestheticRegions?'is-active':''} onClick={()=>{setShowAestheticRegions(value=>!value);setActiveAestheticRegion(null)}}>{showAestheticRegions?<EyeOff size={15}/>:<Eye size={15}/>} {activeAestheticRegion?'恢复分区总览':'分区外观线'}</button><button className={showRepeatabilityBands?'is-active':''} onClick={()=>setShowRepeatabilityBands(value=>!value)}>{showRepeatabilityBands?<EyeOff size={15}/>:<Eye size={15}/>} 重复性范围</button><button className={showResearchContour?'is-active':''} onClick={()=>setShowResearchContour(value=>!value)}>{showResearchContour?<EyeOff size={15}/>:<Eye size={15}/>} 研究用39点点序连线</button><button className={showEvidence?'is-active':''} onClick={()=>setShowEvidence(value=>!value)}>{showEvidence?<EyeOff size={15}/>:<Eye size={15}/>} E-Line与角度证据线</button><p><i className="legend-region legend-region--forehead"/>眉部 <i className="legend-region legend-region--nasal"/>鼻背 <i className="legend-region legend-region--maxilla"/>上唇 <i className="legend-region legend-region--mandible"/>下颌—颏部 <i className="legend-region legend-region--neck"/>颈线代理</p><div className="profile-neck-boundary"><Info size={15}/><span><strong>下颌线与颈线分开建模</strong>绿色线是下颌—颏部；青色线由29例人工修正颈线训练的局部模板估计。两线夹角只保留实验读数±14.35°，不等于下颌骨角或标准颈颏角，也不输出美观方向。</span></div><small>可见外观线仍受模型定位误差影响；颈线P95位置误差为可见侧貌高度10.66%，明显高于四条面部线。E-Line是测量参考，不是轮廓线。</small></div>
      </div>
      <div className="profile-repeatability-note"><span/><p><strong>半透明宽带 = 路径P95误差的保守可视化</strong>：额部3.76%、鼻背4.14%、上颌支撑3.20%、下颌—颏部3.06%；实验颈线为留一验证10.66%可见侧貌高度。宽带不是95%置信区间、单图±误差或解剖边界。</p></div>
      <div className={`profile-geometry-source-note ${native.geometryDisagreementReviewMetrics.length?'has-review':''}`}><Info size={16}/><div><strong>{native.geometryDisagreementReviewMetrics.length?`本图${native.geometryDisagreementReviewMetrics.map(item=>item.label).join('、')}模型层分歧较大`:native.geometrySource==='direct_geometry_head'?'核心数值与彩线读数来自两个模型层':'数值由当前39点派生'}</strong><p>{native.geometrySource==='direct_geometry_head'?'核心7项和美学参考卡来自独立直接几何头；照片标签与四区域卡改用当前彩线39点派生值，可以从显示点复算。':'当前卡片数值与彩线均来自同一39点几何。'} 这两层都不是骨骼影像。{native.geometryDisagreementReviewMetrics.length?' 当前报告仍可阅读，重拍用于降低解释冲突，不会隐藏现有结果。':''}</p>{native.geometryDisagreementReviewMetrics.length>0&&<button type="button" className="profile-geometry-retake" onClick={onRetake}><RefreshCcw size={14}/>重拍侧面</button>}{native.geometryDisagreement&&<details><summary>查看核心直接几何头与彩线39点派生值的差异</summary><div><span>面凸角 {native.geometryDisagreement.softTissueConvexityAngleDegrees.toFixed(2)}°</span><span>E-Line {native.geometryDisagreement.eLinePercentagePoints.toFixed(2)}pp</span><span>鼻唇角 {native.geometryDisagreement.nasolabialAngleDegrees.toFixed(2)}°</span><span>颏唇沟 {native.geometryDisagreement.mentolabialAngleDegrees.toFixed(2)}°</span><span>颏投影 {native.geometryDisagreement.chinProjectionPercentagePoints.toFixed(2)}pp</span><span>下颌缘 {native.geometryDisagreement.mandibularInclinationDegrees.toFixed(2)}°</span><span>纵向 {native.geometryDisagreement.verticalPercentagePoints.toFixed(2)}pp</span></div><small>{native.geometryDisagreementReviewMetrics.length?`超过当前RSS：${native.geometryDisagreementReviewMetrics.map(item=>`${item.label} ${item.value.toFixed(2)}>${item.maximum.toFixed(2)}`).join('；')}。核心数值保留但仅供复核。`:'所有分歧均未超过各指标当前RSS。'} 这是模型层分歧诊断，不是额外人工真值误差。</small></details>}</div></div>
      {tendency&&<div className="profile-tendency-summary"><div><span>骨性相关外观倾向</span><h3>{tendency.label}</h3></div><p>{tendency.disclosure}</p></div>}
      <section className="profile-reference-section" aria-label="侧貌美学参考"><div className="profile-reference-heading"><div><p className="eyebrow"><span/> AESTHETIC REFERENCES</p><h3>软组织面凸角、E-Line、下颌角与颏部参考</h3></div><small>三庭五眼位于正面评价；此处只处理侧貌参考。每张卡明确标出方法来源，不把不同点位公式或正面参考带移植到侧面。</small></div><div className="profile-reference-grid">{native.aestheticReferences.map(reference=><article key={reference.code} className={`profile-reference-card status--${reference.status}`}><span>{reference.code}</span><h4>{reference.label}</h4><p className="reference-standard">参考：{reference.reference}</p><small className="reference-basis">方法来源：{reference.basis}</small><strong>{reference.result}</strong><p>{reference.interpretation}</p><small>{validationText(reference.errors,reference.validationNote)}</small></article>)}</div></section>
      <div className="profile-region-grid">{native.regionReadings.map(region=>{const reviewComparison=native.geometryReviewComparisons.find(item=>item.pathCodes.includes(region.pathCode));return<button type="button" key={region.code} aria-pressed={activeAestheticRegion===region.pathCode} className={`profile-region-card reliability--${region.reliability} ${reviewComparison?'has-model-review':''} ${activeAestheticRegion===region.pathCode?'is-active':''}`} onClick={()=>{setShowAestheticRegions(true);setActiveAestheticRegion(value=>value===region.pathCode?null:region.pathCode)}}><span>{region.code} · 彩线读数 · {region.reliability==='moderate'?'中等稳定':region.reliability==='capture_sensitive'?'拍摄敏感':'实验读数'}</span><h3>{region.label}</h3>{reviewComparison&&<b className="profile-region-model-review">彩线 {reviewComparison.overlayValue.toFixed(2)}{reviewComparison.unit} vs 核心 {reviewComparison.coreValue.toFixed(2)}{reviewComparison.unit} · 差 {reviewComparison.difference.toFixed(2)} &gt; RSS {reviewComparison.maximum.toFixed(2)} · 仅供复核</b>}<MetricReading code={region.code} value={region.value} errors={region.errors}/><p>{region.interpretation}</p><small>{validationText(region.errors,region.validationNote)}</small></button>})}</div>
      <section className="profile-aux-section" aria-label="扩展侧貌指标"><div className="profile-aux-heading"><div><p className="eyebrow"><span/> EXTENDED PROFILE METRICS</p><h3>扩展侧貌指标</h3></div><small>以下7项来自39点派生几何，不计入核心7项模型门；字面三点折线角单独记录，不与面凸角混用。</small></div><div className="profile-aux-grid">{native.auxiliaryReadings.map(item=><article key={item.code} className={`reliability--${item.reliability}`}><span>{item.code} · {item.reliability==='moderate'?'中等稳定':item.reliability==='capture_sensitive'?'拍摄敏感':'实验读数'}</span><h4>{item.label}</h4><MetricReading code={item.code} value={item.value} errors={item.errors}/><p>{item.interpretation}</p><details><summary>查看公式与验证</summary><code>{item.formula}</code><small>{validationText(item.errors,item.validationNote)}</small></details></article>)}</div></section>
      <div className="profile-photo-metrics profile-photo-metrics--native">{orderedReadings.map(reading=>{const grade=nativeProfileReadingGrade(reading);return <article key={reading.code} className={`${reading.availability==='unavailable'?'is-unavailable':''} confidence--${grade}`}><span>{reading.code} · {nativeGradeLabel(grade)}</span><h3>{reading.label}</h3><MetricReading code={reading.code} value={reading.value} errors={reading.errors}/><ProfileReferenceBars code={reading.code} value={reading.value} errors={reading.errors}/><p>{reading.interpretation}</p><small className="metric-validation">{validationText(reading.errors,reading.validationNote)}</small><details><summary>查看公式与原始分层</summary><code>{reading.formula}</code><small>原始证据分层：{reading.reliability==='moderate'?'中等稳定':reading.reliability==='capture_sensitive'?'拍摄敏感':reading.reliability==='experimental'?'实验读数':'不评分'}</small></details></article>})}</div><div className="reference-disclosure"><Info size={17}/><p><strong>排序规则</strong>：可比较 → 可记录 → 仅参考 → 不可用；边框和主标签均来自数值与两级RSS。侧貌区间尺沿用正面报告的“参考带＋误差区间＋观测标记”表达，但只显示已有同构侧貌参考的项目；所有数值仍完整保留。</p></div>
    </section>
  }
  if(!analysis)return null
  const radius = Math.max(2, Math.max(analysis.width, analysis.height) * 0.003)
  return <section id="profile-photo-evidence" className="profile-evidence" aria-label="实验性侧面可见轮廓">
    <div className="profile-evidence__heading"><div><p className="eyebrow"><span /> PROFILE PHOTO EVIDENCE · EXPERIMENTAL</p><h2>侧面可见轮廓与照片代理</h2><p>青色线勾勒额—鼻—唇—颏和可见下颌；橙色线展示计算依据。所有读数只对应当前2D照片。</p></div><span>2组轮廓 · 3组证据线 · 6个语义代理点 · 5项实验读数</span></div>
    <div className="profile-evidence__body"><div className="profile-evidence__canvas" style={{aspectRatio:`${analysis.width} / ${analysis.height}`}}><img src={capture.url} alt="本次侧面实验轮廓"/><svg viewBox={`0 0 ${analysis.width} ${analysis.height}`} preserveAspectRatio="none" aria-label="侧面实验轮廓与证据线">{analysis.paths.filter(path=>path.category==='contour'&&showContour||path.category==='evidence'&&showEvidence).map(path=><polyline key={path.code} points={path.points.map(point=>`${point.x},${point.y}`).join(' ')} className={`profile-overlay profile-overlay--${path.category}`}><title>{path.label}</title></polyline>)}{showEvidence&&analysis.points.map(point=><circle key={point.index} cx={point.x} cy={point.y} r={radius} className="profile-overlay-point"><title>MediaPipe代理点 {point.index}</title></circle>)}</svg></div><div className="profile-evidence__controls"><button className={showContour?'is-active':''} onClick={()=>setShowContour(value=>!value)}>{showContour?<EyeOff size={15}/>:<Eye size={15}/>} 可见轮廓代理</button><button className={showEvidence?'is-active':''} onClick={()=>setShowEvidence(value=>!value)}>{showEvidence?<EyeOff size={15}/>:<Eye size={15}/>} 证据线与代理点</button><p><i className="legend-contour"/>轮廓代理 <i className="legend-profile-evidence"/>计算证据</p><small>{analysis.limitation}</small></div></div>
    <div className="profile-photo-metrics">{analysis.metrics.map(metric=><article key={metric.code}><span>{metric.code} · 实验/拍摄敏感</span><h3>{metric.label}</h3><strong>{metric.value}</strong><p>{metric.interpretation}</p><details><summary>查看公式</summary><code>{metric.formula}</code></details></article>)}</div>
    <div className="reference-disclosure"><Info size={17}/><p><strong>当前评价边界</strong>：这里只回答“照片中的可见轮廓怎样”，不回答“好不好看”或“属于哪类骨型”。原生39点软组织面凸角、鼻唇角、颏唇沟角、E-Line和颈颏角继续禁用。</p></div>
  </section>
}

function Report(props: { mode: Mode; captures: Capture[]; record?:ReportRecord;generatedAt?:string; isExample?: boolean; onStart: () => void; onRetake: (target?:CaptureId) => void; onPrivacy: () => void }) {
  return <ReportPageV2 {...props}/>
}

function PrivacyCenter({ captures, setCaptures, onBack, hasReport, accepted, onClear }: { captures: Capture[]; setCaptures: React.Dispatch<React.SetStateAction<Capture[]>>; onBack: () => void;hasReport:boolean;accepted:boolean;onClear:()=>void }) {
  const [deleted, setDeleted] = useState(false)
  const stored = captures.filter((capture) => capture.url).length
  const clearAll = () => {
    captures.forEach(revokeCaptureImages)
    setCaptures(initialCaptures)
    localStorage.removeItem('headup-session')
    onClear()
    setDeleted(true)
  }
  return (
    <section className="privacy-page page-grid">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> 返回</button>
      <div className="privacy-hero"><div><p className="eyebrow"><span /> PRIVACY CENTER</p><h1>你的脸，不应该<br />成为我们的库存。</h1><p>HeadUp 默认把照片留在当前设备。每一次出站、保存或训练用途都必须分别获得你的主动同意。</p></div><ShieldCheck /></div>
      <div className="privacy-grid">
        <article><span><Camera /></span><div><p>当前设备中的照片</p><strong>{deleted ? 0 : stored} 张</strong><small>仅保存在浏览器内存；关闭页面后自动释放。</small></div></article>
        <article><span><FileText /></span><div><p>派生测量与报告</p><strong>{deleted ? 0 : hasReport ? 1 : 0} 份</strong><small>本次生成或打开的报告，仅留在当前页面。</small></div></article>
        <article><span><Fingerprint /></span><div><p>使用说明</p><strong>{deleted?'已清除':accepted?'已确认':'未确认'}</strong><small>仅保存本次页面的确认状态。</small></div></article>
      </div>
      <section className="data-policy"><div><h2>默认数据路径</h2><p>从选择照片到基础报告，均可在设备侧闭环完成。</p></div><div className="data-flow"><span>照片</span><ArrowRight /><span>本地质量门控</span><ArrowRight /><span>派生测量</span><ArrowRight /><span>本地报告</span></div></section>
      <div className="delete-panel"><div><Trash2 /><span><strong>删除当前分析</strong><p>清除照片预览、质量结果与本地会话。此操作不可撤销。</p></span></div><button onClick={clearAll} disabled={deleted}>{deleted ? '已清除' : '立即清除本地数据'}</button></div>
      <div className="privacy-note"><Info /><p><strong>你的数据由你决定</strong>：照片默认留在当前设备。你可以在这里清除本次分析；已经下载到设备的报告文件，需要在保存位置另行删除。</p></div>
    </section>
  )
}

export default function App() {
  const [view,setView]=useState<View>('home')
  const [mode,setMode]=useState<Mode>('adult')
  const [captures,setCaptures]=useState<Capture[]>(initialCaptures)
  const [isExampleReport,setIsExampleReport]=useState(false)
  const [retakeTarget,setRetakeTarget]=useState<CaptureId|null>(null)
  const [setupAccepted,setSetupAccepted]=useState(false)
  const [uploadBusy,setUploadBusy]=useState(false)
  const [recordBusy,setRecordBusy]=useState(false)
  const [hasCurrentReport,setHasCurrentReport]=useState(false)
  const [generatedAt,setGeneratedAt]=useState<string>()
  const [generatedMode,setGeneratedMode]=useState<Mode>('adult')
  const [record,setRecord]=useState<ReportRecord|null>(null)
  const [recordError,setRecordError]=useState('')
  const recordInput=useRef<HTMLInputElement>(null)
  const returnFromPrivacy=useRef<View>('home')
  const navigate=(next:View)=>{
    if(uploadBusy||recordBusy)return
    if(next==='privacy')returnFromPrivacy.current=view
    setView(next)
    window.scrollTo({top:0,behavior:'instant'})
  }
  const start=()=>{setRecord(null);setIsExampleReport(false);setRetakeTarget(null);navigate(setupAccepted?'capture':'setup')}
  const goCapture=(target:CaptureId|null=null)=>{setRecord(null);setIsExampleReport(false);setRetakeTarget(target);navigate('capture')}
  const showExample=()=>{setRecord(null);setIsExampleReport(true);navigate('report')}
  const showCurrent=()=>{if(!hasCurrentReport)return;setRecord(null);setIsExampleReport(false);navigate('report')}
  const done=useMemo(()=>()=>{setRecord(null);setIsExampleReport(false);setGeneratedAt(new Date().toISOString());setGeneratedMode(mode);setHasCurrentReport(true);setView('report');window.scrollTo({top:0,behavior:'instant'})},[mode])
  const openRecord=async(file:File)=>{
    if(!REPORT_FILE_ACTIONS_ENABLED)return
    setRecordBusy(true);setRecordError('')
    try{
      if(file.size>MAX_REPORT_BYTES)throw new Error('文件超过2MB，请选择HeadUp下载的JSON记录。')
      const parsed=parseReportRecord(await file.text())
      setRecord(parsed);setIsExampleReport(parsed.isExample);setView('report');window.scrollTo({top:0,behavior:'instant'})
    }catch(error){setRecordError(error instanceof Error?error.message:'记录读取失败，请重新选择文件。')}
    finally{setRecordBusy(false)}
  }
  const clearContext=()=>{setRecord(null);setHasCurrentReport(false);setGeneratedAt(undefined);setSetupAccepted(false);returnFromPrivacy.current='home'}
  return <Shell view={view} reportSource={record?'saved':isExampleReport?'example':'current'} hasCurrentReport={hasCurrentReport} busy={uploadBusy||recordBusy} onOpenRecord={()=>recordInput.current?.click()} onCurrentReport={showCurrent} onNavigate={next=>next==='report'?showExample():next==='setup'?start():next==='capture'?goCapture():navigate(next)}>
    {REPORT_FILE_ACTIONS_ENABLED&&<input ref={recordInput} type="file" accept=".json,application/json" hidden disabled={uploadBusy||recordBusy} onChange={event=>{const file=event.target.files?.[0];event.currentTarget.value='';if(file)void openRecord(file)}}/>}
    {recordBusy&&<div className="app-notice" role="status">正在打开本地记录…</div>}
    {recordError&&<div className="app-notice app-notice--error" role="alert"><span>{recordError} 当前照片和报告仍保留。</span><button onClick={()=>setRecordError('')} aria-label="关闭记录错误提示"><X size={16}/></button></div>}
    {view==='home'&&<>{hasCurrentReport&&<div className="resume-banner page-grid"><div><strong>本次报告已生成</strong><span>可以继续查看本次测量结果与照片依据。</span></div><button onClick={showCurrent}>继续查看本次报告 <ArrowRight size={16}/></button></div>}<Home onStart={start} onReport={showExample}/></>}
    {view==='setup'&&<Setup mode={mode} setMode={setMode} accepted={setupAccepted} setAccepted={setSetupAccepted} onBack={()=>navigate('home')} onNext={()=>goCapture()}/>}
    {view==='capture'&&<CaptureFlow captures={captures} setCaptures={setCaptures} focusCaptureId={retakeTarget} onBack={()=>navigate('setup')} onAnalyze={()=>navigate('processing')} onViewExample={showExample} onBusyChange={setUploadBusy} onInvalidate={()=>setHasCurrentReport(false)}/>}
    {view==='processing'&&<Processing onDone={done}/>}
    {view==='report'&&<Report mode={record?.mode??(isExampleReport?mode:generatedMode)} captures={captures} record={record??undefined} generatedAt={generatedAt} isExample={isExampleReport} onStart={start} onRetake={target=>goCapture(target??null)} onPrivacy={()=>navigate('privacy')}/>}
    {view==='privacy'&&<PrivacyCenter captures={captures} setCaptures={setCaptures} hasReport={hasCurrentReport||Boolean(record)} accepted={setupAccepted} onClear={clearContext} onBack={()=>navigate(returnFromPrivacy.current)}/>}
  </Shell>
}
import {isPhotoQualityAcceptable} from './lib/imageQuality'
import {isPoseAcceptable} from './lib/facePose'
