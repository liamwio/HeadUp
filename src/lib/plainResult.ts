import type {Capture} from '../types'
import type {ConsumerReading} from './consumerReport'
import {isPhotoQualityAcceptable} from './photoQualityAcceptance'

/**
 * Plain-language layer for the user-facing result screens.
 * Display only: saved readings, codes, formulas and evidence are never changed;
 * the original label and full-precision value stay available in the detail view.
 */
export const PLAIN_LABELS:Record<string,string>={
  'FRONT-RATIO-01':'脸型长宽','FRONT-RATIO-02':'瞳距占脸宽','FRONT-RATIO-03':'两眼间距','FRONT-ANGLE-01':'眼角倾斜',
  'FRONT-RATIO-04':'下颌宽度','FRONT-RATIO-05':'嘴巴宽度','FRONT-RATIO-06':'中脸高度','FRONT-RATIO-07':'下脸高度',
  'FRONT-RATIO-08':'鼻翼与嘴宽','FRONT-RATIO-09':'鼻子长度','FRONT-RATIO-10':'嘴唇厚度',
  'PROFILE-ANGLE-01':'侧脸夹角','PROFILE-LINE-02':'唇部参考距离','PROFILE-ANGLE-03':'鼻唇夹角','PROFILE-ANGLE-04':'唇下夹角',
  'PROFILE-RATIO-07':'侧脸上下比例','PROFILE-RATIO-05':'下巴参考距离','PROFILE-AUX-01':'眉鼻夹角','PROFILE-AUX-02':'鼻梁长度',
  'PROFILE-AUX-03':'鼻尖高度','PROFILE-AUX-04':'上下唇前后','PROFILE-AUX-05':'唇下凹陷','PROFILE-AUX-06':'下巴高度','PROFILE-AUX-07':'眉鼻下巴折角',
}
export const PLAIN_HINTS:Record<string,string>={
  'FRONT-RATIO-01':'脸长 ÷ 脸宽','FRONT-RATIO-05':'嘴宽 ÷ 脸宽','FRONT-RATIO-07':'鼻底到下巴 ÷ 脸高','FRONT-RATIO-04':'下颌宽 ÷ 脸宽',
  'PROFILE-ANGLE-01':'鼻梁—鼻底—下巴','PROFILE-RATIO-07':'中脸 : 下脸','PROFILE-LINE-02':'嘴唇到鼻尖下巴连线',
}
export const plainLabel=(reading:Pick<ConsumerReading,'code'|'label'>)=>PLAIN_LABELS[reading.code??'']??reading.label

const roundNumber=(raw:string,unit:string)=>{
  const n=Number(raw)
  if(!Number.isFinite(n))return raw
  const digits=unit==='°'?0:unit==='%'?(Math.abs(n)>=10?0:1):2
  const fixed=n.toFixed(digits)
  return Number(fixed)===0?fixed.replace('-',''):fixed
}
/** Rounds every number in a reading value for display, e.g. 36.62% → 37%, 169.39° → 169°. */
export function plainValue(value:string){
  return value.replace(/(-?\d+\.\d+)(%|°)?/g,(_,n:string,unit='')=>roundNumber(n,unit)+unit)
}

/** One small tag replaces the stacked "实验读数 / 误差待重新校准 / 仅记录值" captions. */
export function readingTag(reading:ConsumerReading):'参考'|''{
  if(reading.origin==='demo')return ''
  if(reading.origin==='experimental'||reading.code==='FRONT-ANGLE-01'||reading.code==='PROFILE-ANGLE-09'||reading.code==='PROFILE-REGION-NECK')return '参考'
  if(reading.evidence&&!reading.errors?.length)return '参考'
  return ''
}

