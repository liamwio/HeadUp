import {useMemo,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {AiStagePanel} from './AiStagePanel'
import {StageSummary} from './StageSummary'
import {createProfile} from './model'
import {CompareView} from './CompareView'
import {createSession,defaultProtocol} from './model'
import {AI_CONTRACT_VERSION,localAiSelection} from './aiContract'
import {absoluteP95,evidenceForComponent} from '../lib/errorEvidence'
import '../appStyles'
import './family.css'
const session=createSession({profileId:'qa',recordedOn:'2026-09-17',kind:'memory',recordedBy:'together',note:'不应发送的本机备注',protocol:defaultProtocol()},[{id:'front',url:'blob:qa-not-used',label:'正面',hint:'',eyebrow:''}],new Date('2026-09-17T01:00:00Z'))
function engineeringRows(){
  const row=structuredClone(session);row.kind='measurement';row.captures.push({id:'profile',label:'侧面',hint:'',eyebrow:''});row.report.front=[{code:'FRONT-RATIO-07',label:'下半脸占脸高',value:'40.71%',score:0,note:'工程模拟，非真实测量',group:'比例',view:'front',origin:'measurement',available:true,errors:[absoluteP95('模拟误差','工程验证',5.88,'percentage_points')]}];row.report.profile=[{code:'PROFILE-LINE-02',label:'E-Line唇部距离',value:'上唇 -6.35% · 下唇 -4.34%',score:0,note:'工程模拟',group:'侧貌',view:'profile',origin:'experimental',available:true,errors:[evidenceForComponent(absoluteP95('模拟误差','上唇',4.37,'percentage_points'),0)]}];row.report.measuredCount=2;
  const prior=structuredClone(row);prior.id='prior-engineering';prior.recordedOn='2026-08-17';prior.report.front[0].value='39.10%';return [prior,row]
}
const stageProfile={...createProfile({nickname:'阶段工程档案',guardianConfirmed:true,childInformed:true,storage:true}),id:'qa'}
function Harness(){
  const [stage,setStage]=useState(false)
  const [mode,setMode]=useState('success'),[rows,setRows]=useState([session]),[count,setCount]=useState(0),[opened,setOpened]=useState(''),[comparison,setComparison]=useState(false)
  const comparisonRows=useMemo(()=>engineeringRows().map(r=>({...r,protocol:{...r.protocol,device:'工程设备',camera:'rear' as const,distanceCm:100,light:'daylight' as const},captures:r.captures.map(c=>({...c,poseValidation:{status:'pass',estimatedPose:c.id==='front'?'front':'left_profile'} as any,quality:{flags:[]} as any}))})),[])
  const request=useMemo<typeof fetch>(()=>async(url,options)=>{
    const config={ready:true,provider:'隔离模拟（非真实AI）',model:'fixture',configId:'qa',contract:AI_CONTRACT_VERSION}
    if(String(url).endsWith('/config'))return new Response(JSON.stringify(config))
    setCount(n=>n+1)
    if(mode==='wait')return new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted'))))
    const selection=localAiSelection(JSON.parse(String(options?.body)).input)
    return new Response(JSON.stringify({...config,generatedAt:new Date().toISOString(),selection:mode==='invalid'?{...selection,observed:['invented']}:selection}))
  },[mode])
  return <div className="family-app"><main style={{maxWidth:1000,margin:'0 auto',padding:24}}><h1>AI界面隔离自测</h1><p>使用本地固定响应，不访问任何外部AI，不读写家庭数据库。</p><label>模拟结果<select value={mode} onChange={e=>setMode(e.target.value)}><option value="success">有效依据</option><option value="invalid">伪造依据</option><option value="wait">等待直到取消</option></select></label><button onClick={()=>setRows(r=>r.map(s=>({...s,updatedAt:new Date().toISOString()})))}>模拟原记录更新</button><button onClick={()=>setRows(engineeringRows())}>切换到两期工程读数</button><button onClick={()=>setRows([session])}>切回生活留念</button><p>生成请求次数：{count} · 已打开依据：{opened||'无'}</p><button onClick={()=>setComparison(v=>!v)}>显示或收起对照表工程样例</button>{comparison&&<CompareView a={comparisonRows[0]} b={comparisonRows[1]} onBack={()=>setComparison(false)} onRecord={()=>setComparison(false)}/>}<button onClick={()=>setStage(v=>!v)}>显示阶段范围与导出验收</button>{stage?<StageSummary profile={stageProfile} sessions={rows} events={[{id:'engineering-question',profileId:'qa',date:'2026-09-17',type:'question',text:'工程家庭问题：<script>不应执行</script>；这段记录需要补充哪些资料？',createdAt:'2026-09-17T00:00:00Z'}]} onOpen={setOpened} onRecord={()=>setOpened('开始记录入口')} onSettings={()=>setOpened('设置入口')} onQuestions={()=>setOpened('问题入口')} request={request}/>:<AiStagePanel sessions={rows} profileId="qa" onOpen={setOpened} request={request}/>}</main></div>
}
const root=createRoot(document.getElementById('root')!);root.render(<Harness/>);import.meta.hot?.dispose(()=>root.unmount())
