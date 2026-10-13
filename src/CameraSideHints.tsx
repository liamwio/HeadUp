import {Check,Minus,Move} from 'lucide-react'
import type {FramingCheck} from './lib/liveFraming'

const groups=[['距离','位置','完整入镜'],['角度','光线','清晰度']]
const good:Record<string,string>={'距离':'合适','位置':'居中','完整入镜':'留白合适','角度':'合适','光线':'合适','清晰度':'清晰'}
/** Display-only projection of the existing checks; no change to capture gates. */
export function CameraSideHints({checks,message}:{checks:FramingCheck[];message:string}){
 const unavailable=/检测暂不可用|准备检测/.test(message)
 const framingWarning=/只保留一个人/.test(message)?'只留一人':/摘下|遮挡轮廓/.test(message)?'露出面部':undefined
 return <div className="live-side-hints" aria-label="实时拍摄检查">{groups.map((labels,i)=><ul key={i} className={`live-side-hints-column live-side-hints-column--${i?'right':'left'}`} aria-label={i?'角度与画质':'取景与位置'}>{labels.map(label=>{
   const check=checks.find(c=>c.label===label),warning=label==='完整入镜'?framingWarning:undefined,state=warning?'adjust':check?.state??'unknown'
   const detail=warning??(state==='good'?good[label]:state==='unknown'?(unavailable?'待确认':label==='完整入镜'?'面部入框':'待检测'):check!.detail)
   return <li key={label} className={'is-'+state} aria-label={`${label}：${detail}`}><span>{state==='good'?<Check aria-hidden="true"/>:state==='adjust'?<Move aria-hidden="true"/>:<Minus aria-hidden="true"/>}{label==='完整入镜'?'入镜':label}</span><strong>{detail}</strong></li>
 })}{i===0&&unavailable&&<li className="live-side-hints-notice">检测未就绪<br/>可手动拍摄</li>}{i===1&&message.startsWith('侧面角度仍待核对')&&<li className="live-side-hints-notice">已端正时<br/>勿反复扭头</li>}</ul>)}</div>
}
