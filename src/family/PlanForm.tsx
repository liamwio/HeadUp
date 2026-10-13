import {useState,useRef,useEffect} from 'react'
import {CalendarDays} from 'lucide-react'
import {useDraftGuard} from './DraftGuard'
import {validatePlan,type RecordPlan,type FamilySession} from './model'
import {planCalendar} from './reminders'
import {withPlanInterval} from './personalPlan'

const presets=[7,14,30]
export function PlanForm({initial,onSave,exists=false,sessions=[],canEdit=true}:{initial:RecordPlan;exists?:boolean;sessions?:FamilySession[];onOpen?:(id:string)=>void;canEdit?:boolean;cloudFamilyName?:string;onSave:(plan:RecordPlan,expected:RecordPlan|null)=>Promise<void>}){
  const baseline=useRef<RecordPlan|null>(exists?initial:null),savedPlan=useRef(initial)
  const [plan,setPlan]=useState(initial),[customCycle,setCustomCycle]=useState(!presets.includes(initial.intervalDays)),[customTime,setCustomTime]=useState(initial.time!=='18:00'),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const releaseDraft=useDraftGuard(JSON.stringify(plan)!==JSON.stringify(savedPlan.current))
  useEffect(()=>{if(JSON.stringify(plan)===JSON.stringify(savedPlan.current)&&JSON.stringify(initial)!==JSON.stringify(savedPlan.current)){savedPlan.current=initial;baseline.current=exists?initial:null;setPlan(initial);setCustomCycle(!presets.includes(initial.intervalDays));setCustomTime(initial.time!=='18:00')}},[initial,exists,plan])
  const persist=async(draft:RecordPlan)=>{
    const next={...draft,owner:'user' as const,windowDays:1,time:customTime?draft.time:'18:00',quietStart:'00:00',quietEnd:'00:00',followupEnabled:false}
    setBusy(true);setMessage('')
    try{validatePlan(next);await onSave(next,baseline.current);baseline.current=next;savedPlan.current=next;releaseDraft();setPlan(next);setMessage(next.enabled?'已保存':'已暂停');return next}catch(error){setMessage(error instanceof Error?error.message:'保存失败');return null}finally{setBusy(false)}
  }
  const notifications=async()=>{try{if(plan.notificationEnabled){await persist({...plan,notificationEnabled:false});return}if(typeof Notification==='undefined'||!window.isSecureContext)throw new Error('当前环境不支持通知');const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('通知未获允许');await persist({...plan,notificationEnabled:true,notificationError:undefined})}catch(e){setMessage(e instanceof Error?e.message:'通知未开启')}}
  const exportCalendar=async()=>{try{const saved=await persist(plan);if(!saved)return;const url=URL.createObjectURL(new Blob([planCalendar(saved)],{type:'text/calendar;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='headup-recording-plan.ics';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);setMessage('日历已导出')}catch(e){setMessage(e instanceof Error?e.message:'导出失败')}}
  return <section className="family-simple-plan"><div className="family-page-heading"><h1>调整计划</h1><CalendarDays size={32}/></div><form className="family-form family-plan-form" onSubmit={e=>{e.preventDefault();void persist(plan)}}>
    <fieldset className="family-schedule-fields" disabled={busy||!canEdit}><legend className="sr-only">记录计划</legend>
      <label>记录周期<select value={customCycle?'custom':String(plan.intervalDays)} onChange={e=>{const custom=e.target.value==='custom';setCustomCycle(custom);if(!custom)setPlan(p=>withPlanInterval(p,Number(e.target.value),sessions))}}><option value="7">一周</option><option value="14">两周</option><option value="30">一月</option><option value="custom">自定义</option></select></label>
      {customCycle&&<label>间隔天数<input type="number" required min={1} max={365} value={plan.intervalDays||''} onChange={e=>setPlan(p=>withPlanInterval(p,Number(e.target.value),sessions))}/></label>}
      <label>下一次记录日期<input type="date" required value={plan.nextDate} onChange={e=>setPlan(p=>({...p,nextDate:e.target.value}))}/></label>
      <label className="family-inline-check"><input type="checkbox" checked={customTime} onChange={e=>{setCustomTime(e.target.checked);if(!e.target.checked)setPlan(p=>({...p,time:'18:00'}))}}/>自定义时间{!customTime?'（默认18:00）':''}</label>
      {customTime&&<label>记录时间<input type="time" required value={plan.time} onChange={e=>setPlan(p=>({...p,time:e.target.value}))}/></label>}
    </fieldset>
    {message&&<p role="status">{message}</p>}
    <div className="family-actions">{canEdit&&<button className="family-primary" disabled={busy}>{busy?'保存中…':'保存计划'}</button>}<button type="button" disabled={busy} onClick={()=>void persist({...plan,enabled:!plan.enabled})}>{plan.enabled?'暂停计划':'启用计划'}</button></div>
    <details className="family-protocol"><summary>提醒</summary><div className="family-actions"><button type="button" disabled={busy||!plan.enabled&&!plan.notificationEnabled} onClick={()=>void notifications()}>{plan.notificationEnabled?'关闭页面通知':'开启页面通知'}</button><button type="button" disabled={busy||!plan.enabled} onClick={()=>void exportCalendar()}>导出日历</button></div></details>
  </form></section>
}
