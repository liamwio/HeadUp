import {photoRecordRows} from './automaticTrend'
import {sessionPurpose} from './model'
import {sideCapture} from './captureViews'
import {eventSourceText,eventQuestionText,eventAuthorText} from './eventDetails'
import { useEffect, useState, useRef, type CSSProperties } from 'react'
import { ArrowRight, Camera, Images } from 'lucide-react'
import { useMediaUrl } from './hooks'
import {getActiveFamilyStore} from './store'
import {comparisonViewLabel} from './comparisonLabels'
import {readTimelinePreferences,saveTimelinePreferences,timelineEntries,timelinePeriodLabel,type TimelineView,type TimelinePreferences} from './timelineQuery'
import { sortedSessions, type FamilyProfile, type FamilySession,type FamilyEvent } from './model'

export function SessionThumb({session,view='front',original=false}:{session:FamilySession;view?:'front'|'profile'|'right_profile';original?:boolean}) {
  const capture=view==='right_profile'?session.captures.find(c=>c.id==='right_profile')??sideCapture(session,'right_profile'):session.captures.find(c=>c.id===view),url=useMediaUrl(capture?.mediaId,original)
  return <figure className="family-thumb">{url?<img src={url} alt={`${session.recordedOn} ${view==='front'?'正面':view==='right_profile'?'右侧':comparisonViewLabel(session,'profile')}`} loading="lazy"/>:<div className="family-photo-empty"><Camera size={26}/><span>{capture?'照片加载中或暂不可读':'未添加此视角'}</span></div>}<figcaption>{view==='front'?'正面':view==='right_profile'?'右侧':comparisonViewLabel(session,'profile')}</figcaption></figure>
}

