import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import {AutomaticTrendReport} from './AutomaticTrendReport'
import {ReportPageV2} from '../ReportPageV2'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {archiveFixture} from './backupVolumes.fixture'
import {defaultProtocol,type FamilySession} from './model'
import {useSessionCaptures} from './hooks'
import type {ConsumerReading} from '../lib/consumerReport'
import '../appStyles'
import './family.css'
const store=new FamilyStore('headup-visual-qa-20261024',true);configureLocalFamilyStore(store)
const fixture=archiveFixture(),profile={...fixture.profiles[0],id:'visual-test',nickname:'成长记录示例'}
const sessions:FamilySession[]=[]
for(let i=0;i<3;i++){
 const s=structuredClone(fixture.sessions[0]);s.id='visual-'+i;s.profileId=profile.id;s.recordedOn=['2026-04-01','2026-07-01','2026-10-01'][i];s.createdAt=s.updatedAt=s.recordedOn+'T12:00:00Z';s.kind='measurement';s.recordedBy='user';s.revision=undefined;s.note='合成轮廓，仅供界面测试';s.contentKey='front:'+(i+1).toString().repeat(64)
 s.protocol={...defaultProtocol(),device:'同一测试设备',camera:'rear',distanceCm:100,light:'daylight'}
 const canvas=document.createElement('canvas');canvas.width=400;canvas.height=520;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#eee6e0';ctx.fillRect(0,0,400,520);ctx.fillStyle='#d8b9a1';ctx.beginPath();ctx.ellipse(200,242,108-i*4,160,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#64453f';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(138,207);ctx.lineTo(166,207);ctx.moveTo(234,207);ctx.lineTo(262,207);ctx.moveTo(200,222);ctx.lineTo(188,285);ctx.lineTo(205,285);ctx.moveTo(165,325);ctx.quadraticCurveTo(200,340,235,325);ctx.stroke();ctx.fillStyle='#647b7e';ctx.beginPath();ctx.ellipse(200,520,170,105,0,0,Math.PI*2);ctx.fill()
 const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png')),id=s.id+'/front'
 s.captures=[{id:'front',mediaId:id,label:'正面',eyebrow:'',hint:'',quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:'front',detectedFaces:1,flags:[]}}]
 const make=(code:string,label:string,points:number[][],value:string):ConsumerReading=>({code,label,value,view:'front',available:true,origin:'experimental',group:'比例',score:0,note:'合成几何示例',formula:'距离比',errors:[],evidence:{version:'HEADUP-POINT-LINE-1',source:'saved_front_landmarks',width:400,height:520,points:points.map(([x,y],j)=>({id:'p'+j,label:'参考点'+j,x,y})),segments:[{id:'numerator',label,from:'p2',to:'p3',role:'measure'},{id:'denominator',label:'可见脸高',from:'p0',to:'p1',role:'reference'}],formula:'测量长度 / 可见脸高'}})
 s.report.isExample=false;s.report.profile=[];s.report.extended=[];s.report.front=[make('FRONT-RATIO-07','下半脸占脸高',[[200,82],[200,402],[200,285-i*2],[200,402]],((117+i*2)/320*100).toFixed(2)+'%'),make('FRONT-RATIO-01','脸宽高比',[[200,82],[200,402],[92+i*4,242],[308-i*4,242]],((216-i*8)/320).toFixed(3)),make('FRONT-RATIO-05','嘴宽占脸宽',[[92+i*4,242],[308-i*4,242],[165,325],[235,325]],(70/(216-i*8)).toFixed(3))]
 await store.restore({profiles:[profile],sessions:[s],media:[{id,sessionId:s.id,profileId:profile.id,blob}],plans:[],events:[]});sessions.push(s)
}
function Harness(){const [mode,setMode]=useState('trend');const capture=useSessionCaptures(sessions[2]);return <div className="family-app" style={{maxWidth:900,margin:'auto',padding:16}}><div style={{padding:8,background:'#f1e7d2',fontSize:12}}>合成照片与读数 · 界面验收，不访问用户档案</div><div className="family-actions"><button onClick={()=>setMode('trend')}>趋势展示</button><button onClick={()=>setMode('record')}>记录测量线</button></div>{mode==='trend'?<AutomaticTrendReport profile={profile} sessions={sessions} onOpen={()=>{}} onRecord={()=>{}}/>:<ReportPageV2 captures={capture.captures} frozenReport={sessions[2].report} visibleView="front" mode="youth" onStart={()=>{}} onRetake={()=>{}} onPrivacy={()=>{}}/>}</div>}
createRoot(document.getElementById('root')!).render(<Harness/> )
