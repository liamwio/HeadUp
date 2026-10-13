import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { computeFrontGeometry, type FrontGeometry } from '../src/lib/faceMeasurements'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import type { LandmarkPoint } from '../src/types'
import { detectFaceLandmarksSource } from '../src/lib/facePose'

declare global { interface Window { __HEADUP_AVATAR_ROBUSTNESS__?: unknown } }
type ManifestRecord = { id: string; relativePath: string; externalAssetId?: string; view?: string }
type Metric = Exclude<keyof FrontGeometry, 'midLowerFaceHeightRatio'>
type VariantName = 'jpeg_quality_75'|'brightness_85_percent'|'brightness_115_percent'|'contrast_85_percent'|'saturation_70_percent'|'warm_tone_15_percent'|'blur_0_6_px'|'rotate_minus_2_degrees'|'rotate_plus_2_degrees'|'shift_right_3_percent'|'shift_down_3_percent'|'center_zoom_5_percent'|'compress_width_2_percent'|'compress_height_2_percent'|'shear_x_2_percent'|'shear_y_2_percent'
type LipCandidateName = 'currentSingleEuclidean'|'singleProjected'|'triMedianEuclidean'|'triMeanEuclidean'|'triMedianProjected'|'triMeanProjected'|'triCentroidEuclidean'|'triCentroidProjected'|'fiveMedianEuclidean'|'fiveMedianProjected'|'fiveCentroidEuclidean'|'fiveCentroidProjected'
type EnsembleCandidateName = 'ensembleCurrentVertical3Median'|'ensembleCurrentAxis5Median'|'ensembleTriVertical3Median'|'ensembleTriAxis5Median'

const sourceName = new URLSearchParams(location.search).get('source') || 'ffhq'
if (!['ffhq','london'].includes(sourceName)) throw new Error(`非法来源标识: ${sourceName}`)
const datasetId = sourceName==='london'?'london-authorized-front':'ffhq-highres'
const projectRoot = '/@fs/D:/AICodex/HeadUp'
const manifestUrl = sourceName==='london'?`${projectRoot}/data/face-db-real-research/manifest.jsonl`:`${projectRoot}/data/face-db-real-research/avatar-smoke/${datasetId}/manifest.jsonl`
const statusElement = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const summaryElement = document.querySelector<HTMLElement>('#summary')!
const variantRows = document.querySelector<HTMLElement>('#variantRows')!
const metricGrid = document.querySelector<HTMLElement>('#metricGrid')!
const lipCandidateRows = document.querySelector<HTMLElement>('#lipCandidateRows')!
const samples = document.querySelector<HTMLElement>('#samples')!
window.addEventListener('unhandledrejection', (event) => { const message=event.reason instanceof Error?event.reason.stack||event.reason.message:String(event.reason);resultElement.dataset.error=message;resultElement.textContent=message;statusElement.textContent='失败' })
const metrics: Metric[] = ['mirrorResidual','visibleFaceLengthWidthRatio','pupilDistanceFaceWidthRatio','interEyeRatio','eyeCanthalTiltDegrees','jawWidthRatio','mouthWidthRatio','midfaceHeightRatio','lowerFaceHeightRatio','noseMouthWidthRatio','noseLengthFaceHeightRatio','lipHeightMouthWidthRatio']
const stableMetrics = new Set<Metric>(['pupilDistanceFaceWidthRatio','jawWidthRatio'])
const variantNames: VariantName[] = ['jpeg_quality_75','brightness_85_percent','brightness_115_percent','contrast_85_percent','saturation_70_percent','warm_tone_15_percent','blur_0_6_px','rotate_minus_2_degrees','rotate_plus_2_degrees','shift_right_3_percent','shift_down_3_percent','center_zoom_5_percent','compress_width_2_percent','compress_height_2_percent','shear_x_2_percent','shear_y_2_percent']
const variantLabels: Record<VariantName,string> = { jpeg_quality_75:'JPEG 75%',brightness_85_percent:'亮度 85%',brightness_115_percent:'亮度 115%',contrast_85_percent:'对比度 85%',saturation_70_percent:'饱和度 70%',warm_tone_15_percent:'暖色偏移 15%',blur_0_6_px:'轻微模糊 0.6px',rotate_minus_2_degrees:'旋转 −2°',rotate_plus_2_degrees:'旋转 +2°',shift_right_3_percent:'右移 3%',shift_down_3_percent:'下移 3%',center_zoom_5_percent:'中心放大 5%',compress_width_2_percent:'横向压缩 2%',compress_height_2_percent:'纵向压缩 2%',shear_x_2_percent:'水平剪切 2%',shear_y_2_percent:'垂直剪切 2%' }
const lipCandidateNames: LipCandidateName[] = ['currentSingleEuclidean','singleProjected','triMedianEuclidean','triMeanEuclidean','triMedianProjected','triMeanProjected','triCentroidEuclidean','triCentroidProjected','fiveMedianEuclidean','fiveMedianProjected','fiveCentroidEuclidean','fiveCentroidProjected']
const lipCandidateLabels: Record<LipCandidateName,string> = { currentSingleEuclidean:'当前：0–17欧氏距离',singleProjected:'0–17面轴投影',triMedianEuclidean:'三组外唇欧氏距离中位',triMeanEuclidean:'三组外唇欧氏距离均值',triMedianProjected:'三组外唇面轴投影中位',triMeanProjected:'三组外唇面轴投影均值',triCentroidEuclidean:'三点上下唇质心欧氏距离',triCentroidProjected:'三点上下唇质心面轴投影',fiveMedianEuclidean:'五组外唇欧氏距离中位',fiveMedianProjected:'五组外唇面轴投影中位',fiveCentroidEuclidean:'五点上下唇质心欧氏距离',fiveCentroidProjected:'五点上下唇质心面轴投影' }
const ensembleCandidateNames: EnsembleCandidateName[] = ['ensembleCurrentVertical3Median','ensembleCurrentAxis5Median','ensembleTriVertical3Median','ensembleTriAxis5Median']
const ensembleCandidateLabels: Record<EnsembleCandidateName,string> = { ensembleCurrentVertical3Median:'当前公式：上下1%三次中位',ensembleCurrentAxis5Median:'当前公式：四向1%五次中位',ensembleTriVertical3Median:'三组中位公式：上下1%三次中位',ensembleTriAxis5Median:'三组中位公式：四向1%五次中位' }

