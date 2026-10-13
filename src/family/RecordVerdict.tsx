import {Check,RefreshCcw,Plus} from 'lucide-react'
import type {Capture} from '../types'
import {recordVerdict} from '../lib/plainResult'

/** Answers "can these photos be used?" in one sentence, with a status tag on each photo. */
export function RecordVerdict({captures,busy=false,onView}:{captures:Capture[];busy?:boolean;onView?:(id:Capture['id'])=>void}){
  const verdict=recordVerdict(captures)
  return <section className={`record-verdict record-verdict--${verdict.tone}`} aria-label="本次记录结论">
    <div className="record-verdict-head" role="status"><strong>{verdict.headline}</strong><span>{verdict.sub}</span></div>
    <div className="record-verdict-photos">{verdict.rows.map(row=><figure key={row.capture.id} className={`record-verdict-photo record-verdict-photo--${row.status}`}>
      {row.capture.url?<img src={row.capture.originalUrl??row.capture.url} alt={row.label+'照片'}/>:<div className="record-verdict-empty">未拍</div>}
      <figcaption><span className="record-verdict-tag">{row.status==='ok'?<><Check size={13}/>{row.label}</>:row.status==='retake'?<><RefreshCcw size={13}/>{row.label}需重拍</>:<>{row.label}</>}</span>
        {onView&&<button type="button" disabled={busy} onClick={()=>onView(row.capture.id)}>{row.status==='missing'?<><Plus size={14}/>补拍</>:row.status==='retake'?'重拍':'更换'}</button>}
      </figcaption>
    </figure>)}</div>
  </section>
}
