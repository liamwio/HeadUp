import {compareSessions,sortedSessions,type FamilySession} from './model'
import {isPhotoQualityAcceptable} from '../lib/imageQuality'
import {extractAiMetric} from './aiReadings'
import {COMPARISON_REASONS,type ComparisonReason} from './comparisonReasons'
import {AI_CONTRACT_VERSION,type AiInput,type AiTopic,type AiComparison} from './aiContract'
export function buildAiInput(sessions:FamilySession[],profileId:string,topic:AiTopic='overview',requested:AiInput['focus']=null):{input:AiInput;sources:Record<string,string>;versionLabels:Record<string,string>}{
  const rows=sortedSessions(sessions,profileId).slice(0,12).reverse(),sources:Record<string,string>={},versionLabels:Record<string,string>={},versions=new Map<string,string>()
  const tag=(prefix:string,value:string)=>{const key=prefix+':'+value;let id=versions.get(key);if(!id){id=prefix+(1+[...versions.keys()].filter(k=>k.startsWith(prefix+':')).length);versions.set(key,id);versionLabels[id]=value}return id}
  const records:AiInput['records']=rows.map((row,i)=>{
    const ref='R'+(i+1);sources[ref]=row.id
    const compare=(view:'front'|'profile'):AiComparison=>{const comparison=compareSessions(rows[i-1],row,view);return{status:comparison.status,reasons:comparison.reasons.map(reason=>(Object.keys(COMPARISON_REASONS) as ComparisonReason[]).find(k=>COMPARISON_REASONS[k]===reason)??'quality')}}
    const metrics=row.kind==='memory'||row.report.isExample?[]:row.report.front.concat(row.report.profile).map(extractAiMetric).filter((r):r is NonNullable<typeof r>=>r!==null)
    return{ref,date:row.recordedOn,kind:row.kind,measuredCount:row.kind==='memory'?0:row.report.measuredCount,metrics,versions:{algorithm:tag('A',row.version.algorithm),norm:tag('N',row.version.norm),copy:tag('C',row.version.copy),protocol:tag('P',row.protocol.version)},previous:i?{front:compare('front'),profile:compare('profile')}:null,
      views:row.captures.filter(c=>c.id==='front'||c.id==='profile').map(c=>({view:c.id as 'front'|'profile',side:c.id==='front'?'unknown':c.poseValidation?.estimatedPose==='left_profile'?'left':c.poseValidation?.estimatedPose==='right_profile'?'right':'unknown',quality:c.quality?isPhotoQualityAcceptable(c.quality)?'pass':'review':'unavailable',pose:c.analysisError||!c.poseValidation?'unavailable':c.poseValidation.status==='pass'?'pass':'review'}))}
  })
  const options=records.flatMap(r=>r.metrics.map(m=>({ref:r.ref,code:m.code}))),focus=['reading','uncertainty'].includes(topic)?options.find(o=>o.ref===requested?.ref&&o.code===requested?.code)??options.find(o=>o.ref===[...records].reverse().find(r=>r.metrics.length)?.ref)??null:null
  return{input:{version:AI_CONTRACT_VERSION,topic,focus,records},sources,versionLabels}
}
