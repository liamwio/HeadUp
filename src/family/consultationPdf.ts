import {sortedSessions,sessionPurpose,type FamilyProfile,type FamilySession,type FamilyMedia} from './model'
import {sideCapture,sideSession} from './captureViews'

export function selectConsultationRecords(sessions:FamilySession[],profileId:string,ids:string[]){
 if(!ids.length||ids.length>3||new Set(ids).size!==ids.length)throw Error('请选择1至3次不同记录')
 const current=sortedSessions(sessions,profileId),rows=ids.map(id=>current.find(s=>s.id===id))
 if(rows.some(r=>!r))throw Error('所选记录已变化，请重新选择')
 return (rows as FamilySession[]).sort((a,b)=>a.recordedOn.localeCompare(b.recordedOn))
}
export function consultationMetrics(session:FamilySession){
 const read=(s:FamilySession,code:string,view:'front'|'profile')=>s.kind==='memory'?'不参与测量':s.report[view].find(r=>r.code===code&&r.available)?.value??'未测出'
 return [read(session,'FRONT-RATIO-07','front'),read(session,'FRONT-RATIO-01','front'),read(sideSession(session,'left_profile'),'PROFILE-ANGLE-01','profile'),read(!session.captures.some(c=>c.id==='right_profile')&&session.captures.some(c=>c.id==='profile'&&c.poseValidation?.estimatedPose==='right_profile')?session:sideSession(session,'right_profile'),'PROFILE-ANGLE-01','profile')]
}
/** One A4 image page preserves Chinese glyphs using local system fonts; no remote font/photo service. */
export async function createConsultationPdf({profile,rows,getMedia,includeName=false,includePhotos=true}:{profile:FamilyProfile;rows:FamilySession[];getMedia:(id:string)=>Promise<FamilyMedia|undefined>;includeName?:boolean;includePhotos?:boolean}){
 if(!rows.length||rows.length>3||rows.some(s=>s.profileId!==profile.id))throw Error('请选择当前档案的1至3次记录')
 await document.fonts.ready
 const canvas=document.createElement('canvas');canvas.width=2480;canvas.height=3508
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('当前环境无法生成PDF')
 ctx.scale(2,2);ctx.fillStyle='#fff';ctx.fillRect(0,0,1240,1754)
 const text=(value:string,x:number,y:number,size=22,color='#29252a',width=1120,maxLines=1)=>{
   ctx.fillStyle=color;ctx.font=`${size}px system-ui, "Microsoft YaHei", sans-serif`
   let line='',lineIndex=0
   for(const char of value.replace(/[\r\n]+/g,' ')){if(ctx.measureText(line+char).width>width){if(lineIndex>=maxLines-1){ctx.fillText(line+'…',x,y+lineIndex*(size+7));return}ctx.fillText(line,x,y+lineIndex*(size+7));lineIndex++;line=char}else line+=char}
   ctx.fillText(line,x,y+lineIndex*(size+7))
 }
 const line=(y:number)=>{ctx.strokeStyle='#ded5d9';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(60,y);ctx.lineTo(1180,y);ctx.stroke()}
 text('HeadUp · 面部生长记录资料',60,85,36,'#782d3e')
 text('用于与专业人员沟通 · 保存时的照片与读数 · 非诊断报告',60,126,21)
 text(includeName?`档案：${profile.nickname}`:'档案名称未导出',60,166,21)
 text(`共 ${rows.length} 次记录 · ${rows[0].recordedOn} 至 ${rows.at(-1)!.recordedOn}`,60,200,21)
 const colWidth=1120/rows.length
 for(const [i,s] of rows.entries()){
   const x=60+i*colWidth
   text(s.recordedOn,x,252,24,'#782d3e',colWidth-20)
   text(sessionPurpose(s),x,283,18,'#635b60',colWidth-20)
   for(const [j,view] of (['front','left_profile','right_profile'] as const).entries()){
     const capture=view==='front'?s.captures.find(c=>c.id==='front'):sideCapture(s,view)??(view==='right_profile'&&!s.captures.some(c=>c.id==='right_profile')?s.captures.find(c=>c.id==='profile'&&c.poseValidation?.estimatedPose==='right_profile'):undefined),pw=(colWidth-24)/3,px=x+j*pw,py=306,ph=200
     ctx.fillStyle='#f4f0f1';ctx.fillRect(px,py,pw-8,ph)
     let message=includePhotos?'未拍摄':'未导出照片'
     if(includePhotos&&capture?.mediaId){let bitmap:ImageBitmap|undefined;try{const m=await getMedia(capture.mediaId);if(!m||m.profileId!==profile.id||m.sessionId!==s.id)throw Error('missing');bitmap=await createImageBitmap(m.originalBlob??m.blob);const scale=Math.min((pw-8)/bitmap.width,ph/bitmap.height);ctx.drawImage(bitmap,px+(pw-8-bitmap.width*scale)/2,py+(ph-bitmap.height*scale)/2,bitmap.width*scale,bitmap.height*scale);message=''}catch{message='照片不可读取'}finally{bitmap?.close()}}
     if(message)text(message,px+4,py+92,15,'#635b60',pw-12,2)
     text(view==='front'?'正面':view==='left_profile'?'左侧':'右侧',px,531,18)
   }
 }
 text('照片按各次原图展示，未进行跨日期形变或轮廓对齐。',60,575,19,'#635b60');line(595)
 text('保存的核心读数',60,638,26,'#782d3e')
 const labels=['下脸高度占比','脸型长宽比','左侧三点夹角','右侧三点夹角'],cw=820/rows.length
 rows.forEach((s,i)=>text(s.recordedOn,345+i*cw,678,19,'#635b60',cw-20))
 labels.forEach((label,j)=>{const y=727+j*58;text(label,60,y,22);rows.forEach((s,i)=>text(consultationMetrics(s)[j],345+i*cw,y,22,'#29252a',cw-18));line(y+18)})
 text('各列为独立保存读数，不表示可直接比较；复拍误差尚未校准，不据此判断真实生长。',60,951,19,'#635b60',1120,2)
 text('拍摄条件与计算版本',60,1006,26,'#782d3e')
 rows.forEach((s,i)=>{
   const y=1054+i*182,p=s.protocol
   text(`${s.recordedOn} · V${(s.revision?.number??0)+1} · ${p.method==='live'?'应用内拍摄':'相册导入'}`,60,y,22,'#782d3e')
   text(`设备：${p.device||'未记录'}  镜头：${p.camera==='rear'?'后置':p.camera==='front'?'前置':'未记录'}  距离：${p.distanceCm===null?'未记录':p.distanceCm+'厘米'}  光线：${p.light==='daylight'?'自然光':p.light==='indoor'?'室内灯光':'未记录'}`,60,y+33,19,'#29252a',1120,2)
   text(`算法：${s.version.algorithm} / ${s.version.norm}`,60,y+93,18,'#635b60',1120,2)
   text(`记录协议：${p.version}；旧读数保留，未按当前版本重算。`,60,y+146,18,'#635b60')
 })
 line(1634);text('仅描述照片中可见的软组织外观。完整历史、全部指标和原始照片请在应用中查看。',60,1676,18,'#635b60',1120,2)
 text('本机生成 · 用户主动导出 · 一页摘要 / 1',60,1730,17,'#635b60')
 const jpeg=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('PDF图片生成失败')),'image/jpeg',.94))
 const {PDFDocument}=await import('pdf-lib'),pdf=await PDFDocument.create(),page=pdf.addPage([595.28,841.89]),img=await pdf.embedJpg(await jpeg.arrayBuffer())
 page.drawImage(img,{x:0,y:0,width:595.28,height:841.89});pdf.setTitle('HeadUp 面部生长记录资料');pdf.setCreator('HeadUp local export')
 const bytes=await pdf.save();return new Blob([new Uint8Array(bytes).buffer],{type:'application/pdf'})
}
