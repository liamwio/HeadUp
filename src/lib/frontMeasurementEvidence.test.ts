import { describe, expect, it } from 'vitest'
import type { LandmarkPoint } from '../types'
import type { MeasurementEvidence } from './measurementEvidence'
import { analyzeCaptures, measureFrontLandmarks } from './faceMeasurements'
import { buildFrontPointMeasurements } from './frontMeasurementEvidence'

function fixture(): LandmarkPoint[] {
  const points = Array.from({ length: 478 }, () => ({ x: .5, y: .5, z: 0 }))
  for (const [index, x, y] of [
    [10, .5, .1], [168, .5, .3], [6, .5, .36], [1, .5, .45], [2, .5, .6], [152, .5, .9],
    [234, .1, .5], [454, .9, .5], [172, .2, .78], [397, .8, .78], [61, .35, .7], [291, .65, .7],
    [33, .2, .39], [133, .35, .4], [362, .65, .4], [263, .8, .38], [98, .43, .55], [327, .57, .55],
    [37, .47, .67], [84, .47, .73], [0, .5, .69], [17, .5, .71], [267, .53, .66], [314, .53, .74],
  ]) points[index] = { x, y, z: 0 }
  for (let index = 468; index < 473; index++) points[index] = { x: .3 + (index - 470) * .001, y: .4, z: 0 }
  for (let index = 473; index < 478; index++) points[index] = { x: .7 + (index - 475) * .001, y: .4, z: 0 }
  return points
}

function length(evidence: MeasurementEvidence, id: string) {
  const segment = evidence.segments.find(s => s.id === id)!
  const a = evidence.points.find(p => p.id === segment.from)!, b = evidence.points.find(p => p.id === segment.to)!
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('front measurements use the points drawn in their evidence', () => {
  it.each([[1200, 800], [800, 1200]])('reconstructs every ratio solely from saved evidence at %s×%s', (width, height) => {
    const measurements = measureFrontLandmarks(fixture(), 90, width, height)
    const ratios = measurements.filter(reading => reading.code?.startsWith('FRONT-RATIO-'))
    expect(ratios).toHaveLength(10)
    for (const reading of ratios) {
      const evidence = reading.evidence!
      expect(evidence).toMatchObject({ version: 'HEADUP-POINT-LINE-1', source: 'saved_front_landmarks', width, height })
      const measures = evidence.segments.filter(s => s.role === 'measure').map(s => length(evidence, s.id))
      const references = evidence.segments.filter(s => s.role === 'reference').map(s => length(evidence, s.id))
      const numerator = reading.code === 'FRONT-RATIO-10' ? measures.sort((a, b) => a - b)[1] : measures[0]
      const denominator = references.reduce((sum, value) => sum + value, 0) / references.length
      const exact = numerator / denominator
      expect(reading.value).toBe(reading.value.endsWith('%') ? `${(exact * 100).toFixed(2)}%` : exact.toFixed(3))
    }
  })

  it('uses three different saved lip heights without accepting a hidden scalar override or old uncertainty', () => {
    const points = fixture()
    const result = analyzeCaptures([{ id: 'front', label: '正面', eyebrow: '', hint: '', poseValidation: {
      status: 'pass', estimatedPose: 'front', detectedFaces: 1, flags: [], landmarks: points,
      landmarkImageWidth: 1000, landmarkImageHeight: 1000, robustLipHeightMouthWidthRatio: .99,
    } }])
    const lip = result.measurements.find(reading => reading.code === 'FRONT-RATIO-10')!
    // Heights are .06, .02 and .08 image heights; median .06 / mouth width .30.
    expect(lip.value).toBe('0.200')
    expect(lip.errors).toEqual([])
    expect(lip.evidence!.segments.filter(s => s.role === 'measure')).toHaveLength(3)
    expect(lip.confidenceBasis).toContain('待重新校准')
  })

  it('provides the actual averaged iris centers and their saved source points', () => {
    const input = fixture(), evidence = buildFrontPointMeasurements(input, 1600, 900)!['FRONT-RATIO-02'].evidence
    for (const [id, start] of [['iris-left-center', 468], ['iris-right-center', 473]] as const) {
      const center = evidence.points.find(p => p.id === id)!
      const source = Array.from({ length: 5 }, (_, offset) => evidence.points.find(p => p.id === `mp-${start + offset}`)!)
      expect(center.x).toBeCloseTo(source.reduce((sum, p) => sum + p.x, 0) / 5)
      expect(center.y).toBeCloseTo(source.reduce((sum, p) => sum + p.y, 0) / 5)
    }
  })

  it('reconstructs eye tilt from the emitted eye segments and fitted axis instead of image horizontal', () => {
    const theta = 7 * Math.PI / 180
    const points = fixture().map(p => ({ ...p, x: .5 + (p.x - .5) * Math.cos(theta) - (p.y - .5) * Math.sin(theta), y: .5 + (p.x - .5) * Math.sin(theta) + (p.y - .5) * Math.cos(theta) }))
    const reading = measureFrontLandmarks(points, 90, 1000, 1000).find(r => r.code === 'FRONT-ANGLE-01')!
    const evidence = reading.evidence!
    const vector = (id: string) => {
      const segment = evidence.segments.find(s => s.id === id)!, a = evidence.points.find(p => p.id === segment.from)!, b = evidence.points.find(p => p.id === segment.to)!
      return { x: b.x - a.x, y: b.y - a.y }
    }
    const axis = vector('horizontal-axis')
    const angle = (id: string) => { const v = vector(id); return Math.atan2(axis.x * v.y - axis.y * v.x, axis.x * v.x + axis.y * v.y) * 180 / Math.PI }
    expect(reading.value).toBe(`${((angle('left-eye') - angle('right-eye')) / 2).toFixed(2)}°`)
    expect(Math.abs(axis.y)).toBeGreaterThan(1)
  })

  it('rejects incomplete, nonfinite or degenerate geometry before producing numbers or evidence', () => {
    const points = fixture()
    for (const input of [points.slice(0, 477), points.map((p, index) => index === 475 ? { ...p, x: NaN } : p), points.map((p, index) => index === 10 ? { ...p, z: Infinity } : p), points.map((p, index) => index === 291 ? { ...points[61] } : p)]) {
      expect(measureFrontLandmarks(input, 90, 1000, 800)).toEqual([])
      expect(buildFrontPointMeasurements(input, 1000, 800)).toBeNull()
    }
    expect(measureFrontLandmarks(points, 90, Infinity, 800)).toEqual([])
    expect(measureFrontLandmarks(points, 90, 1000, 0)).toEqual([])
  })
})
