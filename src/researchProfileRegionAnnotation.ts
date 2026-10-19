import{inspectCaptureFile}from'./lib/captureAnalysis'
import{buildNativeProfilePresentation}from'./lib/nativeProfilePresentation'
import{PROFILE_REGION_ANNOTATION_POLICY,PROFILE_REGION_CANONICAL_POLICY,canonicalizeProfileRegionAnnotations,compareProfileRegionAnnotationSessions,emptyProfileRegionAnnotations,evaluateProfileRegionModelError,firstIncompleteProfileRegionCell,nextIncompleteProfileRegionCell,profileRegionAnnotationCoverage,profileRegionAnnotationDefinitions,profileRegionAnnotationGeometryIssues,resolveProfileRegionAnnotationStart,validateProfileRegionAnnotationExport,validateProfileRegionCanonicalExport}from'./lib/profileRegionAnnotationStudy'
import type{NormalizedAnnotationPoint,ProfileRegionAnnotationCase,ProfileRegionAnnotationExport,ProfileRegionCanonicalExport,ProfileRegionName,ProfileRegionPredictionCase}from'./lib/profileRegionAnnotationStudy'

type ManifestCase={reviewId:string;dataset:string;view:string;path:string;sourceResolution:string}
type Manifest={cases:ManifestCase[]}
const projectRoot=''
const manifest=await fetch(`${projectRoot}/data/manual-test/profile-region-truth-v1/manifest.json`).then(response=>response.json())as Manifest
const cases=manifest.cases.filter(item=>item.dataset==='london_highres_confirmation'&&item.view==='right_profile')
if(cases.length!==30)throw new Error(`Expected 30 London right profiles, found ${cases.length}`)

const names=Object.keys(profileRegionAnnotationDefinitions)as ProfileRegionName[]
const requestedStart=resolveProfileRegionAnnotationStart(cases.map(item=>item.reviewId),location.search)
const colors:Record<ProfileRegionName,string>={forehead:'#4baeea',nasalDorsum:'#e6ae2c',maxillarySupport:'#a76bd5',mandibularChin:'#36b873'}
const $=<T extends Element>(selector:string)=>document.querySelector<T>(selector)!
const photo=$<HTMLImageElement>('#photo'),overlay=$<SVGSVGElement>('#overlay'),progress=$('#progress'),caseTitle=$('#case-title'),caseIndex=$('#case-index'),regionsNode=$('#regions'),instruction=$('#instruction'),regionStatus=$('#region-status'),note=$<HTMLTextAreaElement>('#note'),output=$('#output'),caseJump=$<HTMLSelectElement>('#case-jump'),autoAdvance=$<HTMLInputElement>('#auto-advance'),sessionSelect=$<HTMLSelectElement>('#session')
sessionSelect.value=requestedStart.session

const records=new Map<string,ProfileRegionAnnotationCase>()
const predictions=new Map<string,ProfileRegionPredictionCase>()
let currentIndex=requestedStart.caseIndex,activeRegion:ProfileRegionName=requestedStart.region,draggingIndex:number|null=null,loading=false
let zoom=100
let evaluationResult:ReturnType<typeof evaluateProfileRegionModelError>|null=null
let comparisonResult:ReturnType<typeof compareProfileRegionAnnotationSessions>|null=null
let canonicalResult:ReturnType<typeof canonicalizeProfileRegionAnnotations>|null=null
let resumedAnnotatorHash:string|null=null
for(const item of cases){const dimensions=item.sourceResolution.match(/(\d+)\s*[×x]\s*(\d+)/i);records.set(item.reviewId,{reviewId:item.reviewId,width:Number(dimensions?.[1]??0),height:Number(dimensions?.[2]??0),regions:emptyProfileRegionAnnotations()})}
caseJump.innerHTML=cases.map((item,index)=>`<option value="${index}">${String(index+1).padStart(2,'0')} · ${item.reviewId}</option>`).join('')

