import type{Capture}from'../types'
import{isPhotoQualityAcceptable}from'./imageQuality'
import{isPoseAcceptable}from'./facePose'

export type CaptureRetakeAssessment={
  strictPass:boolean
  issues:string[]
  improvements:string[]
}

const improvementRules:Array<[RegExp,string]>=[
  [/镜头需与眼睛同高|抬头|低头/,'将手机升降到与双眼同高；下巴自然放松，不抬头也不低头。'],
  [/直视镜头|正面照片/,'脸和双肩正对镜头，左右耳尽量对称可见，眼睛看向镜头。'],
  [/侧面.*90|侧面照片需要接近|方向相反/,'向任一侧转头至接近90°，左侧面或右侧面均可；保留完整额头、鼻尖、嘴唇和下巴。'],
  [/横向倾斜|倾斜过大/,'保持头部竖直，使双眼连线或耳部方向接近水平。'],
  [/画面中央/,'移动手机或身体，把面部完整放在取景框中央。'],
  [/太小|靠近镜头/,'靠近镜头或使用约 2× 变焦，让面部占据画面主要区域。'],
  [/未检测到|可信的单人面部/,'确保只有一人入镜，面部无遮挡、边缘完整且光线均匀。'],
  [/只能出现一个人/,'裁掉旁人或背景中的人脸，画面中只保留当前用户。'],
  [/分辨率偏低|低清放大/,'使用相机原始照片，不要截图、社交软件压缩图或放大后的低清图片。'],
  [/光线不足/,'面向窗户或柔和正面光源，避免顶光和背光。'],
  [/画面过曝/,'降低曝光并避开直射强光，保留额头、鼻梁和面颊纹理。'],
  [/对比度偏低/,'增加均匀正面光，让面部轮廓与背景清晰分离。'],
  [/画面模糊|清晰度一般/,'擦净镜头，保持手机稳定并重新对焦面部后拍摄。'],
  [/遮挡|口罩|眼镜/,'摘下口罩和所有眼镜，拨开遮挡面部轮廓的头发。'],
]

export function captureRetakeAssessment(capture:Capture):CaptureRetakeAssessment{
  if(!capture.quality)return{strictPass:false,issues:[],improvements:[]}
  const strictPass=isPhotoQualityAcceptable(capture.quality)&&Boolean(capture.poseValidation&&isPoseAcceptable(capture.poseValidation))
  const rawIssues=[...(capture.analysisError?[capture.analysisError]:[]),...(capture.quality.flags??[]),...(capture.poseValidation?.flags??[])]
  if(!isPhotoQualityAcceptable(capture.quality)&&capture.quality.flags.length===0)rawIssues.push('照片综合清晰度与曝光未达到最低要求')
  if(!capture.poseValidation)rawIssues.push('未完成面部姿态检查')
  else if(!isPoseAcceptable(capture.poseValidation)&&capture.poseValidation.flags.length===0)rawIssues.push('拍摄视角未达到当前照片类型要求')
  const issues=[...new Set(rawIssues.filter(Boolean))]
  const improvements=[...new Set(issues.map(issue=>improvementRules.find(([pattern])=>pattern.test(issue))?.[1]??'按照本卡片示例重新取景，并保持自然表情、闭唇不抿嘴。'))]
  return{strictPass,issues,improvements}
}
