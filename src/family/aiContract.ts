/** Closed derived-data contract. No photos, points, names or family free text. */
import {AI_METRICS,metricLabel,metricMeaning,metricText,metricView,type AiMetric} from './aiReadings.ts'
import {COMPARISON_REASONS,type ComparisonReason} from './comparisonReasons.ts'
export const AI_CONSENT_VERSION='HEADUP-AI-2'
export const AI_CONTRACT_VERSION='HEADUP-STAGE-2'
export const AI_TOPICS={overview:'这段时间留下了什么',reading:'这个读数是什么意思',uncertainty:'这个读数的误差怎么看',capture:'下次怎样拍得更一致',comparison:'两次读数不同，能说明什么'} as const
export type AiTopic=keyof typeof AI_TOPICS
export type AiComparison={status:'incompatible'|'visual_only'|'conditions_close';reasons:ComparisonReason[]}
export type AiRow={ref:string;date:string;kind:'measurement'|'memory';views:Array<{view:'front'|'profile';side:'left'|'right'|'unknown';quality:'pass'|'review'|'unavailable';pose:'pass'|'review'|'unavailable'}>;measuredCount:number;metrics:AiMetric[];versions:{algorithm:string;norm:string;copy:string;protocol:string};previous:null|{front:AiComparison;profile:AiComparison}}
export type AiInput={version:typeof AI_CONTRACT_VERSION;topic:AiTopic;focus:null|{ref:string;code:string};records:AiRow[]}
export type AiFact={id:string;section:'recorded'|'observed'|'limitations';text:string;refs:string[]}
export const AI_ACTIONS={same_side:'下次继续拍同一侧面，保留正面和侧面原图。',conditions:'尽量沿用同一设备、镜头、距离和光线，并记下拍摄条件。',schedule:'设置下次记录时间，随时可以暂停。',retry:'检测未完成的照片可以稍后重试，照片记录仍然保留。',missing:'下次补齐缺少的正面或侧面照片。'} as const
export type AiSelection={recorded:string[];observed:string[];limitations:string[];actions:Array<keyof typeof AI_ACTIONS>}
function fail():never{throw new Error('AI_DATA_INVALID')}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail()
const keys=(v:Record<string,unknown>,expected:string[])=>{if(Object.keys(v).length!==expected.length||Object.keys(v).some(k=>!expected.includes(k)))fail()}
const one=<T extends string>(v:unknown,allowed:readonly T[]):T=>typeof v==='string'&&allowed.includes(v as T)?v as T:fail()
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e6?v:fail()
const incompatible=new Set<ComparisonReason>(['other_profile','same_record','revision','reused_photo','missing_view','side'])
function comparison(raw:unknown):AiComparison{const value=object(raw);keys(value,['status','reasons']);if(!Array.isArray(value.reasons)||!value.reasons.length||value.reasons.length>20)fail();const reasons=value.reasons.map(r=>one(r,Object.keys(COMPARISON_REASONS) as ComparisonReason[]));if(new Set(reasons).size!==reasons.length)fail();const status=one(value.status,['incompatible','visual_only','conditions_close']);if(status!==(reasons.some(r=>incompatible.has(r))?'incompatible':reasons.length===1&&reasons[0]==='uncalibrated'?'conditions_close':'visual_only'))fail();return{status,reasons}}
export function validateAiInput(raw:unknown):AiInput{
  const data=object(raw);keys(data,['version','topic','focus','records'])
  if(data.version!==AI_CONTRACT_VERSION||!Array.isArray(data.records)||!data.records.length||data.records.length>12)fail()
  const records=data.records.map((value,i):AiRow=>{
    const row=object(value);keys(row,['ref','date','kind','views','measuredCount','metrics','versions','previous'])
    if(row.ref!=='R'+(i+1)||typeof row.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||!Number.isFinite(Date.parse(row.date))||new Date(row.date+'T12:00:00Z').toISOString().slice(0,10)!==row.date)fail()
    if(!Number.isInteger(row.measuredCount)||Number(row.measuredCount)<0||Number(row.measuredCount)>40||!Array.isArray(row.views)||!row.views.length||row.views.length>2)fail()
    const views=row.views.map((v):AiRow['views'][number]=>{const c=object(v);keys(c,['view','side','quality','pose']);return {view:one(c.view,['front','profile']),side:one(c.side,['left','right','unknown']),quality:one(c.quality,['pass','review','unavailable']),pose:one(c.pose,['pass','review','unavailable'])}})
    if(new Set(views.map(v=>v.view)).size!==views.length||views.some(v=>v.view==='front'&&v.side!=='unknown'))fail()
    if(!Array.isArray(row.metrics)||row.metrics.length>20)fail()
    const metrics=row.metrics.map((m):AiMetric=>{const metric=object(m);keys(metric,['code','values','uncertainty','origin']);const code=one(metric.code,Object.keys(AI_METRICS)),spec=AI_METRICS[code];if(!Array.isArray(metric.values)||!Array.isArray(metric.uncertainty)||metric.values.length!==spec.parts.length||metric.uncertainty.length!==spec.parts.length||!views.some(v=>v.view===metricView(code)))fail();return{code,values:metric.values.map(number),uncertainty:metric.uncertainty.map(v=>v===null?null:number(v)>=0?v as number:fail()),origin:one(metric.origin,['measurement','experimental'])}})
    if(new Set(metrics.map(m=>m.code)).size!==metrics.length||metrics.length>Number(row.measuredCount))fail()
    const kind=one(row.kind,['measurement','memory']);if(kind==='memory'&&(metrics.length||row.measuredCount!==0))fail()
    const versions=object(row.versions);keys(versions,['algorithm','norm','copy','protocol']);for(const [key,prefix]of [['algorithm','A'],['norm','N'],['copy','C'],['protocol','P']])if(typeof versions[key]!=='string'||!new RegExp('^'+prefix+'([1-9]|1[0-2])$').test(versions[key] as string))fail()
    let previous:AiRow['previous']=null
    if(i===0){if(row.previous!==null)fail()}else{const p=object(row.previous);keys(p,['front','profile']);previous={front:comparison(p.front),profile:comparison(p.profile)}}
    return{ref:row.ref as string,date:row.date as string,kind,views,measuredCount:Number(row.measuredCount),metrics,versions:versions as AiRow['versions'],previous}
  })
  if(records.some((r,i)=>i>0&&r.date<records[i-1].date))fail()
  const topic=one(data.topic,Object.keys(AI_TOPICS) as AiTopic[]);let focus:AiInput['focus']=null
  if(data.focus!==null){const f=object(data.focus);keys(f,['ref','code']);const row=records.find(r=>r.ref===f.ref);if(!row?.metrics.some(m=>m.code===f.code))fail();focus={ref:f.ref as string,code:f.code as string}}
  if(['reading','uncertainty'].includes(topic)&&!focus)fail()
  return{version:AI_CONTRACT_VERSION,topic,focus,records}
}
export const metricFactId=(ref:string,code:string)=>ref+'-metric-'+code
export function aiFacts(input:AiInput):AiFact[]{
  const all=input.records.map(r=>r.ref),facts:AiFact[]=[{id:'record-count',section:'recorded',text:'本次整理'+input.records.length+'次记录，共'+input.records.reduce((n,r)=>n+r.views.length,0)+'张视角照片。',refs:all},{id:'boundary',section:'limitations',text:'目前缺少适用的真实跨期误差校准，不能据此判断健康发育、改善或退步。',refs:all}]
  if(input.records.length===1)facts.push({id:'need-pair',section:'limitations',text:'目前只有一次记录，不能进行两期对照；重新分析同一张照片也不构成新的成长时间点。',refs:all})
  for(const [i,r]of input.records.entries()){
    facts.push({id:r.ref+'-record',section:'recorded',text:r.date+'：'+(r.kind==='memory'?'生活留念':'面部生长记录')+'，包含'+r.views.map(v=>v.view==='front'?'正面':v.side==='left'?'左侧面':v.side==='right'?'右侧面':'方向未确认的侧面').join('和')+'。',refs:[r.ref]})
    facts.push({id:r.ref+'-reading',section:'observed',text:r.kind==='memory'?r.date+'的生活留念不参与测量趋势。':r.date+'保存了'+r.measuredCount+'项照片读数；本次可解释'+r.metrics.length+'项。未支持的格式仍可在原报告查看。',refs:[r.ref]})
    if(r.views.length<2)facts.push({id:r.ref+'-missing',section:'limitations',text:r.date+'尚未同时包含正面和侧面。',refs:[r.ref]})
    if(r.views.some(v=>v.quality!=='pass'||v.pose!=='pass'))facts.push({id:r.ref+'-quality',section:'limitations',text:r.date+'存在拍摄质量、姿态或检测未完成的提示，请先查看原记录。',refs:[r.ref]})
    for(const m of r.metrics){const id=metricFactId(r.ref,m.code);facts.push({id,section:'observed',text:r.date+'的'+metricLabel(m.code)+'：'+metricText(m)+'。'+metricMeaning(m.code),refs:[r.ref]});facts.push({id:id+'-limits',section:'limitations',text:(m.origin==='experimental'?'这是实验读数。':'这是照片中的可见外观读数。')+(m.uncertainty.some(v=>v!==null)?'±范围由该次保存的误差证据计算，不是个人的生理正常范围，也不能当成跨期变化阈值。':'原记录没有可用于此读数的误差范围，不能把未知误差当作零。')+'本次算法标识'+r.versions.algorithm+'，完整版本与误差来源见原记录。',refs:[r.ref]})}
    if(r.previous)for(const view of ['front','profile'] as const){const pair=r.previous[view];facts.push({id:r.ref+'-'+view+'-comparison',section:'limitations',text:r.date+'与'+input.records[i-1].date+'的'+(view==='front'?'正面':'侧面')+'比较：'+pair.reasons.map(k=>COMPARISON_REASONS[k]).join('；')+'。',refs:[input.records[i-1].ref,r.ref]})}
  }
  return facts
}
export function availableAiActions(input:AiInput):(keyof typeof AI_ACTIONS)[]{return ['same_side','conditions','schedule',...(input.records.some(r=>r.views.some(v=>v.pose==='unavailable'))?['retry' as const]:[]),...(input.records.some(r=>r.views.length<2)?['missing' as const]:[])]}
export function validateAiSelection(raw:unknown,input:AiInput):AiSelection{
  const data=object(raw);keys(data,['recorded','observed','limitations','actions']);const facts=aiFacts(input)
  for(const section of ['recorded','observed','limitations'] as const){const ids=data[section];if(!Array.isArray(ids)||!ids.length||ids.length>(section==='limitations'?8:6)||new Set(ids).size!==ids.length||ids.some(id=>!facts.some(f=>f.id===id&&f.section===section)))fail()}
  const observed=data.observed as string[],limits=data.limitations as string[]
  if(!limits.includes('boundary'))fail()
  if(input.focus&&!observed.includes(metricFactId(input.focus.ref,input.focus.code)))fail()
  for(const id of observed)if(id.includes('-metric-')){if(!limits.includes(id+'-limits'))fail();const quality=id.split('-metric-')[0]+'-quality';if(facts.some(f=>f.id===quality)&&!limits.includes(quality))fail()}
  if(input.topic==='overview'&&input.records.some(r=>r.metrics.length)&&!observed.some(id=>id.includes('-metric-')))fail()
  if(input.topic==='comparison'&&input.records.length>1&&['front','profile'].some(view=>!limits.includes(input.records.at(-1)!.ref+'-'+view+'-comparison')))fail()
  if(input.topic==='comparison'&&input.records.length===1&&!limits.includes('need-pair'))fail()
  const actions=data.actions;if(!Array.isArray(actions)||!actions.length||actions.length>3||new Set(actions).size!==actions.length||actions.some(a=>!availableAiActions(input).includes(a)))fail()
  return data as unknown as AiSelection
}
/** Deterministic answer remains available without an AI provider or consent. */
export function localAiSelection(input:AiInput):AiSelection{
  const row=input.focus?input.records.find(r=>r.ref===input.focus!.ref):[...input.records].reverse().find(r=>r.metrics.length)
  const metric=row&&(input.focus?row.metrics.find(m=>m.code===input.focus!.code):row.metrics[0])
  const id=row&&metric&&input.topic!=='capture'?metricFactId(row.ref,metric.code):undefined
  const last=input.records.at(-1),limits=['boundary',...(id?[id+'-limits']:[]),...(id&&row?.views.some(v=>v.quality!=='pass'||v.pose!=='pass')?[row.ref+'-quality']:[]),...(input.topic==='comparison'&&last?.previous?[last.ref+'-front-comparison',last.ref+'-profile-comparison']:[])]
  if(input.topic==='comparison'&&input.records.length===1)limits.push('need-pair')
  if(input.topic==='capture'&&last){if(last.views.length<2)limits.push(last.ref+'-missing');if(last.views.some(v=>v.quality!=='pass'||v.pose!=='pass'))limits.push(last.ref+'-quality')}
  const available=availableAiActions(input),actions=(['missing','retry','conditions','same_side','schedule'] as const).filter(id=>available.includes(id)).slice(0,3)
  const observed=id?[id]:last?[last.ref+'-reading']:[]
  if(input.topic==='comparison'&&last&&row===last&&metric&&input.records.length>1){const prior=input.records.at(-2)!;if(prior.metrics.some(m=>m.code===metric.code)&&last.previous?.[metricView(metric.code)].status!=='incompatible'){const priorId=metricFactId(prior.ref,metric.code);observed.unshift(priorId);limits.push(priorId+'-limits');if(prior.views.some(v=>v.quality!=='pass'||v.pose!=='pass'))limits.push(prior.ref+'-quality')}}
  return {recorded:['record-count'],observed,limitations:limits,actions}
}