const eventLabels={memory:'成长小事',device:'设备或拍摄方法',question:'想讨论的问题',followup:'用户记录的专业随访'}
export function Timeline({sessions,events=[],profile,onOpen,onTrend,onRecord,onEvents}:{sessions:FamilySession[];events?:FamilyEvent[];profile:FamilyProfile;onOpen:(id:string)=>void;onTrend:()=>void;onRecord:()=>void;onEvents:()=>void}) {
  const preferenceKey='headup-timeline:'+getActiveFamilyStore().name+':'+profile.id
  const [initial]=useState(()=>readTimelinePreferences(preferenceKey))
  const [filter,setFilter]=useState<TimelinePreferences['filter']>(initial.filter),[viewFilter,setViewFilter]=useState<TimelineView>(initial.view),[month,setMonth]=useState(initial.month),[limit,setLimit]=useState(12)
  const [period,setPeriod]=useState(initial.period?.startsWith('year:')?initial.period:''),[showEvents,setShowEvents]=useState(initial.showEvents!==false),[focusId,setFocusId]=useState(initial.focusId??'')
  const page=useRef<HTMLElement>(null),[navHeight,setNavHeight]=useState(76)
  useEffect(()=>{const nav=page.current?.closest('.family-app')?.querySelector('.family-bottom-nav');if(!nav)return;const measure=()=>setNavHeight(nav.getBoundingClientRect().height);measure();const observer=new ResizeObserver(measure);observer.observe(nav);return()=>observer.disconnect()},[])
  useEffect(()=>saveTimelinePreferences(preferenceKey,{filter,view:viewFilter,month,selection:[],period,showEvents,focusId}),[preferenceKey,filter,viewFilter,month,period,showEvents,focusId])
  const allRows=sortedSessions(sessions,profile.id),photoCount=photoRecordRows(sessions,profile.id).length
  const entries=timelineEntries(sessions,events,profile.id,{filter,view:viewFilter,month,selection:[],period,showEvents}),rows=entries.flatMap(e=>e.kind==='session'?[e.session]:[])
  const focused=rows.find(s=>s.id===focusId)??rows[0]
  const dates=[...allRows.map(s=>s.recordedOn),...events.filter(e=>e.profileId===profile.id).map(e=>e.date)]
  const years=[...new Set(dates.map(d=>d.slice(0,4)))].sort().reverse(),months=[...new Set(dates.map(d=>d.slice(0,7)))].sort().reverse()
  useEffect(()=>setLimit(12),[filter,month,viewFilter,period,showEvents])
  const preview=(id:string)=>{setFocusId(id);if(!window.matchMedia('(min-width:1100px)').matches)onOpen(id)}
  const resetRange=()=>{setMonth('');setPeriod('')}
  const activeRange=month?month+'月':period?timelinePeriodLabel(period):'全部时间'
  return <section ref={page} className="family-timeline-page" style={{'--timeline-nav-height':`${navHeight}px`} as CSSProperties}><div className="family-page-heading"><div><span className="family-eyebrow">{profile.nickname}的时间线</span><h1>成长时间线</h1><p>按日期回看照片与记录。</p></div><button className="family-primary" onClick={onRecord}><Camera size={18}/>记录今天</button></div>
    <nav className="family-timeline-periods" aria-label="按年份或月份回看"><label>年份<select value={period} onChange={e=>{setPeriod(e.target.value);setMonth('')}}><option value="">全部时间</option><optgroup label="按年">{years.map(y=><option key={y} value={'year:'+y}>{y}年全年</option>)}</optgroup>{period&&!years.some(y=>period==='year:'+y)&&<option value={period}>{timelinePeriodLabel(period)}（暂无记录）</option>}</select></label><label>精确到月份<input type="month" value={month} onInput={e=>{setMonth(e.currentTarget.value);setPeriod('')}} onChange={e=>{setMonth(e.target.value);setPeriod('')}}/></label>{(month||period)&&<button onClick={resetRange}>全部时间</button>}<details><summary>已有月份</summary><div className="family-month-jumps">{months.map(m=><button key={m} aria-pressed={month===m} onClick={()=>{setMonth(m);setPeriod('')}}>{m}</button>)}</div></details></nav>
    <div className="family-toolbar"><label>记录类型<select value={filter} onChange={e=>setFilter(e.target.value as TimelinePreferences['filter'])}><option value="all">全部记录</option><option value="measurement">面部生长记录</option><option value="memory">其他</option></select></label><label>照片视角<select value={viewFilter} onChange={e=>setViewFilter(e.target.value as TimelineView)}><option value="all">所有视角</option><option value="front">包含正面</option><option value="left_profile">包含左侧面</option><option value="right_profile">包含右侧面</option><option value="unknown_profile">侧面方向未确认</option></select></label><label className="family-inline-check"><input type="checkbox" checked={showEvents} onChange={e=>setShowEvents(e.target.checked)}/>同时显示个人事件</label><button onClick={onEvents}>记录或管理个人事件</button></div>
    <p className="family-muted" role="status">{activeRange} · {rows.length}次照片记录 · {entries.length-rows.length}条个人事件。</p>
    <div className="family-baseline"><div><strong>趋势报告自动整理</strong><p>{photoCount>=3?`已保存${photoCount}次照片记录，报告随记录自动更新。`:`已保存${photoCount}/3次照片记录，完成3次后自动生成。`}</p></div><button onClick={onTrend}>查看趋势报告</button></div>
    <div className="family-timeline-layout"><div>
      {!entries.length?<div className="family-empty"><Images size={40}/><h2>{dates.length?'这个筛选下还没有记录':'成长记录，从今天开始'}</h2><p>不用每天拍。也可以留下一句话。</p>{dates.length&&<button onClick={()=>{resetRange();setFilter('all');setViewFilter('all');setShowEvents(true)}}>清除筛选</button>}<button onClick={onRecord}>开始一次记录<ArrowRight size={17}/></button></div>:<div className="family-timeline">{entries.slice(0,limit).map((entry,index)=><article key={entry.id} className={'family-timeline-row '+(entry.kind==='event'?'family-timeline-event':'')}>{(index===0||entries[index-1].date.slice(0,7)!==entry.date.slice(0,7))&&<h2 className="family-timeline-month">{entry.date.slice(0,7).replace('-','年')}月</h2>}{entry.kind==='event'?<><div className="family-session-date"><time dateTime={entry.date}>{entry.date}</time><strong>{entry.event.height?'身高记录':entry.event.type==='question'?eventQuestionText(entry.event):eventLabels[entry.event.type]}</strong></div><p className="family-event-copy">{entry.event.text}</p><small>{eventSourceText(entry.event)} · {eventAuthorText(entry.event)}</small>{entry.event.discussedOn&&<details><summary>上次讨论 · {entry.event.discussedOn}</summary><p className="family-event-copy">{entry.event.discussionNote||'未补充讨论记录。'}</p></details>}<small>不作为测量结论或照片变化的原因。</small></>:<><div className="family-session-date"><time dateTime={entry.date}><strong>{entry.date}</strong></time><span>{sessionPurpose(entry.session)}</span></div><button className="family-session-photos" onClick={()=>preview(entry.session.id)} aria-label={`查看${entry.date}的记录`} aria-pressed={focused?.id===entry.session.id}><SessionThumb session={entry.session}/><SessionThumb session={entry.session} view="profile"/>{entry.session.captures.some(c=>c.id==='right_profile')&&<SessionThumb session={entry.session} view="right_profile"/>}</button>{entry.session.note&&<p className="family-session-note">“{entry.session.note}”</p>}<div className="family-session-footer"><span>{entry.session.protocol.device||'设备未记录'} · {entry.session.captures.length}张视角照片</span><button onClick={()=>onOpen(entry.session.id)}>查看完整记录<ArrowRight size={16}/></button></div></>}</article>)}</div>}
      {entries.length>limit&&<button onClick={()=>setLimit(v=>v+12)}>加载更早记录与事件</button>}
    </div><aside className="family-timeline-inspector" aria-label="当前照片记录详情">{focused?<><span className="family-eyebrow">选中记录</span><h2>{focused.recordedOn}</h2><p>{sessionPurpose(focused)} · {comparisonViewLabel(focused,'profile')}</p><div className="family-inspector-photos"><SessionThumb session={focused} original/><SessionThumb session={focused} view="profile" original/></div><p className="family-event-copy">{focused.note||'这次没有填写备注。'}</p><dl><dt>设备</dt><dd>{focused.protocol.device||'未记录'}</dd><dt>拍摄方式</dt><dd>{focused.protocol.method==='live'?'应用内拍摄':'相册导入'}</dd><dt>记录版本</dt><dd>V{(focused.revision?.number??0)+1} · 历史结果保留</dd></dl><button onClick={()=>onOpen(focused.id)}>打开完整记录与依据<ArrowRight size={16}/></button><small>这里只回看已保存内容，不重新检测照片。</small></>:<p>当前筛选下没有照片记录。个人事件可在左侧回看。</p>}</aside></div>

  </section>
}
