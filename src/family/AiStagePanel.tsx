import {useEffect,useMemo,useRef,useState} from 'react'
import type {FamilySession} from './model'
import {buildAiInput} from './aiData'
import {metricLabel} from './aiReadings'
import type {AiStageExport} from './stageScope'
import {AI_CONSENT_VERSION,AI_CONTRACT_VERSION,AI_TOPICS,AI_ACTIONS,aiFacts,validateAiSelection,localAiSelection,type AiSelection,type AiTopic,type AiInput} from './aiContract'
type Config={ready:boolean;provider:string;model:string;configId:string;contract:string;requiresLogin?:boolean}
type Result={selection:AiSelection;provider:string;model:string;generatedAt:string;fingerprint:string}
const errorCopy:Record<string,string>={login_required:'请先登录家庭账号，再请求云端AI整理。',not_configured:'服务端尚未配置AI服务。本地摘要仍可使用。',invalid_request:'记录或授权内容已变化，请刷新服务状态后重新确认。',rate_limited:'请求较多，请稍后再试。',timeout:'AI服务等待超时，本地摘要仍可使用。',provider_failed:'AI提供方暂时不可用，本地摘要仍可使用。',unverified_output:'AI返回内容未通过依据校验，已保留本地摘要。',request_denied:'当前页面地址未获服务端允许，请检查服务配置。'}
export function AiStagePanel({sessions,profileId,onOpen,request=fetch,scopeKey='',scopeLabel,onExport}:{sessions:FamilySession[];profileId:string;onOpen:(id:string)=>void;request?:typeof fetch;scopeKey?:string;scopeLabel?:string;onExport?:(value:AiStageExport|null)=>void}) {
  const [config,setConfig]=useState<Config|null>(null),[configError,setConfigError]=useState(''),[reload,setReload]=useState(0),[topic,setTopic]=useState<AiTopic>('overview'),[focus,setFocus]=useState<AiInput['focus']>(null),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null),[short,setShort]=useState(false)
  const {input,sources,versionLabels}=useMemo(()=>buildAiInput(sessions,profileId,topic,focus),[sessions,profileId,topic,focus])
  const needsMetric=topic==='reading'||topic==='uncertainty',questionReady=!needsMetric||Boolean(input.focus)
  // Include source revisions locally: dates, removals, or metadata edits invalidate old results.
  const fingerprint=JSON.stringify([scopeKey,input,sessions.filter(s=>s.profileId===profileId).map(s=>[s.id,s.updatedAt])])
  const controller=useRef<AbortController|null>(null),serial=useRef(0)
  useEffect(()=>{let mounted=true;const c=new AbortController(),timer=setTimeout(()=>c.abort(),8000);setConfig(null);setConfigError('');void request('/api/ai/config',{redirect:'error',cache:'no-store',signal:c.signal}).then(async r=>{if(!r.ok)throw new Error();const v=await r.json();if(typeof v.ready!=='boolean'||typeof v.configId!=='string'||typeof v.provider!=='string'||typeof v.model!=='string'||v.contract!==AI_CONTRACT_VERSION)throw new Error();if(mounted)setConfig(v)}).catch(()=>{if(mounted)setConfigError('AI服务暂未连接，可继续查看本地摘要。')}).finally(()=>clearTimeout(timer));return()=>{mounted=false;clearTimeout(timer);c.abort()}},[reload,request])
  useEffect(()=>{serial.current++;controller.current?.abort();setBusy(false);setConsent(false);setResult(null);setError('');return()=>{serial.current++;controller.current?.abort()}},[fingerprint,config?.configId])
  const cancel=()=>{serial.current++;controller.current?.abort();setBusy(false);setConsent(false);setResult(null);setError('已停止等待。已经发出的请求可能已由提供方处理；本页不保存云端解读。')}
  const generate=async()=>{
    if(!config?.ready||config.requiresLogin||!consent||busy||!questionReady)return
    const token=++serial.current,c=new AbortController();controller.current=c;setBusy(true);setError('');setResult(null)
    const timer=setTimeout(()=>c.abort(),35000)
    try{
      const r=await request('/api/ai/stage',{method:'POST',redirect:'error',signal:c.signal,headers:{'Content-Type':'application/json','X-HeadUp-Request':'1'},body:JSON.stringify({consentVersion:AI_CONSENT_VERSION,configId:config.configId,input})})
      const v=await r.json();if(!r.ok)throw new Error(errorCopy[v.error]??'AI解读暂时不可用，本地摘要仍可使用。')
      if(v.configId!==config.configId||v.contract!==AI_CONTRACT_VERSION||typeof v.generatedAt!=='string'||!Number.isFinite(Date.parse(v.generatedAt)))throw new Error('AI服务配置已变化，请重新确认。')
      const selection=validateAiSelection(v.selection,input)
      if(token===serial.current)setResult({selection,provider:config.provider,model:config.model,generatedAt:v.generatedAt,fingerprint})
    }catch(e){if(token===serial.current)setError(c.signal.aborted?'AI请求已超时，本地摘要仍可使用。':e instanceof Error&&e.message!=='AI_DATA_INVALID'?e.message:'AI内容无法核验，已保留本地摘要。')}
    finally{clearTimeout(timer);if(token===serial.current){setBusy(false);setConsent(false)}}
  }
  const facts=aiFacts(input),localAnswer=localAiSelection(input),shown=result?.fingerprint===fingerprint?result:null
  useEffect(()=>{
    if(!onExport)return
    if(!result||result.fingerprint!==fingerprint){onExport(null);return}
    const verified=aiFacts(input)
    onExport({scopeKey,recordCount:input.records.length,topic:AI_TOPICS[input.topic],provider:result.provider,model:result.model,generatedAt:result.generatedAt,sections:[...(['recorded','observed','limitations'] as const).map(key=>({title:{recorded:'留下了什么',observed:'可以确认什么',limitations:'仍不能确定什么'}[key],facts:result.selection[key].map(id=>{const fact=verified.find(f=>f.id===id)!;return{text:fact.text,sourceIds:fact.refs.map(ref=>sources[ref])}})})),{title:'下一步最多三件事',facts:result.selection.actions.map(id=>({text:AI_ACTIONS[id],sourceIds:[]}))}]})
  },[result,fingerprint,scopeKey,onExport])
  return <section className="family-ai-panel"><div className="family-section-heading"><div><span className="family-eyebrow">可选 · 云端AI整理</span><h2>读懂记录</h2><p>围绕读数含义、误差、比较限制和拍摄方法提问。AI选择相关依据，数值和解释来自可核验的记录与指标定义。</p></div><button disabled={busy} onClick={()=>setReload(n=>n+1)}>刷新服务状态</button></div>
    <p role="status">{config?config.requiresLogin?'请先登录家庭账号，再使用云端AI整理。':config.ready?`处理方：${config.provider} · 模型：${config.model}`:'服务端尚未配置AI提供方，当前使用本地摘要。':configError||'正在读取AI服务状态…'}</p>
    <p>{scopeLabel?`本次范围：${scopeLabel}。整理该范围内最近${input.records.length}次记录（最多12次），范围内其余记录仍保留在本地摘要与依据列表。`:'本次最多整理最近12次记录。'}不会发送照片、面部关键点、昵称、出生年份或家庭备注；仅提交日期、可用核心读数、派生误差、版本代号与比较限制，仍属于个人数据。退出页面即清除本页解读，停止等待不能撤回已交给提供方的数据。</p>
    <label className="family-ai-topic">选择一个问题<select disabled={busy} value={topic} onChange={e=>setTopic(e.target.value as AiTopic)}>{Object.entries(AI_TOPICS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    {needsMetric&&<label className="family-ai-topic">选择记录与指标<select disabled={busy||!input.focus} value={input.focus?input.focus.ref+'/'+input.focus.code:''} onChange={e=>{const [ref,code]=e.target.value.split('/');setFocus({ref,code})}}>{!input.focus&&<option value="">尚无可解释的已保存读数</option>}{input.records.flatMap(r=>r.metrics.map(m=><option key={r.ref+m.code} value={r.ref+'/'+m.code}>{r.date} · {metricLabel(m.code)}</option>))}</select></label>}
    {!questionReady&&<p role="status">所选问题需要已保存且格式可核验的测量读数。生活留念、示例和检测未完成的数据不会补造读数。</p>}
    {topic!=='overview'&&questionReady&&input.records.length>0&&!shown&&<div className="family-ai-result"><h3>本机依据解答 · 非AI生成</h3><p>不用发送数据也能查看；可在下方授权AI选择和整理相关依据。</p>{[...localAnswer.observed,...localAnswer.limitations].map(id=>{const f=facts.find(f=>f.id===id)!;return <article key={id}><p>{f.text}</p><div className="family-ai-sources">{f.refs.map(ref=><button key={ref} onClick={()=>onOpen(sources[ref])}>依据：{input.records.find(r=>r.ref===ref)?.date}</button>)}</div></article>})}<h3>下一次可以做什么</h3><ul>{localAnswer.actions.map(id=><li key={id}>{AI_ACTIONS[id]}</li>)}</ul></div>}
    <details className="family-protocol"><summary>查看本次将发送的数据（{input.records.length}次）</summary><p>仅发送下列字段；记录编号R及版本代号A/N/C/P只在本次请求中使用。</p><pre className="family-ai-preview">{JSON.stringify(input,null,2)}</pre><p>版本代号在本机对应下列完整版本（这些原始版本文字不发送）：</p><ul>{Object.entries(versionLabels).map(([tag,label])=><li key={tag}>{tag}：{label}</li>)}</ul></details>
    <label className="family-inline-check"><input type="checkbox" checked={consent} disabled={!config?.ready||config.requiresLogin||!input.records.length||!questionReady||busy} onChange={e=>setConsent(e.target.checked)}/>已确认，同意本次将上述读数、误差与记录数据交给{config?.provider??'所配置的提供方'}处理，用于整理记录。</label>
    <div className="family-actions"><button className="family-primary" disabled={!consent||!config?.ready||!input.records.length||!questionReady||busy} onClick={()=>void generate()}>{busy?'正在整理依据…':'生成本次AI整理'}</button>{busy&&<button onClick={cancel}>停止等待</button>}{shown&&<button onClick={()=>{setResult(null);setConsent(false)}}>清除本页AI结果</button>}</div>
    {!input.records.length&&<p>先保存一次记录，再生成阶段整理。</p>}{error&&<p className="family-notice" role="status">{error}</p>}
    {shown&&<div className="family-ai-result"><div className="family-section-heading"><div><h3>AI整理的记录依据</h3><p>{shown.provider} · {new Date(shown.generatedAt).toLocaleString()} · 事实与引用已校验</p></div><button onClick={()=>setShort(v=>!v)} aria-pressed={short}>{short?'展开完整依据':'简短查看'}</button></div>{(['recorded','observed','limitations'] as const).map(section=><article key={section}><h3>{{recorded:'留下了什么',observed:'可以确认什么',limitations:'仍不能确定什么'}[section]}</h3><ul>{(short?(section==='limitations'?shown.selection.limitations:[shown.selection[section][0]]):shown.selection[section]).map(id=>{const f=facts.find(f=>f.id===id)!;return <li key={id}><p>{f.text}</p><div className="family-ai-sources">{f.refs.map(ref=><button key={ref} onClick={()=>onOpen(sources[ref])}>依据：{input.records.find(r=>r.ref===ref)?.date}</button>)}</div></li>})}</ul></article>)}<article><h3>下一步最多三件事</h3><ul>{shown.selection.actions.map(a=><li key={a}>{AI_ACTIONS[a]}<small> · 一般记录建议</small></li>)}</ul></article><p>本次使用受限整理模式：AI选择依据，页面使用核验后的原事实文字，问题限定为记录与拍摄相关内容；不保存问答历史，不提供诊断或外貌评判。</p></div>}
  </section>
}
