import type {ConsumerReading} from '../lib/consumerReport'
import type {FamilySession} from './model'

export function sameReadingProvenance(before:ConsumerReading,after:ConsumerReading) {
  const left=before.evidence,right=after.evidence
  if((before.formula??'')!==(after.formula??''))return false
  // Absence remains legacy; it never implies the new point-derived contract.
  if(!left||!right)return !left&&!right
  return left.version===right.version&&left.source===right.source&&left.formula===right.formula
}

function savedProfileSource(session:FamilySession) {
  const capture=session.captures.find(c=>c.id==='profile')?.poseValidation?.nativeProfile
  const source=session.report.native?.geometrySource??capture?.geometrySource
  return {source,capture}
}

export function sessionReadingProvenanceMatches(a:FamilySession,b:FamilySession,view:'front'|'profile') {
  if(view==='profile') {
    const left=savedProfileSource(a),right=savedProfileSource(b)
    if(left.source!==right.source)return false
    for(const key of ['modelVersion','cropVersion','refinerVersion','geometryModelVersion'] as const) {
      if(left.capture?.[key]!==right.capture?.[key])return false
    }
  }
  const readings=(s:FamilySession)=>[...s.report[view],...s.report.extended.filter(r=>r.view===view)]
  const right=readings(b)
  return readings(a).every(before=>{
    const after=right.find(r=>r.code===before.code)
    return !before.available||!after?.available||sameReadingProvenance(before,after)
  })
}
