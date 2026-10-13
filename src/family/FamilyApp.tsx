import {HeightJournal} from './HeightJournal'
import {TrendPreview} from './AutomaticTrendReport'
import {trendSaveDestination} from './automaticTrend'
import {defaultPersonalPlan} from './personalPlan'
import {sessionPurpose} from './model'
import {FAMILY_SERVICES_ENABLED} from '../productMode'
import {PersonalReport} from './PersonalReport'
import {ShareManager} from './ShareManager'
import {ShareReceiver} from './ShareReceiver'
import {EventJournal} from './EventJournal'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, ArrowRight, CalendarDays, Camera, Check, ChevronRight, Clock3, FolderHeart, Home, Images, Info, Plus, RefreshCcw, Settings, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { ReportPageV2 } from '../ReportPageV2'
import { emptySnapshot, familyStore, storageMessage, FAMILY_CHANGE_CHANNEL, STORE_SWITCH_EVENT } from './store'
import { localDate, sideLabel, sortedSessions, sessionVersions, type FamilyEvent, type FamilyProfile, type FamilySession, type FamilySnapshot } from './model'
import {HandoffReceiver} from './HandoffReceiver'
import {HandoffProgress} from './HandoffProgress'
import {rememberHandoffRecord,type HandoffTask} from './handoff'
import {ProfileOverview} from './ProfileOverview'
import {captureReferenceSession} from './baseline'
import type {ProfileSide} from './model'
import { ProfileForm } from './ProfileForm'
import { RecordFlow } from './RecordFlow'
import {ReviseSession} from './ReviseSession'
import type {RevisionOperation} from './revisions'
import { SessionThumb, Timeline } from './Timeline'
import { FamilySettings } from './FamilySettings'
import {CloudAccountPanel} from './CloudAccountPanel'
import {getWorkspace,subscribeWorkspace,openWorkspace,leaveWorkspace,unlockWorkspace,restoreWorkspace} from './cloudRuntime'
import {SyncPanel} from './SyncPanel'
import type {CloudIdentity} from './cloudTransport'
import { PlanForm } from './PlanForm'
import { StageSummary } from './StageSummary'
import { ReminderBridge } from './ReminderBridge'
import { UpdateNotice } from './UpdateNotice'
import { useSessionCaptures } from './hooks'
import {DraftGuardContext,useDraftGuard} from './DraftGuard'
import {useLeaveConfirmation} from './LeaveConfirmation'
import {DraftRegistry} from './draftRegistry'
import './family.css'

const storedSelection=()=>{try{return localStorage.getItem('headup-family-selected-profile')??''}catch{return ''}}
const initialRoute=()=>{const route=typeof location!=='undefined'&&location.hash.startsWith('#family/')?location.hash.slice(8):'home';if(route.split('/')[0]==='compare')return 'summary';return !FAMILY_SERVICES_ENABLED&&['account','sync','shares','shared','handoff'].includes(route.split('/')[0])?'home':route}
const links=[{id:'home',label:'首页',desktop:'总览',Icon:Home},{id:'timeline',label:'时间线',desktop:'成长时间线',Icon:Images},{id:'record',label:'记录',desktop:'新增记录',Icon:Camera},{id:'summary',label:'趋势',desktop:'趋势报告',Icon:Sparkles},{id:'settings',label:'档案',desktop:'档案与设置',Icon:Settings}]

