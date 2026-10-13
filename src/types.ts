import type {CaptureSelection} from './lib/captureSelection'
export type {CaptureSelection} from './lib/captureSelection'
import type{MetricErrorEvidence}from'./lib/errorEvidence'

export type View = 'home' | 'setup' | 'capture' | 'processing' | 'report' | 'privacy'
export type Mode = 'adult' | 'youth'
export type CaptureId = 'front' | 'profile' | 'right_profile' | 'top'
export type PoseStatus = 'pass' | 'review' | 'reject'
export type EstimatedPose = 'front' | 'left_profile' | 'right_profile' | 'oblique' | 'no_face' | 'multiple_faces'
export type LandmarkPoint = { x: number; y: number; z: number }

export type NativeProfileGeometry = {
  softTissueConvexityAngleDegrees: number
  eLineUpperLipDistanceFaceHeightRatio: number
  eLineLowerLipDistanceFaceHeightRatio: number
  nasolabialAngleDegrees: number
  mentolabialAngleDegrees: number
  softTissueChinProjectionFaceHeightRatio: number
  mandibularPlaneInclinationDegrees: number
  cervicomentalAngleDegrees: number | null
  verticalMidfaceShare: number
  verticalLowerFaceShare: number
}
export type NativeProfileGeometryDisagreement = {
  softTissueConvexityAngleDegrees:number
  eLinePercentagePoints:number
  nasolabialAngleDegrees:number
  mentolabialAngleDegrees:number
  chinProjectionPercentagePoints:number
  mandibularInclinationDegrees:number
  verticalPercentagePoints:number
}

export type NativeProfileResult = {
  jawRefinement?: import('./lib/profileJawRefinement').JawRefinement
  neckEdge?: import('./lib/profileNeckEdge').NeckEdgeResult
  status: 'measured' | 'unavailable'
  reason?: string
  orientation?: 'left' | 'right'
  landmarks?: LandmarkPoint[]
  pointConfidence?: number[]
  confidenceP10?: number
  geometry?: NativeProfileGeometry
  landmarkDerivedGeometry?:NativeProfileGeometry
  geometryDisagreement?:NativeProfileGeometryDisagreement
  measuredMetricCount?: number
  modelVersion?: string
  cropVersion?: string
  runtimeMs?: number
  headAxisAngleDegrees?: number
  geometrySource?: 'landmark_derived' | 'direct_geometry_head'
  geometryModelVersion?: string
  refinerVersion?: string
  refinerRuntimeMs?: number
}

/** Face detector bounds in image-relative coordinates; may extend outside the image. */
export type NormalizedFaceBounds = { x: number; y: number; width: number; height: number }

export type PoseValidation = {
  status: PoseStatus
  estimatedPose: EstimatedPose
  detectedFaces: number
  yaw?: number
  roll?: number
  pitch?: number
  faceDetectorScore?: number
  faceAreaRatio?: number
  faceCenterDistance?: number
  faceBounds?: NormalizedFaceBounds
  landmarkImageWidth?: number
  landmarkImageHeight?: number
  landmarks?: LandmarkPoint[]
  robustLipHeightMouthWidthRatio?: number
  lipEnsembleViews?: number
  lipEnsembleRuntimeMs?: number
  flags: string[]
  nativeProfile?: NativeProfileResult
}

export type Capture = {
  id: CaptureId
  label: string
  eyebrow: string
  hint: string
  url?: string
  originalUrl?: string
  straightening?: import('./lib/photoStraightening').StraighteningRecord
  fileName?: string
  mirrorCorrected?: boolean
  acceptedWithBias?: boolean
  inputError?: string
  analysisError?: string
  source?: 'upload'|'live'
  captureSelection?: CaptureSelection
  photoDate?: string
  photoDateSource?: 'exif' | 'live'
  capturedAt?: string
  cameraFacing?: 'user'|'environment'|'unknown'
  quality?: PhotoQuality
  poseValidation?: PoseValidation
}

export type PhotoQuality = {
  score: number
  resolution: number
  brightness: number
  contrast: number
  sharpness: number
  resamplingRisk?: number
  highlightClipping?: number
  flags: string[]
}

export type Measurement = {
  evidence?: import('./lib/measurementEvidence').MeasurementEvidence
  code?: string
  label: string
  value: string
  score: number
  note: string
  group: '对称' | '比例' | '侧貌'
  reliability?: 'comparatively_stable' | 'moderate' | 'capture_sensitive'
  formula?: string
  landmarkIndices?: string
  confidenceBasis?: string
  errors?: MetricErrorEvidence[]
}
