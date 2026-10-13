export type ManualDefectSnapshot = {
  reviewId: string
  caseId: string
  view: string
  transformation: string | null
  decision: 'fail' | 'needs_review'
  auto?: {
    qualityAccepted?: boolean
    qualityFlags?: string[]
    poseStatus?: string
    measurementCount?: number
  }
}

export type ManualDefectCurrentResult = {
  reviewId: string
  caseId: string
  view: string
  transformation: string | null
  analysisError: boolean
  qualityAccepted?: boolean
  qualityFlags?: string[]
  poseStatus?: string
  measurementCount?: number
}

export type ManualDefectResolution = {
  reviewId: string
  status: 'changed_pending_human_confirmation' | 'unchanged' | 'missing_current_result'
  changes: string[]
}

export function evaluateManualDefectResolutions(
  defects: ManualDefectSnapshot[],
  currentResults: ManualDefectCurrentResult[],
): { total: number; changedPendingConfirmation: number; unchanged: number; missing: number; cases: ManualDefectResolution[] } {
  const currentById = new Map(currentResults.map(result => [result.reviewId, result]))
  const cases = defects.map<ManualDefectResolution>(defect => {
    const current = currentById.get(defect.reviewId)
    if (!current || current.caseId !== defect.caseId || current.view !== defect.view || current.transformation !== defect.transformation) {
      return { reviewId: defect.reviewId, status: 'missing_current_result', changes: [] }
    }
    const previous = defect.auto
    const changes: string[] = []
    if (previous?.qualityAccepted === false && current.qualityAccepted === true) changes.push('quality_rejection_cleared')
    if ((previous?.qualityFlags?.length || 0) > 0 && (current.qualityFlags?.length || 0) === 0) changes.push('quality_flags_cleared')
    if (previous?.poseStatus !== 'pass' && current.poseStatus === 'pass') changes.push('pose_rejection_cleared')
    if ((previous?.measurementCount || 0) < 12 && current.measurementCount === 12) changes.push('twelve_measurements_restored')
    const frontReady = defect.view !== 'front' || current.measurementCount === 12
    const candidateResolved = !current.analysisError && current.qualityAccepted === true && current.poseStatus === 'pass' && frontReady && changes.length > 0
    return { reviewId: defect.reviewId, status: candidateResolved ? 'changed_pending_human_confirmation' : 'unchanged', changes }
  })
  return {
    total: cases.length,
    changedPendingConfirmation: cases.filter(item => item.status === 'changed_pending_human_confirmation').length,
    unchanged: cases.filter(item => item.status === 'unchanged').length,
    missing: cases.filter(item => item.status === 'missing_current_result').length,
    cases,
  }
}
