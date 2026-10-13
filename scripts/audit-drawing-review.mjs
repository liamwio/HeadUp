import {readFile,readdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {auditReadingEvidence} from '../src/lib/measurementEvidenceAudit.ts'
const folder=resolve('data/validation/llm-drawing-review-2026-09-22'),rows=[]
for(const name of (await readdir(join(folder,'results'))).filter(n=>n.endsWith('.json')).sort()){
 const path=join(folder,'results',name),r=JSON.parse(await readFile(path,'utf8'))
 r.audits=r.readings.map(reading=>({code:reading.code,label:reading.label,...auditReadingEvidence(reading,r.view==='left_profile'?'left':r.view==='right_profile'?'right':undefined)}))
 await writeFile(path,JSON.stringify(r,null,2));rows.push(r)
}
const count=values=>Object.fromEntries([...new Set(values)].map(k=>[k,values.filter(v=>v===k).length]))
const summary={total:rows.length,poseStatus:count(rows.map(r=>r.poseStatus??'missing')),nativeStatus:count(rows.map(r=>r.nativeStatus??'front')),audit:count(rows.flatMap(r=>r.audits.map(a=>a.status))),availableReadings:rows.reduce((n,r)=>n+r.readings.filter(x=>x.available).length,0),availableNotAudited:rows.flatMap(r=>r.audits.filter(a=>a.status==='not_applicable'&&r.readings.find(x=>x.code===a.code)?.available).map(a=>({id:r.id,...a}))),numericFailures:rows.flatMap(r=>r.audits.filter(a=>a.status==='fail').map(a=>({id:r.id,...a}))),noReadings:rows.filter(r=>!r.readings.some(x=>x.available)).map(r=>r.id)}
await writeFile(join(folder,'numeric-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2))
