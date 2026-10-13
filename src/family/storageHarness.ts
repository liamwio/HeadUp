import {FamilyStore} from './store'
import {addDays,createProfile,defaultPlan,defaultProtocol,localDate,sortedSessions,recordRootId,type SessionDraft} from './model'
import {reminderWindow} from './reminders'
import {encryptArchive,decryptArchive} from './backup'
import type {Capture} from '../types'

const button=document.getElementById('run') as HTMLButtonElement,status=document.getElementById('status')!,output=document.getElementById('result')!
button.onclick=async()=>{
  button.disabled=true
  const dbName=`headup-family-qa-${crypto.randomUUID()}`,restoreName=dbName+'-restore',store=new FamilyStore(dbName),restoredStore=new FamilyStore(restoreName),urls:string[]=[],checks:Array<{name:string;pass:boolean}>=[]
  const check=(name:string,pass:boolean)=>{checks.push({name,pass});if(!pass)throw new Error(name)}
  try {
    status.textContent='正在检查真实IndexedDB事务与加密备份…'
    const profiles=['自测档案A','自测档案B'].map(nickname=>createProfile({nickname,guardianConfirmed:true,childInformed:true,storage:true}))
    const channel=new BroadcastChannel(`${dbName}:changes`)
    const changed=new Promise<boolean>(resolve=>{const timeout=setTimeout(()=>resolve(false),3000);channel.onmessage=event=>{clearTimeout(timeout);resolve(JSON.stringify(event.data)==='{"type":"changed"}')}})
    for(const p of profiles)await store.putProfile(p)
    check('提交后发布不含个人数据的更新通知',await changed);channel.close()
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d')!.fillRect(0,0,64,64)
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png'))
    const url=URL.createObjectURL(blob);urls.push(url)
    const captures:Capture[]=[{id:'front',label:'正面',hint:'合成测试图，不用于测量',eyebrow:'QA',url}]
    const draft=(profileId:string):SessionDraft=>({profileId,recordedOn:localDate(),kind:'memory',recordedBy:'together',note:'仅用于事务测试',protocol:defaultProtocol()})
    let orphanRejected=false;try{await store.saveSession(draft('missing-profile'),captures)}catch{orphanRejected=true}
    const afterOrphan=await store.archive();check('档案不存在时事务回滚，不留下照片或记录',orphanRejected&&afterOrphan.sessions.length===0&&afterOrphan.media.length===0)
    const a=await store.saveSession(draft(profiles[0].id),captures)
    let duplicateRejected=false;try{await store.saveSession(draft(profiles[0].id),captures)}catch{duplicateRejected=true}
    check('同档案重复照片拒绝且无残留',duplicateRejected&&(await store.archive()).sessions.length===1&&(await store.archive()).media.length===1)
    await store.saveSession(draft(profiles[1].id),captures)
    await store.close()
    const reloaded=await store.snapshot();check('关闭连接再打开后两个档案及记录仍在',reloaded.profiles.length===2&&reloaded.sessions.length===2)
    await store.updateSessionMetadata(a.id,profiles[0].id,addDays(localDate(),-28),'日期更正的工程验收')
    const corrected=(await store.snapshot()).sessions.find(s=>s.id===a.id)!
    check('更正拍摄日期保留旧信息和原始读数',corrected.recordedOn===addDays(localDate(),-28)&&corrected.metadataHistory?.[0].recordedOn===a.recordedOn&&JSON.stringify(corrected.report)===JSON.stringify(a.report))
    let reusedRejected=false;try{await store.saveSession({...draft(profiles[0].id),kind:'measurement'},[...captures,{...captures[0],id:'profile',label:'侧面'}])}catch(e){reusedRejected=e instanceof Error&&e.message.includes('已用于')}
    check('旧照片混入新日期照片组时拒绝测量保存且无残留',reusedRejected&&(await store.archive()).sessions.length===2&&(await store.archive()).media.length===2)
    const pictures=await store.restoreCaptures(a)
    const restoredBlob=await(await fetch(pictures.captures[0].url!)).blob()
    check('照片Blob恢复且大小类型一致',restoredBlob.size===blob.size&&restoredBlob.type===blob.type);pictures.dispose()
    const archive=await store.archive(),encrypted=await encryptArchive(archive,'only-for-isolated-qa'),decoded=await decryptArchive(encrypted,'only-for-isolated-qa')
    check('加密文件不直接暴露档案昵称',!(await encrypted.text()).includes(profiles[0].nickname))
    await restoredStore.restore(decoded)
    await restoredStore.restore(decoded)
    check('备份往返及重复导入不复制记录',(await restoredStore.archive()).sessions.length===2&&(await restoredStore.archive()).media.length===2)
    check('备份恢复保留日期更正历史',(await restoredStore.snapshot()).sessions.find(s=>s.id===a.id)?.metadataHistory?.[0].recordedOn===a.recordedOn)
    let badPassword=false;try{await decryptArchive(encrypted,'wrong-qa-password')}catch{badPassword=true}
    check('密码错误不改变已恢复档案',badPassword&&(await restoredStore.snapshot()).sessions.length===2)
    await store.deleteSession(a.id)
    check('删除单次记录同时删除关联照片',(await store.archive()).sessions.length===1&&(await store.archive()).media.length===1)
    await restoredStore.deleteProfile(profiles[0].id)
    const afterDelete=await restoredStore.archive()
    check('删除一个档案不影响另一个档案',afterDelete.profiles.length===1&&afterDelete.profiles[0].id===profiles[1].id&&afterDelete.sessions.length===1&&afterDelete.media.length===1)
    const plan={...defaultPlan(profiles[1].id),enabled:true,notificationEnabled:true,nextDate:localDate(),time:'00:00',quietStart:'00:00',quietEnd:'00:00'}
    await store.putPlan(plan)
    const otherTab=new FamilyStore(dbName)
    const claims=await Promise.all([store.claimReminder(plan.profileId,new Date()),otherTab.claimReminder(plan.profileId,new Date())]);await otherTab.close()
    check('两个独立连接同时请求提醒时仅一个取得通知资格',claims.filter(Boolean).length===1)
    await store.putPlan({...plan,owner:'child'})
    check('旧表单保存不会清除同一期提醒去重标记',!await store.claimReminder(plan.profileId,new Date()))
    await store.failReminder(plan.profileId,reminderWindow(plan))
    check('系统通知失败后暂停页面通知，避免重试轰炸',(await store.snapshot()).plans.find(p=>p.profileId===plan.profileId)?.notificationEnabled===false)
    const complete:Capture[]=([{...captures[0]},{...captures[0],id:'profile'}] as Capture[]).map(c=>({...c,quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:c.id==='front'?'front':'left_profile',detectedFaces:1,flags:[]}}))
    const initialObservation=await store.saveSession({...draft(plan.profileId),kind:'measurement'},complete)
    check('完整当日观察与计划顺延在同一次保存中提交',(await store.snapshot()).plans.find(p=>p.profileId===plan.profileId)?.nextDate===addDays(localDate(),28))
    const withoutNotification=await decryptArchive(await encryptArchive(await store.archive(),'only-for-isolated-qa'),'only-for-isolated-qa')
    check('备份导入不会继承另一设备的通知授权',withoutNotification.plans.every(p=>!p.notificationEnabled))
    const attempts=await Promise.allSettled([store.saveRevision(initialObservation,complete,'reanalyze',['front']),store.saveRevision(initialObservation,complete,'reanalyze',['front'])])
    check('并发重新检测保存只提交一个新版本，不产生分支',attempts.filter(r=>r.status==='fulfilled').length===1)
    const revision=attempts.find(r=>r.status==='fulfilled')!;if(revision.status!=='fulfilled')throw new Error('missing revision')
    const revised=await store.snapshot(),original=revised.sessions.find(s=>s.id===initialObservation.id)!
    check('修订后原报告和原媒体引用完全不变',JSON.stringify(original.report)===JSON.stringify(initialObservation.report)&&JSON.stringify(original.captures)===JSON.stringify(initialObservation.captures))
    check('时间线按同一次记录计数，默认显示新版本',sortedSessions(revised.sessions,plan.profileId).length===2&&sortedSessions(revised.sessions,plan.profileId).some(s=>s.id===revision.value.id))
    await store.updateSessionMetadata(revision.value.id,plan.profileId,addDays(localDate(),-1),'修订链日期更正')
    const correctedVersions=(await store.snapshot()).sessions.filter(s=>recordRootId(s)===initialObservation.id)
    check('日期更正同步所有版本并保留旧信息',correctedVersions.length===2&&correctedVersions.every(s=>s.recordedOn===addDays(localDate(),-1)&&s.metadataHistory?.at(-1)?.recordedOn===localDate()))
    const revisedBackup=await decryptArchive(await encryptArchive(await store.archive(),'only-for-isolated-qa'),'only-for-isolated-qa')
    await restoredStore.restore(revisedBackup)
    check('修订链与全部媒体随加密备份完整恢复',(await restoredStore.snapshot()).sessions.some(s=>s.revision?.parentId===initialObservation.id)&&(await restoredStore.archive()).media.some(m=>m.sessionId===revision.value.id))
    await store.deleteSession(revision.value.id)
    const erased=await store.archive()
    check('删除一次记录同时清理全部修订及其媒体',!erased.sessions.some(s=>recordRootId(s)===initialObservation.id)&&!erased.media.some(m=>[initialObservation.id,revision.value.id].includes(m.sessionId)))
    output.textContent=JSON.stringify({date:new Date().toISOString(),pass:checks.every(c=>c.pass),checks,isolatedDatabase:true,realPersonalImagesUsed:false},null,2)
    status.textContent='PASS：存储、恢复、回滚与删除检查通过'
  }catch(error){output.textContent=JSON.stringify({pass:false,checks,error:error instanceof Error?error.message:String(error)},null,2);status.textContent='FAIL：检查未通过'}
  finally {
    urls.forEach(url=>URL.revokeObjectURL(url));await store.close();await restoredStore.close()
    for(const name of [dbName,restoreName])if(name.startsWith('headup-family-qa-'))await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})
  }
}
