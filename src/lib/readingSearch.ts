import type { ConsumerReading } from './consumerReport'
const aliases:Record<string,string>={
  'FRONT-SYM-01':'对称 左右差异 镜像残差',
  'FRONT-RATIO-03':'眼间距 两眼距离',
  'FRONT-RATIO-05':'嘴宽 口宽',
  'FRONT-RATIO-10':'唇高 嘴唇高度',
  'PROFILE-ANGLE-01':'面凸角 侧面弯曲',
  'PROFILE-ANGLE-03':'鼻唇角',
  'PROFILE-ANGLE-04':'颏唇沟角 下唇下巴',
  'PROFILE-RATIO-05':'下巴 颏投影',
}
const normalize=(s:string)=>s.toLocaleLowerCase().replace(/[\s-]/g,'')
export function searchReadings(readings:ConsumerReading[],query:string,view:'all'|'front'|'profile'='all'){
  const terms=query.trim().split(/\s+/).filter(Boolean).map(normalize)
  return readings.filter(r=>r.available&&(view==='all'||r.view===view)&&terms.every(q=>normalize([r.label,r.note,r.code,aliases[r.code??'']??''].join(' ')).includes(q)))
}
