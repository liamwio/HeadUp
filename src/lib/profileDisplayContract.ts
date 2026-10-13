import type { LandmarkPoint } from '../types'

/** Display topology only; it does not change model channels or measurement formulas.
 * Authors' one-based diagram (subtract 1 for these tensor indices):
 * https://github.com/jiankangdeng/MenpoBenchmark/blob/master/menpo2D_landmarks.png
 * Authors' grouped photograph (each group starts at 0):
 * https://ibug.doc.ic.ac.uk/media/uploads/documents/thumbnail_39_lms.jpg
 */
export const PROFILE_DISPLAY_CONTRACT_VERSION = 'HEADUP-MENPO39-DISPLAY-2.0'

export const MENPO39_DISPLAY_GROUPS = {
  jaw: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  eyebrow: [12, 13, 14, 15],
  nose: [16, 17, 18, 19, 20, 21],
  eye: [22, 23, 24, 25, 26],
  mouth: [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38],
} as const

// Separate open feature paths. In particular, there are no forehead points in
// Menpo39, and eye points must not become a nose-to-lip or cheek connector.
// The nostril base and inner mouth are deliberately omitted from these paths.
export const PROFILE_DISPLAY_PATHS = [
  { code: 'brow_profile_line', label: '可见眉部', indices: [12, 13, 14, 15] },
  { code: 'nasal_dorsum_line', label: '可见鼻梁—鼻尖', indices: [16, 17, 18, 19] },
  { code: 'upper_lip_contour', label: '可见上唇外缘', indices: [27, 28, 29, 30] },
  { code: 'lower_lip_contour', label: '可见下唇外缘', indices: [30, 31, 32, 33] },
  { code: 'mandibular_aesthetic_line', label: '可见下颌—颏部', indices: [4, 5, 6, 7, 8, 9, 10] },
] as const

/** Keep original orientation and convert only from full-image relative to pixels. */
export function buildProfileDisplayPaths(landmarks: readonly LandmarkPoint[], width: number, height: number) {
  if (landmarks.length !== 39 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || landmarks.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return []
  return PROFILE_DISPLAY_PATHS.map(path => ({
    code: path.code,
    label: path.label,
    category: 'region' as const,
    points: path.indices.map(index => ({ x: landmarks[index].x * width, y: landmarks[index].y * height })),
  }))
}
