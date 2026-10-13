export const RETAKE_METRICS = [
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
]

const DEVICE_CLASSES = new Set(['smartphone_rear', 'smartphone_front'])
const LIGHTING_CLASSES = new Set(['indirect_daylight', 'indoor_even'])
const SAME_IMAGE_PROXY_LIMITS = {
  mirrorResidual: { measure: 'absoluteDifference', value: 0.01, unit: 'raw ratio (1.0 percentage point)' },
  visibleFaceLengthWidthRatio: { measure: 'relativeDifferencePercent', value: 1.36, unit: 'percent' },
  pupilDistanceFaceWidthRatio: { measure: 'relativeDifferencePercent', value: 1.25, unit: 'percent' },
  interEyeRatio: { measure: 'relativeDifferencePercent', value: 3.58, unit: 'percent' },
  eyeCanthalTiltDegrees: { measure: 'absoluteDifference', value: 0.38, unit: 'degrees' },
  jawWidthRatio: { measure: 'relativeDifferencePercent', value: 0.99, unit: 'percent' },
  mouthWidthRatio: { measure: 'relativeDifferencePercent', value: 1.94, unit: 'percent' },
  midfaceHeightRatio: { measure: 'relativeDifferencePercent', value: 2.29, unit: 'percent' },
  browPeakMidfaceHeightRatio: { measure: 'relativeDifferencePercent', value: 1.34, unit: 'percent (102-person × 8 in-memory perturbation engineering proxy)' },
  lowerFaceHeightRatio: { measure: 'relativeDifferencePercent', value: 1.34, unit: 'percent' },
  noseMouthWidthRatio: { measure: 'relativeDifferencePercent', value: 2.73, unit: 'percent' },
  noseLengthFaceHeightRatio: { measure: 'relativeDifferencePercent', value: 2.48, unit: 'percent' },
  lipHeightMouthWidthRatio: { measure: 'relativeDifferencePercent', value: 5.3, unit: 'percent' },
}

function assertKeys(value, expected, path) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${path}: unexpected structure; keys=${actual.join(',')}`)
  }
}

function finiteNumber(value, path, { integer = false, min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`${path}: invalid number`)
  }
  return value
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${path}: must be a string array`)
}