function round(value:number,digits=6){return Number(value.toFixed(digits))}
function percentile(values:number[],fraction:number){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.max(0,Math.round((sorted.length-1)*fraction)))]}
function distribution(values:number[]){return values.length?{min:round(Math.min(...values)),median:round(percentile(values,.5)),p95:round(percentile(values,.95)),max:round(Math.max(...values))}:{min:null,median:null,p95:null,max:null}}
function escapeHtml(value:unknown){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
function median(values:number[]){const sorted=[...values].sort((a,b)=>a-b);const middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2}
function mean(values:number[]){return values.reduce((sum,value)=>sum+value,0)/values.length}
function lipCandidates(landmarks:LandmarkPoint[],width:number,height:number):Record<LipCandidateName,number>{
  const aspect=width/height
  const point=(index:number)=>({x:landmarks[index].x*aspect,y:landmarks[index].y})
  const distance=(left:number,right:number)=>{const a=point(left),b=point(right);return Math.hypot(a.x-b.x,a.y-b.y)}
  const axisPoints=[10,168,6,1,2,152].map(point);const origin={x:mean(axisPoints.map(value=>value.x)),y:mean(axisPoints.map(value=>value.y))}
  const covariance=axisPoints.reduce((value,current)=>{const x=current.x-origin.x,y=current.y-origin.y;value.xx+=x*x;value.xy+=x*y;value.yy+=y*y;return value},{xx:0,xy:0,yy:0})
  const angle=.5*Math.atan2(2*covariance.xy,covariance.xx-covariance.yy);let vertical={x:Math.cos(angle),y:Math.sin(angle)};if(Math.abs(vertical.x)>Math.abs(vertical.y))vertical={x:-vertical.y,y:vertical.x};if(vertical.y<0)vertical={x:-vertical.x,y:-vertical.y}
  const projected=(upper:number,lower:number)=>{const a=point(upper),b=point(lower);return Math.abs((b.x-a.x)*vertical.x+(b.y-a.y)*vertical.y)}
  const mouthWidth=Math.max(distance(61,291),1e-6);const triPairs:[[number,number],[number,number],[number,number]]=[[37,84],[0,17],[267,314]];const fivePairs:[[number,number],[number,number],[number,number],[number,number],[number,number]]=[[39,181],[37,84],[0,17],[267,314],[269,405]]
  const values=(pairs:Array<[number,number]>)=>({euclidean:pairs.map(([upper,lower])=>distance(upper,lower)/mouthWidth),projection:pairs.map(([upper,lower])=>projected(upper,lower)/mouthWidth)})
  const tri=values(triPairs),five=values(fivePairs)
  const centroid=(indices:number[])=>({x:mean(indices.map(index=>point(index).x)),y:mean(indices.map(index=>point(index).y))})
  const centroidValues=(pairs:Array<[number,number]>)=>{const upper=centroid(pairs.map(pair=>pair[0])),lower=centroid(pairs.map(pair=>pair[1]));const dx=lower.x-upper.x,dy=lower.y-upper.y;return{euclidean:Math.hypot(dx,dy)/mouthWidth,projection:Math.abs(dx*vertical.x+dy*vertical.y)/mouthWidth}}
  const triCentroid=centroidValues(triPairs),fiveCentroid=centroidValues(fivePairs)
  return{currentSingleEuclidean:tri.euclidean[1],singleProjected:tri.projection[1],triMedianEuclidean:median(tri.euclidean),triMeanEuclidean:mean(tri.euclidean),triMedianProjected:median(tri.projection),triMeanProjected:mean(tri.projection),triCentroidEuclidean:triCentroid.euclidean,triCentroidProjected:triCentroid.projection,fiveMedianEuclidean:median(five.euclidean),fiveMedianProjected:median(five.projection),fiveCentroidEuclidean:fiveCentroid.euclidean,fiveCentroidProjected:fiveCentroid.projection}
}
async function canvasBlob(canvas:HTMLCanvasElement,quality=.95){return new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Canvas encoding failed')),'image/jpeg',quality))}
function drawCanvas(bitmap:ImageBitmap,draw:(ctx:CanvasRenderingContext2D,w:number,h:number)=>void){const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);draw(ctx,canvas.width,canvas.height);return canvas}
async function variantsFor(bitmap:ImageBitmap):Promise<Record<VariantName,Blob>>{
  const standard=drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,0,0,w,h))
  const brightness=async(value:number)=>canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>{ctx.filter=`brightness(${value}%)`;ctx.drawImage(bitmap,0,0,w,h)}))
  const filtered=async(filter:string)=>canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>{ctx.filter=filter;ctx.drawImage(bitmap,0,0,w,h)}))
  const rotate=async(degrees:number)=>canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>{ctx.translate(w/2,h/2);ctx.rotate(degrees*Math.PI/180);ctx.drawImage(bitmap,-w/2,-h/2,w,h)}))
  return {
    jpeg_quality_75:await canvasBlob(standard,.75),brightness_85_percent:await brightness(85),brightness_115_percent:await brightness(115),contrast_85_percent:await filtered('contrast(85%)'),saturation_70_percent:await filtered('saturate(70%)'),warm_tone_15_percent:await filtered('sepia(15%) saturate(105%)'),blur_0_6_px:await filtered('blur(0.6px)'),
    rotate_minus_2_degrees:await rotate(-2),rotate_plus_2_degrees:await rotate(2),
    shift_right_3_percent:await canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,w*.03,0,w,h))),
    shift_down_3_percent:await canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,0,h*.03,w,h))),
    center_zoom_5_percent:await canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,-w*.025,-h*.025,w*1.05,h*1.05))),
    compress_width_2_percent:await canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,w*.01,0,w*.98,h))),
    compress_height_2_percent:await canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,0,h*.01,w,h*.98))),
    shear_x_2_percent:await canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>{ctx.transform(1,0,.02,1,-w*.01,0);ctx.drawImage(bitmap,0,0,w,h)})),
    shear_y_2_percent:await canvasBlob(drawCanvas(bitmap,(ctx,w,h)=>{ctx.transform(1,.02,0,1,0,-h*.01);ctx.drawImage(bitmap,0,0,w,h)})),
  }
}
async function ensembleLip(blob:Blob){
  const bitmap=await createImageBitmap(blob);const started=performance.now()
  try{
    const sources=[
      drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,0,0,w,h)),
      drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,-w*.01,0,w,h)),
      drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,w*.01,0,w,h)),
      drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,0,-h*.01,w,h)),
      drawCanvas(bitmap,(ctx,w,h)=>ctx.drawImage(bitmap,0,h*.01,w,h)),
    ]
    const current:number[]=[],tri:number[]=[]
    for(const source of sources){const landmarks=(await detectFaceLandmarksSource(source))[0];if(!landmarks||landmarks.length!==478)return null;const values=lipCandidates(landmarks,source.width,source.height);current.push(values.currentSingleEuclidean);tri.push(values.triMedianEuclidean)}
    return{values:{ensembleCurrentVertical3Median:median([current[0],current[3],current[4]]),ensembleCurrentAxis5Median:median(current),ensembleTriVertical3Median:median([tri[0],tri[3],tri[4]]),ensembleTriAxis5Median:median(tri)} as Record<EnsembleCandidateName,number>,elapsedMs:performance.now()-started,detections:5}
  }finally{bitmap.close()}
}
async function inspectBlob(blob:Blob,name:string){const file=new File([blob],name,{type:blob.type||'image/jpeg'});const inspected=await inspectCaptureFile('front',file);const accepted=isPhotoQualityAcceptable(inspected.quality)&&inspected.pose.status==='pass'&&inspected.pose.landmarks?.length===478&&inspected.pose.robustLipHeightMouthWidthRatio!==undefined;const geometry=accepted?computeFrontGeometry(inspected.pose.landmarks!,inspected.width,inspected.height,inspected.pose.robustLipHeightMouthWidthRatio):null;const lip=accepted?lipCandidates(inspected.pose.landmarks!,inspected.width,inspected.height):null;return{accepted,geometry,lip,quality:inspected.quality,pose:inspected.pose}}

