import {useEffect,useId,useRef} from 'react'
import {X} from 'lucide-react'
import {compareSessions,type FamilySession} from './model'

export function comparisonTitle(status:ReturnType<typeof compareSessions>['status']){return status==='incompatible'?'本次不作同视角比较':status==='conditions_close'?'条件接近，误差仍待验证':'可看照片，暂不判断变化'}
export function ComparisonEvidence({a,b,view}:{a:FamilySession;b:FamilySession;view:'front'|'profile'}) {
  const comparison=compareSessions(a,b,view)
  return <><h2>{comparisonTitle(comparison.status)}</h2><ul>{comparison.reasons.map(r=><li key={r}>{r}</li>)}</ul><p>照片不同，不代表发育异常；没有适用的真实复拍证据时，不输出成长或改善百分比。</p><details className="family-evidence-conditions"><summary>两次保存的拍摄条件与版本</summary>{[a,b].map((s,i)=><section key={s.id+':'+i}><h3>{i===0?'前次':'后次'} · {s.recordedOn}</h3><dl><dt>设备</dt><dd>{s.protocol.device||'未记录'}</dd><dt>镜头</dt><dd>{s.protocol.camera==='rear'?'后置':s.protocol.camera==='front'?'前置':'未记录'}</dd><dt>距离</dt><dd>{s.protocol.distanceCm===null?'未记录':s.protocol.distanceCm+'厘米'}</dd><dt>光线</dt><dd>{s.protocol.light==='daylight'?'自然光':s.protocol.light==='indoor'?'室内灯光':'未记录'}</dd><dt>算法</dt><dd>{s.version.algorithm}</dd><dt>误差依据</dt><dd>{s.version.norm}</dd></dl></section>)}<p>以上是保存时的记录，不是软件对实际距离、设备或光线的再次实测。</p></details></>
}
export function ComparisonEvidenceDrawer({a,b,view,onClose}:{a:FamilySession;b:FamilySession;view:'front'|'profile';onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null),titleId=useId()
  useEffect(()=>{const modal=ref.current,overflow=document.body.style.overflow;modal?.showModal();document.body.style.overflow='hidden';return()=>{modal?.close();document.body.style.overflow=overflow}},[])
  return <dialog ref={ref} className="family-evidence-drawer" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose()}}><header><div><h2 id={titleId}>这两次能否比较</h2><p>{a.recordedOn} / {b.recordedOn} · {view==='front'?'正面':'侧面'}</p></div><button aria-label="关闭比较依据" onClick={onClose}><X size={20}/></button></header><div className="family-evidence-body"><ComparisonEvidence a={a} b={b} view={view}/></div><footer><button className="family-primary" onClick={onClose}>返回照片对照</button></footer></dialog>
}
