import type {PoseValidation} from './types'

export function captureGuideGeometry(width:number,height:number){
  const w=Number.isFinite(width)&&width>0?width:4,h=Number.isFinite(height)&&height>0?height:3
  const scale=Math.min(h*.9/360,w*.9/280)
  return {width:w,height:h,scale,x:w/2-150*scale,y:h/2-175*scale}
}
const FRONT_OUTLINE='M 62 332 Q 77 302 111 295 L 115 258 C 92 247 77 222 75 190 C 60 188 59 153 72 151 C 67 91 85 36 150 34 C 215 36 233 91 228 151 C 241 153 240 188 225 190 C 223 222 208 247 185 258 L 189 295 Q 223 302 238 332 M 115 258 Q 150 280 185 258'
const SIDE_OUTLINE='M 193 332 L 191 270 C 191 247 193 233 207 221 C 237 199 249 169 248 131 C 247 78 211 36 163 36 C 116 33 90 61 85 101 L 84 127 L 63 164 Q 60 173 84 176 L 81 187 L 89 195 L 82 204 Q 80 228 110 233 L 122 232 L 124 278 Q 107 302 77 322'
const OVAL=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109,10]

export function CameraFramingGuide({width,height,view,side,ready,pose}:{width:number;height:number;view:'front'|'profile';side?:'left_profile'|'right_profile'|null;ready:boolean;pose?:PoseValidation}){
  const g=captureGuideGeometry(width,height),right=side==='right_profile',name=view==='front'?'正面':right?'右侧':'左侧'
  const points=view==='front'&&pose?.estimatedPose==='front'&&pose.landmarks&&OVAL.every(i=>{const p=pose.landmarks?.[i];return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1})?OVAL.map(i=>`${pose.landmarks![i].x*g.width},${pose.landmarks![i].y*g.height}`).join(' '):undefined
  const b=pose?.faceBounds,box=b&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0?b:undefined
  return <svg className={'live-framing-guide '+(ready?'is-ready':'')} viewBox={`0 0 ${g.width} ${g.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${name}头部取景框`}>
    <g transform={`translate(${g.x} ${g.y}) scale(${g.scale})`}>
      <g transform={view==='profile'&&right?'translate(300 0) scale(-1 1)':undefined}><path className="live-target-outline" d={view==='front'?FRONT_OUTLINE:SIDE_OUTLINE}/><path className="live-eye-guide" d={view==='front'?'M 92 133 H 208 M 150 52 V 260':'M 79 129 H 171'}/></g>
      <text className="live-guide-label" x="150" y="18" textAnchor="middle">{name}</text>
      <text className="live-guide-label live-eye-label" x={view==='front'?232:right?28:272} y="132" textAnchor="middle">眼睛</text>
    </g>
    {points?<polyline className="live-detected-contour" points={points}/>:box&&<rect className="live-detected-bounds" x={box.x*g.width} y={box.y*g.height} width={box.width*g.width} height={box.height*g.height} rx={Math.min(box.width*g.width,box.height*g.height)*.10}/>}
  </svg>
}