function validateGeometry(value, path) {
  if (value === null) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: invalid geometry`)
  assertKeys(value, RETAKE_METRICS, path)
  for (const metric of RETAKE_METRICS) finiteNumber(value[metric], `${path}.${metric}`, { min: metric === 'eyeCanthalTiltDegrees' ? -180 : 0 })
}

export function validateRetakeSession(value, sourcePath = 'session') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${sourcePath}: root must be an object`)
  assertKeys(value, ['policyVersion', 'testedAt', 'pairing', 'session', 'protocol', 'captures', 'summary', 'retention', 'interpretation'], sourcePath)
  if (value.policyVersion !== 'HEADUP-LOCAL-RETAKE-SESSION-3.0') throw new Error(`${sourcePath}: unsupported policyVersion`)
  if (typeof value.testedAt !== 'string' || !Number.isFinite(Date.parse(value.testedAt))) throw new Error(`${sourcePath}: invalid testedAt`)
  if (typeof value.interpretation !== 'string') throw new Error(`${sourcePath}: invalid interpretation`)

  assertKeys(value.pairing, ['token'], `${sourcePath}.pairing`)
  if (typeof value.pairing.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value.pairing.token)) throw new Error(`${sourcePath}: invalid anonymous pairing token`)
  assertKeys(value.session, ['label', 'deviceClass', 'lighting', 'distanceBand'], `${sourcePath}.session`)
  if (!['A', 'B'].includes(value.session.label)) throw new Error(`${sourcePath}: invalid session label`)
  if (!DEVICE_CLASSES.has(value.session.deviceClass)) throw new Error(`${sourcePath}: invalid deviceClass`)
  if (!LIGHTING_CLASSES.has(value.session.lighting)) throw new Error(`${sourcePath}: invalid lighting`)
  if (value.session.distanceBand !== '40_60_cm') throw new Error(`${sourcePath}: invalid distance band`)

  assertKeys(value.protocol, ['repeats', 'protocolComplete', 'subjectLeavesFrameBetweenRepeats', 'cameraReacquiredFocusBetweenRepeats', 'neutralExpressionRequired', 'sameDeviceRequiredAcrossSessions', 'recommendedSessionSeparationHours'], `${sourcePath}.protocol`)
  if (value.protocol.repeats !== 3 || value.protocol.protocolComplete !== true
    || value.protocol.subjectLeavesFrameBetweenRepeats !== true || value.protocol.cameraReacquiredFocusBetweenRepeats !== true
    || value.protocol.neutralExpressionRequired !== true || value.protocol.sameDeviceRequiredAcrossSessions !== true
    || value.protocol.recommendedSessionSeparationHours !== 24) throw new Error(`${sourcePath}: incomplete or altered protocol`)

  if (!Array.isArray(value.captures) || value.captures.length !== 3) throw new Error(`${sourcePath}: exactly three captures required`)
  const repeats = new Set()
  for (const [index, capture] of value.captures.entries()) {
    const path = `${sourcePath}.captures[${index}]`
    assertKeys(capture, ['repeat', 'width', 'height', 'qualityScore', 'qualityPass', 'posePass', 'combinedPass', 'qualityFlags', 'poseFlags', 'geometry'], path)
    finiteNumber(capture.repeat, `${path}.repeat`, { integer: true, min: 1 })
    if (capture.repeat > 3 || repeats.has(capture.repeat)) throw new Error(`${path}: duplicate or invalid repeat`)
    repeats.add(capture.repeat)
    finiteNumber(capture.width, `${path}.width`, { integer: true, min: 1 })
    finiteNumber(capture.height, `${path}.height`, { integer: true, min: 1 })
    finiteNumber(capture.qualityScore, `${path}.qualityScore`)
    for (const key of ['qualityPass', 'posePass', 'combinedPass']) if (typeof capture[key] !== 'boolean') throw new Error(`${path}.${key}: must be boolean`)
    stringArray(capture.qualityFlags, `${path}.qualityFlags`)
    stringArray(capture.poseFlags, `${path}.poseFlags`)
    validateGeometry(capture.geometry, `${path}.geometry`)
    if (capture.combinedPass !== Boolean(capture.qualityPass && capture.posePass && capture.geometry)) throw new Error(`${path}: inconsistent combinedPass/geometry`)
  }

  assertKeys(value.summary, ['attempted', 'qualityPassed', 'posePassed', 'combinedPassed', 'usableMeasurements'], `${sourcePath}.summary`)
  const expectedSummary = {
    attempted: 3,
    qualityPassed: value.captures.filter((item) => item.qualityPass).length,
    posePassed: value.captures.filter((item) => item.posePass).length,
    combinedPassed: value.captures.filter((item) => item.combinedPass).length,
    usableMeasurements: value.captures.filter((item) => item.combinedPass && item.geometry).length,
  }
  for (const [key, expected] of Object.entries(expectedSummary)) if (value.summary[key] !== expected) throw new Error(`${sourcePath}.summary.${key}: inconsistent count`)

  assertKeys(value.retention, ['imagesIncluded', 'fileNamesIncluded', 'imageHashesIncluded', 'landmarksIncluded', 'demographicAttributesIncluded', 'geometryIncludedForTemporaryPairing', 'pairingTokenIncludedForTemporaryPairing', 'browserStorageUsed'], `${sourcePath}.retention`)
  for (const key of ['imagesIncluded', 'fileNamesIncluded', 'imageHashesIncluded', 'landmarksIncluded', 'demographicAttributesIncluded', 'browserStorageUsed']) {
    if (value.retention[key] !== false) throw new Error(`${sourcePath}: retention boundary violated at ${key}`)
  }
  if (value.retention.geometryIncludedForTemporaryPairing !== true || value.retention.pairingTokenIncludedForTemporaryPairing !== true) throw new Error(`${sourcePath}: temporary pairing declaration missing`)
  return value
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function quantile(values, probability) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const result = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  return Number(result.toFixed(6))
}