function currentCase(){return cases[currentIndex]}
function currentRecord(){return records.get(currentCase().reviewId)!}
function currentRegion(){return currentRecord().regions[activeRegion]}
function syncLocation(){const url=new URL(location.href);url.searchParams.set('case',currentCase().reviewId);url.searchParams.set('region',activeRegion);url.searchParams.set('session',session());history.replaceState(null,'',url)}
function setZoom(value:number){zoom=Math.max(70,Math.min(250,value));$('#stage').setAttribute('style',`width:${zoom}%`);$('#zoom-label').textContent=`${zoom}%`}
function session(){return $<HTMLSelectElement>('#session').value as'A'|'B'|'C'}
async function annotatorHash(){const code=$<HTMLInputElement>('#annotator-code').value.trim();if(!code)throw new Error('请输入标注者匿名口令');const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${session()}/${code}`));return[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('')}
function normalizedPointer(event:PointerEvent):NormalizedAnnotationPoint{const rect=overlay.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))}}
function pointsAttribute(points:readonly NormalizedAnnotationPoint[]){return points.map(point=>`${point.x},${point.y}`).join(' ')}

function updateCoverage(){
  const exportValue:ProfileRegionAnnotationExport={policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session:session(),annotatorHash:'0'.repeat(64),blindToModel:true,cases:[...records.values()]}
  const coverage=profileRegionAnnotationCoverage(exportValue)
  progress.textContent=`人工区域 ${coverage.annotated}/${coverage.total} · 不可见 ${coverage.occluded} · 待处理 ${coverage.notReviewed}`
  output.textContent=JSON.stringify({policyVersion:PROFILE_REGION_ANNOTATION_POLICY,coverage,validationErrors:validateProfileRegionAnnotationExport(exportValue)},null,2)
}

async function ensurePrediction(item:ManifestCase){
  const existing=predictions.get(item.reviewId);if(existing)return existing
  const url=`${projectRoot}/${item.path}`,blob=await fetch(url).then(response=>response.blob()),inspected=await inspectCaptureFile('profile',new File([blob],`${item.reviewId}.jpg`,{type:blob.type||'image/jpeg'})),presentation=buildNativeProfilePresentation(inspected.pose.nativeProfile,inspected.width,inspected.height)
  const byPath=Object.fromEntries((presentation?.paths??[]).map(path=>[path.code,path.points.map(point=>({x:point.x/inspected.width,y:point.y/inspected.height}))]))as Record<string,NormalizedAnnotationPoint[]>
  const brow=presentation?.points[14],menton=presentation?.points[8],visibleProfileHeightRatio=brow&&menton?Math.hypot((brow.x-menton.x)/inspected.width,(brow.y-menton.y)/inspected.height):0
  const prediction:ProfileRegionPredictionCase={reviewId:item.reviewId,visibleProfileHeightRatio,regions:Object.fromEntries(names.map(name=>[name,byPath[profileRegionAnnotationDefinitions[name].pathCode]]))as Partial<Record<ProfileRegionName,NormalizedAnnotationPoint[]>>}
  predictions.set(item.reviewId,prediction);return prediction
}

function renderRegionButtons(){
  regionsNode.innerHTML=names.map(name=>{const definition=profileRegionAnnotationDefinitions[name],region=currentRecord().regions[name],state=region.status==='annotated'?`${region.points.length}/${definition.pointCount}`:region.status==='occluded'?'不可见':'未标';return`<button data-region="${name}" class="region-button ${name===activeRegion?'active':''}"><span>${definition.label}</span><small>${state}</small></button>`}).join('')
  regionsNode.querySelectorAll<HTMLButtonElement>('[data-region]').forEach(button=>button.addEventListener('click',()=>{activeRegion=button.dataset.region as ProfileRegionName;syncLocation();render()}))
}

function renderOverlay(){
  const record=currentRecord()
  const manualSvg=names.map(name=>{const points=record.regions[name].points;if(!points.length)return'';const circles=points.map((point,index)=>`<circle class="manual-point" data-region="${name}" data-index="${index}" cx="${point.x}" cy="${point.y}" r="0.006" fill="${colors[name]}"/><text class="manual-index" x="${point.x+.008}" y="${point.y-.008}" fill="${colors[name]}" font-size="0.018" stroke-width="0.003">${index+1}</text>`).join('');return`<polyline class="manual" stroke="${colors[name]}" points="${pointsAttribute(points)}"/>${circles}`}).join('')
  overlay.innerHTML=manualSvg
  overlay.querySelectorAll<SVGCircleElement>('.manual-point').forEach(circle=>circle.addEventListener('pointerdown',event=>{if(circle.dataset.region!==activeRegion)return;event.stopPropagation();draggingIndex=Number(circle.dataset.index);circle.setPointerCapture(event.pointerId)}))
}

function render(){
  const definition=profileRegionAnnotationDefinitions[activeRegion],region=currentRegion()
  caseTitle.textContent=currentCase().reviewId
  caseIndex.textContent=`${currentIndex+1} / ${cases.length} · ${currentCase().sourceResolution}`
  caseJump.value=String(currentIndex)
  instruction.innerHTML=`<strong>${definition.instruction}</strong><ol>${definition.pointLabels.map((label,index)=>`<li>${index+1}. ${label}</li>`).join('')}</ol>`
  note.value=region.note??''
  const geometryIssues=profileRegionAnnotationGeometryIssues(activeRegion,region),nextLabel=definition.pointLabels[region.points.length],baseStatus=region.status==='occluded'?'本区域已标记不可见，不参与坐标误差。':region.status==='annotated'?`人工点已完成 ${region.points.length}/${definition.pointCount}；可拖动圆点修正。`:`请依次点击 ${definition.pointCount} 个点，当前 ${region.points.length}/${definition.pointCount}。${nextLabel?` 下一点：${nextLabel}。`:''}`
  regionStatus.textContent=[baseStatus,...geometryIssues.errors.map(issue=>`阻断：${issue}`),...geometryIssues.warnings.map(issue=>`检查：${issue}`)].join('\n')
  renderRegionButtons();renderOverlay();updateCoverage()
}

function advanceAfterCompletion(){
  if(!autoAdvance.checked){render();return}
  const next=nextIncompleteProfileRegionCell({cases:[...records.values()]},currentIndex,activeRegion)
  if(!next){render();$('#session-note').textContent=`会话${session()}的120个区域均已处理；请保存当前会话JSON。`;return}
  activeRegion=next.region
  if(next.caseIndex!==currentIndex)void load(next.caseIndex);else{syncLocation();render()}
}

async function load(index:number){
  if(loading)return;loading=true;currentIndex=Math.max(0,Math.min(cases.length-1,index));const item=currentCase()
  caseTitle.textContent=`${item.reviewId} · 正在加载照片…`
  const url=`${projectRoot}/${item.path}`
  await new Promise<void>((resolve,reject)=>{photo.onload=()=>resolve();photo.onerror=()=>reject(new Error('Unable to load image'));photo.src=url})
  overlay.setAttribute('viewBox','0 0 1 1');overlay.setAttribute('preserveAspectRatio','none')
  const record=records.get(item.reviewId)!;record.width=photo.naturalWidth;record.height=photo.naturalHeight
  loading=false;syncLocation();render()
}

overlay.addEventListener('pointerdown',event=>{
  if(draggingIndex!==null)return
  const region=currentRegion(),definition=profileRegionAnnotationDefinitions[activeRegion]
  if(region.status==='occluded'||region.points.length>=definition.pointCount)return
  region.points.push(normalizedPointer(event));const completed=region.points.length===definition.pointCount;region.status=completed?'annotated':'not_reviewed';if(completed)advanceAfterCompletion();else render()
})
overlay.addEventListener('pointermove',event=>{if(draggingIndex===null)return;const region=currentRegion();region.points[draggingIndex]=normalizedPointer(event);renderOverlay()})
overlay.addEventListener('pointerup',()=>{draggingIndex=null;render()});overlay.addEventListener('pointercancel',()=>{draggingIndex=null})
note.addEventListener('input',()=>{currentRegion().note=note.value.trim()||undefined})
$<HTMLButtonElement>('#undo').addEventListener('click',()=>{const region=currentRegion();region.points.pop();region.status=region.points.length===profileRegionAnnotationDefinitions[activeRegion].pointCount?'annotated':'not_reviewed';render()})
$<HTMLButtonElement>('#clear').addEventListener('click',()=>{currentRecord().regions[activeRegion]={status:'not_reviewed',points:[],note:currentRegion().note};render()})
$<HTMLButtonElement>('#occluded').addEventListener('click',()=>{currentRecord().regions[activeRegion]={status:'occluded',points:[],note:currentRegion().note};advanceAfterCompletion()})
$<HTMLButtonElement>('#previous').addEventListener('click',()=>load(currentIndex-1))
$<HTMLButtonElement>('#next').addEventListener('click',()=>load(currentIndex+1))
caseJump.addEventListener('change',()=>void load(Number(caseJump.value)))
$<HTMLButtonElement>('#zoom-out').addEventListener('click',()=>setZoom(zoom-25))
$<HTMLButtonElement>('#zoom-in').addEventListener('click',()=>setZoom(zoom+25))
$<HTMLButtonElement>('#zoom-reset').addEventListener('click',()=>setZoom(100))
$<HTMLButtonElement>('#export').addEventListener('click',async()=>{
  try{const hash=await annotatorHash();if(resumedAnnotatorHash&&hash!==resumedAnnotatorHash)throw new Error('匿名口令与导入会话不一致');const exportValue:ProfileRegionAnnotationExport={policyVersion:PROFILE_REGION_ANNOTATION_POLICY,createdAt:new Date().toISOString(),session:session(),annotatorHash:hash,blindToModel:true,cases:[...records.values()]},errors=validateProfileRegionAnnotationExport(exportValue);if(errors.length)throw new Error(errors.join('；'));const blob=new Blob([JSON.stringify(exportValue,null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`headup-profile-region-manual-${session()}-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),0)}catch(error){output.textContent=`导出失败：${error instanceof Error?error.message:String(error)}`}
})

