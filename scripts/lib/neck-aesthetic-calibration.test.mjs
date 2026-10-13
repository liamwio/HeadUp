import{describe,expect,it}from'vitest'
import{analyzeNeckAestheticRows}from'./neck-aesthetic-calibration.mjs'

describe('neck aesthetic calibration',()=>{
  it('promotes a strong bounded preference signal only after cross-validation and permutation testing',()=>{
    const rows=Array.from({length:30},(_,index)=>{const angle=10+index*1.5,inside=angle>=20&&angle<=35;return{angle,score:inside?(index%3===0?4:5):(index%4===0?1:2)}}),result=analyzeNeckAestheticRows(rows,{permutations:500,seed:7})
    expect(result.gates.complete30).toBe(true)
    expect(result.gates.looBalancedAccuracyAtLeast65Percent).toBe(true)
    expect(result.gates.permutationPAtMost05).toBe(true)
    expect(result.gates.eligibleForPreferenceBand).toBe(true)
  })
  it('rejects a flat score distribution with no high or low evidence',()=>{
    const result=analyzeNeckAestheticRows(Array.from({length:30},(_,index)=>({angle:10+index,score:3})),{permutations:100})
    expect(result.gates.highRatedAtLeast8).toBe(false)
    expect(result.gates.eligibleForPreferenceBand).toBe(false)
  })
  it('rejects incomplete rating coverage',()=>{
    const result=analyzeNeckAestheticRows(Array.from({length:29},(_,index)=>({angle:10+index,score:index%2?4:2})),{permutations:100})
    expect(result.gates.complete30).toBe(false)
    expect(result.gates.eligibleForPreferenceBand).toBe(false)
  })
})
