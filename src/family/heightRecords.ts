import {eventDetails} from './eventDetails'
import {localDate,validDate,type FamilyEvent} from './model'
export function createHeightRecord(profileId:string,date:string,centimeters:number,source:string,previous?:FamilyEvent,now=new Date()):FamilyEvent{
  if(!validDate(date)||date>localDate(now))throw Error('请选择今天或过去的测量日期')
  if(previous&&(previous.profileId!==profileId||!previous.height))throw Error('身高记录不属于当前档案')
  const height={centimeters:Math.round(centimeters*10)/10,source:source.trim()},stamp=now.toISOString()
  const event:FamilyEvent={id:previous?.id??crypto.randomUUID(),profileId,date,type:'memory',text:`身高 ${height.centimeters} 厘米 · ${height.source}`,height,detailsVersion:'HEADUP-EVENT-2',recordedBy:'user',createdAt:previous?.createdAt??stamp,updatedAt:stamp}
  eventDetails(event);return event
}
export function heightRecords(events:FamilyEvent[],profileId:string){return events.filter(e=>e.profileId===profileId&&e.height).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt))}
