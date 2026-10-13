import {createRoot} from 'react-dom/client'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import {archiveFixture} from './backupVolumes.fixture'
import {defaultPlan} from './model'
import {completedPlan} from './planCompletion'
import '../appStyles'
const store=new FamilyStore('headup-plan-ui-qa-11',true)
configureLocalFamilyStore(store);configureWorkspacePreferences('plan-ui-qa-11')
if(!(await store.snapshot()).profiles.length){const data=archiveFixture(),row=data.sessions[0];data.profiles[0].nickname='月历工程档案';row.kind='measurement';row.note='纯色图形和固定检测状态，仅用于月历流程测试';row.captures=['front','profile'].map(view=>({id:view as 'front'|'profile',label:view,eyebrow:'',hint:'',mediaId:row.id+'/'+view,poseValidation:{status:'pass',estimatedPose:view==='front'?'front':'left_profile',detectedFaces:1,flags:[]},quality:{score:90,resolution:90,brightness:90,contrast:90,sharpness:90,flags:[]}}));data.sessions=[row];data.media=row.captures.map(c=>({id:c.mediaId!,sessionId:row.id,profileId:row.profileId,blob:data.media[0].blob}));data.plans=[completedPlan({...defaultPlan(row.profileId),enabled:true,nextDate:row.recordedOn},row,row.recordedOn)];await store.restore(data)}
const root=createRoot(document.getElementById('root')!);root.render(<><div style={{padding:8,background:'#fff1c9'}}>隔离月历验收：独立工程档案和固定输入，不是真人成长数据。</div><FamilyApp/></>);import.meta.hot?.dispose(()=>root.unmount())
