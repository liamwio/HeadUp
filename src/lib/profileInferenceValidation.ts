type NumericOutput = ArrayLike<unknown> | null | undefined
type ProfilePoint = {x:number;y:number}

/** The coordinate and confidence heads export normalized numeric values, not calibrated certainty. */
export function validNormalizedProfileOutput(values:NumericOutput,length:number):values is ArrayLike<number> {
  if(!values||values.length!==length)return false
  for(let index=0;index<length;index++) {
    const value=values[index]
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)return false
  }
  return true
}

export function nativeProfileOutputRejection(coordinates:NumericOutput,confidence:NumericOutput) {
  if(!coordinates||coordinates.length!==78||!confidence||confidence.length!==39)return 'native39_output_contract_failed'
  if(!validNormalizedProfileOutput(coordinates,78)||!validNormalizedProfileOutput(confidence,39))return 'native39_output_values_invalid'
  return undefined
}

/** Apply before and after refinement so a local model cannot reverse or move the accepted profile out of frame. */
export function nativeProfileLandmarkRejection(landmarks:ReadonlyArray<ProfilePoint>,orientation:'left'|'right') {
  if(landmarks.length!==39||!landmarks.every(point=>point&&
    Number.isFinite(point.x)&&Number.isFinite(point.y)&&
    point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1))return 'native39_landmarks_invalid'
  const direction=Math.sign(landmarks[19].x-landmarks[10].x)
  if((orientation==='right'&&direction<=0)||(orientation==='left'&&direction>=0))return 'native39_pose_direction_conflict'
  return undefined
}
