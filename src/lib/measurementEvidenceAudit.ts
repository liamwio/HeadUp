import type {ConsumerReading} from './consumerReport'
import type {MeasurementEvidence} from './measurementEvidence'

export type ReadingEvidenceAudit={status:'pass'|'fail'|'not_applicable';recomputed:number[];displayed:number[];reason:string;maxDifference:number|null}
type Vector={x:number;y:number}
const vector=(a:Vector,b:Vector):Vector=>({x:b.x-a.x,y:b.y-a.y})
const length=(v:Vector)=>Math.hypot(v.x,v.y)
const dot=(a:Vector,b:Vector)=>a.x*b.x+a.y*b.y
const cross=(a:Vector,b:Vector)=>a.x*b.y-a.y*b.x
const ratioCodes=new Set(['FRONT-RATIO-01','FRONT-RATIO-03','FRONT-RATIO-08','FRONT-RATIO-10'])
const sideAngles=new Set(['PROFILE-ANGLE-01','PROFILE-ANGLE-03','PROFILE-ANGLE-04','PROFILE-AUX-01','PROFILE-AUX-07'])
const sideCodes=new Set([...sideAngles,'PROFILE-LINE-02','PROFILE-RATIO-05','PROFILE-RATIO-07','PROFILE-AUX-02','PROFILE-AUX-03','PROFILE-AUX-04','PROFILE-AUX-05','PROFILE-AUX-06'])
class MissingProof extends Error {}

function readers(e:MeasurementEvidence){
  if(e.version!=='HEADUP-POINT-LINE-1'||!Number.isFinite(e.width)||!Number.isFinite(e.height)||e.width<=0||e.height<=0
    ||!Array.isArray(e.points)||!Array.isArray(e.segments)||e.points.length>40||e.segments.length>30)throw Error('invalid_evidence_contract')
  const points=new Map(e.points.map(p=>[p.id,p])),segments=new Map(e.segments.map(s=>[s.id,s]))
  if(points.size!==e.points.length||segments.size!==e.segments.length||e.points.some(p=>!p.id||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>e.width||p.y>e.height)
    ||e.segments.some(s=>!s.id||!points.has(s.from)||!points.has(s.to)||!['measure','reference','projection'].includes(s.role)))throw Error('invalid_evidence_geometry')
  const point=(id:string)=>{const p=points.get(id);if(!p)throw new MissingProof('missing_point:'+id);return p}
  const segment=(id:string)=>{const s=segments.get(id);if(!s)throw new MissingProof('missing_segment:'+id);return {a:point(s.from),b:point(s.to),from:s.from,to:s.to}}
  const direction=(id:string)=>{const s=segment(id);return vector(s.a,s.b)}
  const distance=(id:string)=>length(direction(id))
  const divide=(numerator:number,denominator:number)=>{if(!(denominator>1e-12))throw Error('degenerate_reference_line');return numerator/denominator}
  const angle=()=>{
    const a=segment('a'),b=segment('b'),common=[a.from,a.to].find(id=>id===b.from||id===b.to)
    if(!common)throw Error('angle_segments_have_no_common_vertex')
    const origin=point(common),av=vector(origin,point(a.from===common?a.to:a.from)),bv=vector(origin,point(b.from===common?b.to:b.from))
    return Math.acos(Math.max(-1,Math.min(1,divide(dot(av,bv),length(av)*length(bv)))))*180/Math.PI
  }
  const projectedDistance=(id:string,baseline:string)=>{
    const projected=segment(id),reference=segment(baseline),v=vector(reference.a,reference.b),projection=vector(projected.b,projected.a)
    const span=length(v);if(!(span>1e-12))throw Error('degenerate_reference_line')
    // The drawn foot must lie on the reference, and the drawn measurement must be perpendicular.
    const tolerance=Math.max(1,e.width,e.height)*1e-8
    if(Math.abs(cross(v,vector(reference.a,projected.b)))/span>tolerance||Math.abs(dot(v,projection))/span>tolerance)throw Error('inconsistent_perpendicular_projection')
    return {projection,v,span}
  }
  const signedDistance=(id:string,baseline:string,orientation:'left'|'right')=>{
    const {projection,v,span}=projectedDistance(id,baseline)
    const height=direction('height'),sign=orientation==='right'?1:-1,anterior={x:sign*height.y,y:-sign*height.x}
    let normal={x:v.y/span,y:-v.x/span}
    if(Math.abs(dot(normal,anterior))<=1e-12)throw Error('ambiguous_signed_distance_direction')
    if(dot(normal,anterior)<0)normal={x:-normal.x,y:-normal.y}
    return dot(projection,normal)
  }
  return {point,segment,direction,distance,divide,angle,signedDistance,perpendicularDistance:(id:string,baseline:string)=>length(projectedDistance(id,baseline).projection)}
}

