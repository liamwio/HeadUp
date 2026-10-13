import {compareSessions,type FamilySession} from './model'
import {extractAiMetric,AI_METRICS} from './aiReadings'
import {summarizeMetricValue} from '../lib/metricUncertainty'
import type {ConsumerReading} from '../lib/consumerReport'
import {sameReadingProvenance} from './readingProvenance'
const display=(r?:ConsumerReading)=>!r?'本次无此项目':!r.available?'未得到可用读数':summarizeMetricValue(r.value,r.errors??[]).display
export function compareReadings(a:FamilySession,b:FamilySession,view:'front'|'profile'){
  const readings=(s:FamilySession)=>[...s.report[view],...s.report.extended.filter(r=>r.view===view)],left=readings(a),right=readings(b),comparison=compareSessions(a,b,view)
  return [...new Set([...left,...right].map(r=>r.code).filter((code):code is string=>Boolean(code)))].map(code=>{
    const before=left.find(r=>r.code===code),after=right.find(r=>r.code===code),x=before&&extractAiMetric(before),y=after&&extractAiMetric(after)
    let difference='条件未通过，不计算差值'
    if(a.kind==='memory'||b.kind==='memory')difference='生活留念不作读数比较'
    else if(!before?.available||!after?.available)difference=!before?.available&&after?.available?'本次新增可用读数':before?.available&&!after?.available?'本次未得到可用读数':'两次均无可用读数'
    else if(!sameReadingProvenance(before,after))difference='读数来源或公式不同，不计算差值'
    else if(comparison.status==='conditions_close'){
      if(!x||!y)difference='保留原读数；此格式尚不计算差值'
      else{const spec=AI_METRICS[code],precision=spec.unit==='ratio'?3:2;difference=y.values.map((v,i)=>{const delta=Number((v-x.values[i]).toFixed(precision)),unit=spec.unit==='percent'?' 个百分点':spec.unit==='degrees'?'°':'';return(spec.parts.length>1?spec.parts[i]+' ':'')+(delta>0?'+':'')+delta.toFixed(precision)+unit}).join('；')}
    }
    return{code,label:after?.label??before?.label??code,before:display(before),after:display(after),difference,experimental:before?.origin==='experimental'||after?.origin==='experimental',extended:!a.report[view].some(r=>r.code===code)&&!b.report[view].some(r=>r.code===code)}
  })
}
