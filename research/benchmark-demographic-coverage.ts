import { inspectCaptureFile } from '../src/lib/captureAnalysis'
import { isPhotoQualityAcceptable } from '../src/lib/imageQuality'

type Axis = { yaw: number; pitch: number; roll: number }
type RecordEntry = { sampleId: string; relativePath: string; ageGroup: string; gender: string; publisherPose: Axis }
type Observation = {
  ageGroup: string
  gender: string
  qualityAccepted: boolean
  mediapipeDetected: boolean
  yunetTrusted: boolean
  poseAccepted: boolean
  analysisError: boolean
  qualityFlags: string[]
  poseFlags: string[]
  publisherPose: Axis
  headupPose: Axis
}

const root = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/demographic-coverage'
const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const round = (value: number, digits = 4) => Number(value.toFixed(digits))
const rate = (count: number, total: number) => total ? round(count / total) : 0
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return { min: round(Math.min(...values)), median: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values)) } }

function aggregate(items: Observation[]) {
  const countFlags = (key: 'qualityFlags' | 'poseFlags') => {
    const counts = new Map<string, number>()
    for (const item of items) for (const flag of item[key]) counts.set(flag, (counts.get(flag) ?? 0) + 1)
    return Object.fromEntries([...counts].sort((left, right) => right[1] - left[1]))
  }
  const total = items.length
  const qualityAccepted = items.filter((item) => item.qualityAccepted).length
  const mediapipeDetected = items.filter((item) => item.mediapipeDetected).length
  const yunetTrusted = items.filter((item) => item.yunetTrusted).length
  const poseAccepted = items.filter((item) => item.poseAccepted).length
  const analysisErrors = items.filter((item) => item.analysisError).length
  const axisAgreement = Object.fromEntries((['yaw', 'pitch', 'roll'] as const).map((axis) => {
    const valid = items.filter((item) => Number.isFinite(item.headupPose[axis]) && Number.isFinite(item.publisherPose[axis]))
    const signed = valid.map((item) => item.headupPose[axis] - item.publisherPose[axis])
    const absolute = signed.map(Math.abs)
    return [axis, {
      comparable: valid.length,
      publisherDegrees: distribution(valid.map((item) => item.publisherPose[axis])),
      headupDegrees: distribution(valid.map((item) => item.headupPose[axis])),
      signedDeltaDegrees: { mean: round(signed.reduce((sum, value) => sum + value, 0) / signed.length), median: round(percentile(signed, 0.5)) },
      absoluteDeltaDegrees: distribution(absolute),
    }]
  }))
  return {
    total,
    qualityAccepted, qualityAcceptanceRate: rate(qualityAccepted, total),
    mediapipeDetected, mediapipeDetectionRate: rate(mediapipeDetected, total),
    yunetTrusted, yunetTrustedRate: rate(yunetTrusted, total),
    poseAccepted, poseAcceptanceRate: rate(poseAccepted, total),
    analysisErrors,
    axisAgreement,
    qualityRejectReasons: countFlags('qualityFlags'),
    poseRejectReasons: countFlags('poseFlags'),
  }
}

function gap(values: number[]) { return round(Math.max(...values) - Math.min(...values)) }

