import{inspectCaptureFile}from'../src/lib/captureAnalysis'
import{profileGeometryDisagreementReviewMetrics}from'../src/lib/nativeProfilePresentation'
import type{NativeProfileGeometryDisagreement}from'../src/types'

type Manifest={cases:Array<{reviewId:string;dataset:string;view:string;path:string}>}
const projectRoot='/@fs/D:/AICodex/HeadUp',status=document.querySelector<HTMLElement>('#status')!,summary=document.querySelector<HTMLElement>('#summary')!,resultNode=document.querySelector<HTMLElement>('#result')!,queueNode=document.querySelector<HTMLElement>('#queue')!,queueSession=document.querySelector<HTMLSelectElement>('#queue-session')!
const manifest=await fetch(`${projectRoot}/data/manual-test/profile-region-truth-v1/manifest.json`).then(response=>response.json())as Manifest
const cases=manifest.cases.filter(item=>item.dataset==='london_highres_confirmation'&&item.view==='right_profile')
if(cases.length!==30)throw new Error(`Expected 30 right profiles, found ${cases.length}`)
const keys=['softTissueConvexityAngleDegrees','eLinePercentagePoints','nasolabialAngleDegrees','mentolabialAngleDegrees','chinProjectionPercentagePoints','mandibularInclinationDegrees','verticalPercentagePoints']as const satisfies readonly(keyof NativeProfileGeometryDisagreement)[]
const values=Object.fromEntries(keys.map(key=>[key,[]as number[]]))as Record<typeof keys[number],number[]>,reviewCounts=Object.fromEntries(keys.map(key=>[key,0]))as Record<typeof keys[number],number>
let measured=0,rejected=0,reviewImages=0,analysisErrors=0
const reviewQueue:string[]=[]
const quantile=(input:readonly number[],fraction:number)=>{const sorted=[...input].sort((a,b)=>a-b),position=(sorted.length-1)*fraction,left=Math.floor(position),right=Math.ceil(position);return sorted.length?sorted[left]+(sorted[right]-sorted[left])*(position-left):null}
for(const[index,item]of cases.entries()){
  status.textContent=`分析 ${index+1}/30`
  try{
    const blob=await fetch(`${projectRoot}/${item.path}`).then(response=>response.blob()),inspected=await inspectCaptureFile('profile',new File([blob],`${item.reviewId}.jpg`,{type:blob.type||'image/jpeg'})),native=inspected.pose.nativeProfile
    if(native?.status!=='measured'||!native.geometryDisagreement){rejected++;continue}
    measured++;for(const key of keys)values[key].push(native.geometryDisagreement[key])
    const reviews=profileGeometryDisagreementReviewMetrics(native.geometryDisagreement);if(reviews.length){reviewImages++;reviewQueue.push(item.reviewId)}for(const review of reviews)reviewCounts[review.key]++
  }catch{analysisErrors++}
}
const distribution=(input:readonly number[])=>({min:quantile(input,0),median:quantile(input,.5),p95:quantile(input,.95),max:quantile(input,1)})
const output={testedAt:new Date().toISOString(),policyVersion:'HEADUP-PROFILE-GEOMETRY-SOURCE-CROSSCHECK-30-1.0',runtime:navigator.userAgent,scope:{images:30,measured,rejected,analysisErrors},disagreement:Object.fromEntries(keys.map(key=>[key,distribution(values[key])])),review:{images:reviewImages,withoutReview:measured-reviewImages,byMetric:reviewCounts},contract:{valueSource:'deployed direct geometry head',overlaySource:'deployed refined Menpo39 landmarks',reviewRule:'flag when same-image disagreement exceeds the current metric RSS',manualTruthClaim:false,coordinatorQueueSerialized:false,coordinatorQueryKeys:['case','session']},privacy:{imagesIncluded:false,caseIdsIncluded:false,individualValuesIncluded:false,modelLinesRendered:false}}
summary.innerHTML=`<span>固定图片<strong>30</strong></span><span>完成测量<strong>${measured}</strong></span><span>需复核<strong>${reviewImages}</strong></span><span>运行错误<strong>${analysisErrors}</strong></span>`
status.textContent=`分析完成 · ${measured}/30可测 · ${reviewImages}张模型层分歧越线 · 错误${analysisErrors}`
const renderQueue=()=>{const session=queueSession.value;queueNode.innerHTML=reviewQueue.map((reviewId,index)=>`<a href="/research-profile-region-annotation.html?case=${encodeURIComponent(reviewId)}&session=${session}" aria-label="打开${session}会话优先盲标病例${index+1}">优先病例 ${String(index+1).padStart(2,'0')} · ${session}</a>`).join('')||'没有越线病例。'}
queueSession.addEventListener('change',renderQueue);renderQueue()
resultNode.textContent=JSON.stringify(output,null,2)
;(window as typeof window&{__HEADUP_PROFILE_GEOMETRY_CROSSCHECK__?:unknown}).__HEADUP_PROFILE_GEOMETRY_CROSSCHECK__=output
