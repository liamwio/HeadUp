import type {MetricErrorEvidence} from './errorEvidence'
import type {MeasurementEvidence} from './measurementEvidence'
export const MAX_REPORT_BYTES=2*1024*1024
export type WireReading={code?:string;label:string;value:string;score:number;note:string;group:'对称'|'比例'|'侧貌';view:'front'|'profile';origin:'measurement'|'experimental'|'demo';available:boolean;formula?:string;landmarkIndices?:string;confidenceBasis?:string;errors?:MetricErrorEvidence[];evidence?:MeasurementEvidence}
export type WireDetection={title:string;facts:string[];issues:string[]}
export type ReportRecord={schema:'headup-report-record-v2';createdAt:string;isExample:boolean;mode:'adult'|'youth';measurements:WireReading[];extendedMeasurements:WireReading[];detection:{front:WireDetection;profile:WireDetection};issues:string[];summaries?:Array<{label:string;value:string;note:string}>;version?:{algorithm:string;norm:string;copy:string}}
const invalid = () => new Error('这不是完整的 HeadUp 测量记录。请选择通过“下载记录”保存的 JSON 文件。')
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
  return value as Record<string,unknown>
}
function text(value:unknown,max=1000):string {
  if(typeof value!=='string'||value.length>max)throw invalid()
  return value
}
function list(value:unknown,max:number):unknown[] { if(!Array.isArray(value)||value.length>max)throw invalid();return value }
function textList(value:unknown):string[] { return value===undefined?[]:list(value,40).map(v=>text(v)) }
function measurementEvidence(value:unknown,view:WireReading['view']):MeasurementEvidence {
  const e=object(value)
  if(e.version!=='HEADUP-POINT-LINE-1'||e.source!==(view==='front'?'saved_front_landmarks':'saved_profile_landmarks'))throw invalid()
  const dimension=(value:unknown)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>100000)throw invalid();return value}
  const width=dimension(e.width),height=dimension(e.height)
  const identifier=(value:unknown)=>{const result=text(value,160);if(!result.trim())throw invalid();return result}
  const coordinate=(value:unknown,maximum:number)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>maximum)throw invalid();return value}
  const points=list(e.points,40).map(value=>{const p=object(value);return {id:identifier(p.id),label:text(p.label,160),x:coordinate(p.x,width),y:coordinate(p.y,height)}})
  const ids=new Set(points.map(p=>p.id));if(ids.size!==points.length)throw invalid()
  const segments=list(e.segments,30).map(value=>{
    const s=object(value),from=identifier(s.from),to=identifier(s.to)
    if(!ids.has(from)||!ids.has(to)||!['measure','reference','projection'].includes(String(s.role)))throw invalid()
    return {id:identifier(s.id),label:text(s.label,160),from,to,role:s.role as MeasurementEvidence['segments'][number]['role']}
  })
  if(new Set(segments.map(s=>s.id)).size!==segments.length)throw invalid()
  return {version:'HEADUP-POINT-LINE-1',source:e.source as MeasurementEvidence['source'],width,height,points,segments,formula:text(e.formula,3000)}
}
function errorEvidence(value:unknown):MetricErrorEvidence {
  const e=object(value)
  if(e.statistic!=='p95'||!['drift','error','difference','repeatability'].includes(String(e.measure))||!['uncertainty_component','conservative_radius','descriptive_repeatability'].includes(String(e.use)))throw invalid()
  if(typeof e.value!=='number'||!Number.isFinite(e.value)||e.value<0||e.value>1e6)throw invalid()
  if(e.kind==='relative'&&e.unit!=='percent'||e.kind==='absolute'&&!['percentage_points','degrees','ratio','face_box_diagonal_percent','visible_profile_height_percent'].includes(String(e.unit))||!['relative','absolute'].includes(String(e.kind)))throw invalid()
  if(e.componentIndex!==undefined&&(!Number.isInteger(e.componentIndex)||Number(e.componentIndex)<0||Number(e.componentIndex)>8))throw invalid()
  return {source:text(e.source,160),context:e.context===undefined?undefined:text(e.context,300),statistic:'p95',measure:e.measure,kind:e.kind,unit:e.unit,value:e.value,use:e.use,componentIndex:e.componentIndex} as MetricErrorEvidence
}
function reading(value:unknown):WireReading {
  const r=object(value),code=text(r.code,80),valueText=text(r.value,500)
  if(!/^(FRONT|PROFILE)[-A-Z0-9_]*$/.test(code)||typeof r.available!=='boolean'||!['front','profile'].includes(String(r.view))||!['measurement','experimental','demo'].includes(String(r.origin)))throw invalid()
  if(r.available&&(!/\d/.test(valueText)||/NaN|Infinity/.test(valueText)))throw invalid()
  if(r.available&&[...valueText.matchAll(/[-+]?\d+(?:\.\d+)?/g)].some(m=>!Number.isFinite(Number(m[0]))||Math.abs(Number(m[0]))>1e6))throw invalid()
  if(!['对称','比例','侧貌'].includes(String(r.group)))throw invalid()
  if(code.startsWith('FRONT-')&&r.view!=='front'||code.startsWith('PROFILE-')&&r.view!=='profile')throw invalid()
  return {code,label:text(r.label,160),value:valueText,score:0,note:text(r.note),group:r.group as WireReading['group'],view:r.view as WireReading['view'],origin:r.origin as WireReading['origin'],available:r.available,
    formula:r.formula===undefined?undefined:text(r.formula,3000),landmarkIndices:r.landmarkIndices===undefined?undefined:text(r.landmarkIndices,3000),confidenceBasis:r.confidenceBasis===undefined?undefined:text(r.confidenceBasis,3000),errors:r.errors===undefined?[]:list(r.errors,40).map(errorEvidence),...(r.evidence===undefined?{}:{evidence:measurementEvidence(r.evidence,r.view as WireReading['view'])})}
}
function detection(value:unknown,fallback:string):WireDetection {
  if(value===undefined)return {title:fallback,facts:[],issues:[]}
  const d=object(value);return {title:text(d.title,180),facts:textList(d.facts),issues:textList(d.issues)}
}
export function parseReportRecord(source:string):ReportRecord {
  if(new TextEncoder().encode(source).byteLength>MAX_REPORT_BYTES)throw new Error('记录文件过大，请选择小于2MB的HeadUp记录。')
  let root:Record<string,unknown>
  try{root=object(JSON.parse(source))}catch{throw invalid()}
  if(root.schema!=='headup-report-record-v2'||typeof root.isExample!=='boolean'||!['adult','youth'].includes(String(root.mode)))throw invalid()
  const date=text(root.createdAt,40)
  if(!Number.isFinite(Date.parse(date)))throw invalid()
  const measurements=list(root.measurements,100).map(reading),extendedMeasurements=list(root.extendedMeasurements??[],100).map(reading)
  const ids=[...measurements,...extendedMeasurements].map(r=>r.code)
  if(new Set(ids).size!==ids.length)throw invalid()
  const d=root.detection===undefined?{}:object(root.detection)
  const summaries=root.summaries===undefined?undefined:list(root.summaries,3).map(v=>{const s=object(v);return {label:text(s.label,80),value:text(s.value,300),note:text(s.note,1000)}})
  if(summaries&&summaries.length!==3)throw invalid()
  const versionObject=root.version==null?null:object(root.version)
  const version=versionObject?{algorithm:text(versionObject.algorithm,200),norm:text(versionObject.norm,200),copy:text(versionObject.copy,200)}:undefined
  return {schema:'headup-report-record-v2',createdAt:date,isExample:root.isExample,mode:root.mode as ReportRecord['mode'],measurements,extendedMeasurements,detection:{front:detection(d.front,'正面检测记录'),profile:detection(d.profile,'侧面检测记录')},issues:textList(root.issues),summaries,version}
}
