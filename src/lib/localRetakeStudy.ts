import type { FrontGeometry } from './faceMeasurements'

export const LOCAL_RETAKE_REPEATS = 3
const RETAKE_GEOMETRY_KEYS = [
  'mirrorResidual',
  'visibleFaceLengthWidthRatio',
  'pupilDistanceFaceWidthRatio',
  'interEyeRatio',
  'eyeCanthalTiltDegrees',
  'jawWidthRatio',
  'mouthWidthRatio',
  'midfaceHeightRatio',
  'browPeakMidfaceHeightRatio',
  'lowerFaceHeightRatio',
  'noseMouthWidthRatio',
  'noseLengthFaceHeightRatio',
  'lipHeightMouthWidthRatio',
] as const
export type RetakeGeometry = Pick<FrontGeometry, typeof RETAKE_GEOMETRY_KEYS[number]>

export type LocalRetakeCaptureResult = {
  repeat: number
  width: number
  height: number
  qualityScore: number
  qualityPass: boolean
  posePass: boolean
  combinedPass: boolean
  qualityFlags: string[]
  poseFlags: string[]
  geometry: FrontGeometry | RetakeGeometry | null
}

export type LocalRetakeStudyMetadata = {
  pairingToken: string
  sessionLabel: 'A' | 'B'
  deviceClass: 'smartphone_rear' | 'smartphone_front'
  lighting: 'indirect_daylight' | 'indoor_even'
}

function roundedGeometry(geometry: FrontGeometry | RetakeGeometry | null): RetakeGeometry | null {
  if (!geometry) return null
  return Object.fromEntries(RETAKE_GEOMETRY_KEYS.map((key) => [key, Number(geometry[key].toFixed(6))])) as RetakeGeometry
}

export function buildLocalRetakeStudySession(
  captures: LocalRetakeCaptureResult[],
  metadata: LocalRetakeStudyMetadata,
  testedAt = new Date().toISOString(),
) {
  const repeats = new Set(captures.map((capture) => capture.repeat))
  const validRepeats = captures.every((capture) => Number.isInteger(capture.repeat) && capture.repeat >= 1 && capture.repeat <= LOCAL_RETAKE_REPEATS)
  const protocolComplete = captures.length === LOCAL_RETAKE_REPEATS && repeats.size === LOCAL_RETAKE_REPEATS && validRepeats
  const serializedCaptures = [...captures]
    .sort((a, b) => a.repeat - b.repeat)
    .map((capture) => ({ ...capture, geometry: roundedGeometry(capture.geometry) }))
  const usableMeasurements = serializedCaptures.filter((capture) => capture.combinedPass && capture.geometry).length

  return {
    policyVersion: 'HEADUP-LOCAL-RETAKE-SESSION-3.0',
    testedAt,
    pairing: { token: metadata.pairingToken },
    session: {
      label: metadata.sessionLabel,
      deviceClass: metadata.deviceClass,
      lighting: metadata.lighting,
      distanceBand: '40_60_cm' as const,
    },
    protocol: {
      repeats: LOCAL_RETAKE_REPEATS,
      protocolComplete,
      subjectLeavesFrameBetweenRepeats: true,
      cameraReacquiredFocusBetweenRepeats: true,
      neutralExpressionRequired: true,
      sameDeviceRequiredAcrossSessions: true,
      recommendedSessionSeparationHours: 24,
    },
    captures: serializedCaptures,
    summary: {
      attempted: captures.length,
      qualityPassed: captures.filter((capture) => capture.qualityPass).length,
      posePassed: captures.filter((capture) => capture.posePass).length,
      combinedPassed: captures.filter((capture) => capture.combinedPass).length,
      usableMeasurements,
    },
    retention: {
      imagesIncluded: false,
      fileNamesIncluded: false,
      imageHashesIncluded: false,
      landmarksIncluded: false,
      demographicAttributesIncluded: false,
      geometryIncludedForTemporaryPairing: true,
      pairingTokenIncludedForTemporaryPairing: true,
      browserStorageUsed: false,
    },
    interpretation: protocolComplete
      ? 'Temporary session-level measurements. Aggregate session A and B, then delete both session files; only the aggregate is suitable for retention.'
      : 'Incomplete protocol. Do not use this session for repeatability estimates.',
  }
}