/** Numerical self-consistency only. A pass does not establish anatomical point accuracy. */
export function auditReadingEvidence(reading:ConsumerReading,orientation?:'left'|'right'):ReadingEvidenceAudit{
  const result=(status:ReadingEvidenceAudit['status'],reason:string,recomputed:number[]=[],displayed:number[]=[],maxDifference:number|null=null):ReadingEvidenceAudit=>({status,reason,recomputed,displayed,maxDifference})
  const code=reading.code??'',frontRatio=/^FRONT-RATIO-(?:0[1-9]|10)$/.test(code),frontAngle=code==='FRONT-ANGLE-01',side=sideCodes.has(code)
  if(!reading.available)return result('not_applicable','reading_unavailable')
  if(!frontRatio&&!frontAngle&&!side)return result('not_applicable','unsupported_metric')
  const e=reading.evidence
  if(!e)return result('not_applicable','missing_point_line_evidence')
  if((frontRatio||frontAngle)&&(reading.view!=='front'||e.source!=='saved_front_landmarks')||side&&(reading.view!=='profile'||e.source!=='saved_profile_landmarks'))return result('fail','evidence_source_or_view_mismatch')
  const signed=code==='PROFILE-LINE-02'||code==='PROFILE-RATIO-05'||code==='PROFILE-AUX-04'
  if(signed&&!orientation)return result('not_applicable','signed_distance_requires_orientation')
  const unit=ratioCodes.has(code)?'ratio':frontAngle||sideAngles.has(code)?'degrees':'percent',precision=unit==='ratio'?3:code==='PROFILE-AUX-01'||code==='PROFILE-AUX-07'?1:2
  const numeric='(-?\\d+(?:\\.\\d+)?)',pattern=code==='PROFILE-LINE-02'?`^上唇 ${numeric}% · 下唇 ${numeric}%$`:code==='PROFILE-RATIO-07'?`^中面 ${numeric}% · 下面 ${numeric}%$`:`^${numeric}${unit==='percent'?'%':unit==='degrees'?'°':''}$`
  const match=reading.value.match(new RegExp(pattern))
  if(!match)return result('not_applicable','unsupported_display_format')
  const displayed=match.slice(1).map(Number)
  if(displayed.some(v=>!Number.isFinite(v)))return result('fail','nonfinite_display_value',[],displayed)
  let recomputed:number[]=[]
  try{
    const {point,direction,distance,divide,angle,signedDistance,perpendicularDistance}=readers(e)
    if(frontRatio){
      let numerator=code==='FRONT-RATIO-10'?['lip-height-left','lip-height-center','lip-height-right'].map(distance).sort((a,b)=>a-b)[1]:distance('numerator')
      const denominator=code==='FRONT-RATIO-03'?(distance('denominator-left')+distance('denominator-right'))/2:distance('denominator')
      if(code==='FRONT-RATIO-02')for(const [id,start]of [['iris-left-center',468],['iris-right-center',473]]as const){
        const center=point(id),source=Array.from({length:5},(_,i)=>point('mp-'+(start+i))),average={x:source.reduce((n,p)=>n+p.x,0)/5,y:source.reduce((n,p)=>n+p.y,0)/5}
        if(length(vector(center,average))>Math.max(e.width,e.height)*1e-8)throw Error('iris_center_does_not_match_saved_source_points')
      }
      numerator=divide(numerator,denominator)
      recomputed=[unit==='percent'?numerator*100:numerator]
    }else if(frontAngle){
      const axis=direction('horizontal-axis');if(length(axis)<=1e-12)throw Error('degenerate_reference_line')
      const relative=(id:string)=>{const v=direction(id);if(length(v)<=1e-12)throw Error('degenerate_measurement_line');return Math.atan2(cross(axis,v),dot(axis,v))*180/Math.PI}
      recomputed=[(relative('left-eye')-relative('right-eye'))/2]
    }else if(sideAngles.has(code))recomputed=[angle()]
    else if(code==='PROFILE-LINE-02')recomputed=['upper','lower'].map(id=>divide(signedDistance(id,'eline',orientation!),distance('height'))*100)
    else if(code==='PROFILE-RATIO-05')recomputed=[divide(signedDistance('chin-distance','baseline',orientation!),distance('height'))*100]
    else if(code==='PROFILE-RATIO-07')recomputed=['mid','lower'].map(id=>divide(distance(id),distance('total'))*100)
    else if(code==='PROFILE-AUX-02')recomputed=[divide(distance('nose-length'),distance('height'))*100]
    else if(code==='PROFILE-AUX-03')recomputed=[divide(perpendicularDistance('projection','base'),distance('height'))*100]
    else if(code==='PROFILE-AUX-04')recomputed=[divide(signedDistance('upper','eline',orientation!)-signedDistance('lower','eline',orientation!),distance('height'))*100]
    else if(code==='PROFILE-AUX-05')recomputed=[divide(perpendicularDistance('fold-depth','base'),distance('height'))*100]
    else if(code==='PROFILE-AUX-06')recomputed=[divide(distance('chin'),distance('lower'))*100]
    if(recomputed.length!==displayed.length||recomputed.some(v=>!Number.isFinite(v)))throw Error('nonfinite_or_incomplete_recomputation')
    const maxDifference=Math.max(...recomputed.map((value,i)=>Math.abs(value-displayed[i])))
    const matches=recomputed.every((value,i)=>Math.abs(Number(value.toFixed(precision))-displayed[i])<1e-9)
    return result(matches?'pass':'fail',matches?'matches_saved_evidence_at_display_precision':'display_value_differs_from_saved_evidence',recomputed,displayed,maxDifference)
  }catch(error){return result(error instanceof MissingProof?'not_applicable':'fail',error instanceof Error?error.message:'evidence_audit_failed',recomputed,displayed)}
}
