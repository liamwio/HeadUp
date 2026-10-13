import {useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {readCapture} from './lib/readCapture'
import {buildConsumerReport} from './lib/consumerReport'
import {buildFrontLandmarkOverlay} from './lib/frontLandmarkOverlay'
import {resolveProfileDisplayPaths} from './lib/profileDisplayPolicy'
import {profileSemanticPathD} from './lib/nativeProfilePresentation'
import {auditReadingEvidence} from './lib/measurementEvidenceAudit'
import {reportVersion} from './data/report'
import type {Capture} from './types'
import type {MeasurementEvidence} from './lib/measurementEvidence'
import './appStyles'
type Case={id:string;subject:string;view:'front'|'left_profile'|'right_profile';path:string;sha256:string;retrieval:string}
const base='/data/validation/llm-drawing-review-2026-09-22/'
const colors:Record<string,string>={brow_profile_line:'#83cfff',nasal_dorsum_line:'#ffd166',upper_lip_contour:'#d6a4ff',lower_lip_contour:'#efa5cf',mandibular_aesthetic_line:'#7ce6a5'}
async function runCase(item:Case,index:number){
 const response=await fetch(base+item.path);if(!response.ok)throw Error('image_read_failed')
 const file=new File([await response.blob()],item.id+'.jpg',{type:'image/jpeg'}),result=await readCapture(item.view==='front'?'front':'profile',file,true),url=URL.createObjectURL(result.file)
 try{
 const capture:Capture={id:item.view==='front'?'front':'profile',label:item.view,hint:'',eyebrow:'',url,quality:result.quality,poseValidation:result.pose,straightening:result.straightening,analysisError:result.analysisError},report=buildConsumerReport([capture]),bitmap=await createImageBitmap(result.file)
 const readings=[...report.front,...report.profile,...report.extended],supported=readings.filter(r=>r.available&&r.evidence),group=Math.floor(index/3),codes=item.view==='front'?['FRONT-RATIO-07','FRONT-RATIO-05','FRONT-RATIO-01','FRONT-RATIO-04']:['PROFILE-RATIO-07','PROFILE-LINE-02','PROFILE-ANGLE-03','PROFILE-RATIO-05','PROFILE-ANGLE-01','PROFILE-ANGLE-04'],requested=codes[group%codes.length],selected=supported.find(r=>r.code===requested)??supported[0]
 const audits=readings.map(reading=>({code:reading.code,label:reading.label,...auditReadingEvidence(reading,item.view==='left_profile'?'left':item.view==='right_profile'?'right':undefined)}))
 const w=bitmap.width,h=bitmap.height,b=result.pose?.faceBounds
 const margin=b?{x:Math.max(0,(b.x-.18*b.width)*w),y:Math.max(0,(b.y-.22*b.height)*h),right:Math.min(w,(b.x+1.18*b.width)*w),bottom:Math.min(h,(b.y+1.22*b.height)*h)}:{x:0,y:0,right:w,bottom:h}
 const roi={x:margin.x,y:margin.y,width:Math.max(1,margin.right-margin.x),height:Math.max(1,margin.bottom-margin.y)},canvas=document.createElement('canvas');canvas.width=1440;canvas.height=1320;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#f4f2ee';ctx.fillRect(0,0,1440,1320);ctx.fillStyle='#161d24';ctx.font='bold 22px sans-serif';ctx.fillText(item.id+' | '+item.view,24,30);ctx.font='16px sans-serif';ctx.fillText('同一分析底图；用于绘线审查。No identity or demographic inference.',24,55)
 const native=report.native,front=result.pose?.landmarks&&result.pose.landmarkImageWidth&&result.pose.landmarkImageHeight?buildFrontLandmarkOverlay(result.pose.landmarks,result.pose.landmarkImageWidth,result.pose.landmarkImageHeight):null
 const positions=[[20,78],[730,78],[20,694],[730,694]]
 const draw=(panel:number,title:string,annotation:()=>void)=>{const [x,y]=positions[panel],pw=690,ph=556,scale=Math.min(pw/roi.width,ph/roi.height),ox=x+(pw-roi.width*scale)/2,oy=y+34+(ph-roi.height*scale)/2;ctx.fillStyle='#fff';ctx.fillRect(x,y,pw,ph+34);ctx.fillStyle='#161d24';ctx.font='bold 18px sans-serif';ctx.fillText(title,x+10,y+24);ctx.save();ctx.beginPath();ctx.rect(x,y+34,pw,ph);ctx.clip();ctx.translate(ox,oy);ctx.scale(scale,scale);ctx.translate(-roi.x,-roi.y);ctx.drawImage(bitmap,0,0);ctx.lineWidth=1.2/scale;ctx.lineJoin='round';ctx.lineCap='round';(ctx as any).__scale=scale;annotation();ctx.restore()}
 const line=(points:Array<{x:number;y:number}>,color:string)=>{if(points.length<2)return;ctx.strokeStyle=color;ctx.stroke(new Path2D(profileSemanticPathD(points)))}
 draw(0,'A 分析底图（已应用的校正保留）',()=>{})
 draw(1,'B 检测关键点（编号与原图坐标）',()=>{
  const scale=(ctx as any).__scale,source=item.view==='front'?result.pose?.landmarks:result.pose?.nativeProfile?.landmarks
  const ids=item.view==='front'?[10,168,2,152,234,454,172,397,61,291,33,133,362,263,98,327,1,0,17]:Array.from({length:39},(_,i)=>i)
  if(!source)return
  for(const i of ids){const p=source[i];if(!p)continue;const x=p.x*w,y=p.y*h;ctx.fillStyle='#ffff70';ctx.strokeStyle='#16202a';ctx.lineWidth=.8/scale;ctx.beginPath();ctx.arc(x,y,2.2/scale,0,Math.PI*2);ctx.fill();ctx.stroke();if(item.view==='front'||[4,8,10,11,12,15,16,17,19,20,21,22,26,27,30,33].includes(i)){ctx.font=`bold ${11/scale}px sans-serif`;ctx.lineWidth=2/scale;ctx.strokeText(String(i),x+4/scale,y+(i%2?12:-5)/scale);ctx.fillText(String(i),x+4/scale,y+(i%2?12:-5)/scale)}}
 })
 draw(2,'C 产品轮廓（不连未支持的额部和颈线）',()=>{if(item.view==='front')front?.contours.forEach(p=>line(p.points,'#ffffff'));else if(native)resolveProfileDisplayPaths(native).filter(p=>p.category==='region'&&p.code!=='neck_aesthetic_line').forEach(p=>line(p.points,colors[p.code]??'#ffffff'))})
 draw(3,'D '+(selected?selected.code+' '+selected.label:'无可用测量'),()=>{
  const e=selected?.evidence as MeasurementEvidence|undefined;if(!e)return;const scale=(ctx as any).__scale,points=new Map(e.points.map(p=>[p.id,p]))
  for(const s of e.segments){const a=points.get(s.from)!,b=points.get(s.to)!;ctx.strokeStyle=s.role==='measure'?'#ffca68':s.role==='reference'?'#60d9ef':'#ffffff';ctx.setLineDash(s.role==='measure'?[]:[4/scale,3/scale]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}
  ctx.setLineDash([]);for(const p of e.points){ctx.fillStyle='#ffffff';ctx.strokeStyle='#26303b';ctx.beginPath();ctx.arc(p.x,p.y,2.5/scale,0,Math.PI*2);ctx.fill();ctx.stroke()}
 })
 ctx.fillStyle='#161d24';ctx.font='16px sans-serif';ctx.fillText(selected?selected.value+' | '+selected.evidence?.formula:'质量门未通过或模型无可用结果；不可当作绘图通过',25,1310)
 const analysisSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await result.file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')
 const summary={id:item.id,view:item.view,source:item,version:reportVersion,analysisSha,width:w,height:h,roi,poseStatus:result.pose?.status,estimatedPose:result.pose?.estimatedPose,quality:result.quality,nativeStatus:result.pose?.nativeProfile?.status,nativeReason:result.pose?.nativeProfile?.reason,geometrySource:result.pose?.nativeProfile?.geometrySource,straightening:result.straightening,analysisError:result.analysisError,selectedMetric:selected?.code,readings,pose:result.pose,audits}
 const saved=await fetch('/__drawing_review_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,sheet:canvas.toDataURL('image/png'),result:summary})});bitmap.close();if(!saved.ok)throw Error('output_save_failed:'+await saved.text());return{summary,sheet:canvas.toDataURL('image/png')}
 }finally{URL.revokeObjectURL(url)}
}
function App(){const [cases,setCases]=useState<Case[]>([]),[message,setMessage]=useState('载入清单'),[busy,setBusy]=useState(false),[rows,setRows]=useState<string[]>([]),[preview,setPreview]=useState('');useEffect(()=>{fetch(base+'manifest.json').then(r=>r.json()).then(m=>{setCases(m.cases);setMessage('已准备 '+m.cases.length+' 张授权样本')}).catch(e=>setMessage(String(e)))},[])
 const run=async()=>{setBusy(true);setRows([]);let success=0;for(const [i,item] of cases.entries()){setMessage(`正在检测 ${i+1}/${cases.length} · ${item.id}`);try{const r=await runCase(item,i);success++;setPreview(r.sheet);setRows(v=>[...v,`${item.id} · ${r.summary.poseStatus??'检测不可用'} · ${r.summary.audits.filter(a=>a.status==='pass').length}项复算通过 · ${r.summary.audits.filter(a=>a.status==='fail').length}项不一致`])}catch(e){setRows(v=>[...v,item.id+' · ERROR '+String(e)])}}setBusy(false);setMessage(`批次完成：${success}/${cases.length} 已生成复核图`)}
 return <main style={{maxWidth:1200,margin:'24px auto',padding:16}}><h1>批量绘制复核</h1><p>8张新下载正面 + 16张SHA-256校验的官方侧面缓存；成人研究集，不验证儿童精度。</p><button disabled={busy||!cases.length} onClick={()=>void run()}>运行24张测试并保存复核图</button><p role="status">{message}</p><ol>{rows.map((r,i)=><li key={i}>{r}</li>)}</ol>{preview&&<img src={preview} alt="最近完成的四联复核图" style={{width:'100%'}}/>}</main>
}
createRoot(document.getElementById('root')!).render(<App/> )
