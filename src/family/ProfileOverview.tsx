import {ArrowLeft} from 'lucide-react'
import {sortedSessions,type FamilyProfile,type FamilySession,type ProfileSide} from './model'
import {protocolSummary} from './baseline'
export function ProfileOverview({profile,sessions,onEdit,onOpen,onRecord,onBack}:{profile:FamilyProfile;sessions:FamilySession[];onEdit:()=>void;onOpen:(id:string)=>void;onRecord:(side:ProfileSide)=>void;onBack:()=>void}){
  const rows=sortedSessions(sessions,profile.id),latest=rows[0],conditions=latest?protocolSummary(latest.protocol):null
  return <section><button className="family-back" onClick={onBack}><ArrowLeft size={16}/>返回首页</button><div className="family-page-heading"><div><span className="family-eyebrow">个人档案</span><h1>{profile.nickname}</h1><p>出生年份：{profile.birthYear??'未填写'} · 已保存{rows.length}次记录</p></div><button onClick={onEdit}>编辑档案</button></div><div className="family-form"><h2>拍摄顺序</h2><p>正面 → 左侧 → 右侧。每次尽量使用相同设备、距离和光线；左右侧分别保存和对照。</p><button className="family-primary" onClick={()=>onRecord('left_profile')}>开始记录</button></div>{latest&&conditions&&<section className="family-settings-section"><h2>上次拍摄 · {latest.recordedOn}</h2><p>{conditions.device} · {conditions.camera} · 距离{conditions.distance} · {conditions.light}</p><p>{conditions.method}</p><button onClick={()=>onOpen(latest.id)}>查看上次记录</button></section>}</section>
}