const manifestResponse=await fetch(manifestUrl);if(!manifestResponse.ok)throw new Error(`无法读取manifest: ${manifestResponse.status}`)
const records=(await manifestResponse.text()).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as ManifestRecord).filter(record=>sourceName!=='london'||record.view==='front')
const baselines=[] as Array<{record:ManifestRecord;url:string;blob:Blob;geometry:FrontGeometry;lip:Record<LipCandidateName,number>;ensemble:{values:Record<EnsembleCandidateName,number>;elapsedMs:number;detections:number}}>
for(const[index,record]of records.entries()){
  statusElement.textContent=`筛选基线 ${index+1} / ${records.length}`
  const url=sourceName==='london'?`${projectRoot}/data/face-db-real-research/${record.relativePath.replaceAll('\\','/')}`:`${projectRoot}/${record.relativePath.replaceAll('\\','/')}`;const response=await fetch(url);if(!response.ok)throw new Error(`无法读取 ${record.id}`)
  const blob=await response.blob();const inspected=await inspectBlob(blob,`${record.id}.jpg`)
  if(inspected.accepted&&inspected.geometry&&inspected.lip){const ensemble=await ensembleLip(blob);if(ensemble)baselines.push({record,url,blob,geometry:inspected.geometry,lip:inspected.lip,ensemble})}
}

