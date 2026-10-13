import {sessionPurpose} from './model'
import {eventQuestionText} from './eventDetails'
import {sortedSessions,stageSummary,compareSessions,type FamilySession,type FamilyProfile,type FamilyEvent} from './model'
import {validDate,localDate} from './dates'
import {photoChecksPass} from './planCompletion'
export type StageRange={from:string;to:string}
export type StageFact={text:string;sourceIds:string[]}
export type StageSection={title:string;facts:StageFact[]}
export type StageQuestion={id:string;text:string;source:string}
export type AiStageExport={scopeKey:string;recordCount:number;topic:string;provider:string;model:string;generatedAt:string;sections:StageSection[]}
export const consultationQuestions:StageQuestion[]=[
  {id:'general:conditions',text:'这些记录的拍摄条件差异，会影响哪些观察？下次需要怎样保持一致？',source:'一般资料整理问题'},
  {id:'general:materials',text:'如果需要进一步了解我们提出的问题，应补充哪些记录或资料？',source:'一般资料整理问题'},
  {id:'general:plan',text:'如果已有专业随访安排，下一次需要记录什么、何时回看？',source:'一般资料整理问题'},
]
export function validateStageRange(range:StageRange,today=localDate()) {
  if(range.from&&!validDate(range.from)||range.to&&!validDate(range.to))return '请填写有效的起止日期，或留空表示不限。'
  if(range.from&&range.to&&range.from>range.to)return '开始日期不能晚于结束日期。'
  if(range.from>today||range.to>today)return '阶段范围不能超过今天。'
  return ''
}
export function selectStage(sessions:FamilySession[],events:FamilyEvent[],profileId:string,range:StageRange,today=localDate()) {
  const error=validateStageRange(range,today);if(error)throw new Error(error)
  const within=(date:string)=>(!range.from||date>=range.from)&&(!range.to||date<=range.to)
  return {rows:sortedSessions(sessions,profileId).filter(s=>within(s.recordedOn)),events:events.filter(e=>e.profileId===profileId&&within(e.date)).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id))}
}
export function stageRangeLabel(range:StageRange){return !range.from&&!range.to?'全部已保存记录':`${range.from||'最早记录'} — ${range.to||'今天'}`}
export function stagePreset(kind:'quarter'|'term',today=localDate()):StageRange {const year=Number(today.slice(0,4)),month=Number(today.slice(5,7));return {from:kind==='quarter'?`${year}-${String(Math.floor((month-1)/3)*3+1).padStart(2,'0')}-01`:`${month===1?year-1:year}-${month>=2&&month<=8?'02':'09'}-01`,to:today}}
export function buildStageSections(rows:FamilySession[],profile:FamilyProfile):StageSection[]{
  const summary=stageSummary(rows,profile),ids=rows.map(s=>s.id),observations=rows.filter(s=>s.kind==='measurement'),missing=observations.filter(s=>!(s.recordedBy==='user'?['front','profile','right_profile']:['front','profile']).every(id=>s.captures.some(c=>c.id===id)))
  const limits=new Map<string,Set<string>>()
  for(let i=1;i<observations.length;i++)for(const view of ['front','profile'] as const)for(const text of compareSessions(observations[i],observations[i-1],view).reasons){const sources=limits.get(text)??new Set<string>();sources.add(observations[i].id);sources.add(observations[i-1].id);limits.set(text,sources)}
  return [
    {title:'这段时间记录了什么',facts:[{text:summary.recorded,sourceIds:ids},...(rows.length?[{text:`其中${observations.filter(s=>!s.report.isExample&&photoChecksPass(s)).length}次照片观察通过所需视角的基础拍摄检查；这不代表跨期可比或健康结论。`,sourceIds:ids}]:[])]},
    {title:'目前能观察到什么',facts:[{text:summary.observed,sourceIds:missing.length?Array.from(new Set([rows[0]?.id,...missing.map(s=>s.id)].filter((s):s is string=>Boolean(s)))):ids}]},
    {title:'有哪些不能确定',facts:[{text:summary.limitations,sourceIds:[]},...Array.from(limits,([text,sources])=>({text,sourceIds:[...sources]}))]},
    {title:'下一步最多三件事',facts:summary.actions.map(text=>({text,sourceIds:[]}))},
  ]
}
export function stageQuestions(events:FamilyEvent[]):StageQuestion[]{return [...consultationQuestions,...events.filter(e=>e.type==='question').map(e=>({id:'event:'+e.id,text:e.text+(e.discussedOn?'\n上次讨论：'+e.discussedOn+'\n'+(e.discussionNote||'未补充讨论记录。'):''),source:e.date+' · 用户主动记录 · '+eventQuestionText(e)}))]}
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
/** srcdoc inherits the host URL; keep generated reference links inside the preview. */
export function stagePreviewHtml(html:string){return html.replaceAll('href="#R','href="about:srcdoc#R')}
export function stageSummaryHtml({profile,range,rows,sections,questions,includeNickname=false,ai,now=new Date()}:{profile:FamilyProfile;range:StageRange;rows:FamilySession[];sections:StageSection[];questions:StageQuestion[];includeNickname?:boolean;ai?:AiStageExport|null;now?:Date}) {
  const refs=new Map(rows.map((s,i)=>[s.id,'R'+(i+1)]))
  const renderSections=(groups:StageSection[])=>groups.map(group=>`<section><h2>${esc(group.title)}</h2>${group.facts.map(f=>`<p>${esc(f.text)}</p>${f.sourceIds.length?`<p class="source">依据：${f.sourceIds.map(id=>refs.has(id)?`<a href="#${refs.get(id)}">${refs.get(id)}</a>`:'依据已不在本范围').join('、')}</p>`:''}`).join('')}</section>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>HeadUp 阶段记录摘要</title><style>body{font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif;color:#29252a;background:#faf8f7;margin:0}main{max-width:880px;margin:auto;padding:32px}h1,h2{color:#782d3e}section{border:1px solid #e8e1e3;background:white;padding:20px;border-radius:12px;margin:20px 0}p,li{overflow-wrap:anywhere;white-space:pre-wrap}.source,small{font-size:12px;color:#706b70}a{color:#782d3e}li{margin-bottom:12px}@media(max-width:600px){main{padding:16px}section{padding:14px}}@media print{body{background:white}main{padding:0}section{border:0;border-top:1px solid #ddd;break-inside:avoid}}</style></head><body><main><h1>阶段记录摘要</h1>${includeNickname?`<p>档案：${esc(profile.nickname)}</p>`:''}<p>范围：${esc(stageRangeLabel(range))}；共${rows.length}次逻辑记录，采用各次最新保存版本。</p><p>整理时间：${esc(now.toLocaleString())}。本文件用于阅读和打印，不能恢复完整档案。照片差异不等于发育变化。</p><h2>本地规则摘要 · 非AI生成</h2>${renderSections(sections)}${questions.length?`<section><h2>准备讨论的问题</h2><p>以下为一般整理问题或用户主动选入的文字，不是诊断、专业意见或由照片推断的问题。</p><ul>${questions.map(q=>`<li>${esc(q.text)}<br><small>${esc(q.source)}</small></li>`).join('')}</ul></section>`:''}${ai?`<h2>本页已核验的AI整理</h2><p>${esc(ai.topic)}；仅覆盖本范围内最近${ai.recordCount}次记录；处理方${esc(ai.provider)}；模型${esc(ai.model)}；生成时间${esc(ai.generatedAt)}。AI选择依据，事实文字来自受控记录，不是独立诊断。</p>${renderSections(ai.sections)}`:''}<section><h2>记录依据索引</h2>${rows.length?`<ol>${rows.map(s=>`<li id="${refs.get(s.id)}"><strong>${refs.get(s.id)} · ${esc(s.recordedOn)}</strong> · ${esc(sessionPurpose(s))} · V${(s.revision?.number??0)+1}<br><small>${esc(s.version.algorithm)} / ${esc(s.version.norm)}</small></li>`).join('')}</ol>`:'<p>该范围内没有照片记录。</p>'}</section><p>没有导出原始照片、面部关键点或未选入的家庭文字。需要完整照片、读数或可恢复备份时，请使用档案与家庭中的数据工具。</p></main></body></html>`
}
