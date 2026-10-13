import type {PoseValidation} from '../types'

export type FramingCheck = {state:'good'|'adjust'|'unknown';label:string;detail:string}
export type LiveFraming = {
  distance:FramingCheck
  completeness:FramingCheck
  position:FramingCheck
  message?:string
  ready:boolean
}

const check=(state:FramingCheck['state'],label:string,detail:string):FramingCheck=>({state,label,detail})

/** Relative framing only: a face rectangle cannot measure camera distance or segment the whole head. */
export function evaluateLiveFraming(pose:PoseValidation,expected:'front'|'profile'):LiveFraming {
  const bounds=pose.faceBounds
  // A confident side detector can supply a rectangle when the landmark detector finds no face.
  const nativeSide=expected==='profile'&&pose.detectedFaces===0&&['left_profile','right_profile'].includes(pose.estimatedPose)
  if((pose.detectedFaces!==1&&!nativeSide)||pose.estimatedPose==='no_face'||pose.estimatedPose==='multiple_faces'||!bounds||
    ![bounds.x,bounds.y,bounds.width,bounds.height,bounds.x+bounds.width,bounds.y+bounds.height].every(Number.isFinite)||
    bounds.width<=0||bounds.height<=0) {
    return {
      distance:check('unknown','等待检测','检测到面部后判断取景大小'),
      completeness:check('unknown','等待检测','检测到面部后检查顶部、下巴和两侧留白'),
      position:check('unknown','等待检测','检测到面部后判断画面位置'),
      message:'让面部进入取景框，等待检测。',
      ready:false,
    }
  }
  const {x,y,width,height}=bounds
  const tooLarge=height>.72||width>.76
  const tooSmall=width*height<(expected==='front'?.09:.07)||height<.35
  const distance=tooLarge
    ?check('adjust','退后一点','面部占画面过大，请退后一点')
    :tooSmall
      ?check('adjust','靠近一点','面部占画面较小，请靠近一点')
      :check('good','距离合适','面部在画面中的大小合适')

  // Reserve conservative space beyond the detected face; do not infer actual hair/crown boundaries.
  const top=y-.25*height<.02,bottom=y+1.15*height>.98
  const left=x-.10*width<.02,right=x+1.10*width>.98
  const missing=[top?'顶部':'',bottom?'下巴':'',left&&right?'两侧':left?'左侧':right?'右侧':''].filter(Boolean)
  const spaceCorrection=(top&&bottom)||(left&&right)||missing.length>1
    ?'请退后一点'
    :top?'请向下移动头部或稍微退后'
      :bottom?'请向上移动头部或稍微退后'
        :left?'请向右移动头部或稍微退后':'请向左移动头部或稍微退后'
  const completeness=missing.length
    ?check('adjust','留白不足',`${missing.join('、')}留白不足，${spaceCorrection}`)
    :check('good','完整入镜','顶部、下巴和两侧留白合适')

  const centerX=x+width/2,centerY=y+height/2
  const horizontal=centerX<.4?'右':centerX>.6?'左':''
  const vertical=centerY<.4?'下':centerY>.6?'上':''
  const position=horizontal||vertical
    ?check('adjust','移到中央',`请向${horizontal}${vertical}${horizontal&&vertical?'方':''}移动头部，让面部居中`)
    :check('good','位置合适','面部位于画面中央')
  const adjustment=[completeness,distance,position].find(value=>value.state==='adjust')
  return {distance,completeness,position,message:adjustment?.detail,ready:!adjustment}
}
