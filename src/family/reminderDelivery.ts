import type {FamilyStore} from './store'
import {canDeliverClaimedReminder,type ReminderKind} from './reminders'
type ReminderStore=Pick<FamilyStore,'claimReminder'|'reminderPlan'|'confirmReminderDelivery'|'failReminder'>
export async function deliverReminder({store,profileId,window,kind,now,current,notify}:{
  store:ReminderStore;profileId:string;window:string;kind:ReminderKind;
  now:()=>Date;current:()=>boolean;notify:(canSend:()=>Promise<boolean>)=>Promise<boolean>
}){
  if(!current()||!await store.claimReminder(profileId,now(),kind,window))return false
  const canSend=async()=>{
    if(!current())return false
    const plan=await store.reminderPlan(profileId)
    return Boolean(current()&&plan&&canDeliverClaimedReminder(plan,window,kind,now()))
  }
  if(!await canSend())return false
  try{
    if(!await notify(canSend))return false
    if(current())await store.confirmReminderDelivery(profileId,window,kind,now())
    return true
  }catch{
    if(current())await store.failReminder(profileId,window,kind)
    return false
  }
}