export type PlainIssue={headline:string;tip:string;detail:string}
const ISSUE_RULES:Array<[RegExp,string,string]>=[
  [/横向倾斜|倾斜过大|倾斜估计/,'头歪了，请摆正再拍','眼睛平视前方，手机竖直拿稳。'],
  [/只能出现一个人|多张人脸|多人/,'画面里不止一个人','只让本人入镜。'],
  [/未检测到|未能稳定定位|可信的单人面部|0 张人脸/,'没有找到脸','面部放在画面中间，靠近一些，别让头发挡住。'],
  [/抬头|低头|同高|俯仰/,'镜头太高或太低','手机举到和眼睛一样高。'],
  [/需要.*侧面|侧面.*90|方向|左侧|右侧/,'不是要求的侧面','把头转到正侧面，露出额头到下巴。'],
  [/直视镜头|正面照片|正对/,'没有正对镜头','脸和肩膀都正对手机。'],
  [/画面中央|边缘|完整拍入|照片范围外|完整侧面/,'脸没有拍全','额头、鼻尖、嘴唇和下巴都要在画面里。'],
  [/太小|靠近镜头/,'离得太远','靠近一些，或用 2 倍变焦。'],
  [/光线不足/,'太暗了','面向窗户或灯光再拍。'],
  [/过曝/,'太亮了','避开直射的强光。'],
  [/对比度/,'脸和背景分不清','换个干净的浅色背景，光线打在脸上。'],
  [/模糊|清晰度/,'照片模糊','擦净镜头，拿稳手机再拍。'],
  [/遮挡|口罩|眼镜/,'脸被挡住了','摘下眼镜和口罩，拨开头发。'],
  [/分辨率|低清|截图/,'照片太小或被压缩','请用相机拍的原图。'],
  [/点位或测量线|闭唇/,'没能画出测量线','自然闭嘴，露出完整侧面后重拍。'],
  [/模型|检测未完成|重试检测|定位未完成/,'这次没有检测完','照片已保留，可以点“重新检测”。'],
  [/读取失败|无法读取/,'照片打不开','请重新选择这张照片。'],
]
export function captureIssues(capture:Capture){
  return [...new Set([capture.inputError,capture.analysisError,...(capture.poseValidation?.flags??[]),...(capture.quality?.flags??[])].filter((s):s is string=>Boolean(s)))]
}
/** Short headline + one action for a photo that cannot be measured; raw reasons kept in `detail`. */
export function plainIssue(capture:Capture):PlainIssue{
  const issues=captureIssues(capture),detail=issues.join('；')
  if(capture.id!=='front'&&issues.some(s=>/横向倾斜|倾斜估计/.test(s)))return {headline:'侧面角度待核对',tip:'先把手机拿正、镜头与眼睛同高；头部已端正时不要继续扭头。',detail}
  for(const issue of issues){const rule=ISSUE_RULES.find(([pattern])=>pattern.test(issue));if(rule)return {headline:rule[1],tip:rule[2],detail}}
  return {headline:'这张照片暂时不能测量',tip:'按取景框提示重新拍摄。',detail}
}

export type CaptureStatus='ok'|'retake'|'missing'
export function captureStatus(capture?:Capture):CaptureStatus{
  if(!capture?.url)return 'missing'
  const pose=capture.poseValidation
  if(capture.inputError||capture.analysisError||!pose||pose.status!=='pass')return 'retake'
  if(capture.quality&&!isPhotoQualityAcceptable(capture.quality))return 'retake'
  return 'ok'
}
export const captureViewLabel=(capture:Pick<Capture,'id'|'poseValidation'>)=>capture.id==='front'?'正面':capture.id==='right_profile'||capture.poseValidation?.estimatedPose==='right_profile'?'右侧':'左侧'

export type RecordVerdict={tone:'ok'|'warn'|'empty';headline:string;sub:string;ok:number;rows:Array<{capture:Capture;label:string;status:CaptureStatus;issue?:PlainIssue}>}
/** One sentence that answers "can these photos be used?" for a whole record. */
export function recordVerdict(captures:Capture[]):RecordVerdict{
  const rows=captures.filter(c=>c.id==='front'||c.id==='profile'||c.id==='right_profile').map(capture=>{const status=captureStatus(capture);return {capture,label:captureViewLabel(capture),status,issue:status==='retake'?plainIssue(capture):undefined}})
  const ok=rows.filter(r=>r.status==='ok').length,retake=rows.filter(r=>r.status==='retake'),missing=rows.filter(r=>r.status==='missing')
  if(!ok&&!retake.length)return {tone:'empty',headline:'还没有添加照片',sub:'按正面、左侧、右侧依次拍摄。',ok,rows}
  if(!retake.length&&!missing.length)return {tone:'ok',headline:`${ok} 张照片通过拍摄检查`,sub:'跨期对比还需核对拍摄条件和计算来源。',ok,rows}
  const parts=[retake.length?`${retake.map(r=>r.label).join('、')}需重拍`:'',missing.length?`${missing.map(r=>r.label).join('、')}未拍`:''].filter(Boolean)
  return {tone:'warn',headline:ok?`可用 ${ok} 张，${parts.join('，')}`:`照片暂不可用，${parts.join('，')}`,sub:retake.length?retake.map(r=>`${r.label}：${r.issue!.headline}`).join('；'):'可以稍后补拍。',ok,rows}
}