$<HTMLButtonElement>('#evaluate').addEventListener('click',async()=>{
  const file=$<HTMLInputElement>('#manual-json').files?.[0],evaluationOutput=$('#evaluation-output'),exportButton=$<HTMLButtonElement>('#export-evaluation')
  if(!file){evaluationOutput.textContent='请先选择人工标注JSON。';return}
  try{
    const manual=JSON.parse(await file.text())as ProfileRegionAnnotationExport|ProfileRegionCanonicalExport,errors=manual.policyVersion===PROFILE_REGION_CANONICAL_POLICY?validateProfileRegionCanonicalExport(manual):validateProfileRegionAnnotationExport(manual),expectedIds=new Set(cases.map(item=>item.reviewId))
    if(errors.length)throw new Error(errors.join('；'))
    if(manual.cases.length!==cases.length||manual.cases.some(item=>!expectedIds.has(item.reviewId)))throw new Error('人工JSON必须覆盖本页面固定的30张右侧面照片')
    for(const[index,item]of cases.entries()){evaluationOutput.textContent=`正在重跑模型 ${index+1}/${cases.length} · ${item.reviewId}`;await ensurePrediction(item)}
    evaluationResult=evaluateProfileRegionModelError(manual,[...predictions.values()]);evaluationOutput.textContent=JSON.stringify(evaluationResult,null,2);exportButton.disabled=false
  }catch(error){evaluationResult=null;exportButton.disabled=true;evaluationOutput.textContent=`评估失败：${error instanceof Error?error.message:String(error)}`}
})
$<HTMLButtonElement>('#export-evaluation').addEventListener('click',()=>{
  if(!evaluationResult)return
  const blob=new Blob([JSON.stringify(evaluationResult,null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`headup-profile-region-model-vs-manual-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),0)
})
$<HTMLButtonElement>('#compare').addEventListener('click',async()=>{
  const a=$<HTMLInputElement>('#compare-a').files?.[0],b=$<HTMLInputElement>('#compare-b').files?.[0],comparisonOutput=$('#comparison-output'),exportButton=$<HTMLButtonElement>('#export-comparison')
  if(!a||!b){comparisonOutput.textContent='请选择A、B两份会话JSON。';return}
  try{comparisonResult=compareProfileRegionAnnotationSessions(JSON.parse(await a.text()),JSON.parse(await b.text()));comparisonOutput.textContent=JSON.stringify(comparisonResult,null,2);exportButton.disabled=false}catch(error){comparisonResult=null;exportButton.disabled=true;comparisonOutput.textContent=`比较失败：${error instanceof Error?error.message:String(error)}`}
})
$<HTMLButtonElement>('#export-comparison').addEventListener('click',()=>{
  if(!comparisonResult)return
  const blob=new Blob([JSON.stringify(comparisonResult,null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`headup-profile-region-inter-rater-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),0)
})
sessionSelect.addEventListener('change',()=>{
  resumedAnnotatorHash=null
  records.clear();for(const item of cases){const dimensions=item.sourceResolution.match(/(\d+)\s*[×x]\s*(\d+)/i);records.set(item.reviewId,{reviewId:item.reviewId,width:Number(dimensions?.[1]??0),height:Number(dimensions?.[2]??0),regions:emptyProfileRegionAnnotations()})}
  currentIndex=0;activeRegion='forehead';$('#session-note').textContent=session()==='C'?'C盲裁决模式：模型完全不运行、不显示。请依据A/B一致性报告中的待裁决清单独立重画。':'A、B模型盲标模式：不运行、不显示模型线；两人必须独立完成，切换会话会清空当前内存标注。';void load(0)
})
$<HTMLButtonElement>('#resume').addEventListener('click',async()=>{
  const file=$<HTMLInputElement>('#resume-json').files?.[0];if(!file){output.textContent='请选择需要恢复的会话JSON。';return}
  try{
    const value=JSON.parse(await file.text())as ProfileRegionAnnotationExport,errors=validateProfileRegionAnnotationExport(value),expectedIds=new Set(cases.map(item=>item.reviewId))
    if(errors.length)throw new Error(errors.join('；'))
    if(value.cases.length!==cases.length||value.cases.some(item=>!expectedIds.has(item.reviewId)))throw new Error('恢复文件必须覆盖固定30张确认集照片')
    sessionSelect.value=value.session;resumedAnnotatorHash=value.annotatorHash;records.clear();for(const item of value.cases)records.set(item.reviewId,item)
    const pending=firstIncompleteProfileRegionCell(value);currentIndex=pending?.caseIndex??0;activeRegion=pending?.region??'forehead';$('#session-note').textContent=`已恢复会话${value.session}；${pending?'已跳到首个待处理区域':'全部区域已处理'}。导出时必须输入原匿名口令。`;await load(currentIndex)
  }catch(error){output.textContent=`恢复失败：${error instanceof Error?error.message:String(error)}`}
})
$<HTMLButtonElement>('#canonicalize').addEventListener('click',async()=>{
  const files=[$<HTMLInputElement>('#canonical-a').files?.[0],$<HTMLInputElement>('#canonical-b').files?.[0],$<HTMLInputElement>('#canonical-c').files?.[0]],canonicalOutput=$('#canonical-output'),exportButton=$<HTMLButtonElement>('#export-canonical')
  if(files.some(file=>!file)){canonicalOutput.textContent='请选择A、B、C三份会话JSON。';return}
  try{const values=[];for(const file of files)values.push(JSON.parse(await file!.text())as ProfileRegionAnnotationExport);canonicalResult=canonicalizeProfileRegionAnnotations(values[0],values[1],values[2]);canonicalOutput.textContent=JSON.stringify(canonicalResult,null,2);exportButton.disabled=false}catch(error){canonicalResult=null;exportButton.disabled=true;canonicalOutput.textContent=`canonical生成失败：${error instanceof Error?error.message:String(error)}`}
})
$<HTMLButtonElement>('#export-canonical').addEventListener('click',()=>{
  if(!canonicalResult)return
  const blob=new Blob([JSON.stringify(canonicalResult,null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`headup-profile-region-canonical-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),0)
})
document.addEventListener('keydown',event=>{
  if(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement||event.target instanceof HTMLSelectElement)return
  if(event.key==='ArrowLeft'){event.preventDefault();void load(currentIndex-1);return}
  if(event.key==='ArrowRight'){event.preventDefault();void load(currentIndex+1);return}
  if(/^[1-4]$/.test(event.key)){activeRegion=names[Number(event.key)-1];syncLocation();render();return}
  if(event.key.toLowerCase()==='z')$<HTMLButtonElement>('#undo').click()
  if(event.key.toLowerCase()==='o')$<HTMLButtonElement>('#occluded').click()
  if(event.key==='+'||event.key==='=')setZoom(zoom+25)
  if(event.key==='-')setZoom(zoom-25)
  if(event.key==='0')setZoom(100)
})

setZoom(100)
await load(currentIndex)