export default function FamilyApp({apiBase='/api/family',allowLocalHandoff=false,allowLocalShare=false}:{apiBase?:string;allowLocalHandoff?:boolean;allowLocalShare?:boolean}={}) {
  const activeWorkspace=useSyncExternalStore(subscribeWorkspace,getWorkspace,()=>null),workspace=FAMILY_SERVICES_ENABLED?activeWorkspace:null
  const [snapshot,setSnapshot]=useState<FamilySnapshot>(emptySnapshot),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[activeId,setActiveId]=useState(storedSelection),[route,setRoute]=useState(initialRoute),[busy,setBusy]=useState(false)
  const {confirmLeave,dialog:leaveDialog}=useLeaveConfirmation()
  const draftRegistry=useRef(new DraftRegistry())
  const dirtyRef=useRef(false),routeRef=useRef(route),loadSerial=useRef(0)
  const busyRef=useRef(busy),pendingRefresh=useRef(false);busyRef.current=busy
  const receivingShare=route.startsWith('shared/')
  const profile=snapshot.profiles.find(p=>p.id===activeId)??snapshot.profiles[0]
  const refresh=useCallback(async()=>{const token=++loadSerial.current;try{const data=await familyStore.snapshot();if(token!==loadSerial.current)return;setSnapshot(data);setLoaded(true);setError('')}catch(e){if(token===loadSerial.current){setError(storageMessage(e));setLoaded(true)}}},[])
  const markDraft=useCallback((id:string,dirty:boolean)=>{dirtyRef.current=draftRegistry.current.set(id,dirty);if(!dirtyRef.current&&pendingRefresh.current){pendingRefresh.current=false;void refresh()}},[refresh])
  const setDirty=useCallback((dirty:boolean)=>markDraft('photos',dirty),[markDraft])
  const clearDrafts=useCallback(()=>{draftRegistry.current.clear();dirtyRef.current=false},[])
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirtyRef.current||busyRef.current){e.preventDefault();e.returnValue=''}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[])
  useEffect(()=>{if(receivingShare)return;if(!FAMILY_SERVICES_ENABLED)leaveWorkspace();void refresh();if(FAMILY_SERVICES_ENABLED)void restoreWorkspace().catch(()=>{});const switched=()=>{setLoaded(false);setSnapshot(emptySnapshot());setActiveId('');void refresh()};window.addEventListener(STORE_SWITCH_EVENT,switched);return()=>window.removeEventListener(STORE_SWITCH_EVENT,switched)},[refresh,receivingShare])
  useEffect(()=>{if(!busy&&!dirtyRef.current&&pendingRefresh.current){pendingRefresh.current=false;void refresh()}},[busy,refresh])
  useEffect(()=>{
    if(receivingShare)return
    const changed=()=>{if(dirtyRef.current||busyRef.current){pendingRefresh.current=true;return}void refresh()}
    const visible=()=>{if(document.visibilityState==='visible')changed()}
    let channel:BroadcastChannel|undefined
    try{if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel(FAMILY_CHANGE_CHANNEL);channel.onmessage=changed}}catch{}
    window.addEventListener('focus',changed);document.addEventListener('visibilitychange',visible)
    return()=>{channel?.close();window.removeEventListener('focus',changed);document.removeEventListener('visibilitychange',visible)}
  },[refresh,receivingShare])
  useEffect(()=>{if(profile){setActiveId(profile.id);try{localStorage.setItem('headup-family-selected-profile',profile.id)}catch{}}},[profile?.id])
  const navigate=useCallback(async(next:string,feedback='')=>{
    if(next.split('/')[0]==='compare')next='summary'
    if(!FAMILY_SERVICES_ENABLED&&['account','sync','shares','shared','handoff'].includes(next.split('/')[0]))next='home'
    if(routeRef.current===next)return
    if(!await confirmLeave(dirtyRef.current))return
    clearDrafts();setNotice(feedback);if(pendingRefresh.current){pendingRefresh.current=false;void refresh()}routeRef.current=next;setRoute(next);history.pushState(null,'',`#family/${next}`);window.scrollTo(0,0)
  },[refresh,clearDrafts,confirmLeave])
  useEffect(()=>{
    let handling=false
    const changed=async()=>{if(handling||!location.hash.startsWith('#family/'))return;const next=initialRoute();if(next===routeRef.current)return;handling=true;try{if(dirtyRef.current){history.replaceState(null,'',`#family/${routeRef.current}`);if(!await confirmLeave(true))return;history.pushState(null,'',`#family/${next}`)}clearDrafts();setNotice('');routeRef.current=next;setRoute(next);window.scrollTo(0,0)}finally{handling=false}}
    window.addEventListener('popstate',changed);window.addEventListener('hashchange',changed)
    return()=>{window.removeEventListener('popstate',changed);window.removeEventListener('hashchange',changed)}
  },[clearDrafts,confirmLeave])
  const changeWorkspace=async(me?:CloudIdentity,familyId?:string,base?:string)=>{if(busyRef.current)throw new Error('当前正在处理照片，请稍后切换');if(!await confirmLeave(dirtyRef.current))return;if(me&&familyId)await openWorkspace(me,familyId,base);else leaveWorkspace();clearDrafts();setNotice('');routeRef.current=me?'sync':'home';setRoute(routeRef.current);history.pushState(null,'',`#family/${routeRef.current}`)}
  const saveProfile=async(p:FamilyProfile,cloudConsent=false,expected?:FamilyProfile|null)=>{await familyStore.putProfile(p,expected);if(workspace&&cloudConsent&&!await workspace.store.syncState(p.id).then(s=>s.link)){await workspace.engine.connect(p.id);void workspace.engine.run()};clearDrafts();setActiveId(p.id);await refresh();await navigate(expected?'profile':'record',expected?'档案已更新。':'档案已创建，请按正面、左侧、右侧依次记录。')}
  const openSession=(id:string)=>navigate(`session/${encodeURIComponent(id)}`)
  const saved=async(session:FamilySession)=>{if(workspace&&getWorkspace()?.engine===workspace.engine)rememberHandoffRecord(workspace.base,workspace.user.id,session,routeRef.current.split('/')[2]);setDirty(false);await refresh();const data=await familyStore.snapshot().catch(()=>snapshot),destination=trendSaveDestination(data.sessions,session);void navigate(destination,destination==='summary'?'记录已保存，趋势报告已自动更新。':'照片和结果已保存，达到3次记录后自动生成趋势报告。')}
  const currentSection=route.split('/')[0],sessions=profile?sortedSessions(snapshot.sessions,profile.id):[]
  const requestedSide:ProfileSide|undefined=['left_profile','right_profile'].includes(route.split('/')[1])?route.split('/')[1] as ProfileSide:undefined
  const openHandoffRecord=async(id:string)=>{if(!await confirmLeave(dirtyRef.current))return;clearDrafts();const ws=getWorkspace();if(ws&&!ws.locked){await ws.engine.run();const data=await ws.store.snapshot(),record=data.sessions.find(s=>s.id===id);if(record)setActiveId(record.profileId)}await refresh();await navigate('session/'+encodeURIComponent(id))}
  const acceptHandoff=async(me:CloudIdentity,task:HandoffTask,mode:'capture'|'view')=>{const expectedRoute=routeRef.current;if(!await confirmLeave(dirtyRef.current))return;let ws=getWorkspace();if(!ws||ws.locked||ws.base!==apiBase||ws.user.id!==me.user.id||ws.family.id!==task.familyId)ws=await openWorkspace(me,task.familyId,apiBase);if(!ws)throw new Error('家庭工作区未能打开');const target=await ws.store.syncState(task.profileId),link=target.link;if(link&&!target.archive.profiles.some(p=>p.id===task.profileId))throw new Error('本机目标档案正在删除或未完成下载，请先处理家庭同步再接力');if(link?.status==='conflict')throw new Error('此档案有同步冲突，请先返回家庭同步页处理，再打开原接力链接继续');if(!link)await ws.engine.subscribe(task.profileId);else if(!link.enabled||link.status==='revoked')await ws.engine.pause(task.profileId,false);if(getWorkspace()?.engine!==ws.engine||routeRef.current!==expectedRoute)throw new Error('页面或工作区已变化，请重新确认接力');if(!(await ws.store.snapshot()).profiles.some(p=>p.id===task.profileId))throw new Error('目标档案未能完整打开，请重试');clearDrafts();setActiveId(task.profileId);await refresh();await navigate(mode==='view'&&task.sessionId?'session/'+encodeURIComponent(task.sessionId):'record/'+(task.side??'any')+'/'+task.id+'/'+task.profileId)}
  if(currentSection==='shared')return <div className="family-app"><main className="family-handoff-page"><ShareReceiver key={route} token={route.split('/')[1]??''} base={apiBase} onBack={()=>navigate('home')}/></main></div>
  if(currentSection==='handoff')return <DraftGuardContext.Provider value={markDraft}><div className="family-app">{leaveDialog}<main className="family-handoff-page"><HandoffReceiver key={route} token={route.split('/')[1]??''} base={apiBase} onReady={acceptHandoff} onBack={()=>navigate('home')} onOther={token=>navigate('handoff/'+token)}/></main></div></DraftGuardContext.Provider>
  let page:React.ReactNode
  if(!loaded)page=<div className="family-empty" role="status"><RefreshCcw className="family-spin"/><h1>正在打开本机成长档案</h1></div>
  else if(error)page=<div className="family-empty"><Info size={36}/><h1>本机档案暂时不可用</h1><p role="alert">{error}</p><button onClick={()=>void refresh()}>重新读取</button><p>不要清理浏览器数据；已有档案不会因读取失败被覆盖。</p></div>
  else if(route==='account')page=<CloudAccountPanel apiBase={apiBase} onEnter={changeWorkspace} backLabel={profile?'返回家庭与数据':'返回本机档案'} onBack={()=>navigate(profile?'settings':'home')}/>
  else if(route==='sync'&&workspace)page=<SyncPanel key={workspace.store.name+':'+workspace.engine.owner}/>
  else if(currentSection==='record'&&route.split('/')[2]&&(!workspace||route.split('/')[3]!==profile?.id))page=<div className="family-empty"><h1>接力目标档案暂不可用</h1><p>没有改为其他孩子记录，请从原接力链接重新确认，或先处理家庭同步。</p><button onClick={()=>navigate('sync')}>查看家庭同步</button></div>
  else if(workspace&&!profile&&workspace.family.role!=='owner')page=<div className="family-empty"><h1>连接已授权的档案</h1><p>从家庭同步页选择并下载档案后，即可记录和回看。</p><button onClick={()=>navigate('sync')}>打开家庭同步</button></div>
  else if(!profile||route==='new-profile')page=<ProfileForm onAccount={()=>navigate('account')} cloudFamilyName={workspace?.family.name} onSave={saveProfile} onCancel={profile?()=>navigate('home'):undefined}/>
  else if(route==='edit-profile')page=<ProfileForm key={profile.id} existing={profile} cloudFamilyName={workspace?.family.name} onSave={saveProfile} onCancel={()=>navigate('profile')}/>
  else if(route==='profile')page=<ProfileOverview key={profile.id} profile={profile} sessions={snapshot.sessions} onEdit={()=>navigate('edit-profile')} onOpen={openSession} onRecord={()=>navigate('record')} onBack={()=>navigate('home')}/>
  else if(currentSection==='record')page=<RecordFlow receivingHandoff={Boolean(route.split('/')[2])} allowLocalHandoff={allowLocalHandoff} onAccount={()=>navigate('account')} onHandoffOpen={id=>void openHandoffRecord(id)} requestedSide={requestedSide} cloudFamilyName={workspace?.family.name} key={profile.id+':'+route} profile={profile} previousSession={captureReferenceSession(snapshot.sessions,profile.id,requestedSide??profile.preferredSide)} onSaved={saved} onExit={()=>navigate('home')} onBusy={setBusy} onDirty={setDirty} onPrivacy={()=>navigate('settings')}/>
  else if(currentSection==='timeline')page=<Timeline key={(workspace?.store.name??'local')+':'+profile.id} sessions={snapshot.sessions} events={snapshot.events} profile={profile} onEvents={()=>navigate('events')} onOpen={openSession} onTrend={()=>navigate('summary')} onRecord={()=>navigate('record')}/>
  else if(currentSection==='events')page=<section><button className="family-back" onClick={()=>navigate('timeline')}>返回成长时间线</button><h1>{profile.nickname}的个人事件</h1><HeightJournal events={snapshot.events} profileId={profile.id} onRefresh={refresh}/><EventJournal key={profile.id} profile={profile} events={snapshot.events.filter(e=>e.profileId===profile.id)} onRefresh={refresh}/></section>
  else if(currentSection==='revise') {
    const [,encoded,operation]=route.split('/'),session=sessions.find(s=>s.id===decodeURIComponent(encoded??''))
    page=session&&(operation==='reanalyze'||operation==='supplement')?<ReviseSession key={session.id+operation} session={session} profile={profile} operation={operation} onSaved={saved} onExit={()=>openSession(session.id)} onBusy={setBusy} onDirty={setDirty}/>:<Missing onBack={()=>navigate('timeline')}/>
  } else if(currentSection==='session') {
    const id=decodeURIComponent(route.slice('session/'.length)),session=snapshot.sessions.find(s=>s.profileId===profile.id&&s.id===id)
    page=session?<SessionDetail key={session.id} session={session} versions={sessionVersions(snapshot.sessions,session)} onOpen={openSession} onRevise={operation=>navigate('revise/'+encodeURIComponent(session.id)+'/'+operation)} profile={profile} events={snapshot.events.filter(e=>e.profileId===profile.id)} onBack={()=>navigate('timeline')} onRecord={()=>navigate('record')} onPrivacy={()=>navigate('settings')} onRefresh={refresh} onDeleted={()=>{void refresh();navigate('timeline','该记录及关联照片已从本机删除。')}}/>:<Missing onBack={()=>navigate('timeline')}/>
  } else if(currentSection==='plan')page=<PlanForm sessions={snapshot.sessions} onOpen={openSession} canEdit={workspace?.family.role!=='child'} cloudFamilyName={workspace?.family.name} key={profile.id} exists={snapshot.plans.some(p=>p.profileId===profile.id)} initial={snapshot.plans.find(p=>p.profileId===profile.id)??defaultPersonalPlan(profile.id,snapshot.sessions)} onSave={async (p,expected)=>{await familyStore.putPlan(p,expected);await refresh()}}/>
  else if(currentSection==='shares')page=<ShareManager key={(workspace?.store.name??'local')+':'+profile.id} profile={profile} sessions={snapshot.sessions} events={snapshot.events} allowLocal={allowLocalShare} onAccount={()=>navigate('account')} onBack={()=>navigate('settings')}/>
  else if(currentSection==='settings')page=<FamilySettings onShare={()=>navigate('shares')} onProfile={()=>navigate('profile')} cloudFamilyName={workspace?.family.name} onSync={()=>navigate('sync')} key={profile.id} profile={profile} onAccount={()=>navigate('account')} onCreate={()=>navigate('new-profile')} onEdit={()=>navigate('edit-profile')} onRefresh={refresh} onDeleted={()=>{void refresh();setActiveId('');navigate(workspace?'sync':'home',workspace?'档案已从本机删除，请在家庭同步页确认云端删除结果。离线、暂停或冲突时仍待处理。':'档案及其本机冲突副本已删除。')}}/>
  else if(currentSection==='summary')page=<StageSummary key={(workspace?.store.name??'local')+':'+profile.id} profile={profile} sessions={snapshot.sessions} events={snapshot.events} onQuestions={()=>navigate('events')} onOpen={openSession} onRecord={()=>navigate('record')} onSettings={()=>navigate('settings')}/>
  else page=<Dashboard profile={profile} sessions={sessions} snapshot={snapshot} onRecord={()=>navigate('record')} onOpen={openSession} onTimeline={()=>navigate('timeline')} onPlan={()=>navigate('plan')} onSummary={()=>navigate('summary')} onRefresh={refresh}/>
  const navSection=['session','compare','revise','events'].includes(currentSection)?'timeline':['shares','account','sync','profile','edit-profile','new-profile'].includes(currentSection)?'settings':currentSection==='plan'?'home':currentSection
  return <DraftGuardContext.Provider value={markDraft}><div className="family-app">{leaveDialog}<div hidden={Boolean(workspace?.locked)}><a className="skip-link" href="#family-main">跳到主要内容</a><aside className="family-sidebar"><button className="family-brand" disabled={busy} onClick={()=>navigate('home')}><span>H</span>HEADUP</button><p>记录照片与变化</p><nav aria-label="个人应用导航">{links.filter(l=>l.id!=='record').map(({id,desktop,Icon})=><button disabled={busy} key={id} aria-current={navSection===id?'page':undefined} onClick={()=>navigate(id)}><Icon size={20}/>{desktop}</button>)}</nav><div className="family-sidebar-bottom"><ShieldCheck size={18}/><span>{workspace?'家庭工作区':'本机保存'}<br/><small>{workspace?'先存本机，随后同步':'不自动上传照片'}</small></span></div></aside>
    <div className="family-workspace"><header className="family-topbar"><span className="family-mobile-brand">HEADUP</span>{profile?<label className="family-profile-picker"><span className="sr-only">当前成长档案</span><select disabled={busy} value={profile.id} onChange={async e=>{const next=e.target.value;if(!await confirmLeave(dirtyRef.current))return;clearDrafts();setNotice('');setActiveId(next);void navigate('home')}}>{snapshot.profiles.map(p=><option key={p.id} value={p.id}>{p.nickname}的成长档案</option>)}</select></label>:<span>欢迎来到HeadUp</span>}<div>{FAMILY_SERVICES_ENABLED&&<button disabled={busy} onClick={()=>navigate('account')}>家庭账号</button>}<span className="family-storage-badge"><ShieldCheck size={14}/>{workspace?'家庭工作区':'本机档案'}</span>{profile&&<button className="family-header-record" disabled={busy} onClick={()=>navigate('record')}><Plus size={17}/>新增记录</button>}</div></header>
      <main id="family-main" tabIndex={-1}>{workspace&&<HandoffProgress workspace={workspace} busy={busy} onTask={token=>void navigate('handoff/'+token)} onOpen={id=>void openHandoffRecord(id)}/>}{workspace&&<div className="family-workspace-banner"><span>{workspace.family.name} · {workspace.user.displayName} · {workspace.syncLabel}</span><button disabled={busy} onClick={()=>navigate('sync')}>同步状态</button><button disabled={busy} onClick={()=>void changeWorkspace()}>返回本机模式</button></div>}{notice&&<div className="family-toast" role="status"><Check size={17}/>{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}>关闭</button></div>}{page}</main></div>
    <UpdateNotice busy={busy} hasDraft={()=>dirtyRef.current}/><ReminderBridge/>{profile&&<nav className="family-bottom-nav" aria-label="手机应用导航">{links.map(({id,label,Icon})=><button disabled={busy} key={id} className={id==='record'?'family-bottom-record':''} aria-current={navSection===id?'page':undefined} onClick={()=>navigate(id)}><Icon size={21}/><span>{label}</span></button>)}</nav>}
  </div>{workspace?.locked&&<div className="family-lock-screen"><h1>家庭会话需要重新验证</h1><p>{workspace.locked}</p><p>原账号页面草稿仍保留；请重新登录原账号，再恢复工作区。</p><button onClick={()=>void unlockWorkspace().catch(e=>setNotice(e.message))}>重新验证并恢复</button>{notice&&<p role="alert">{notice}</p>}<button disabled={busy} onClick={()=>void changeWorkspace()}>返回本机模式</button><CloudAccountPanel apiBase={workspace.base} onBack={()=>void unlockWorkspace().catch(e=>setNotice(e.message))}/></div>}</div></DraftGuardContext.Provider>
}

