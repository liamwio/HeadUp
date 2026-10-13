import {addDays,validDate,type RecordPlan,type FamilySession,sortedSessions} from './model'
export function validMonth(month:string){return /^\d{4}-(0[1-9]|1[0-2])$/.test(month)&&Number(month.slice(0,4))>0&&validDate(month+'-01')}
export function moveMonth(month:string,delta:number){if(!validMonth(month)||!Number.isInteger(delta))throw new Error('月份无效');const date=new Date(month+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+delta);const result=date.toISOString().slice(0,7);if(!validMonth(result))throw new Error('月份超出范围');return result}
export function planMonth(month:string,plan:RecordPlan,sessions:FamilySession[]){
  if(!validMonth(month))throw new Error('月份无效')
  const start=month+'-01',offset=(new Date(start+'T12:00:00Z').getUTCDay()+6)%7,first=addDays(start,-offset),rows=sortedSessions(sessions,plan.profileId)
  const windowEnd=validDate(plan.nextDate)?addDays(plan.nextDate,plan.windowDays-1):''
  return Array.from({length:42},(_,i)=>{const date=addDays(first,i);return{date,inMonth:date.startsWith(month),planned:plan.enabled&&date>=plan.nextDate&&date<=windowEnd,selected:date===plan.nextDate,records:rows.filter(row=>row.recordedOn===date)}}).filter(d=>validDate(d.date))
}
