export type CaptureSelection={method:'burst-sharpness-v1';frames:1|2|3;selectedIndex:number}
export function isCaptureSelection(value:unknown):value is CaptureSelection{
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const v=value as CaptureSelection
  return Object.keys(v).sort().join(',')==='frames,method,selectedIndex'&&v.method==='burst-sharpness-v1'&&[1,2,3].includes(v.frames)&&Number.isInteger(v.selectedIndex)&&v.selectedIndex>=0&&v.selectedIndex<v.frames
}
