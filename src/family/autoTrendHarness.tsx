import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import {archiveFixture} from './backupVolumes.fixture'
import {defaultProtocol} from './model'
import {trendSaveDestination} from './automaticTrend'
import '../appStyles'
const store=new FamilyStore('headup-auto-trend-qa-20260922',true)
configureLocalFamilyStore(store);configureWorkspacePreferences('auto-trend-qa-20260922')
const fixture=archiveFixture(),profile={...fixture.profiles[0],id:'auto-trend-profile',nickname:'自动趋势工程档案'}
async function add(i:number){
 const s=structuredClone(fixture.sessions[0]);s.id='auto-trend-'+i;s.profileId=profile.id;s.recordedOn=`2026-09-${String(i+1).padStart(2,'0')}`;s.createdAt=s.updatedAt=s.recordedOn+'T12:00:00Z';s.kind='measurement';s.recordedBy='user';s.purpose='骨骼发育';s.revision=undefined;s.dateSource='user_confirmed';s.note='仅为自动趋势界面测试，非真实测量'
 s.protocol={...defaultProtocol(),device:'工程同一设备',camera:'rear',distanceCm:100,light:'daylight'}
 const canvas=document.createElement('canvas');canvas.width=200;canvas.height=240;const c=canvas.getContext('2d')!;c.fillStyle=['#e4d4c8','#d8e7d8','#e0dae9','#f1e0d8'][i%4];c.fillRect(0,0,200,240);c.strokeStyle='#782d3e';c.lineWidth=2;c.beginPath();c.ellipse(100,115,50+i*2,75,0,0,Math.PI*2);c.stroke();c.fillStyle='#29252a';c.font='15px sans-serif';c.fillText('Test '+(i+1),65,220)
 const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png')),id=s.id+'/front',digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')
 s.contentKey='front:'+digest;s.captures=[{id:'front',mediaId:id,label:'正面',eyebrow:'',hint:'',quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:'front',detectedFaces:1,flags:[]}}]
 s.report.isExample=false;s.report.profile=[];s.report.extended=[];s.report.front=[{code:'FRONT-RATIO-07',value:(40+i*2).toFixed(2)+'%',label:'下半脸占脸高',view:'front',origin:'experimental',available:true,group:'比例',score:0,note:'工程模拟',formula:'A/B',errors:[],evidence:{version:'HEADUP-POINT-LINE-1',source:'saved_front_landmarks',width:200,height:240,points:[{id:'a',label:'A',x:100,y:40},{id:'b',label:'B',x:100,y:80+i*2},{id:'c',label:'C',x:100,y:140}],segments:[{id:'numerator',label:'A',from:'a',to:'b',role:'measure'},{id:'denominator',label:'B',from:'a',to:'c',role:'reference'}],formula:'A/B'}}]
 await store.restore({profiles:[profile],sessions:[s],media:[{id,sessionId:s.id,profileId:profile.id,blob}],plans:[],events:[]});return s
}
if(!(await store.snapshot()).sessions.length){await add(0);await add(1)}
function Harness(){const [message,setMessage]=useState('独立工程数据库，初始两次记录，不访问个人档案')
 return <><aside style={{padding:12,background:'#fff0cf'}}><p>{message}</p><button onClick={async()=>{const before=await store.snapshot(),s=await add(2);window.dispatchEvent(new Event('focus'));location.hash='#family/'+trendSaveDestination(before.sessions,s);setMessage('第三次工程保存完成，自动进入趋势报告')}}>模拟第三次保存</button><button onClick={async()=>{const before=await store.snapshot(),s=await add(3);window.dispatchEvent(new Event('focus'));location.hash='#family/'+trendSaveDestination(before.sessions,s);setMessage('第四次工程保存完成，报告自动更新')}}>模拟第四次保存</button></aside><FamilyApp/></>
}
createRoot(document.getElementById('root')!).render(<Harness/> )
