import {describe,expect,it} from 'vitest'
import type {MeasurementEvidence} from './measurementEvidence'
import {buildConsumerReport} from './consumerReport'
import {parseReportRecord,reportFromRecord,serializeReportRecord} from './reportRecord'
import {archiveFixture} from '../family/backupVolumes.fixture'
import {decryptArchive,encryptArchive} from '../family/backup'

const evidence=():MeasurementEvidence=>({version:'HEADUP-POINT-LINE-1',source:'saved_front_landmarks',width:500,height:600,points:[{id:'a',label:'起点',x:0,y:0},{id:'b',label:'终点',x:500,y:600}],segments:[{id:'ab',label:'测量线',from:'a',to:'b',role:'measure'}],formula:'distance(a,b)'})
function record(){const report=buildConsumerReport([],true);report.front[0].evidence=evidence();return JSON.parse(serializeReportRecord(report,'adult'))}

describe('persisted point and line evidence',()=>{
  it('roundtrips pixel points, lines and formula through report serialization',()=>{
    const input=record(),parsed=parseReportRecord(JSON.stringify(input)),restored=reportFromRecord(parsed)
    expect(restored.front[0].evidence).toEqual(evidence())
    expect(restored.front[0].errors).toEqual(input.measurements[0].errors)
  })
  it('accepts legacy records without adding invented point provenance',()=>{
    const input=record();delete input.measurements[0].evidence
    expect(parseReportRecord(JSON.stringify(input)).measurements[0]).not.toHaveProperty('evidence')
  })
  it('requires the evidence source to match the front/profile view',()=>{
    const input=record();input.measurements[0].evidence.source='saved_profile_landmarks'
    expect(()=>parseReportRecord(JSON.stringify(input))).toThrow()
    const side=input.measurements.find((r:{view:string})=>r.view==='profile')
    side.evidence=evidence();delete input.measurements[0].evidence
    expect(()=>parseReportRecord(JSON.stringify(input))).toThrow()
    side.evidence.source='saved_profile_landmarks'
    expect(parseReportRecord(JSON.stringify(input)).measurements.find(r=>r.view==='profile')?.evidence?.source).toBe('saved_profile_landmarks')
  })
  it.each([
    ['unknown version',(e:any)=>{e.version='future'}],
    ['unknown source',(e:any)=>{e.source='direct_geometry_head'}],
    ['zero width',(e:any)=>{e.width=0}],
    ['negative height',(e:any)=>{e.height=-1}],
    ['huge width',(e:any)=>{e.width=100001}],
    ['nonfinite height',(e:any)=>{e.height=Infinity}],
    ['string coordinate',(e:any)=>{e.points[0].x='1'}],
    ['NaN coordinate',(e:any)=>{e.points[0].y=NaN}],
    ['negative coordinate',(e:any)=>{e.points[0].x=-.1}],
    ['coordinate beyond image',(e:any)=>{e.points[1].y=601}],
    ['duplicate point ID',(e:any)=>{e.points[1].id='a'}],
    ['empty point ID',(e:any)=>{e.points[1].id=''}],
    ['invalid point label',(e:any)=>{e.points[0].label=4}],
    ['unknown endpoint',(e:any)=>{e.segments[0].to='missing'}],
    ['unknown role',(e:any)=>{e.segments[0].role='other'}],
    ['duplicate segment ID',(e:any)=>{e.segments.push({...e.segments[0]})}],
    ['too many points',(e:any)=>{e.points=Array.from({length:41},(_,i)=>({id:String(i),label:'p',x:1,y:1}))}],
    ['too many segments',(e:any)=>{e.segments=Array.from({length:31},(_,i)=>({...e.segments[0],id:String(i)}))}],
    ['oversized formula',(e:any)=>{e.formula='x'.repeat(3001)}],
  ] as const)('rejects %s before restoration',(_label,change)=>{
    const input=record();change(input.measurements[0].evidence)
    expect(()=>parseReportRecord(JSON.stringify(input))).toThrow()
  })
  it('keeps evidence, original values/errors and frozen versions through encrypted backup',async()=>{
    const archive=archiveFixture(),readings=buildConsumerReport([],true).front
    for(const session of archive.sessions){session.report.front=structuredClone(readings);session.report.front[0].evidence=evidence();session.version={algorithm:'saved-algorithm',norm:'saved-errors',copy:'saved-copy'}}
    const restored=await decryptArchive(await encryptArchive(archive,'evidence-test-password'),'evidence-test-password')
    expect(restored.sessions[0].report.front[0].evidence).toEqual(evidence())
    expect(restored.sessions[0].report.front.map(r=>[r.value,r.errors])).toEqual(archive.sessions[0].report.front.map(r=>[r.value,r.errors]))
    expect(restored.sessions[0].version).toEqual(archive.sessions[0].version)
  })
})
