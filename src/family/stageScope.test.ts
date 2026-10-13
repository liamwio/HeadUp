import {it,expect} from 'vitest'
import {archiveFixture} from './backupVolumes.fixture'
import {selectStage,stagePreset,validateStageRange,buildStageSections,stageQuestions,stageSummaryHtml,type AiStageExport} from './stageScope'
import {buildAiInput} from './aiData'
const today='2026-09-17'
it('filters latest revisions before applying dates so an older date never resurrects a record',()=>{
  const f=archiveFixture(),root=f.sessions[0],revision=f.sessions[1];revision.recordedOn='2026-09-16'
  expect(selectStage(f.sessions,[],root.profileId,{from:today,to:today},today).rows).toEqual([])
  expect(selectStage(f.sessions,[],root.profileId,{from:'2026-09-16',to:today},today).rows.map(s=>s.id)).toEqual([revision.id])
})
it('rejects reversed, impossible and future ranges and handles year boundaries for presets',()=>{
  for(const range of [{from:'2026-02-30',to:''},{from:today,to:'2026-09-16'},{from:'',to:'2026-09-18'}])expect(validateStageRange(range,today)).not.toBe('')
  expect(stagePreset('term','2026-01-15')).toEqual({from:'2025-09-01',to:'2026-01-15'})
  expect(stagePreset('term','2026-02-01').from).toBe('2026-02-01');expect(stagePreset('quarter','2026-01-15').from).toBe('2026-01-01');expect(stagePreset('quarter',today).from).toBe('2026-07-01')
})
it('limits events and questions to the current profile and explicit date range',()=>{
  const f=archiveFixture(),id=f.profiles[0].id,events=[{id:'in',profileId:id,date:today,type:'question' as const,text:'家庭选择的问题',createdAt:''},{id:'out',profileId:'other',date:today,type:'question' as const,text:'另一档案私密问题',createdAt:''},{id:'old',profileId:id,date:'2026-08-01',type:'question' as const,text:'范围外问题',createdAt:''}]
  const scoped=selectStage(f.sessions,events,id,{from:today,to:today},today)
  expect(scoped.events.map(e=>e.id)).toEqual(['in']);expect(stageQuestions(scoped.events).filter(q=>q.id.startsWith('event:')).map(q=>q.text)).toEqual(['家庭选择的问题'])
})
it('keeps four evidence-backed sections and no more than three general actions',()=>{
  const f=archiveFixture(),a={...f.sessions[0],kind:'measurement' as const},b={...structuredClone(a),id:'another',recordedOn:'2026-08-01',protocol:{...a.protocol,device:'other'}}
  const groups=buildStageSections([a,b],f.profiles[0]);expect(groups).toHaveLength(4);expect(groups[0].facts[0].sourceIds).toEqual([a.id,b.id]);expect(groups[2].facts.some(f=>f.text.includes('照片缺失'))).toBe(true);expect(groups[3].facts.length).toBeLessThanOrEqual(3)
  expect(buildStageSections([],f.profiles[0])[0].facts[0].text).toContain('还没有保存记录')
})
it('distinguishes basic capture checks from record type and keeps biased or failed photos out of the qualified count',()=>{
  const f=archiveFixture(),row={...structuredClone(f.sessions[0]),kind:'measurement' as const};row.report.isExample=false
  row.captures=(['front','profile'] as const).map(id=>({id,label:id,hint:'',eyebrow:'',quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:id==='front'?'front':'left_profile',detectedFaces:1,flags:[]}}))
  const biased=structuredClone(row);biased.id='biased';biased.captures[0].acceptedWithBias=true
  const failed=structuredClone(row);failed.id='failed';failed.captures[1].analysisError='model unavailable'
  const facts=buildStageSections([row,biased,failed],f.profiles[0])[0].facts
  expect(facts.some(f=>f.text.startsWith('其中1次'))).toBe(true);expect(facts[1].text).toContain('不代表跨期可比')
})
it('exports selected facts safely and omits nickname, photos, raw ids and unselected notes',()=>{
  const f=archiveFixture(),rows=selectStage(f.sessions,[],f.profiles[0].id,{from:'',to:''},today).rows,sections=buildStageSections(rows,f.profiles[0]),question={id:'chosen',text:'<img src=x onerror=alert(1)>',source:'家庭文字'}
  const html=stageSummaryHtml({profile:f.profiles[0],rows,range:{from:'',to:''},sections,questions:[question],now:new Date('2026-09-17T00:00:00Z')})
  for(const secret of [f.profiles[0].nickname,f.sessions[0].note,f.profiles[0].id,rows[0].id,'<img','<script','blob:'])expect(html).not.toContain(secret)
  expect(html).toContain('&lt;img');expect(html).toContain('href="#R1"');expect(html).toContain("default-src 'none'");expect(html).not.toContain('本页已核验的AI整理')
})
it('clearly separates optional AI provenance and escapes provider text',()=>{
  const f=archiveFixture(),rows=[f.sessions[0]],ai:AiStageExport={scopeKey:'internal-key',recordCount:1,topic:'记录概况',provider:'<script>vendor</script>',model:'model',generatedAt:'2026-09-17T00:00:00Z',sections:[{title:'AI观察',facts:[{text:'依据已有记录',sourceIds:[rows[0].id]}]}]}
  const html=stageSummaryHtml({profile:f.profiles[0],rows,range:{from:'',to:''},sections:buildStageSections(rows,f.profiles[0]),questions:[],includeNickname:true,ai})
  expect(html).toContain(f.profiles[0].nickname);expect(html).toContain('仅覆盖本范围内最近1次记录');expect(html).toContain('&lt;script&gt;vendor');expect(html).not.toContain('internal-key')
})
it('sends only the latest twelve scoped records to AI without losing earlier local evidence',()=>{
  const f=archiveFixture(),rows=Array.from({length:16},(_,i)=>({...structuredClone(f.sessions[0]),id:'record-'+i,recordedOn:'2026-08-'+String(i+1).padStart(2,'0')})),scope=selectStage(rows,[],f.profiles[0].id,{from:'2026-08-02',to:'2026-08-15'},today),built=buildAiInput(scope.rows,f.profiles[0].id)
  expect(scope.rows).toHaveLength(14);expect(built.input.records).toHaveLength(12);expect(built.input.records[0].date).toBe('2026-08-04');expect(built.input.records.at(-1)?.date).toBe('2026-08-15');expect(JSON.stringify(built.input)).not.toContain(f.sessions[0].note)
})
