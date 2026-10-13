import { describe, expect, it } from 'vitest'
import { buildConsumerReport } from './consumerReport'
import { MAX_REPORT_BYTES, parseReportRecord, reportFromRecord, serializeReportRecord } from './reportRecord'
const recordObject=()=>JSON.parse(serializeReportRecord(buildConsumerReport([],true),'adult'))
describe('download and reopen report records',()=>{
  it('roundtrips values, dates, errors and summaries without photos or scores',()=>{
    const original=buildConsumerReport([],true)
    const json=serializeReportRecord(original,'adult'),parsed=parseReportRecord(json),restored=reportFromRecord(parsed)
    expect(restored.createdAt).toBe(original.createdAt)
    expect(restored.front.map(r=>r.value)).toEqual(original.front.map(r=>r.value))
    expect(restored.profile.map(r=>r.errors)).toEqual(original.profile.map(r=>r.errors))
    expect(restored.summaries).toEqual(original.summaries)
    expect(restored.native).toBeNull()
    expect(JSON.parse(json).measurements[0]).not.toHaveProperty('score')
    expect(JSON.parse(json)).not.toHaveProperty('photos')
  })
  it('opens older v2 records without saved summary text',()=>{
    const input=recordObject();delete input.summaries
    const r=reportFromRecord(parseReportRecord(JSON.stringify(input)))
    expect(r.summaries).toHaveLength(3)
    expect(r.summaries[1].value).toContain('40.11%')
  })
  it('retains original version metadata and capture warnings when reopening a real record',()=>{
    const input=recordObject();input.isExample=false;input.version={algorithm:'historic-v1',norm:'historic-band',copy:'historic-copy'}
    input.detection.front.issues=['姿态偏差']
    const parsed=parseReportRecord(JSON.stringify(input)),restored=reportFromRecord(parsed)
    expect(restored.issues).toContain('正面：姿态偏差')
    expect(JSON.parse(serializeReportRecord(restored,parsed.mode,parsed.version)).version.algorithm).toBe('historic-v1')
  })
  it.each(['{}','[]','null','not json'])('rejects non-record input %s',(value)=>expect(()=>parseReportRecord(value)).toThrow())
  it.each(['schema','createdAt','mode'])('rejects invalid %s',(key)=>{
    const input=recordObject();input[key]='wrong'
    expect(()=>parseReportRecord(JSON.stringify(input))).toThrow()
  })
  it('rejects oversized files before attempting restoration',()=>expect(()=>parseReportRecord(' '.repeat(MAX_REPORT_BYTES+1))).toThrow(/过大/))
  it('rejects invalid error units and nonfinite magnitudes',()=>{
    const input=recordObject();input.measurements[0].errors[0].unit='px'
    expect(()=>parseReportRecord(JSON.stringify(input))).toThrow()
    input.measurements[0].errors[0].unit='percentage_points';input.measurements[0].errors[0].value=null
    expect(()=>parseReportRecord(JSON.stringify(input))).toThrow()
  })
  it('rejects duplicate identifiers and overflowing numeric strings',()=>{
    const input=recordObject();input.measurements[1].code=input.measurements[0].code
    expect(()=>parseReportRecord(JSON.stringify(input))).toThrow()
    const huge=recordObject();huge.measurements[0].value='9'.repeat(310)
    expect(()=>parseReportRecord(JSON.stringify(huge))).toThrow()
  })
  it('ignores arbitrary file URLs and unknown executable-looking fields',()=>{
    const input=recordObject();input.photos=['file:///private.jpg'];input.script='alert(1)';input.measurements[0].onClick='alert(1)'
    const result=parseReportRecord(JSON.stringify(input))
    expect(result).not.toHaveProperty('photos');expect(result).not.toHaveProperty('script');expect(result.measurements[0]).not.toHaveProperty('onClick')
  })
})
