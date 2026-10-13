import { describe, expect, it } from 'vitest'
import { evaluateManualDefectResolutions, type ManualDefectSnapshot } from './manualDefectResolution'

const defect: ManualDefectSnapshot = {
  reviewId: 'MANUAL-001',
  caseId: 'case-1',
  view: 'front',
  transformation: null,
  decision: 'fail',
  auto: { qualityAccepted: false, qualityFlags: ['画面过曝'], poseStatus: 'pass', measurementCount: 0 },
}

describe('evaluateManualDefectResolutions', () => {
  it('marks a cleared rejection as changed but still pending human confirmation', () => {
    const result = evaluateManualDefectResolutions([defect], [{
      reviewId: 'MANUAL-001', caseId: 'case-1', view: 'front', transformation: null, analysisError: false,
      qualityAccepted: true, qualityFlags: [], poseStatus: 'pass', measurementCount: 12,
    }])
    expect(result.changedPendingConfirmation).toBe(1)
    expect(result.cases[0]).toEqual({
      reviewId: 'MANUAL-001',
      status: 'changed_pending_human_confirmation',
      changes: ['quality_rejection_cleared', 'quality_flags_cleared', 'twelve_measurements_restored'],
    })
  })

  it('does not claim resolution when the current result is still blocked', () => {
    const result = evaluateManualDefectResolutions([defect], [{
      reviewId: 'MANUAL-001', caseId: 'case-1', view: 'front', transformation: null, analysisError: false,
      qualityAccepted: false, qualityFlags: ['画面过曝'], poseStatus: 'pass', measurementCount: 0,
    }])
    expect(result.unchanged).toBe(1)
    expect(result.cases[0].status).toBe('unchanged')
  })

  it('fails closed when the current result identity does not match the defect', () => {
    const result = evaluateManualDefectResolutions([defect], [{
      reviewId: 'MANUAL-001', caseId: 'different', view: 'front', transformation: null, analysisError: false,
      qualityAccepted: true, qualityFlags: [], poseStatus: 'pass', measurementCount: 12,
    }])
    expect(result.missing).toBe(1)
    expect(result.cases[0].status).toBe('missing_current_result')
  })
})