function Missing({onBack}:{onBack:()=>void}){return <div className="family-empty"><Info size={32}/><h1>这条记录暂不可用</h1><p>它可能已删除，或属于另一个成长档案。</p><button onClick={onBack}>返回时间线</button></div>}

function Dashboard({profile,sessions,snapshot,onRecord,onOpen,onTimeline,onPlan,onSummary,onRefresh}:{profile:FamilyProfile;sessions:FamilySession[];snapshot:FamilySnapshot;onRecord:()=>void;onOpen:(id:string)=>void;onTimeline:()=>void;onPlan:()=>void;onSummary:()=>void;onRefresh:()=>Promise<void>}) {
  const plan=snapshot.plans.find(p=>p.profileId===profile.id)??defaultPersonalPlan(profile.id,sessions),latest=sessions[0]
  return <section><div className="family-dashboard-hero"><span className="family-eyebrow">{profile.nickname}的成长档案 · 个人记录</span><h1>记录照片与变化</h1><p>按计划记录，回看照片与读数。</p><button className="family-primary" onClick={onRecord}><Camera size={20}/>开始本次记录<ArrowRight size={18}/></button></div>
    <div className="family-next-record"><CalendarDays size={25}/><div><span>下一次记录</span><strong>{plan.enabled?`${plan.nextDate} ${plan.time}`:'计划已暂停'}</strong></div><button onClick={onPlan}>调整计划<ChevronRight size={16}/></button></div>
    <div className="family-section-heading"><div><h2>成长记录</h2><p>{sessions.length?`已经留下${sessions.length}次记录。`:'第一次记录，从这里开始。'}</p></div><button onClick={onTimeline}>查看时间线<ArrowRight size={17}/></button></div>
    {latest?<div className="family-recent-grid">{sessions.slice(0,3).map(s=><button key={s.id} className="family-recent-item" onClick={()=>onOpen(s.id)}><SessionThumb session={s} view={s.captures.some(c=>c.id==='front')?'front':'profile'}/><strong>{s.recordedOn}</strong><span>{sessionPurpose(s)} · {s.captures.length}张</span></button>)}</div>:<div className="family-empty family-empty-inline"><FolderHeart size={42}/><div><h3>留下一次真实的记录</h3><p>按正面、左侧、右侧依次记录。照片和测量会一起保存在本机。</p></div></div>}
    <TrendPreview profile={profile} sessions={sessions} onOpen={onSummary}/>
    <HeightJournal events={snapshot.events} profileId={profile.id} onRefresh={onRefresh}/><EventJournal key={profile.id} profile={profile} events={snapshot.events.filter(e=>e.profileId===profile.id)} onRefresh={onRefresh}/>
  </section>
}

