import { describe, expect, it } from 'vitest'
import { buildProfileDisplayPaths, MENPO39_DISPLAY_GROUPS, PROFILE_DISPLAY_PATHS } from './profileDisplayContract'

describe('Menpo39 display topology from the authors’ schema', () => {
  it('partitions all 39 channels into separate facial features without a forehead group', () => {
    const groups = Object.values(MENPO39_DISPLAY_GROUPS).flat()
    expect(groups).toEqual(Array.from({ length: 39 }, (_, index) => index))
    expect(MENPO39_DISPLAY_GROUPS.eyebrow).toEqual([12, 13, 14, 15])
    expect(MENPO39_DISPLAY_GROUPS.eye).toEqual([22, 23, 24, 25, 26])
    expect(PROFILE_DISPLAY_PATHS.some(path => /forehead|maxillary/.test(path.code))).toBe(false)
  })

  it('keeps lip paths inside mouth channels and never joins the eye or nostril base to the mouth', () => {
    const upper = PROFILE_DISPLAY_PATHS.find(path => path.code === 'upper_lip_contour')!
    const lower = PROFILE_DISPLAY_PATHS.find(path => path.code === 'lower_lip_contour')!
    expect(upper.indices).toEqual([27, 28, 29, 30])
    expect(lower.indices).toEqual([30, 31, 32, 33])
    expect(upper.indices.at(-1)).toBe(lower.indices[0])
    expect([...upper.indices, ...lower.indices].every(index => index >= 27)).toBe(true)
    expect(PROFILE_DISPLAY_PATHS.flatMap(path => [...path.indices]).some(index => index >= 20 && index <= 26)).toBe(false)
  })

  it('maps asymmetric left and right points without mirroring or cropping', () => {
    const left = Array.from({ length: 39 }, (_, index) => ({ x: .2 + index / 100, y: .1 + index / 80, z: 0 }))
    const right = left.map(point => ({ ...point, x: 1 - point.x }))
    const a = buildProfileDisplayPaths(left, 1200, 800)
    const b = buildProfileDisplayPaths(right, 1200, 800)
    expect(a).toHaveLength(5)
    for (const [pathIndex, definition] of PROFILE_DISPLAY_PATHS.entries()) {
      for (const [pointIndex, sourceIndex] of definition.indices.entries()) {
        expect(a[pathIndex].points[pointIndex]).toEqual({ x: left[sourceIndex].x * 1200, y: left[sourceIndex].y * 800 })
        expect(a[pathIndex].points[pointIndex].x + b[pathIndex].points[pointIndex].x).toBeCloseTo(1200)
        expect(a[pathIndex].points[pointIndex].y).toBe(b[pathIndex].points[pointIndex].y)
      }
    }
  })

  it('does not fabricate paths for incomplete or nonfinite point sets', () => {
    const points = Array.from({ length: 39 }, () => ({ x: .5, y: .5, z: 0 }))
    expect(buildProfileDisplayPaths(points.slice(1), 1200, 800)).toEqual([])
    expect(buildProfileDisplayPaths(points, 0, 800)).toEqual([])
    expect(buildProfileDisplayPaths(points, 1200, Infinity)).toEqual([])
    expect(buildProfileDisplayPaths(points.map((point, i) => i === 22 ? { ...point, x: NaN } : point), 1200, 800)).toEqual([])
  })
})
