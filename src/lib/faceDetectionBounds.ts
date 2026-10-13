import type { CaptureId, NormalizedFaceBounds } from '../types'
import type { FaceDetectionSummary } from './faceDetector'

/** Reuse the pose pipeline's single-face evidence without running another model. */
export function faceBoundsFromDetection(
  expected: CaptureId,
  summary: FaceDetectionSummary,
  landmarkFaceCount: number,
): NormalizedFaceBounds | undefined {
  if (expected !== 'front' && expected !== 'profile') return undefined
  if (!Number.isInteger(landmarkFaceCount) || landmarkFaceCount < 0 || landmarkFaceCount > 1) return undefined
  if (expected === 'front' && landmarkFaceCount === 0) return undefined
  const { contentWidth, contentHeight } = summary
  // Padded inputWidth/inputHeight cannot be substituted: portrait and landscape
  // frames otherwise drift relative to the preview and hide near-edge clipping.
  if (!contentWidth || !contentHeight || !Number.isFinite(contentWidth) || !Number.isFinite(contentHeight)
    || contentWidth <= 0 || contentHeight <= 0) return undefined
  const primary = summary.detections[0]
  if (!primary || ![primary.score, primary.x, primary.y, primary.width, primary.height].every(Number.isFinite)
    || primary.score < (expected === 'front' ? 0.9 : 0.85) || primary.score > 1
    || primary.width <= 0 || primary.height <= 0) return undefined
  if (summary.detections.filter(face => face.score >= 0.6).length !== 1) return undefined
  // Preserve negative positions and edges beyond 1 so framing can detect cuts.
  const bounds = {
    x: primary.x / contentWidth,
    y: primary.y / contentHeight,
    width: primary.width / contentWidth,
    height: primary.height / contentHeight,
  }
  return Object.values(bounds).every(Number.isFinite) ? bounds : undefined
}