function distribution(values) {
  return {
    observations: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: quantile(values, 1),
  }
}

function relativeDifference(a, b) {
  const denominator = (Math.abs(a) + Math.abs(b)) / 2
  return denominator > 0 ? Math.abs(a - b) / denominator * 100 : 0
}

function metricTemplate() {
  return Object.fromEntries(RETAKE_METRICS.map((metric) => [metric, { absolute: [], relative: [] }]))
}

export function evaluateBrowPeakMidfaceRetakePromotion(aggregate){
  const candidate=aggregate?.metrics?.browPeakMidfaceHeightRatio,legacy=aggregate?.metrics?.midfaceHeightRatio,candidateCross=candidate?.crossSessionMedianDifference?.relativeDifferencePercent?.p95,candidateWithin=candidate?.withinSessionPairwise?.relativeDifferencePercent?.p95,legacyCross=legacy?.crossSessionMedianDifference?.relativeDifferencePercent?.p95,improvement=typeof candidateCross==='number'&&typeof legacyCross==='number'&&legacyCross>0?(legacyCross-candidateCross)/legacyCross:null
  const gates={atLeast30EligibleParticipants:(aggregate?.pairing?.eligiblePairs??0)>=30,candidateCrossSessionP95AtMost5Percent:typeof candidateCross==='number'&&candidateCross<=5,candidateWithinSessionP95AtMost3Percent:typeof candidateWithin==='number'&&candidateWithin<=3,atLeast10PercentBetterThanLegacy168:typeof improvement==='number'&&improvement>=.10,smartphoneRearAtLeast20Sessions:(aggregate?.coverage?.byDeviceClass?.smartphone_rear??0)>=20,smartphoneFrontAtLeast20Sessions:(aggregate?.coverage?.byDeviceClass?.smartphone_front??0)>=20,indirectDaylightAtLeast20Sessions:(aggregate?.coverage?.byLighting?.indirect_daylight??0)>=20,indoorEvenAtLeast20Sessions:(aggregate?.coverage?.byLighting?.indoor_even??0)>=20}
  const passes=Object.values(gates).every(Boolean)
  return{policyVersion:'HEADUP-BROW-PEAK-MIDFACE-RETAKE-PROMOTION-1.0',metrics:{candidateCrossSessionP95RelativePercent:candidateCross??null,candidateWithinSessionP95RelativePercent:candidateWithin??null,legacy168CrossSessionP95RelativePercent:legacyCross??null,relativeImprovementVsLegacy168:improvement===null?null:Number((improvement*100).toFixed(2))},gates,passesProductionPromotionGate:passes,decision:passes?'eligible_to_replace_FRONT_RATIO_06_after_formula_and_copy_review':'retain_research_candidate'}
}