const comparisons=Object.fromEntries(variantNames.map(name=>[name,[] as Array<{baseline:FrontGeometry;measured:FrontGeometry}>])) as Record<VariantName,Array<{baseline:FrontGeometry;measured:FrontGeometry}>>
const lipComparisons=Object.fromEntries(variantNames.map(name=>[name,[] as Array<{baseline:Record<LipCandidateName,number>;measured:Record<LipCandidateName,number>}>])) as Record<VariantName,Array<{baseline:Record<LipCandidateName,number>;measured:Record<LipCandidateName,number>}>>
const ensembleComparisons=Object.fromEntries(variantNames.map(name=>[name,[] as Array<{baseline:Record<EnsembleCandidateName,number>;measured:Record<EnsembleCandidateName,number>;elapsedMs:number}>])) as Record<VariantName,Array<{baseline:Record<EnsembleCandidateName,number>;measured:Record<EnsembleCandidateName,number>;elapsedMs:number}>>
const rejectedReasons=Object.fromEntries(variantNames.map(name=>[name,{} as Record<string,number>])) as Record<VariantName,Record<string,number>>
for(const[baselineIndex,baseline]of baselines.entries()){
  statusElement.textContent=`扰动回归 ${baselineIndex+1} / ${baselines.length}`
  const bitmap=await createImageBitmap(baseline.blob)
  try{
    const variants=await variantsFor(bitmap)
    for(const name of variantNames){
      const inspected=await inspectBlob(variants[name],`${baseline.record.id}-${name}.jpg`)
      if(inspected.accepted&&inspected.geometry&&inspected.lip){const ensemble=await ensembleLip(variants[name]);if(ensemble){comparisons[name].push({baseline:baseline.geometry,measured:inspected.geometry});lipComparisons[name].push({baseline:baseline.lip,measured:inspected.lip});ensembleComparisons[name].push({baseline:baseline.ensemble.values,measured:ensemble.values,elapsedMs:ensemble.elapsedMs})}else rejectedReasons[name]['微扰集成关键点不足']=(rejectedReasons[name]['微扰集成关键点不足']||0)+1}
      else{const reasons=[...inspected.quality.flags,...inspected.pose.flags];for(const reason of reasons.length?reasons:['未生成完整测量'])rejectedReasons[name][reason]=(rejectedReasons[name][reason]||0)+1}
    }
  }finally{bitmap.close()}
}

