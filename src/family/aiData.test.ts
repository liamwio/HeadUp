import {it,expect} from 'vitest'
import {buildAiInput} from './aiData'
import {archiveFixture} from './backupVolumes.fixture'
import {extractAiMetric,metricText} from './aiReadings'
import {absoluteP95,evidenceForComponent} from '../lib/errorEvidence'
import {validateAiInput,validateAiSelection,localAiSelection,aiFacts,metricFactId} from './aiContract'
import type {FamilySession} from './model'
const front={code:'FRONT-RATIO-07',label:'不应发送的标签',value:'40.71%',score:0,note:'不应发送的备注',group:'比例' as const,view:'front' as const,available:true,origin:'measurement' as const,errors:[absoluteP95('工程误差来源','仅测试',5.88,'percentage_points')]}
function record():FamilySession{const r=structuredClone(archiveFixture().sessions[0]);r.kind='measurement';r.report.front=[front];r.report.profile=[];r.report.measuredCount=1;r.protocol.device='不应发送的设备';r.note='不应发送的家庭备注';r.captures=r.captures.filter(c=>c.id==='front');return r}
it('extracts stored numbers and uncertainty without sending labels, sources, notes, keypoints or database identifiers',()=>{
  const r=record(),{input,sources,versionLabels}=buildAiInput([r],r.profileId,'reading')
  expect(validateAiInput(input)).toEqual(input);expect(input.focus).toEqual({ref:'R1',code:front.code});expect(input.records[0].metrics[0]).toEqual({code:front.code,values:[40.71],uncertainty:[5.88],origin:'measurement'})
  const wire=JSON.stringify(input);for(const privateText of ['不应发送','工程误差来源',r.id,r.profileId,'landmarks','blob:'])expect(wire).not.toContain(privateText)
  expect(sources.R1).toBe(r.id);expect(versionLabels.A1).toBe(r.version.algorithm)
  const answer=localAiSelection(input);expect(validateAiSelection(answer,input)).toEqual(answer);expect(aiFacts(input).find(f=>f.id===metricFactId('R1',front.code))?.text).toContain('40.71% ± 5.88 个百分点')
})
it('pairs multi-value errors by component and never converts absent error to zero',()=>{
  const reading={...front,code:'PROFILE-LINE-02',view:'profile' as const,value:'上唇 -6.35% · 下唇 -4.34%',errors:[evidenceForComponent(absoluteP95('same-source','upper',3,'percentage_points'),0),evidenceForComponent(absoluteP95('same-source','upper',4,'percentage_points'),0),evidenceForComponent(absoluteP95('other-source','lower',2,'percentage_points'),1)]}
  expect(extractAiMetric(reading)?.uncertainty).toEqual([5,2]);expect(extractAiMetric({...reading,errors:reading.errors.slice(0,2)})?.uncertainty).toEqual([5,null])
  expect(metricText(extractAiMetric({...front,errors:[]})!)).toContain('无适用误差')
})
it('rejects arbitrary prose, units, demo values and unknown metric formats',()=>{
  for(const reading of [{...front,value:'40.71% 好看'},{...front,value:'40.71°'},{...front,origin:'demo' as const},{...front,code:'FRONT-SYM-01'},{...front,available:false}])expect(extractAiMetric(reading)).toBeNull()
})
it('keeps two views separate and reports version changes without exposing device strings',()=>{
  const a=record(),b={...structuredClone(a),id:'later',recordedOn:'2026-09-18',createdAt:'2026-09-18T00:00:00Z',contentKey:undefined,version:{...a.version,algorithm:'updated-engine'},revision:undefined}
  const {input}=buildAiInput([a,b],a.profileId,'comparison');expect(validateAiInput(input)).toEqual(input)
  expect(input.records[1].previous?.front.reasons).toContain('version');expect(input.records[1].previous?.profile.status).toBe('incompatible');expect(input.records[1].versions.algorithm).toBe('A2')
  const answer=localAiSelection(input);expect(validateAiSelection(answer,input)).toEqual(answer)
  expect(()=>validateAiSelection({...answer,limitations:answer.limitations.filter(id=>!id.endsWith('profile-comparison'))},input)).toThrow()
})
it('does not present a selected reading without its uncertainty and capture warnings',()=>{
  const r=record(),{input}=buildAiInput([r],r.profileId,'uncertainty'),answer=localAiSelection(input)
  for(const omitted of ['boundary','R1-quality',metricFactId('R1',front.code)+'-limits'])expect(()=>validateAiSelection({...answer,limitations:answer.limitations.filter(id=>id!==omitted)},input)).toThrow()
  expect(()=>validateAiSelection({...answer,observed:['R1-reading']},input)).toThrow()
})
it('collapses revisions, excludes other profiles, omits memory readings and invalidates metric values',()=>{
  const original=record(),revision={...structuredClone(original),id:'revision',revision:{rootId:original.id,parentId:original.id,number:1,operation:'reanalyze' as const,views:['front' as const]}}
  revision.report.front[0].value='41.00%';const outsider={...original,id:'other',profileId:'other-profile'},built=buildAiInput([original,revision,outsider],original.profileId)
  expect(built.input.records).toHaveLength(1);expect(built.sources.R1).toBe('revision');expect(built.input.records[0].metrics[0].values).toEqual([41])
  const memory=buildAiInput([{...original,kind:'memory'}],original.profileId);expect(memory.input.records[0].metrics).toEqual([]);expect(memory.input.records[0].measuredCount).toBe(0)
})
