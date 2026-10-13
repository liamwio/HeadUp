import {profileSide,sideLabel,type FamilySession} from './model'
export function comparisonViewLabel(session:FamilySession,view:'front'|'profile') {
  if(!session.captures.some(c=>c.id===view))return view==='front'?'正面未添加':'侧面未添加'
  if(view==='front')return '正面'
  const side=profileSide(session)
  return side?sideLabel(side):'侧面方向未确认'
}
