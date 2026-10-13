import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FrontMetricVisual } from './FrontMetricVisual'
import { absoluteP95 } from './lib/errorEvidence'
import type { Measurement } from './types'

const make = (code:string,value:string,uncertainty:number):Measurement => ({code,value,label:'测试指标',score:0,note:'',group:'比例',errors:[absoluteP95('test','',uncertainty,value.includes('%')?'percentage_points':'ratio')]})
describe('front metric interval presentation',()=>{
  it('withholds an unvalidated external reference even with a precise numeric reading',()=>{
    const html=renderToStaticMarkup(<FrontMetricVisual item={make('FRONT-RATIO-01','1.262',.104)}/> )
    expect(html).toContain('暂无适配此公式的评价参考范围')
    expect(html).not.toMatch(/<i[ >]/)
    expect(html).toContain('1.158–1.366')
  })
  it.each([['FRONT-RATIO-06','29.05%',4.06,'24.99%–33.11%'],['FRONT-RATIO-10','0.309',.018,'0.291–0.327']])('shows %s uncertainty without inventing a reference band',(code,value,u,interval)=>{
    const html=renderToStaticMarkup(<FrontMetricVisual item={make(code as string,value as string,u as number)}/> )
    expect(html).toContain(interval)
    expect(html).toContain('暂无适配此公式的评价参考范围')
    expect(html).not.toMatch(/<i[ >]/)
  })
})
