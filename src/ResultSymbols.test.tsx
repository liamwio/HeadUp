import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReadingSymbol, ResultSymbols, shortUncertainty } from './ResultSymbols'
import { buildConsumerReport } from './lib/consumerReport'

describe('result symbols encode observed values',()=>{
  const report=buildConsumerReport([],true)
  it('uses the observed percentage for the ring length',()=>{
    const reading=report.front.find(r=>r.code==='FRONT-RATIO-07')!
    const markup=renderToStaticMarkup(<ReadingSymbol reading={reading}/>)
    expect(markup).toContain(`stroke-dasharray="${2*Math.PI*28*.4011}`)
    expect(markup).toContain('40.11%比例图')
    expect(shortUncertainty(reading)).toBe('± 5.79个百分点')
  })
  it('preserves the actual angle and avoids invalid SVG geometry',()=>{
    const reading=report.profile[0]
    const markup=renderToStaticMarkup(<ReadingSymbol reading={reading}/>)
    expect(markup).toContain('168.20°角度图')
    expect(markup).not.toMatch(/NaN|Infinity/)
  })
  it('keeps three concise measured outcomes without explanatory paragraphs',()=>{
    const markup=renderToStaticMarkup(<ResultSymbols report={report} onSelect={()=>{}}/>)
    expect(markup.match(/class="result-symbol-card"/g)).toHaveLength(3)
    expect(markup).toContain('40.11%')
    expect(markup).toContain('168.20°')
    expect(markup).not.toContain('<p>')
  })
  it('does not invent a percentage or angle for an empty report',()=>{
    const markup=renderToStaticMarkup(<ResultSymbols report={buildConsumerReport([])} onSelect={()=>{}}/>)
    expect(markup).toContain('未添加照片')
    expect(markup).not.toContain('result-symbol-fill')
    expect(markup).not.toContain('result-symbol-ray')
  })
})