const byVariant=Object.fromEntries(variantNames.map(name=>[name,{retained:comparisons[name].length,rejected:baselines.length-comparisons[name].length,retentionRate:round(comparisons[name].length/Math.max(1,baselines.length),4),reasonCounts:rejectedReasons[name],metrics:Object.fromEntries(metrics.map(metric=>{const absolute=comparisons[name].map(item=>Math.abs(item.measured[metric]-item.baseline[metric]));const relative=comparisons[name].map(item=>Math.abs(item.measured[metric]-item.baseline[metric])/Math.max(Math.abs(item.baseline[metric]),1e-6));return[metric,{absoluteDifference:distribution(absolute),relativeDifference:distribution(relative)}]}))}])) as Record<VariantName,any>
const perMetricGates=Object.fromEntries(metrics.map(metric=>[metric,{p95WithinThreshold:variantNames.every(name=>metric==='mirrorResidual'?byVariant[name].metrics[metric].absoluteDifference.p95<=.03:metric==='eyeCanthalTiltDegrees'?byVariant[name].metrics[metric].absoluteDifference.p95<=1:byVariant[name].metrics[metric].relativeDifference.p95<=(stableMetrics.has(metric)?.03:.08)),worstP95:round(Math.max(...variantNames.map(name=>metric==='mirrorResidual'||metric==='eyeCanthalTiltDegrees'?byVariant[name].metrics[metric].absoluteDifference.p95:byVariant[name].metrics[metric].relativeDifference.p95)),6)}]))
const staticLipCandidateDiagnostics=Object.fromEntries(lipCandidateNames.map(candidate=>{
  const byVariant=Object.fromEntries(variantNames.map(name=>{const relative=lipComparisons[name].map(item=>Math.abs(item.measured[candidate]-item.baseline[candidate])/Math.max(Math.abs(item.baseline[candidate]),1e-6));return[name,{relativeDifference:distribution(relative)}]}))
  const worstP95=Math.max(...variantNames.map(name=>(byVariant[name] as any).relativeDifference.p95));const scale=distribution(baselines.map(item=>item.lip[candidate]/Math.max(item.lip.currentSingleEuclidean,1e-6)));const passesStability=worstP95<=.08;const preservesCurrentScale=scale.median!==null&&scale.median>=.75&&scale.median<=1.25
  return[candidate,{label:lipCandidateLabels[candidate],worstP95:round(worstP95,6),baselineScaleRelativeToCurrent:scale,passesStability,preservesCurrentScale,eligibleForIndependentConfirmation:passesStability&&preservesCurrentScale,byVariant}]
})) as Record<LipCandidateName,any>
const ensembleLipCandidateDiagnostics=Object.fromEntries(ensembleCandidateNames.map(candidate=>{
  const byVariant=Object.fromEntries(variantNames.map(name=>{const relative=ensembleComparisons[name].map(item=>Math.abs(item.measured[candidate]-item.baseline[candidate])/Math.max(Math.abs(item.baseline[candidate]),1e-6));return[name,{relativeDifference:distribution(relative)}]}))
  const worstP95=Math.max(...variantNames.map(name=>(byVariant[name] as any).relativeDifference.p95));const scale=distribution(baselines.map(item=>item.ensemble.values[candidate]/Math.max(item.lip.currentSingleEuclidean,1e-6)));const passesStability=worstP95<=.08;const preservesCurrentScale=scale.median!==null&&scale.median>=.75&&scale.median<=1.25
  return[candidate,{label:ensembleCandidateLabels[candidate],worstP95:round(worstP95,6),baselineScaleRelativeToCurrent:scale,passesStability,preservesCurrentScale,eligibleForIndependentConfirmation:passesStability&&preservesCurrentScale,byVariant,method:'micro_jitter_ensemble'}]
})) as Record<EnsembleCandidateName,any>
const lipCandidateDiagnostics:Record<string,any>={...staticLipCandidateDiagnostics,...ensembleLipCandidateDiagnostics}
const allLipCandidateNames=[...lipCandidateNames,...ensembleCandidateNames]
const recommendedLipCandidate=allLipCandidateNames.filter(name=>name!=='currentSingleEuclidean'&&lipCandidateDiagnostics[name].eligibleForIndependentConfirmation).sort((left,right)=>lipCandidateDiagnostics[left].worstP95-lipCandidateDiagnostics[right].worstP95)[0]||null
const ensembleRuntimeMs=distribution([...baselines.map(item=>item.ensemble.elapsedMs),...variantNames.flatMap(name=>ensembleComparisons[name].map(item=>item.elapsedMs))])
const fixedIndependentCandidate:EnsembleCandidateName='ensembleTriVertical3Median'
const independentConfirmation=sourceName==='london'?{candidate:fixedIndependentCandidate,selectedOn:'ffhq-highres only',source:'Face Research Lab London neutral front',predeclaredGates:{worstP95AtMost8Percent:lipCandidateDiagnostics[fixedIndependentCandidate].worstP95<=.08,baselineScaleMedianBetween075And125:lipCandidateDiagnostics[fixedIndependentCandidate].preservesCurrentScale},observed:{worstP95:lipCandidateDiagnostics[fixedIndependentCandidate].worstP95,baselineScaleRelativeToCurrent:lipCandidateDiagnostics[fixedIndependentCandidate].baselineScaleRelativeToCurrent},passes:lipCandidateDiagnostics[fixedIndependentCandidate].worstP95<=.08&&lipCandidateDiagnostics[fixedIndependentCandidate].preservesCurrentScale}:null
const overallAttempts=baselines.length*variantNames.length;const overallRetained=variantNames.reduce((sum,name)=>sum+byVariant[name].retained,0)
const gates={baselineSelectedAtLeast18:baselines.length>=18,everyVariantRetainsAtLeast80Percent:variantNames.every(name=>byVariant[name].retentionRate>=.8),overallRetentionAtLeast85Percent:overallRetained/Math.max(1,overallAttempts)>=.85,everyMetricPassesP95Threshold:Object.values(perMetricGates).every((gate:any)=>gate.p95WithinThreshold)}
const result={testedAt:new Date().toISOString(),policyVersion:'HEADUP-AVATAR-ROBUSTNESS-1.2',datasetId,sourceName,sourceCandidates:records.length,baselineSelected:baselines.length,variants:variantNames,protocol:{transformsInMemory:true,thresholds:{variantRetention:.8,overallRetention:.85,stableRatioP95:.03,otherRatioP95:.08,eyeTiltAbsoluteDegreesP95:1,mirrorResidualAbsoluteP95:.03,lipCandidateScaleMedianRange:[.75,1.25]},lipCandidateSelection:'exploratory only; no production change without independent source confirmation',microJitterEnsemble:{views:['original','left_1_percent','right_1_percent','up_1_percent','down_1_percent'],aggregation:['vertical_3_median','axis_5_median'],landmarkOnlyAdditionalPasses:5}},overall:{attempts:overallAttempts,retained:overallRetained,rejected:overallAttempts-overallRetained,retentionRate:round(overallRetained/Math.max(1,overallAttempts),4)},byVariant,perMetricGates,lipCandidateDiagnostics,recommendedLipCandidate,ensembleRuntimeMs,independentConfirmation,gates,passesRobustnessContract:Object.values(gates).every(Boolean),retention:{rawImagesPersistedAfterRun:true,cleanupPending:true,transformedImagesWritten:false,screenshotContainsSourcePhotos:true}}

