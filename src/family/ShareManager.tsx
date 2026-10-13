import {createShareListRead} from './shareListRead'
import {createShareActionGate,type ShareAction} from './shareActionGate'
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {getWorkspace,subscribeWorkspace,cloudErrorMessage} from './cloudRuntime'
import {SyncError} from './cloudTransport'
import {handoffSecret} from './handoff'
import {canonicalJson} from './cloudContract'
import {SHARE_PROTOCOL,buildShareContent,validateShareScope,type ShareScope,type ShareFields,type ShareContent,type ShareAsset} from './shareContract'
import {readShareIntents,saveShareIntent,clearShareIntent,readShareToken,saveShareToken,shareLink,validateShareInfo,validateShareContent,type ShareInfo,type ShareIntent} from './shareClient'
import {SharedDocument} from './SharedDocument'
import {ShareSelection} from './ShareSelection'
import {toggleShareSelection} from './shareChoiceState'
import {sortedSessions,type FamilyProfile,type FamilySession,type FamilyEvent} from './model'
import {validateStageRange} from './stageScope'
type Preview={stamp:string;version:number;sourceStamp:string;content:ShareContent;assets:ShareAsset[];recipient:{username:string;displayName:string}}
const fieldLabels:Record<keyof ShareFields,string>={photos:'所选记录的照片',readings:'保存的读数、误差与检测提示',notes:'所选记录备注和家庭事件文字',sources:'所选事件的资料来源与记录者说明',nickname:'档案昵称'}
export function ShareManager({profile,sessions,events,onAccount,onBack,allowLocal=false}:{profile:FamilyProfile;sessions:FamilySession[];events:FamilyEvent[];onAccount:()=>void;onBack:()=>void;allowLocal?:boolean}){
  const ws=useSyncExternalStore(subscribeWorkspace,getWorkspace,()=>null),[fields,setFields]=useState<ShareFields>({photos:false,readings:true,notes:false,sources:false,nickname:false}),[range,setRange]=useState({from:'',to:''}),[selected,setSelected]=useState<string[]>([]),[selectedEvents,setSelectedEvents]=useState<string[]>([]),[photoMode,setPhotoMode]=useState<ShareScope['photoMode']>('original'),[recipient,setRecipient]=useState(''),[ttl,setTtl]=useState(24),[preview,setPreview]=useState<Preview|null>(null),[confirmed,setConfirmed]=useState(false),[intents,setIntents]=useState<ShareIntent[]>([]),[shares,setShares]=useState<ShareInfo[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const [loadedPhotos,setLoadedPhotos]=useState<string[]>([])
  const photoReady=useCallback((ref:string)=>setLoadedPhotos(rows=>rows.includes(ref)?rows:[...rows,ref]),[])
  const listRead=useRef(createShareListRead<ShareInfo[]>()),epoch=useRef(0),actionGate=useRef(createShareActionGate()),busyNow=useRef(false)
  const rows=sortedSessions(sessions,profile.id),within=(date:string)=>(!range.from||date>=range.from)&&(!range.to||date<=range.to),shownRows=rows.filter(s=>within(s.recordedOn)),shownEvents=events.filter(e=>e.profileId===profile.id&&within(e.date)).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)),scope:ShareScope={...range,fields,photoMode,sessionIds:fields.photos||fields.readings||fields.notes?selected.filter(id=>shownRows.some(s=>s.id===id)):[],eventIds:fields.notes||fields.sources?selectedEvents.filter(id=>shownEvents.some(e=>e.id===id)):[]}
  const stamp=JSON.stringify([scope,recipient.trim().toLowerCase(),ttl,profile,rows.map(s=>[s.id,s.updatedAt,s.recordedOn,s.note]),events]),currentStamp=useRef(stamp);currentStamp.current=stamp
  const valid=()=>Boolean(ws&&getWorkspace()?.engine===ws.engine&&!getWorkspace()?.locked&&getWorkspace()?.family.role!=='child'),shown=preview?.stamp===stamp?preview:null
  let addressError='';try{shareLink(location.href,'a'.repeat(43),allowLocal)}catch(e){addressError=(e as Error).message}
  useEffect(()=>{epoch.current++;actionGate.current.invalidate();busyNow.current=false;listRead.current.invalidate();setPreview(null);setConfirmed(false);setShares([]);setMessage('');setBusy(false);setIntents(ws?readShareIntents(ws.base,ws.user.id,profile.id):[]);return()=>{epoch.current++;actionGate.current.invalidate();listRead.current.invalidate()}},[ws?.engine,ws?.locked,ws?.family.role,profile.id])
  useEffect(()=>{
    const refresh=()=>{if(ws&&valid())setIntents(readShareIntents(ws.base,ws.user.id,profile.id))}
    window.addEventListener('storage',refresh);window.addEventListener('focus',refresh)
    return()=>{window.removeEventListener('storage',refresh);window.removeEventListener('focus',refresh)}
  },[ws?.engine,profile.id])
  useEffect(()=>{setConfirmed(false)},[stamp])
  const loadList=async(action?:ShareAction)=>{
    if(!ws||!valid())return
    const n=epoch.current,check=()=>{action?.check();if(n!==epoch.current||!valid())throw new DOMException('分享页面已变化','AbortError')}
    await listRead.current.run(async()=>{
      check();await ws.transport.authenticate(action?.signal);check()
      const response=await ws.transport.request(`/profiles/${profile.id}/shares`,'GET',undefined,{},action?.signal);check()
      if(!Array.isArray(response.shares)||response.shares.length>200)throw new Error('分享列表无法核验')
      const list=response.shares.map(validateShareInfo);if(list.some((s:ShareInfo)=>s.profileId!==profile.id))throw new Error('分享列表不属于当前档案')
      return list
    },list=>{check();setShares(list);const pending=readShareIntents(ws.base,ws.user.id,profile.id);setIntents(pending);if(pending.some(item=>list.some(s=>s.id===item.id)))setMessage('服务器已有相同编号的分享；请重试原请求核验对象、范围和创建结果。')})
  }
  useEffect(()=>{if(!ws||ws.locked||ws.family.role==='child')return;let active=true;const refresh=async()=>{if(busyNow.current)return;try{await loadList()}catch(e){if(active&&valid())setMessage(cloudErrorMessage(e))}};void refresh();const timer=setInterval(()=>void refresh(),15000);return()=>{active=false;clearInterval(timer)}},[ws?.engine,ws?.locked,ws?.family.role,profile.id])
  const act=(fn:(action:ShareAction)=>Promise<void>)=>actionGate.current.run(valid,async action=>{listRead.current.invalidate();setMessage('');await fn(action)},e=>setMessage(cloudErrorMessage(e)),value=>{busyNow.current=value;setBusy(value)})
  const prepare=()=>act(async action=>{
    if(!ws)throw new Error('请先进入家庭工作区')
    const error=validateStageRange(range);if(error)throw new Error(error)
    const checked=validateShareScope(scope),at=currentStamp.current
    setPreview(null);setLoadedPhotos([]);setConfirmed(false)
    await action.step(()=>ws.engine.run())
    const state=await action.step(()=>ws.store.syncState(profile.id))
    if(!state.link||state.link.status!=='synced'||state.link.baseStamp!==state.stamp||!state.link.baseSnapshot)throw new Error('请先完成此档案同步，再预览分享')
    await action.step(signal=>ws.transport.authenticate(signal))
    const config=await action.step(signal=>ws.transport.request('/config','GET',undefined,{},signal))
    if(config.shareProtocol!==SHARE_PROTOCOL)throw new Error('请更新家庭服务以支持限时分享')
    const response=await action.step(signal=>ws.transport.request('/shares/preview','POST',{profileId:profile.id,version:state.link!.version,scope:checked,recipient:recipient.trim().toLowerCase()},{},signal)),content=validateShareContent(response.content),local=buildShareContent(state.link.baseSnapshot,checked)
    if(canonicalJson(content)!==canonicalJson(local.content)||response.version!==state.link.version||typeof response.recipient?.displayName!=='string'||response.recipient.username!==recipient.trim().toLowerCase())throw new Error('预览或接收对象已变化，请重新核对')
    if(currentStamp.current===at)setPreview({stamp:at,version:state.link.version,sourceStamp:state.stamp,content,assets:local.assets,recipient:response.recipient})
  })
  const create=(retry?:ShareIntent)=>act(async action=>{
    if(!ws)throw new Error('工作区已变化')
    const pending=readShareIntents(ws.base,ws.user.id,profile.id)
    if(retry&&!pending.some(item=>canonicalJson(item)===canonicalJson(retry))){setIntents(pending);throw new Error('这份待核验请求已在其他页面处理，请刷新分享状态')}
    if(!retry&&pending.length){setIntents(pending);throw new Error('其他页面还有待核验分享，请先逐份核对原请求')}
    let next=retry
    if(!next){
      if(!shown||!confirmed)throw new Error('请先核对预览和接收对象')
      const at=currentStamp.current,state=await action.step(()=>ws.store.syncState(profile.id))
      if(currentStamp.current!==at||state.stamp!==shown.sourceStamp||state.link?.version!==shown.version||state.link.status!=='synced')throw new Error('原记录或同步状态已变化，请重新预览')
      next={id:crypto.randomUUID(),token:handoffSecret(),profileId:profile.id,version:shown.version,recipient:shown.recipient.username,ttlHours:ttl,scope:validateShareScope(scope),consentVersion:SHARE_PROTOCOL}
      saveShareToken(ws.base,ws.user.id,profile.id,next.id,next.token);saveShareIntent(ws.base,ws.user.id,profile.id,next);setIntents(readShareIntents(ws.base,ws.user.id,profile.id))
    }
    await action.step(signal=>ws.transport.authenticate(signal))
    try{
      const created=validateShareInfo(await action.step(signal=>ws.transport.request('/shares','POST',next,{},signal)))
      if(created.id!==next.id||created.profileId!==profile.id||created.recipient.username!==next.recipient||canonicalJson(created.scope)!==canonicalJson(next.scope)||created.expiresAt-created.createdAt!==next.ttlHours*3600000)throw new Error('创建结果与确认范围不一致，请重试原请求核验')
      let receiptSaved=true
      try{clearShareIntent(ws.base,ws.user.id,profile.id,next)}catch{receiptSaved=false}
      setIntents(readShareIntents(ws.base,ws.user.id,profile.id));setPreview(null);setConfirmed(false);setSelected([]);setSelectedEvents([])
      setShares(rows=>[created,...rows.filter(row=>row.id!==created.id)])
      const receiptNotice=receiptSaved?'':'本机未能保存核验状态，待核验项仍保留；稍后重试原分享不会重复创建。'
      try{await loadList(action);action.check();setMessage('已确认分享结果，请核对下方对象与状态后复制链接。本应用不会代发；已有分享不会因重试延长有效期。'+receiptNotice)}
      catch(e){if(!action.current())throw e;setMessage('服务器已确认创建，下方保留这份分享；其他分享列表暂未刷新。可刷新状态核对，无需重复创建。'+receiptNotice)}
    }catch(e){
      if(action.current()&&e instanceof SyncError&&[400,403,404,409].includes(e.status)){clearShareIntent(ws.base,ws.user.id,profile.id,next);setIntents(readShareIntents(ws.base,ws.user.id,profile.id));setPreview(null);setConfirmed(false)}
      throw e
    }
  })
  const revoke=(share:ShareInfo)=>act(async action=>{
    if(!ws)throw new Error('工作区已变化')
    await action.step(signal=>ws.transport.authenticate(signal))
    const revoked=validateShareInfo(await action.step(signal=>ws.transport.request('/shares/'+share.id,'DELETE',undefined,{},signal)))
    if(revoked.id!==share.id||revoked.profileId!==profile.id||revoked.state!=='revoked')throw new Error('撤回结果未能核验，请重新读取状态')
    setShares(rows=>rows.map(row=>row.id===revoked.id?revoked:row))
    try{await loadList(action);action.check();setMessage('已撤回在线分享；原家庭资料保留，已下载副本无法收回。')}
    catch(e){if(!action.current())throw e;setMessage('服务器已确认撤回，此分享已停用；其他分享列表暂未刷新，请稍后再试。')}
  })
  const copy=(link:string)=>act(async action=>{
    try{await action.step(()=>navigator.clipboard.writeText(link));setMessage('已复制，请只交给上述接收账号。')}
    catch(e){if(!action.current())throw e;setMessage('未能自动复制，请选中上方链接手动复制，并只交给指定账号。')}
  })
  const loadPhoto=useCallback(async(ref:string,signal:AbortSignal)=>{if(!ws||!preview)throw new Error('请重新预览');const asset=preview.assets.find(a=>a.ref===ref);if(!asset)throw new Error('照片不在预览范围');return await ws.transport.request(`/profiles/${profile.id}/media?key=${encodeURIComponent(asset.key)}`,'GET',undefined,{Accept:'application/octet-stream'},signal) as Blob},[ws?.transport,preview,profile.id])
  const photoError=useCallback((e:Error)=>{setPreview(null);setConfirmed(false);setMessage('预览照片未能读取：'+e.message)},[])
  const changeRange=(next:typeof range)=>{setRange(next);setSelected([]);setSelectedEvents([]);setPreview(null)}
  return <section className="family-share-manager"><button className="family-back" onClick={()=>{actionGate.current.invalidate();listRead.current.invalidate();epoch.current++;onBack()}}>返回家庭与数据</button><h1>只分享你们选择的资料</h1><p>当前来源档案：{profile.nickname}。昵称仅在明确勾选时共享。</p><p>接收方需有本站账号，但无需加入家庭。分享是创建时的快照，不会自动包含后续记录；已下载或截图的副本无法收回。</p>{!ws?<><p>先登录并明确开启该档案的家庭同步。</p><button onClick={onAccount}>管理家庭账号与同步</button></>:ws.locked?<p role="alert">{ws.locked}</p>:ws.family.role==='child'?<p>请由有权访问该档案的家长创建限时分享。</p>:<>{addressError&&<p className="family-notice">{addressError}</p>}{allowLocal&&<p className="family-muted">当前链接只供本机隔离验收，不代表真实HTTPS外部分享。</p>}{intents.length?<section className="family-pending-shares"><h2>待核验的分享（{intents.length}份）</h2><p>各页面的请求分别保留。请逐份核对对象与范围；重试使用原编号，已有分享不会延长有效期。</p>{intents.map((item,index)=><div key={item.id} className="family-notice"><div><h3>待核验分享 {index+1}</h3><p>接收账号：{item.recipient}；{item.scope.sessionIds.length}次记录、{item.scope.eventIds.length}条事件；有效期{item.ttlHours}小时。</p><p>范围：{item.scope.from||'最早所选记录'} — {item.scope.to||'最后所选记录'}；{(Object.keys(fieldLabels) as Array<keyof ShareFields>).filter(k=>item.scope.fields[k]).map(k=>fieldLabels[k]).join('、')}。</p>{item.scope.fields.photos&&<p>照片版本：{{original:'原图（没有独立原图时使用保存照片）',analysis:'分析用图',both:'原图和分析用图'}[item.scope.photoMode]}</p>}<button disabled={busy||Boolean(addressError)} onClick={()=>void create(item)}>核对并重试这份分享</button></div></div>)}</section>:<fieldset disabled={busy} className="family-share-form"><legend>选择范围与接收方</legend><div className="family-form-grid"><label>开始日期<input type="date" value={range.from} onInput={e=>changeRange({...range,from:e.currentTarget.value})} onChange={e=>changeRange({...range,from:e.target.value})}/></label><label>结束日期<input type="date" value={range.to} onInput={e=>changeRange({...range,to:e.currentTarget.value})} onChange={e=>changeRange({...range,to:e.target.value})}/></label><label>接收账号登录名<input value={recipient} maxLength={64} onChange={e=>setRecipient(e.target.value)} autoComplete="off"/></label><label>有效期<select value={ttl} onChange={e=>setTtl(Number(e.target.value))}><option value={1}>1小时</option><option value={24}>24小时</option><option value={168}>7天</option></select></label></div>{(Object.keys(fieldLabels) as Array<keyof ShareFields>).map(key=><label key={key} className="family-inline-check"><input type="checkbox" checked={fields[key]} onChange={e=>setFields(f=>({...f,[key]:e.target.checked}))}/>{fieldLabels[key]}</label>)}{fields.photos&&<label>照片版本<select value={photoMode} onChange={e=>setPhotoMode(e.target.value as ShareScope['photoMode'])}><option value="original">原图（没有独立原图时使用保存照片）</option><option value="analysis">分析用图</option><option value="both">原图和分析用图</option></select></label>}<ShareSelection key={'records/'+range.from+'/'+range.to} title="照片记录" items={shownRows.map(s=>({id:s.id,label:s.recordedOn+' · '+(s.kind==='memory'?'生活留念':'照片观察')}))} selected={scope.sessionIds} disabled={!fields.photos&&!fields.readings&&!fields.notes} onToggle={(id,checked)=>setSelected(ids=>toggleShareSelection(ids,id,checked,shownRows))} onClear={()=>setSelected([])}/>{(fields.notes||fields.sources)&&<ShareSelection key={'events/'+range.from+'/'+range.to} title="家庭事件" items={shownEvents.map(e=>({id:e.id,label:e.date+' · '+e.text.slice(0,80)}))} selected={scope.eventIds} onToggle={(id,checked)=>setSelectedEvents(ids=>toggleShareSelection(ids,id,checked,shownEvents))} onClear={()=>setSelectedEvents([])}/>}<button onClick={()=>void prepare()}>核对接收对象并生成预览</button></fieldset>}
    {shown&&!intents.length&&<section className="family-share-preview"><h2>创建前最后核对</h2><p>来源档案：{profile.nickname}。</p><p>接收方：{shown.recipient.displayName}（{shown.recipient.username}）；有效期{ttl}小时。</p><SharedDocument content={shown.content} loadPhoto={loadPhoto} onFailure={photoError} onPhotoReady={photoReady}/><p>照片预览进度：{loadedPhotos.length}/{shown.assets.length}张已查看。{!shown.assets.length?'本次未选照片，请核对文字内容与分享范围。':loadedPhotos.length===shown.assets.length?'所选照片预览已完成。':'请切换记录与照片组，完成全部所选照片的预览后确认分享。'}</p><label className="family-inline-check"><input type="checkbox" checked={confirmed} disabled={busy||loadedPhotos.length!==shown.assets.length} onChange={e=>setConfirmed(e.target.checked)}/>已与孩子确认，允许此账号在有效期内查看上述范围；不会授予其他档案权限。</label><button className="family-primary" disabled={busy||!confirmed||loadedPhotos.length!==shown.assets.length||Boolean(addressError)} onClick={()=>void create()}>创建这份限时分享</button></section>}
    <div className="family-section-heading"><h2>分享对象与状态</h2><button disabled={busy} onClick={()=>void act(loadList)}>刷新分享状态</button></div>{!shares.length&&<p>尚无可管理的分享。</p>}<ul className="family-share-list">{shares.map(s=>{const token=readShareToken(ws.base,ws.user.id,profile.id,s.id),link=token&&!addressError&&s.state==='active'?shareLink(location.href,token,allowLocal):'';return <li key={s.id}><h3>{s.recipient.displayName}（{s.recipient.username}）</h3><p>{{active:'有效',revoked:'已撤回',expired:'已过期'}[s.state]} · 至{new Date(s.expiresAt).toLocaleString()}</p><p>{s.scope.sessionIds.length}次记录、{s.scope.eventIds.length}条事件；{(Object.keys(fieldLabels) as Array<keyof ShareFields>).filter(k=>s.scope.fields[k]).map(k=>fieldLabels[k]).join('、')}</p>{link?<label>指定账号的分享链接<input readOnly value={link} onFocus={e=>e.currentTarget.select()}/></label>:s.state==='active'&&<p>此设备没有可复制的原链接；可撤回后重新创建。</p>}<div className="family-actions">{link&&<button disabled={busy} onClick={()=>void copy(link)}>复制分享链接</button>}{s.state==='active'&&<button disabled={busy} onClick={()=>void revoke(s)}>撤回此分享</button>}</div></li>})}</ul></>}{busy&&<p role="status">正在核对服务端状态…</p>}{message&&<p className="family-notice" role="status">{message}</p>}</section>
}
