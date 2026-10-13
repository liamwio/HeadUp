import {sessionPurpose} from './model'
import {eventSourceText,eventQuestionText,eventAuthorText} from './eventDetails'
import type {Archive} from './backup'
import {recordRootId,sortedSessions,validDate,type FamilySession} from './model'
import {summarizeMetricValue} from '../lib/metricUncertainty'

export type ArchiveRange={from:string;to:string}
export type ReadableOptions={nickname:boolean;notes:boolean;photos:boolean}
export function selectArchiveRange(archive:Archive,profileId:string,range:ArchiveRange):Archive {
  if(range.from&&!validDate(range.from)||range.to&&!validDate(range.to)||range.from&&range.to&&range.from>range.to)throw new Error('请检查导出起止日期')
  const within=(date:string)=>(!range.from||date>=range.from)&&(!range.to||date<=range.to)
  const profiles=archive.profiles.filter(p=>p.id===profileId);if(profiles.length!==1)throw new Error('成长档案暂不可用')
  const roots=new Set(sortedSessions(archive.sessions,profileId).filter(s=>within(s.recordedOn)).map(recordRootId))
  const sessions=archive.sessions.filter(s=>s.profileId===profileId&&roots.has(recordRootId(s))),ids=new Set(sessions.map(s=>s.id))
  return {profiles,sessions,media:archive.media.filter(m=>m.profileId===profileId&&ids.has(m.sessionId)),plans:archive.plans.filter(p=>p.profileId===profileId),events:archive.events.filter(e=>e.profileId===profileId&&within(e.date))}
}
export function archivePreview(archive:Archive){
  const sessions=archive.profiles.flatMap(p=>sortedSessions(archive.sessions,p.id)),dates=sessions.map(s=>s.recordedOn).sort()
  return {records:sessions.length,versions:archive.sessions.length,photos:archive.media.length,originals:archive.media.filter(m=>m.originalBlob).length,events:archive.events.length,bytes:archive.media.reduce((n,m)=>n+m.blob.size+(m.originalBlob?.size??0),0),first:dates[0],last:dates.at(-1)}
}
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
async function imageData(blob:Blob){if(!['image/jpeg','image/png','image/webp','image/avif'].includes(blob.type))throw new Error('照片格式不支持资料导出');const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return `data:${blob.type};base64,${btoa(binary)}`}
export async function readableArchiveHtml(archive:Archive,options:ReadableOptions,now=new Date()):Promise<string>{
  const sessions=archive.profiles.flatMap(p=>sortedSessions(archive.sessions,p.id)).sort((a,b)=>a.recordedOn.localeCompare(b.recordedOn)),media=new Map(archive.media.map(m=>[m.id,m]))
  const relevant=sessions.flatMap(s=>s.captures.map(c=>media.get(c.mediaId??'')).filter(Boolean))
  if(options.photos&&relevant.reduce((n,m)=>n+m!.blob.size+(m!.originalBlob?.size??0),0)>30*1024*1024)throw new Error('所选原图超过30MB，请缩小资料日期范围，或关闭照片后导出。完整照片可使用分卷加密备份。')
  const section=async(s:FamilySession)=>{
    const photos=options.photos?(await Promise.all(s.captures.map(async c=>{const m=media.get(c.mediaId??'');if(!m)return '';const figure=async(blob:Blob,label:string)=>`<figure><img alt="${escape(c.label)}${label}" src="${await imageData(blob)}"><figcaption>${escape(c.label)} · ${label}</figcaption></figure>`;return m.originalBlob?(await figure(m.originalBlob,'扶正前原图'))+(await figure(m.blob,'分析用图，读数对应此图')):figure(m.blob,'原图 / 分析用图')}))).join(''):''
    const readings=s.kind==='memory'?[]:[...s.report.front,...s.report.profile,...(s.rightProfileReport?.profile??[]).map(r=>({...r,view:'right_profile' as const}))].filter(r=>r.available&&r.origin!=='demo')
    return `<section><h2>${escape(s.recordedOn)} · ${escape(sessionPurpose(s))}</h2><p>保存版本 V${(s.revision?.number??0)+1}；${s.captures.length}张视角照片。${s.revision?'本次曾补充或重新检测，完整历史保留在加密备份中。':''}</p><p class="version">${escape(s.version.algorithm)} · ${escape(s.version.norm)} · ${escape(s.version.copy)}</p>${options.notes&&s.note?`<blockquote>${escape(s.note)}</blockquote>`:''}<div class="photos">${photos}</div>${readings.length?`<table><thead><tr><th>视角</th><th>项目</th><th>原读数与误差</th><th>结果说明</th></tr></thead><tbody>${readings.map(r=>`<tr><td>${r.view==='front'?'正面':r.view==='right_profile'?'右侧':'侧面'}</td><td>${escape(r.label)}</td><td>${escape(summarizeMetricValue(r.value,r.errors??[]).display)}</td><td>${r.origin==='experimental'?'实验读数；':'照片读数；'}${summarizeMetricValue(r.value,r.errors??[]).uncertainty===null?'误差范围未校准':'误差不能用作跨期发育判断'}</td></tr>`).join('')}</tbody></table>`:'<p>本条不提供测量趋势。</p>'}${s.report.issues.length?`<h3>本次检测提示</h3><ul>${s.report.issues.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>`:''}<p>仅描述照片中的可见外观。照片差异可能来自拍摄条件，不能据此判断健康发育、改善或退步。</p></section>`
  }
  const body=(await Promise.all(sessions.map(section))).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>HeadUp 成长记录资料包</title><style>body{font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif;color:#29252a;background:#faf8f7;margin:0}main{max-width:960px;margin:auto;padding:36px}h1{color:#782d3e}h2{margin-top:0}section{padding:24px;background:white;border:1px solid #e8e1e3;border-radius:12px;margin:24px 0;break-inside:avoid}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:10px;text-align:left;border-bottom:1px solid #e8e1e3;overflow-wrap:anywhere}th{background:#faf4f5}.photos{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;flex:1 1 240px}img{max-width:100%;max-height:360px;object-fit:contain}figcaption,.version{color:#706b70;font-size:12px}blockquote{border-left:3px solid #b78493;margin:12px 0;padding:10px 16px;white-space:pre-wrap}p,li{overflow-wrap:anywhere}@media(max-width:600px){main{padding:16px}section{padding:14px}td,th{padding:6px}}@media print{body{background:white}main{padding:0}section{border:0;border-top:1px solid #ddd;border-radius:0;break-inside:auto}img{max-height:240px}thead{display:table-header-group}}</style></head><body><main><h1>成长记录资料包</h1>${options.nickname?`<p>档案：${archive.profiles.map(p=>escape(p.nickname)).join('、')}</p>`:''}<p>整理时间：${escape(now.toLocaleString())}。共${sessions.length}次记录，仅展示各次最新保存版本，不重新计算历史读数。</p><p>本文件可阅读或打印，不能用于恢复完整档案；恢复请使用加密备份。内容不构成健康发育判断或外貌评级。</p>${body}${options.notes&&archive.events.length?`<section><h2>用户记录的备注</h2><ul>${archive.events.map(e=>`<li>${escape(e.date)} · ${escape(eventQuestionText(e))} ${escape(e.text)}<br><small>${escape(eventSourceText(e))} · ${escape(eventAuthorText(e))}</small>${e.discussedOn?`<p>上次讨论：${escape(e.discussedOn)} · ${escape(e.discussionNote||'未补充讨论记录')}</p>`:''}</li>`).join('')}</ul></section>`:''}</main></body></html>`
}
