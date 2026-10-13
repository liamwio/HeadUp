import {useEffect,useRef,useState} from 'react'
import type {MeasurementEvidence} from './lib/measurementEvidence'
export function MeasurementOverlay({evidence,showLabels=false}:{evidence:MeasurementEvidence;showLabels?:boolean}){
 const svg=useRef<SVGSVGElement>(null),[scale,setScale]=useState(1)
 useEffect(()=>{const el=svg.current;if(!el)return;const resize=()=>{const r=el.getBoundingClientRect();setScale(Math.max(.01,Math.min(r.width/evidence.width,r.height/evidence.height)))};resize();const observer=new ResizeObserver(resize);observer.observe(el);return()=>observer.disconnect()},[evidence.width,evidence.height])
 const byId=new Map(evidence.points.map(p=>[p.id,p])),used=new Set(evidence.segments.flatMap(s=>[s.from,s.to]))
 return <svg ref={svg} className="measurement-evidence-overlay" viewBox={`0 0 ${evidence.width} ${evidence.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="本项测量使用的关键点与测量线">
   {evidence.segments.map(s=>{const a=byId.get(s.from),b=byId.get(s.to);return a&&b?<line key={s.id} className={'evidence-line evidence-line--'+s.role} x1={a.x} y1={a.y} x2={b.x} y2={b.y}><title>{s.label}</title></line>:null})}
   {evidence.points.filter(p=>used.has(p.id)).map(p=><g key={p.id}><circle cx={p.x} cy={p.y} r={2.5/scale} className="evidence-point"/><title>{p.label}</title>{showLabels&&!(/垂足|投影|终点|起点/.test(p.label))&&<text x={p.x+(p.x>evidence.width*.62?-6:6)/scale} textAnchor={p.x>evidence.width*.62?'end':'start'} y={p.y-6/scale} fontSize={11/scale} strokeWidth={2.5/scale} className="evidence-point-label">{p.label}</text>}</g>)}
 </svg>
}
