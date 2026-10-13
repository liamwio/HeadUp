import { describe, expect, it } from 'vitest'
import { buildConsumerReport } from './consumerReport'
import { searchReadings } from './readingSearch'
const r=buildConsumerReport([],true),rows=r.front.concat(r.profile)
describe('plain-language measurement lookup',()=>{
  it('supports user terms rather than requiring technical IDs',()=>{
    expect(searchReadings(rows,'嘴宽').map(r=>r.code)).toContain('FRONT-RATIO-05')
    expect(searchReadings(rows,'鼻唇角').map(r=>r.code)).toEqual(['PROFILE-ANGLE-03'])
  })
  it('combines name queries and view filters',()=>{
    expect(searchReadings(rows,'鼻唇角','front')).toEqual([])
    expect(searchReadings(rows,'','profile')).toHaveLength(3)
  })
  it('restores the full list on reset',()=>{
    expect(searchReadings(rows,'不存在')).toEqual([])
    expect(searchReadings(rows,'')).toHaveLength(rows.length)
  })
})
