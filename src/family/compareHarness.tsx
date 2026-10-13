import {createRoot} from 'react-dom/client'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import {archiveFixture} from './backupVolumes.fixture'
import type {Archive} from './backup'
import '../appStyles'
import './family.css'
const store=new FamilyStore('headup-comparison-ui-qa-1',true)
configureLocalFamilyStore(store);configureWorkspacePreferences('comparison-ui-qa')
if(!(await store.snapshot()).profiles.length){
  const fixture=archiveFixture(),profile={...fixture.profiles[0],id:'comparison-profile',nickname:'对照工程档案'},archive:Archive={profiles:[profile],sessions:[],media:[],plans:[],events:[]}
  const oval=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
  for(let i=0;i<4;i++){
    const s=structuredClone(fixture.sessions[0]);s.id='comparison-record-'+i;s.profileId=profile.id;s.recordedOn=['2026-01-01','2026-03-01','2026-09-01','2026-09-17'][i];s.kind=i===3?'memory':'measurement';s.note='仅用于界面和几何流程验收的图形，不是真人或成长数据';s.captures=[];s.protocol={...s.protocol,device:'工程设备',camera:'rear',distanceCm:100,light:'daylight'};s.report.front=[];s.report.profile=[];s.report.extended=[];s.report.measuredCount=0
    for(const view of ['front','profile'] as const){
      const canvas=document.createElement('canvas');canvas.width=500;canvas.height=600;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#f5efe7';ctx.fillRect(0,0,500,600);ctx.strokeStyle='#782d3e';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(250+i*10,300,140,210,0,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#29252a';ctx.font='24px sans-serif';ctx.fillText('Engineering '+i+' '+view,25,40)
      const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png')),points=Array.from({length:478},()=>({x:(250+i*10)/500,y:.5,z:0}));oval.forEach((n,j)=>{const t=j/oval.length*Math.PI*2-Math.PI/2;points[n]={x:(250+i*10+140*Math.cos(t))/500,y:(300+210*Math.sin(t))/600,z:0}})
      const mediaId=s.id+'/'+view;s.captures.push({id:view,mediaId,label:view==='front'?'正面':'侧面',eyebrow:'',hint:'',poseValidation:{status:'pass',estimatedPose:view==='front'?'front':i===1?'right_profile':'left_profile',detectedFaces:1,flags:[],landmarks:view==='front'?points:undefined,landmarkImageWidth:500,landmarkImageHeight:600},quality:{flags:[]} as any});archive.media.push({id:mediaId,sessionId:s.id,profileId:profile.id,blob,originalBlob:blob})
      if(view==='profile')s.report.native={width:500,height:600,paths:[{code:'forehead_aesthetic_line',label:'工程弧线',category:'region',points:oval.slice(0,20).map(n=>({x:points[n].x*500,y:points[n].y*600}))}]} as any
    }
    archive.sessions.push(s)
  }
  await store.restore(archive)
}
const partialId='comparison-front-only'
if(!(await store.snapshot()).sessions.some(s=>s.id===partialId)){
  const fixture=archiveFixture(),profile=(await store.snapshot()).profiles.find(p=>p.id==='comparison-profile')!,session=structuredClone(fixture.sessions[0]),media=fixture.media[0]
  session.id=partialId;session.profileId=profile.id;session.recordedOn='2026-06-01';session.note='缺少侧面的工程记录';session.captures[0].mediaId=partialId+'/front';session.report.isExample=false
  await store.restore({profiles:[profile],sessions:[session],media:[{...media,id:partialId+'/front',sessionId:partialId,profileId:profile.id}],plans:[],events:[]})
}
const existingEvents=new Set((await store.snapshot()).events.map(e=>e.id))
for(const event of [
  {id:'timeline-14-device',date:'2026-09-10',type:'device' as const,text:'工程事件：更换拍摄设备。日期仅用于界面验收。'},
  {id:'timeline-14-question',date:'2026-01-01',type:'question' as const,text:'工程问题：怎样让下一次拍摄保持同样条件？'},
  {id:'timeline-14-memory',date:'2025-08-01',type:'memory' as const,text:'只有事件、没有照片的月份。合成工程资料。'},
])if(!existingEvents.has(event.id))await store.putEvent({...event,profileId:'comparison-profile',createdAt:'2026-09-17T00:00:00Z'})
for(let i=2;i<=10;i++)if(!existingEvents.has('timeline-14-page-'+i))await store.putEvent({id:'timeline-14-page-'+i,date:'2025-08-'+String(i).padStart(2,'0'),type:'memory',text:'分页工程事件 '+i,profileId:'comparison-profile',createdAt:'2026-09-17T00:00:00Z'})
const root=createRoot(document.getElementById('root')!);root.render(<><div style={{padding:8,background:'#fff1c9'}}>隔离验收：合成图形与独立数据库，不代表真人测量。</div><FamilyApp/></>);import.meta.hot?.dispose(()=>root.unmount())
