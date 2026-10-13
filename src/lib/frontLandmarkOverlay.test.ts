import { describe, expect, it } from 'vitest'
import type { LandmarkPoint } from '../types'
import { buildFrontLandmarkOverlay, frontOverlayLineContract } from './frontLandmarkOverlay'

const landmarks = Array.from({ length: 478 }, (_, index): LandmarkPoint => ({
  x: 0.15 + (index % 30) / 45,
  y: 0.1 + Math.floor(index / 30) / 24,
  z: index / 10_000,
}))

describe('front 478-point coverage overlay', () => {
  it('projects all 478 landmarks and the frozen measurement/symmetry lines', () => {
    const overlay = buildFrontLandmarkOverlay(landmarks, 1200, 1600)
    expect(overlay?.points).toHaveLength(frontOverlayLineContract.pointCount)
    expect(overlay?.contours).toHaveLength(frontOverlayLineContract.contourCount)
    expect(overlay?.lines.filter((line) => line.category === 'measurement')).toHaveLength(frontOverlayLineContract.measurementLines)
    expect(overlay?.lines.filter((line) => line.category === 'symmetry')).toHaveLength(frontOverlayLineContract.symmetryLines)
    expect(overlay?.points[0]).toMatchObject({ index: 0, x: 180, y: 160 })
  })

  it('draws closed visible face, eye and lip contours from the same 478-point output', () => {
    const overlay = buildFrontLandmarkOverlay(landmarks, 1000, 1200)!
    expect(overlay.contours.map((contour) => contour.code)).toEqual([
      'face_oval', 'left_brow', 'right_brow', 'left_eye', 'right_eye', 'nose_bridge', 'outer_lips',
    ])
    const oval = overlay.contours[0]
    expect(oval.points[0]).toEqual(oval.points.at(-1))
  })

  it('uses averaged iris centers instead of a single arbitrary iris point', () => {
    const overlay = buildFrontLandmarkOverlay(landmarks, 1000, 1000)!
    const pupil = overlay.lines.find((line) => line.code === 'pupil_distance')!
    const expectedLeftX = landmarks.slice(468, 473).reduce((sum, point) => sum + point.x, 0) / 5 * 1000
    expect(pupil.x1).toBeCloseTo(expectedLeftX, 8)
  })

  it('shows all three outer-lip height pairs used by the robust production formula', () => {
    const overlay = buildFrontLandmarkOverlay(landmarks, 1000, 1000)!
    expect(overlay.lines.filter((line) => line.code.startsWith('lip_height_')).map((line) => line.code)).toEqual([
      'lip_height_left', 'lip_height_center', 'lip_height_right',
    ])
  })

  it('refuses incomplete, non-finite or invalid image contracts', () => {
    expect(buildFrontLandmarkOverlay(landmarks.slice(0, 477), 1000, 1000)).toBeNull()
    const broken = landmarks.map((point) => ({ ...point }))
    broken[152].x = Number.NaN
    expect(buildFrontLandmarkOverlay(broken, 1000, 1000)).toBeNull()
    expect(buildFrontLandmarkOverlay(landmarks, 0, 1000)).toBeNull()
  })
})
