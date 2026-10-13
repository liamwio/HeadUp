import{describe,expect,it}from'vitest'
import type{Capture}from'../types'
import{captureRetakeAssessment}from'./captureRetakeGuidance'

const capture=(flag:string):Capture=>({id:'front',label:'正面',eyebrow:'',hint:'',quality:{score:89,resolution:90,brightness:90,contrast:90,sharpness:90,flags:[]},poseValidation:{status:'reject',estimatedPose:'front',detectedFaces:1,flags:[flag]}})

describe('capture retake guidance',()=>{
  it('allows either direction in profile retake guidance',()=>{
    const result=captureRetakeAssessment({...capture('侧面照片需要接近 90°'),id:'profile',label:'侧面'})
    expect(result.improvements.join(' ')).toContain('左侧面或右侧面均可')
    expect(result.improvements.join(' ')).not.toContain('向左转头')
  })
  it('explains the affected photo, reason and concrete improvement',()=>{
    const result=captureRetakeAssessment(capture('镜头需与眼睛同高，请避免抬头或低头'))
    expect(result.strictPass).toBe(false)
    expect(result.issues).toEqual(['镜头需与眼睛同高，请避免抬头或低头'])
    expect(result.improvements[0]).toContain('双眼同高')
  })

  it('deduplicates repeated quality and pose guidance',()=>{
    const item=capture('画面模糊')
    item.quality!.flags=['画面模糊']
    expect(captureRetakeAssessment(item).issues).toEqual(['画面模糊'])
  })

  it('never leaves a rejected photo without an explicit reason',()=>{
    const item=capture('')
    item.poseValidation!.flags=[]
    expect(captureRetakeAssessment(item).issues).toEqual(['拍摄视角未达到当前照片类型要求'])
  })
})