export function buildRetakeAggregate(sessions, aggregatedAt = new Date().toISOString()) {
  const validated = sessions.map((session, index) => validateRetakeSession(session, `session[${index}]`))
  const seen = new Set()
  for (const session of validated) {
    const key = `${session.pairing.token}:${session.session.label}`
    if (seen.has(key)) throw new Error('duplicate pairing token and session label')
    seen.add(key)
  }

  const coverage = { byDeviceClass: {}, byLighting: {} }
  const gate = { attempts: 0, qualityPassed: 0, posePassed: 0, combinedPassed: 0 }
  const within = metricTemplate()
  for (const session of validated) {
    coverage.byDeviceClass[session.session.deviceClass] = (coverage.byDeviceClass[session.session.deviceClass] ?? 0) + 1
    coverage.byLighting[session.session.lighting] = (coverage.byLighting[session.session.lighting] ?? 0) + 1
    gate.attempts += 3
    gate.qualityPassed += session.summary.qualityPassed
    gate.posePassed += session.summary.posePassed
    gate.combinedPassed += session.summary.combinedPassed
    const captures = session.captures.filter((capture) => capture.combinedPass && capture.geometry)
    for (const metric of RETAKE_METRICS) {
      for (let left = 0; left < captures.length; left++) {
        for (let right = left + 1; right < captures.length; right++) {
          const a = captures[left].geometry[metric]
          const b = captures[right].geometry[metric]
          within[metric].absolute.push(Math.abs(a - b))
          within[metric].relative.push(relativeDifference(a, b))
        }
      }
    }
  }

  const byToken = new Map()
  for (const session of validated) {
    const pair = byToken.get(session.pairing.token) ?? {}
    pair[session.session.label] = session
    byToken.set(session.pairing.token, pair)
  }
  const cross = metricTemplate()
  let completePairs = 0
  let eligiblePairs = 0
  let excludedDeviceMismatch = 0
  let excludedLightingMismatch = 0
  let excludedSessionSeparation = 0
  let excludedInsufficientMeasurements = 0
  for (const pair of byToken.values()) {
    if (!pair.A || !pair.B) continue
    completePairs++
    if (pair.A.session.deviceClass !== pair.B.session.deviceClass) { excludedDeviceMismatch++; continue }
    if (pair.A.session.lighting !== pair.B.session.lighting) { excludedLightingMismatch++; continue }
    const separationHours = (Date.parse(pair.B.testedAt) - Date.parse(pair.A.testedAt)) / (60 * 60 * 1000)
    if (separationHours < 24) { excludedSessionSeparation++; continue }
    const aCaptures = pair.A.captures.filter((capture) => capture.combinedPass && capture.geometry)
    const bCaptures = pair.B.captures.filter((capture) => capture.combinedPass && capture.geometry)
    if (aCaptures.length < 2 || bCaptures.length < 2) { excludedInsufficientMeasurements++; continue }
    eligiblePairs++
    for (const metric of RETAKE_METRICS) {
      const a = median(aCaptures.map((capture) => capture.geometry[metric]))
      const b = median(bCaptures.map((capture) => capture.geometry[metric]))
      cross[metric].absolute.push(Math.abs(a - b))
      cross[metric].relative.push(relativeDifference(a, b))
    }
  }

  const metrics = Object.fromEntries(RETAKE_METRICS.map((metric) => {
    const reference = SAME_IMAGE_PROXY_LIMITS[metric]
    const comparisonValues = reference.measure === 'absoluteDifference' ? cross[metric].absolute : cross[metric].relative
    return [metric, {
      withinSessionPairwise: {
        absoluteDifference: distribution(within[metric].absolute),
        relativeDifferencePercent: distribution(within[metric].relative),
      },
      crossSessionMedianDifference: {
        absoluteDifference: distribution(cross[metric].absolute),
        relativeDifferencePercent: distribution(cross[metric].relative),
      },
      sameImagePerturbationProxy: {
        ...reference,
        crossSessionPairsExceeding: comparisonValues.filter((value) => value > reference.value).length,
        eligibleCrossSessionPairs: comparisonValues.length,
        note: 'Context only; same-image perturbation is not a release threshold for real retakes.',
      },
    }]
  }))

  const result={
    policyVersion: 'HEADUP-LOCAL-RETAKE-CROSS-SESSION-3.0',
    aggregatedAt,
    sessions: validated.length,
    participantsRepresented: byToken.size,
    pairing: {
      completePairs,
      eligiblePairs,
      excludedDeviceMismatch,
      excludedLightingMismatch,
      excludedSessionSeparation,
      excludedInsufficientMeasurements,
    },
    coverage,
    productionGate: gate,
    metrics,
    studyStrength: {
      minimumEligibleParticipantsForPopulationClaim: 30,
      diagnosticOnly: eligiblePairs < 30,
      subjectIsolatedByAnonymousPairing: true,
    },
    retention: {
      imagesIncluded: false,
      fileNamesIncluded: false,
      pairingTokensIncluded: false,
      sessionTimestampsIncluded: false,
      individualMeasurementsIncluded: false,
      inputPathsIncluded: false,
      aggregateOnly: true,
    },
    interpretation: 'Cross-session repeatability uses the median of at least two accepted measurements per session. It is diagnostic until at least 30 eligible participants and pre-registered coverage targets are met. Delete temporary A/B session files after aggregation.',
  }
  result.browPeakMidfacePromotion=evaluateBrowPeakMidfaceRetakePromotion(result)
  return result
}
