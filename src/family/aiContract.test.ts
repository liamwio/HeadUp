import {describe,it,expect} from 'vitest'
import {AI_CONTRACT_VERSION,validateAiInput,validateAiSelection,aiFacts,type AiInput} from './aiContract'
export const fixture:AiInput={version:AI_CONTRACT_VERSION,topic:'overview',focus:null,records:[{ref:'R1',date:'2026-09-17',kind:'measurement',measuredCount:11,previous:null,metrics:[],versions:{algorithm:'A1',norm:'N1',copy:'C1',protocol:'P1'},views:[{view:'front',side:'unknown',quality:'pass',pose:'pass'}]}]}
export const selection={recorded:['record-count'],observed:['R1-reading'],limitations:['boundary'],actions:['missing']}
describe('AI closed evidence contract',()=>{
  it('accepts minimal structured records and renders exact sourced counts',()=>{expect(validateAiInput(fixture)).toEqual(fixture);expect(validateAiSelection(selection,fixture)).toEqual(selection);expect(aiFacts(fixture).find(f=>f.id==='R1-reading')?.text).toContain('11项')})
  it.each(['photo','nickname','birthYear','keypoints','note'])('rejects extra personal field %s',field=>{expect(()=>validateAiInput({...fixture,[field]:'private'})).toThrow();expect(()=>validateAiInput({...fixture,records:[{...fixture.records[0],[field]:'private'}]})).toThrow()})
  it.each([{...selection,observed:['R2-reading']},{...selection,observed:['record-count']},{...selection,limitations:['R1-missing']},{...selection,actions:['diagnose']},{...selection,text:'发育改善10%'},{...selection,observed:['成长正常']}])('rejects invented references, missing limits and free text',value=>expect(()=>validateAiSelection(value,fixture)).toThrow())
  it('rejects invalid dates, empty records and repeated views',()=>{for(const input of [{...fixture,records:[]},{...fixture,records:[{...fixture.records[0],date:'2026-02-30'}]},{...fixture,records:[{...fixture.records[0],views:[...fixture.records[0].views,...fixture.records[0].views]}]}])expect(()=>validateAiInput(input)).toThrow()})
  it('requires a real selected metric, valid uncertainty components and renewed contract version',()=>{
    const metric={code:'FRONT-RATIO-07',values:[40.71],uncertainty:[5.88],origin:'measurement'},row={...fixture.records[0],metrics:[metric]}
    for(const raw of [{...fixture,version:'HEADUP-STAGE-1'},{...fixture,topic:'reading'},{...fixture,focus:{ref:'R9',code:metric.code}},{...fixture,records:[{...row,metrics:[{...metric,uncertainty:[-1]}]}]},{...fixture,records:[{...row,metrics:[{...metric,values:[40,41]}]}]},{...fixture,records:[{...row,metrics:[{...metric,note:'private'}]}]},{...fixture,records:[{...row,kind:'memory'}]}])expect(()=>validateAiInput(raw)).toThrow()
  })
})
