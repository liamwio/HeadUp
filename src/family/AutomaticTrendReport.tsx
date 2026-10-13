import {useMemo} from 'react'
import {ArrowRight,Camera,Info,TrendingUp} from 'lucide-react'
import {buildAutomaticTrend,type TrendSeries} from './automaticTrend'
import {PLAIN_LABELS,plainValue} from '../lib/plainResult'
import {SessionThumb} from './Timeline'
import type {FamilyProfile,FamilySession} from './model'
const colors=['#782d3e','#176b72']
function TrendChart({series}:{series:TrendSeries}){
 const w=640,h=210,pad=40,values=series.points.flatMap(p=>p.values),low=Math.min(...values),high=Math.max(...values),margin=Math.max((high-low)*.25,series.unit==='ratio'?.025:series.unit==='percent'?2:3),min=low-margin,max=high+margin
 const start=Date.parse(series.points[0].date+'T12:00:00Z'),end=Date.parse(series.points.at(-1)!.date+'T12:00:00Z'),x=(date:string)=>pad+(Date.parse(date+'T12:00:00Z')-start)/Math.max(1,end-start)*(w-pad*2),y=(v:number)=>h-pad-(v-min)/(max-min)*(h-pad*2)
 return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${series.label}，${series.points.length}个拍摄日期的${series.comparable?'可比读数曲线':'独立读数点，未连线'}`} className="auto-trend-chart"><line x1={pad} y1={h-pad} x2={w-pad} y2={h-pad} stroke="#d9cfd3"/><text x={pad} y={18}>{max.toFixed(series.unit==='ratio'?3:1)}{series.unit==='percent'?'%':series.unit==='degrees'?'°':''}</text><text x={pad} y={h-pad-6}>{min.toFixed(series.unit==='ratio'?3:1)}</text>
 {series.parts.map((part,i)=><g key={part}>{series.comparable&&<polyline points={series.points.map(p=>`${x(p.date)},${y(p.values[i])}`).join(' ')} fill="none" stroke={colors[i%2]} strokeWidth={2}/>} {series.points.map(p=><circle key={p.sessionId} cx={x(p.date)} cy={y(p.values[i])} r={4} fill={colors[i%2]}><title>{p.date} · {part} {p.values[i]}</title></circle>)}</g>)}
 <text x={pad} y={h-12}>{series.points[0].date}</text><text x={w-pad} y={h-12} textAnchor="end">{series.points.at(-1)!.date}</text></svg>
}
export function TrendPreview({profile,sessions,onOpen}:{profile:FamilyProfile;sessions:FamilySession[];onOpen:()=>void}){
 const report=useMemo(()=>buildAutomaticTrend(sessions,profile.id),[sessions,profile.id])
 return <div className="family-observation-link auto-trend-preview"><div><span className="family-eyebrow">自动趋势报告</span><h2>{report.ready?'趋势报告已自动更新':`再记录 ${report.remaining} 次，自动生成趋势报告`}</h2><p>{report.ready?`已整理 ${report.recordCount} 次照片记录 · ${report.dateCount} 个拍摄日期`:`已完成 ${report.recordCount}/3 次照片记录`}</p></div><button onClick={onOpen}>{report.ready?'查看趋势报告':'查看记录进度'}<ArrowRight size={16}/></button></div>
}
const seriesLabel=(series:TrendSeries)=>PLAIN_LABELS[series.code]??series.label
/** First-to-latest arithmetic difference, rounded for display; null when the records cannot be compared. */
export function trendDelta(series:TrendSeries){
 if(!series.differences)return null
 const suffix=series.unit==='percent'?' 个百分点':series.unit==='degrees'?'°':''
 return series.differences.map((n,i)=>{const digits=series.unit==='ratio'?2:1,abs=Math.abs(n).toFixed(digits),zero=Number(abs)===0;return (series.parts.length>1?series.parts[i]+' ':'')+(zero?'差值约为0':(n>0?'+':'−')+abs+suffix)}).join(' · ')
}
function largestChange(series:TrendSeries[]){
 let best:{series:TrendSeries;score:number}|null=null
 for(const item of series){if(!item.differences)continue;const first=Math.abs(item.points[0].values[0])||1,score=Math.abs(item.differences[0])/first;if(!best||score>best.score)best={series:item,score}}
 return best&&best.score>0?best.series:null
}
function Sparkline({series}:{series:TrendSeries}){
 const w=96,h=34,pad=4,rows=series.points.map(p=>({v:p.values[0],u:p.uncertainty[0]})),band=rows.every(r=>typeof r.u==='number')
 const lows=rows.map(r=>band?r.v-(r.u as number):r.v),highs=rows.map(r=>band?r.v+(r.u as number):r.v),min=Math.min(...lows),max=Math.max(...highs),span=max-min||1
 const x=(i:number)=>pad+i/Math.max(1,rows.length-1)*(w-pad*2),y=(v:number)=>h-pad-(v-min)/span*(h-pad*2)
 const line=rows.map((r,i)=>`${x(i)},${y(r.v)}`).join(' ')
 return <svg className="trend-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">{band&&<polygon className="trend-spark-band" points={[...highs.map((v,i)=>`${x(i)},${y(v)}`),...lows.map((v,i)=>`${x(i)},${y(v)}`).reverse()].join(' ')}/>}{series.comparable?<polyline points={line}/>:null}{rows.map((r,i)=><circle key={i} cx={x(i)} cy={y(r.v)} r={i===rows.length-1?3:2}/>)}</svg>
}
function TrendRow({series,onOpen}:{series:TrendSeries;onOpen:(id:string)=>void}){
 const delta=trendDelta(series),first=series.points[0],last=series.points.at(-1)!
 return <details className="trend-row"><summary><span className="trend-row-name"><strong>{seriesLabel(series)}</strong><small>{series.points.length>1?`${plainValue(first.value)} → ${plainValue(last.value)}`:plainValue(last.value)}</small></span><Sparkline series={series}/><span className={`trend-chip ${delta?delta.includes('差值约为0')&&!/[+−]/.test(delta)?'trend-chip--same':'trend-chip--delta':'trend-chip--na'}`}>{delta??'暂不能比'}</span></summary>
  <div className="auto-trend-metric-body">{series.points.length>1&&<TrendChart series={series}/>}<div className="auto-trend-values">{series.points.map(p=><button key={p.sessionId} onClick={()=>onOpen(p.sessionId)}><time>{p.date}</time><strong>{plainValue(p.value)}</strong></button>)}</div>{series.parts.length>1&&<p>{series.parts.map((p,i)=><span key={p} style={{color:colors[i%2],marginRight:18}}>● {p}</span>)}</p>}{series.reasons.length>0&&<details><summary>为什么暂不能比</summary><ul>{series.reasons.map(r=><li key={r}>{r}</li>)}</ul></details>}<small>原名：{series.label}</small></div>
 </details>
}
export function AutomaticTrendReport({profile,sessions,onOpen,onRecord}:{profile:FamilyProfile;sessions:FamilySession[];onOpen:(id:string)=>void;onRecord:()=>void}){
 const report=useMemo(()=>buildAutomaticTrend(sessions,profile.id),[sessions,profile.id])
 const all=report.views.flatMap(v=>v.series),top=largestChange(all)
 const headline=!report.ready?'照片读数趋势':top?`读数差异最大：${seriesLabel(top)} ${trendDelta(top)}`:report.comparable?'各项读数与首次相同':'还不能对比变化'
 const intervalDays=report.from&&report.to?Math.round((Date.parse(report.to+'T12:00:00Z')-Date.parse(report.from+'T12:00:00Z'))/86400000):0
 const sub=!report.ready?`再记录 ${report.remaining} 次，自动整理读数`:report.comparable?`${report.from} → ${report.to} · ${report.comparable} 项可以对比`:'需要同样条件下拍的 3 个不同日期'
 return <section className="auto-trend-report"><div className="family-page-heading trend-heading"><div><span className="family-eyebrow">{profile.nickname} · {report.ready?`${report.recordCount} 次记录`:`${report.recordCount}/3 次记录`}</span><h1>{headline}</h1><p>{sub}</p></div><button className="family-primary" onClick={onRecord}><Camera size={18}/>继续记录</button></div>
 {report.dateCount>1&&intervalDays<30&&<p className="family-notice" role="status">间隔仅 {intervalDays} 天，读数差异可能来自拍摄条件。</p>}
 {!report.ready?<div className="family-empty"><TrendingUp size={36}/><h2>还需 {report.remaining} 次记录</h2><p>保存后自动生成。</p></div>:<>
 {report.views.map(view=><section key={view.view} className="auto-trend-view"><h2>{view.label}</h2>{view.records.length>0&&<div className="auto-trend-photos">{view.records.map(s=><button key={s.id} onClick={()=>onOpen(s.id)}><SessionThumb session={s} view={view.view==='front'?'front':'profile'}/><time>{s.recordedOn}</time></button>)}</div>}{!view.series.length?<p className="trend-empty"><span className="trend-chip trend-chip--na">暂不能比</span>还没有可用的测量</p>:<div className="trend-rows">{view.series.slice(0,3).map(series=><TrendRow key={series.code} series={series} onOpen={onOpen}/>)}{view.series.length>3&&<details className="trend-more"><summary>更多指标（{view.series.length-3}）</summary>{view.series.slice(3).map(series=><TrendRow key={series.code} series={series} onOpen={onOpen}/>)}</details>}</div>}</section>)}
 <p className="trend-note"><Info size={14}/>差值是照片读数直接相减，复拍误差尚未校准，不能据此确认真实生长变化。</p>
 <details className="auto-trend-rules"><summary>自动整理规则</summary><p>默认30天是暂定记录周期，不是真实变化的判定阈值。</p><p>同一条记录的修订只计一次；同一日期的同一项目取最新合格记录。按当前最新测量来源匹配，左右侧分开，重复照片排除。每项展示首次基准和最近11个日期；所有原始记录仍保留。用途为“其他”的照片保留在回看中，不进入数值趋势。新增、更正、删除记录后自动更新。</p></details></>}
 </section>
}