summaryElement.innerHTML=`<span class="pill">候选 ${records.length}</span><span class="pill">基线通过 ${baselines.length}</span><span class="pill">变体 ${overallAttempts}</span><span class="pill">保留 ${overallRetained}</span><span class="pill">总体 ${(result.overall.retentionRate*100).toFixed(1)}%</span>`
for(const name of variantNames){const value=byVariant[name];const reason=Object.entries(value.reasonCounts).sort((a:any,b:any)=>b[1]-a[1])[0];variantRows.insertAdjacentHTML('beforeend',`<tr><td>${variantLabels[name]}</td><td>${value.retained} / ${baselines.length}</td><td>${(value.retentionRate*100).toFixed(1)}%</td><td>${reason?`${escapeHtml(reason[0])} × ${reason[1]}`:'无'}</td><td class="${value.retentionRate>=.8?'ok':'bad'}">${value.retentionRate>=.8?'通过':'失败'}</td></tr>`)}
for(const metric of metrics){const gate:any=(perMetricGates as any)[metric];const unit=metric==='eyeCanthalTiltDegrees'?'°':metric==='mirrorResidual'?'绝对值':'相对值';metricGrid.insertAdjacentHTML('beforeend',`<div class="metric"><strong class="${gate.p95WithinThreshold?'ok':'bad'}">${metric}</strong><span>最差P95 ${gate.worstP95}（${unit}）· ${gate.p95WithinThreshold?'通过':'失败'}</span></div>`)}
for(const candidate of allLipCandidateNames){const value=lipCandidateDiagnostics[candidate];lipCandidateRows.insertAdjacentHTML('beforeend',`<tr><td>${escapeHtml(value.label)}</td><td>${(value.worstP95*100).toFixed(2)}%</td><td>${value.baselineScaleRelativeToCurrent.median?.toFixed(3)??'—'}</td><td class="${value.passesStability?'ok':'bad'}">${value.passesStability?'通过':'失败'}</td><td class="${value.eligibleForIndependentConfirmation?'ok':'bad'}">${value.eligibleForIndependentConfirmation?'可独立确认':'淘汰'}</td></tr>`)}
for(const baseline of baselines.slice(0,6))samples.insertAdjacentHTML('beforeend',`<article class="sample"><img src="${escapeHtml(baseline.url)}"/><div><strong>生产基线通过</strong>${escapeHtml(baseline.record.externalAssetId||baseline.record.id)}</div></article>`)
window.__HEADUP_AVATAR_ROBUSTNESS__=result;resultElement.textContent=JSON.stringify(result,null,2);statusElement.textContent=`完成 · ${result.passesRobustnessContract?'PASS':'FAIL'}`
