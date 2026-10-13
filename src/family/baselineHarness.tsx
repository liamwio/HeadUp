import {createRoot} from 'react-dom/client'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import {archiveFixture} from './backupVolumes.fixture'
import type {Archive} from './backup'
import '../appStyles'
const store=new FamilyStore('headup-baseline-ui-qa-10',true)
configureLocalFamilyStore(store);configureWorkspacePreferences('baseline-ui-qa-10')
if(!(await store.snapshot()).profiles.length){
  const fixture=archiveFixture(),profile={...fixture.profiles[0],id:'baseline-qa-profile',nickname:'基线工程档案',participation:'together' as const,preferredSide:'left_profile' as const,purpose:'隔离工程验收，非真实成长资料'},archive:Archive={profiles:[profile],sessions:[],media:[],events:[],plans:[]}
  for(let i=0;i<4;i++){
    const row=structuredClone(fixture.sessions[0]);row.id='baseline-qa-'+i;row.profileId=profile.id;row.recordedOn=['2026-01-01','2026-02-01','2026-05-01','2026-08-01'][i];row.kind='measurement';row.note='纯色工程图形，检测状态为固定测试输入';row.protocol={...row.protocol,device:i<2?'工程手机A':'工程手机B',camera:'rear',distanceCm:i===2?null:100,light:'daylight',locationNote:'窗边固定站位'};row.captures=['front','profile'].map(view=>({id:view as 'front'|'profile',label:view,eyebrow:'',hint:'',mediaId:row.id+'/'+view,poseValidation:{status:'pass',estimatedPose:view==='front'?'front':i===1?'right_profile':'left_profile',detectedFaces:1,flags:[]},quality:{score:90,resolution:90,brightness:90,contrast:90,sharpness:90,flags:[]}}));for(const c of row.captures)archive.media.push({id:c.mediaId!,sessionId:row.id,profileId:profile.id,blob:fixture.media[0].blob});archive.sessions.push(row)
  }
  await store.restore(archive)
}
const root=createRoot(document.getElementById('root')!);root.render(<><div style={{padding:8,background:'#fff1c9'}}>隔离基线验收：纯色图形与固定检测状态，不代表真人。</div><FamilyApp/></>);import.meta.hot?.dispose(()=>root.unmount())
