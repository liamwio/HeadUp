import {useEffect} from 'react'
import {getActiveFamilyStore} from './store'
import {getWorkspace} from './cloudRuntime'
import {reminderKindDue,reminderWindow,showRecordingNotification} from './reminders'
import {deliverReminder} from './reminderDelivery'
export function ReminderBridge(){
  useEffect(()=>{let alive=true,busy=false
    const tick=async()=>{
      if(!alive||busy||document.visibilityState!=='visible'||typeof Notification==='undefined'||Notification.permission!=='granted')return
      const store=getActiveFamilyStore(),workspace=getWorkspace()
      const current=()=>alive&&getActiveFamilyStore()===store&&getWorkspace()?.engine===workspace?.engine&&!getWorkspace()?.locked&&document.visibilityState==='visible'&&Notification.permission==='granted'
      if(!current())return;busy=true
      try{for(const plan of await store.reminderPlans()){
        if(!current())break
        const kind=reminderKindDue(plan);if(!kind)continue
        await deliverReminder({store,profileId:plan.profileId,window:reminderWindow(plan),kind,now:()=>new Date(),current,notify:canSend=>showRecordingNotification(kind,canSend)})
      }}catch{/* Notifications must not block the local archive. */}finally{busy=false}
    }
    void tick();const interval=setInterval(()=>void tick(),30000),visible=()=>void tick();document.addEventListener('visibilitychange',visible)
    return()=>{alive=false;clearInterval(interval);document.removeEventListener('visibilitychange',visible)}
  },[])
  return null
}
