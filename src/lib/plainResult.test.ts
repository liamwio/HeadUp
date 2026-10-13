import {describe,expect,it} from 'vitest'
import type {Capture} from '../types'
import {plainIssue,plainLabel,plainValue,readingTag,recordVerdict} from './plainResult'
import type {ConsumerReading} from './consumerReport'

const capture=(id:Capture['id'],extra:Partial<Capture>={}):Capture=>({id,label:id,eyebrow:'',hint:'',url:'blob:'+id,quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:id==='front'?'front':id==='right_profile'?'right_profile':'left_profile',detectedFaces:1,flags:[]},...extra})

describe('plain result language',()=>{
  it('rounds display values without touching units or signs',()=>{
    expect(plainValue('36.62%')).toBe('37%')
    expect(plainValue('169.39°')).toBe('169°')
    expect(plainValue('0.7812')).toBe('0.78')
    expect(plainValue('上唇 -0.16% · 下唇 0.94%')).toBe('上唇 -0.2% · 下唇 0.9%')
    expect(plainValue('中面 55.45% · 下面 44.55%')).toBe('中面 55% · 下面 45%')
    expect(plainValue('-0.01%')).toBe('0.0%')
    expect(plainValue('关键点或参考线超出照片')).toBe('关键点或参考线超出照片')
  })
  it('uses short names and falls back to the stored label',()=>{
    expect(plainLabel({code:'FRONT-RATIO-07',label:'下半脸占脸高'})).toBe('下脸高度')
    expect(plainLabel({code:'UNKNOWN',label:'原名'})).toBe('原名')
  })
  it('collapses uncalibrated captions into one tag',()=>{
    const base={code:'FRONT-RATIO-07',label:'x',value:'1%',score:0,note:'',group:'比例',view:'front',available:true} as ConsumerReading
    expect(readingTag({...base,origin:'measurement',errors:[{} as never]})).toBe('')
    expect(readingTag({...base,origin:'experimental'})).toBe('参考')
    expect(readingTag({...base,origin:'demo'})).toBe('')
  })
  it('turns a technical tilt rejection into one action',()=>{
    const issue=plainIssue(capture('right_profile',{analysisError:'侧面姿态检查未通过：模型估计横向倾斜 21.3°，超过当前 18° 限值。',poseValidation:{status:'reject',estimatedPose:'right_profile',detectedFaces:1,flags:['头部横向倾斜过大']}}))
    expect(issue.headline).toBe('侧面角度待核对')
    expect(issue.detail).toContain('21.3°')
  })
  it('summarizes a record in one sentence',()=>{
    expect(recordVerdict([capture('front'),capture('profile'),capture('right_profile')]).headline).toBe('3 张照片通过拍摄检查')
    const partial=recordVerdict([capture('front'),capture('profile'),capture('right_profile',{analysisError:'侧面关键点定位未完成',poseValidation:{status:'pass',estimatedPose:'right_profile',detectedFaces:1,flags:[]}})])
    expect(partial.tone).toBe('warn')
    expect(partial.headline).toBe('可用 2 张，右侧需重拍')
    const missing=recordVerdict([capture('front'),{id:'profile',label:'左侧',eyebrow:'',hint:''},capture('right_profile')])
    expect(missing.headline).toBe('可用 2 张，左侧未拍')
    expect(recordVerdict([{id:'front',label:'正面',eyebrow:'',hint:''}]).tone).toBe('empty')
  })
})