async function main() {
  const manifest = await fetch(`${root}/manifest.json`).then((response) => response.json()) as {
    policyVersion: string
    source: unknown
    protocol: { ageGroups: string[]; genders: string[]; samplesPerCell: number; totalImages: number; eligibility: string; selection: string }
    records: RecordEntry[]
  }
  if (manifest.policyVersion !== 'HEADUP-DEMOGRAPHIC-COVERAGE-PREPARE-1.0' || manifest.records.length !== 200) throw new Error('Unexpected demographic manifest')
  const observations: Observation[] = []
  for (const [index, record] of manifest.records.entries()) {
    status.textContent = `处理真人分层样本 ${index + 1} / ${manifest.records.length}`
    try {
      const blob = await fetch(`${root}/${record.relativePath}`).then((response) => response.blob())
      const result = await inspectCaptureFile('front', new File([blob], `${record.sampleId}.png`, { type: 'image/png' }))
      observations.push({
        ageGroup: record.ageGroup,
        gender: record.gender,
        qualityAccepted: isPhotoQualityAcceptable(result.quality),
        mediapipeDetected: result.pose.detectedFaces === 1,
        yunetTrusted: (result.pose.faceDetectorScore ?? 0) >= 0.9,
        poseAccepted: result.pose.status === 'pass',
        analysisError: false,
        qualityFlags: result.quality.flags,
        poseFlags: result.pose.flags,
        publisherPose: record.publisherPose,
        headupPose: { yaw: result.pose.yaw, pitch: result.pose.pitch, roll: result.pose.roll },
      })
    } catch {
      observations.push({ ageGroup: record.ageGroup, gender: record.gender, qualityAccepted: false, mediapipeDetected: false, yunetTrusted: false, poseAccepted: false, analysisError: true, qualityFlags: ['analysis_error'], poseFlags: ['analysis_error'], publisherPose: record.publisherPose, headupPose: { yaw: Number.NaN, pitch: Number.NaN, roll: Number.NaN } })
    }
  }
  const byAge = Object.fromEntries(manifest.protocol.ageGroups.map((age) => [age, aggregate(observations.filter((item) => item.ageGroup === age))]))
  const byGender = Object.fromEntries(manifest.protocol.genders.map((gender) => [gender, aggregate(observations.filter((item) => item.gender === gender))]))
  const byCell = Object.fromEntries(manifest.protocol.ageGroups.flatMap((age) => manifest.protocol.genders.map((gender) => [`${age}/${gender}`, aggregate(observations.filter((item) => item.ageGroup === age && item.gender === gender))])))
  const ageValues = Object.values(byAge)
  const genderValues = Object.values(byGender)
  const gates = {
    evaluated200ImagesAcross20BalancedCells: observations.length === 200 && Object.values(byCell).every((item) => item.total === 10),
    noAnalysisErrors: observations.every((item) => !item.analysisError),
    everyAgeMediaPipeDetectionAtLeast90Percent: ageValues.every((item) => item.mediapipeDetectionRate >= 0.9),
    everyGenderMediaPipeDetectionAtLeast95Percent: genderValues.every((item) => item.mediapipeDetectionRate >= 0.95),
    everyAgeYuNetTrustedAtLeast80Percent: ageValues.every((item) => item.yunetTrustedRate >= 0.8),
    everyGenderYuNetTrustedAtLeast90Percent: genderValues.every((item) => item.yunetTrustedRate >= 0.9),
    everyAgeQualityAcceptanceAtLeast70Percent: ageValues.every((item) => item.qualityAcceptanceRate >= 0.7),
    everyGenderQualityAcceptanceAtLeast80Percent: genderValues.every((item) => item.qualityAcceptanceRate >= 0.8),
    everyAgePoseAcceptanceAtLeast60Percent: ageValues.every((item) => item.poseAcceptanceRate >= 0.6),
    everyGenderPoseAcceptanceAtLeast70Percent: genderValues.every((item) => item.poseAcceptanceRate >= 0.7),
    ageMediaPipeDetectionGapAtMost15Points: gap(ageValues.map((item) => item.mediapipeDetectionRate)) <= 0.15,
    genderMediaPipeDetectionGapAtMost5Points: gap(genderValues.map((item) => item.mediapipeDetectionRate)) <= 0.05,
  }
  const detectionContract = gates.noAnalysisErrors && gates.everyAgeMediaPipeDetectionAtLeast90Percent && gates.everyGenderMediaPipeDetectionAtLeast95Percent && gates.everyAgeYuNetTrustedAtLeast80Percent && gates.everyGenderYuNetTrustedAtLeast90Percent && gates.ageMediaPipeDetectionGapAtMost15Points && gates.genderMediaPipeDetectionGapAtMost5Points
  const captureContract = gates.everyAgeQualityAcceptanceAtLeast70Percent && gates.everyGenderQualityAcceptanceAtLeast80Percent && gates.everyAgePoseAcceptanceAtLeast60Percent && gates.everyGenderPoseAcceptanceAtLeast70Percent
  const passesAll = Object.values(gates).every(Boolean)
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-DEMOGRAPHIC-COVERAGE-1.0',
    source: manifest.source,
    protocol: manifest.protocol,
    evaluation: {
      overall: aggregate(observations),
      byAge,
      byGender,
      byCell,
      disparity: {
        ageMediaPipeDetectionGap: gap(ageValues.map((item) => item.mediapipeDetectionRate)),
        ageYuNetTrustedGap: gap(ageValues.map((item) => item.yunetTrustedRate)),
        ageQualityAcceptanceGap: gap(ageValues.map((item) => item.qualityAcceptanceRate)),
        agePoseAcceptanceGap: gap(ageValues.map((item) => item.poseAcceptanceRate)),
        genderMediaPipeDetectionGap: gap(genderValues.map((item) => item.mediapipeDetectionRate)),
        genderYuNetTrustedGap: gap(genderValues.map((item) => item.yunetTrustedRate)),
        genderQualityAcceptanceGap: gap(genderValues.map((item) => item.qualityAcceptanceRate)),
        genderPoseAcceptanceGap: gap(genderValues.map((item) => item.poseAcceptanceRate)),
      },
    },
    predeclaredGates: gates,
    passesDetectionCoverageContract: detectionContract,
    passesCaptureAcceptanceContract: captureContract,
    passesAllDemographicCoverageGates: passesAll,
    productionDecision: passesAll ? 'retain_current_front_pipeline_for_age_gender_coverage' : detectionContract ? 'retain_detection_but_investigate_capture_acceptance_disparity' : 'do_not_claim_age_gender_coverage',
    limitations: [
      'Age and gender labels are dataset annotations and do not establish identity, biology, or medical truth.',
      'This benchmark has no reliable race or skin-tone labels and cannot close the skin-tone fairness requirement.',
      'Ten images per age x gender cell provide a coverage smoke test, not a powered fairness study.',
      'FFHQ images are aligned internet photographs rather than standardized mobile retakes.',
      'Detection and acceptance parity do not prove measurement-error parity because no craniofacial measurement ground truth is available.',
    ],
    retention: { imagesDeletedAfterRun: false, metadataDeletedAfterPrepare: true, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  status.textContent = '完成'
}

main().catch((error) => {
  resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error)
  resultElement.textContent = resultElement.dataset.error
  status.textContent = '失败'
})
