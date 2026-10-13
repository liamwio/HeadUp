/**
 * Research contract for the native Menpo 39-point profile schema.
 *
 * The published diagrams use one-based labels. These indices are zero-based,
 * matching .pts arrays and model tensors. Display groups are separately verified
 * in profileDisplayContract.ts; index 21 is a nostril-base proxy, not a verified subnasale. This contract does not enable
 * profile reporting by itself; a model must pass the declared validation gates.
 */

export const PROFILE_LANDMARK_COUNT = 39 as const

export const profileLandmarks = {
  browCenterProxy: { index: 14, label: '眉弓中部代理', role: 'vertical_reference' },
  nasalRootProxy: { index: 17, label: '鼻根区代理', role: 'profile_convexity_reference' },
  noseTip: { index: 19, label: '鼻尖', role: 'eline_and_nasal_shape' },
  columella: { index: 20, label: '鼻小柱下缘', role: 'nasolabial_tangent' },
  subnasale: { index: 21, label: '鼻基底区域代理（非标准鼻下点）', role: 'lower_face_origin' },
  upperLip: { index: 27, label: '上唇前点', role: 'lip_projection' },
  lowerLip: { index: 33, label: '下唇前点', role: 'lip_projection' },
  mentolabialFold: { index: 11, label: '颏唇沟', role: 'mentolabial_angle' },
  softTissuePogonion: { index: 10, label: '软组织颏前点', role: 'chin_projection' },
  menton: { index: 8, label: '下颏最低点', role: 'inferior_face_extent' },
} as const

export type ProfileLandmarkName = keyof typeof profileLandmarks

export const profileContourSegments = {
  // Official Menpo diagram is one-based; tensor indices 4..8 are its visible
  // lower mandibular contour points 5..9, ending at menton.
  lowerMandibularBorder: [4, 5, 6, 7, 8],
} as const

/** The eight P0 profile requirements from section 4.2 of the source DOCX. */
export const profileMeasurementContract = {
  softTissueConvexityAngle: {
    label: '软组织面凸角',
    nativeLandmarks: ['nasalRootProxy', 'subnasale', 'softTissuePogonion'],
    availability: 'native39',
    formula: 'angle(nasalRootProxy, vertex subnasale, softTissuePogonion)',
    geometryOutputs: ['softTissueConvexityAngleDegrees'],
  },
  eLine: {
    label: 'E-Line',
    nativeLandmarks: ['noseTip', 'upperLip', 'lowerLip', 'softTissuePogonion'],
    availability: 'native39',
    formula: 'signed distance(upperLip/lowerLip, line noseTip–softTissuePogonion) ÷ brow-to-menton projected height',
    geometryOutputs: ['eLineUpperLipDistanceFaceHeightRatio','eLineLowerLipDistanceFaceHeightRatio'],
  },
  nasolabialAngle: {
    label: '鼻唇角',
    nativeLandmarks: ['columella', 'subnasale', 'upperLip'],
    availability: 'native39',
    formula: 'angle(columella, vertex subnasale, upperLip)',
    geometryOutputs: ['nasolabialAngleDegrees'],
  },
  mentolabialAngle: {
    label: '颏唇沟角',
    nativeLandmarks: ['lowerLip', 'mentolabialFold', 'softTissuePogonion'],
    availability: 'native39',
    formula: 'angle(lowerLip, vertex mentolabialFold, softTissuePogonion)',
    geometryOutputs: ['mentolabialAngleDegrees'],
  },
  softTissueChinProjection: {
    label: '软组织颏突出度',
    nativeLandmarks: ['nasalRootProxy', 'subnasale', 'softTissuePogonion'],
    availability: 'native39',
    formula: 'signed distance(softTissuePogonion, line nasalRootProxy–subnasale) ÷ brow-to-menton projected height',
    geometryOutputs: ['softTissueChinProjectionFaceHeightRatio'],
  },
  mandibularPlaneInclinationProxy: {
    label: '下颌缘倾斜代理',
    nativeLandmarks: ['menton'],
    nativeContour: 'lowerMandibularBorder',
    availability: 'native39_proxy',
    formula: 'PCA inclination(points 4–8) relative to declared head-horizontal axis',
    geometryOutputs: ['mandibularPlaneInclinationDegrees'],
  },
  cervicomentalAngle: {
    label: '颈颏角',
    nativeLandmarks: ['menton'],
    externalLandmarks: ['cervicomentalPoint', 'lowerNeckPoint'],
    availability: 'requires_neck_landmarks',
    formula: 'angle(menton, vertex cervicomentalPoint, lowerNeckPoint)',
    geometryOutputs: ['cervicomentalAngleDegrees'],
  },
  profileVerticalProportion: {
    label: '侧面纵向比例',
    nativeLandmarks: ['browCenterProxy', 'subnasale', 'softTissuePogonion'],
    availability: 'native39',
    formula: '(subnasale.y−brow.y) and (pogonion.y−subnasale.y) ÷ brow-to-pogonion projected total',
    geometryOutputs: ['verticalMidfaceShare','verticalLowerFaceShare'],
  },
} as const satisfies Record<string, {
  label: string
  nativeLandmarks: readonly ProfileLandmarkName[]
  availability: 'native39' | 'native39_proxy' | 'requires_neck_landmarks'
  formula: string
  geometryOutputs: readonly string[]
  nativeContour?: keyof typeof profileContourSegments
  externalLandmarks?: readonly string[]
}>

export type ProfileMeasurementName = keyof typeof profileMeasurementContract

export const profileValidationGates = {
  minimumNativeOutputPoints: PROFILE_LANDMARK_COUNT,
  fullMarkupMedianRmsNmeMax: 0.03,
  fullMarkupP95RmsNmeMax: 0.08,
  everyCriticalPointMedianNmeMax: 0.03,
  everyCriticalPointP95NmeMax: 0.08,
  expandedBoxP95DisplacementMax: 0.05,
  eachOrientationDirectionAccuracyMin: 0.95,
  requiresAllEightSourceMetrics: true,
  requiresNeckLandmarkGroundTruth: true,
  requiresFreshConfirmatoryHoldout: true,
  requiresProductCameraRetakes: true,
} as const

export const profileContractLimitations = [
  'Menpo 39-point labels and standard frontal 68-point labels are not interchangeable.',
  'The columella, subnasale, soft-tissue pogonion, menton and mentolabial fold must remain distinct.',
  'Passing a reused Menpo development holdout cannot satisfy the fresh confirmatory holdout gate.',
  'Native Menpo 39-point markup has no neck tangent; it cannot validate the cervicomental angle by itself.',
  'All outputs describe visible soft tissue and cannot establish skeletal diagnosis.',
] as const