function SessionDetail({session,versions,onOpen,onRevise,profile,events,onBack,onRecord,onPrivacy,onRefresh,onDeleted}:{session:FamilySession;versions:FamilySession[];onOpen:(id:string)=>void;onRevise:(operation:RevisionOperation)=>void;profile:FamilyProfile;events:FamilyEvent[];onBack:()=>void;onRecord:()=>void;onPrivacy:()=>void;onRefresh:()=>Promise<void>;onDeleted:()=>void}) {
  const restored=useSessionCaptures(session),[deleting,setDeleting]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const editBaseline=useRef(session)
  const [editing,setEditing]=useState(false),[editDate,setEditDate]=useState(session.recordedOn),[editNote,setEditNote]=useState(session.note)
  const releaseMetadata=useDraftGuard(editing&&(editDate!==editBaseline.current.recordedOn||editNote!==editBaseline.current.note))
  return <section><button className="family-back" onClick={onBack}><ArrowLeft size={17}/>返回时间线</button><div className="family-page-heading"><div><span className="family-eyebrow">{profile.nickname} · {sessionPurpose(session)}</span><h1>{session.recordedOn}的记录</h1><p>按保存时的算法与结果展示，未用新版本悄悄重算。</p></div><button onClick={()=>setDeleting(true)}><Trash2 size={17}/>删除这次记录</button></div>
    <div className="family-revision-bar"><label>查看保存版本<select value={session.id} disabled={busy} onChange={e=>onOpen(e.target.value)}>{versions.map(v=><option key={v.id} value={v.id}>V{(v.revision?.number??0)+1} · {v.revision?v.revision.operation==='reanalyze'?'重新检测':'补充视角':'初次保存'} · {new Date(v.createdAt).toLocaleString()}</option>)}</select></label>{versions.at(-1)?.id===session.id?<div className="family-actions"><button disabled={busy||restored.loading||Boolean(restored.error)} onClick={()=>onRevise('reanalyze')}><RefreshCcw size={17}/>重新检测原照片</button>{!(session.recordedBy==='user'?['front','profile','right_profile']:['front','profile']).every(id=>session.captures.some(c=>c.id===id))&&<button disabled={busy||restored.loading||Boolean(restored.error)} onClick={()=>onRevise('supplement')}><Plus size={17}/>补齐缺失视角</button>}</div>:<button onClick={()=>onOpen(versions.at(-1)!.id)}>返回最新版本</button>}</div>
    {deleting&&<div className="family-confirm" role="alertdialog" aria-label="确认删除本次记录"><h2>删除{session.recordedOn}的记录？</h2><p>会删除这次记录的全部{versions.length}个版本、照片和读数，其他日期与个人备注不受影响。</p><div className="family-actions"><button disabled={busy} onClick={async()=>{setBusy(true);try{await familyStore.deleteSession(session.id);onDeleted()}catch(e){setError(storageMessage(e));setBusy(false)}}}>确认删除本次记录</button><button disabled={busy} onClick={()=>setDeleting(false)}>取消</button></div></div>}
    {(restored.error||error)&&<p role="alert" className="family-error">{restored.error||error}</p>}{session.note&&<blockquote className="family-quote">{session.note}</blockquote>}
    {!editing?<button className="family-back" onClick={()=>{editBaseline.current=session;setEditDate(session.recordedOn);setEditNote(session.note);setEditing(true)}}>更正拍摄日期与备注</button>:<form className="family-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await familyStore.updateSessionMetadata(session.id,profile.id,editDate,editNote,editBaseline.current);releaseMetadata();await onRefresh();setEditing(false)}catch(err){setError(storageMessage(err))}finally{setBusy(false)}}}><h2>更正记录信息</h2><p>同步更正这次记录所有版本的日期与备注，不重新计算或覆盖原读数。保留最近20次更正记录。</p><label>实际拍摄日期<input type="date" required max={localDate()} value={editDate} onInput={e=>setEditDate(e.currentTarget.value)} onChange={e=>setEditDate(e.target.value)}/></label><label>这次记录的备注<textarea rows={3} maxLength={1000} value={editNote} onChange={e=>setEditNote(e.target.value)}/></label><div className="family-actions"><button className="family-primary" disabled={busy}>保存更正</button><button type="button" disabled={busy} onClick={()=>setEditing(false)}>取消</button></div></form>}
    {restored.loading?<p role="status">正在恢复照片…</p>:session.kind==='memory'?<div className="family-photo-pair">{restored.captures.map(c=><figure key={c.id}>{c.url?<img src={c.originalUrl??c.url} alt={c.label}/>:<p>照片暂不可用</p>}<figcaption>{c.label} · {sessionPurpose(session)}</figcaption></figure>)}</div>:<PersonalReport captures={restored.captures} session={session} onRetake={onRecord} onPrivacy={onPrivacy}/>}
    <details className="family-protocol"><summary>本次拍摄信息与版本</summary><p>设备：{session.protocol.device||'未记录'}；镜头：{session.protocol.camera==='rear'?'后置':session.protocol.camera==='front'?'前置':'未记录'}；距离：{session.protocol.distanceCm===null?'未记录':`${session.protocol.distanceCm}厘米`}。</p><p>拍摄方法：{session.protocol.locationNote||'未补充'}。</p><p>{session.version.algorithm} · {session.version.norm} · {session.version.copy}</p></details>
    {Boolean(session.metadataHistory?.length)&&<details className="family-protocol"><summary>信息更正记录</summary>{session.metadataHistory!.map((h,i)=><p key={i}>{new Date(h.at).toLocaleString()}：原拍摄日期 {h.recordedOn}；原备注 {h.note||'未填写'}。原测量结果未变。</p>)}</details>}
    <EventJournal key={profile.id} profile={profile} events={events} onRefresh={onRefresh}/>
  </section>
}

