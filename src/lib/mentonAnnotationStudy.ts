export const MENTON_ANNOTATION_SCHEMA = 'headup.menton-annotation.v1' as const
export const MENTON_CANONICAL_SCHEMA = 'headup.menton-canonical.v1' as const

export type ProfileDirection = 'left' | 'right'
export interface NormalizedPoint { x: number; y: number }
export interface NormalizedBox { x: number; y: number; width: number; height: number }

export interface MentonAnnotationRecord {
  imageSha256: string
  width: number
  height: number
  direction: ProfileDirection
  faceBox: NormalizedBox
  menton: NormalizedPoint
}

export interface MentonAnnotationSession {
  schemaVersion: typeof MENTON_ANNOTATION_SCHEMA
  policyVersion: 'HEADUP-MENTON-CANONICAL-ANNOTATION-1.0'
  generatedAt: string
  sessionLabel: 'A' | 'B' | 'C'
  annotatorHash: string
  definition: string
  records: MentonAnnotationRecord[]
  retention: {
    imagesIncluded: false
    fileNamesIncluded: false
    imageContentHashesIncluded: true
    normalizedCoordinatesIncluded: true
  }
}

export interface AgreementCase {
  imageSha256: string
  direction: ProfileDirection
  disagreementNme: number
  requiresAdjudication: boolean
}

export interface AgreementDistribution {
  min: number | null
  median: number | null
  p95: number | null
  max: number | null
}

export interface MentonAgreementComparison {
  cases: AgreementCase[]
  matched: number
  missingFromA: number
  missingFromB: number
  directionMismatches: number
  distinctAnnotators: boolean
  byDirection: Record<ProfileDirection, number>
  disagreement: AgreementDistribution
  adjudicationRequired: number
  gates: {
    atLeast120MatchedImages: boolean
    atLeast60PerDirection: boolean
    annotatorsAreDistinct: boolean
    noMissingOrDirectionMismatch: boolean
    medianDisagreementAtMost2Percent: boolean
    p95DisagreementAtMost5Percent: boolean
  }
  passesDevelopmentAgreementGate: boolean
}

export interface CanonicalMentonRecord extends MentonAnnotationRecord {
  resolution: 'ab_midpoint_within_2_percent' | 'three_annotator_medoid'
  sourceAnnotator: 'A+B' | 'A' | 'B' | 'C'
  initialDisagreementNme: number
}

export interface MentonCanonicalSession {
  schemaVersion: typeof MENTON_CANONICAL_SCHEMA
  policyVersion: 'HEADUP-MENTON-CANONICAL-ADJUDICATION-1.0'
  generatedAt: string
  annotatorHashes: [string, string] | [string, string, string]
  records: CanonicalMentonRecord[]
  agreement: Omit<MentonAgreementComparison, 'cases'>
  retention: {
    imagesIncluded: false
    fileNamesIncluded: false
    sourceCoordinatesIncluded: false
    canonicalCoordinatesIncluded: true
    imageContentHashesIncluded: true
  }
}

const DEFINITION = '软组织下颏轮廓最低点：沿可见软组织下颏外轮廓寻找垂直位置最低点；不是最前突点、颏唇沟点或下颌角。'
const SHA256 = /^[0-9a-f]{64}$/

function finiteUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function validatePoint(value: unknown): value is NormalizedPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as NormalizedPoint
  return finiteUnit(point.x) && finiteUnit(point.y)
}

function validateBox(value: unknown): value is NormalizedBox {
  if (!value || typeof value !== 'object') return false
  const box = value as NormalizedBox
  return finiteUnit(box.x) && finiteUnit(box.y) && finiteUnit(box.width) && finiteUnit(box.height)
    && box.width >= 0.1 && box.height >= 0.1 && box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001
}

function validateRecord(value: unknown): value is MentonAnnotationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as MentonAnnotationRecord
  const pointInsideBox = validateBox(record.faceBox) && validatePoint(record.menton)
    && record.menton.x >= record.faceBox.x - 0.02
    && record.menton.x <= record.faceBox.x + record.faceBox.width + 0.02
    && record.menton.y >= record.faceBox.y - 0.02
    && record.menton.y <= record.faceBox.y + record.faceBox.height + 0.02
  return SHA256.test(record.imageSha256)
    && Number.isInteger(record.width) && record.width >= 120
    && record.width <= 20_000
    && Number.isInteger(record.height) && record.height >= 120
    && record.height <= 20_000
    && (record.direction === 'left' || record.direction === 'right')
    && pointInsideBox
}

function ensureUniqueRecords(records: MentonAnnotationRecord[]) {
  const hashes = new Set(records.map((record) => record.imageSha256))
  if (hashes.size !== records.length) throw new Error('同一会话包含重复图片哈希')
}

export function buildMentonAnnotationSession(
  records: MentonAnnotationRecord[],
  annotatorHash: string,
  sessionLabel: MentonAnnotationSession['sessionLabel'],
  generatedAt = new Date().toISOString(),
): MentonAnnotationSession {
  if (!SHA256.test(annotatorHash)) throw new Error('标注者匿名哈希无效')
  if (!records.length || records.length > 2_000 || !records.every(validateRecord)) throw new Error('标注记录为空、过多或格式无效')
  ensureUniqueRecords(records)
  return {
    schemaVersion: MENTON_ANNOTATION_SCHEMA,
    policyVersion: 'HEADUP-MENTON-CANONICAL-ANNOTATION-1.0',
    generatedAt,
    sessionLabel,
    annotatorHash,
    definition: DEFINITION,
    records: records.map((record) => structuredClone(record)),
    retention: {
      imagesIncluded: false,
      fileNamesIncluded: false,
      imageContentHashesIncluded: true,
      normalizedCoordinatesIncluded: true,
    },
  }
}

export function parseMentonAnnotationSession(value: unknown): MentonAnnotationSession {
  if (!value || typeof value !== 'object') throw new Error('标注JSON不是对象')
  const session = value as MentonAnnotationSession
  if (session.schemaVersion !== MENTON_ANNOTATION_SCHEMA
    || session.policyVersion !== 'HEADUP-MENTON-CANONICAL-ANNOTATION-1.0'
    || !SHA256.test(session.annotatorHash)
    || !['A', 'B', 'C'].includes(session.sessionLabel)
    || !Array.isArray(session.records)
    || !session.records.length
    || session.records.length > 2_000
    || !session.records.every(validateRecord)
    || session.definition !== DEFINITION
    || session.retention?.imagesIncluded !== false
    || session.retention?.fileNamesIncluded !== false
    || session.retention?.imageContentHashesIncluded !== true
    || session.retention?.normalizedCoordinatesIncluded !== true) {
    throw new Error('标注JSON合同不匹配')
  }
  ensureUniqueRecords(session.records)
  return session
}

function boxDiagonalPixels(record: MentonAnnotationRecord) {
  return Math.hypot(record.faceBox.width * record.width, record.faceBox.height * record.height)
}

export function mentonDisagreementNme(a: MentonAnnotationRecord, b: MentonAnnotationRecord) {
  if (a.imageSha256 !== b.imageSha256 || a.width !== b.width || a.height !== b.height) {
    throw new Error('不能比较不同图片或尺寸的标注')
  }
  const distance = Math.hypot(
    (a.menton.x - b.menton.x) * a.width,
    (a.menton.y - b.menton.y) * a.height,
  )
  return distance / Math.max(1, (boxDiagonalPixels(a) + boxDiagonalPixels(b)) / 2)
}

function quantileNearest(values: number[], fraction: number) {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.round((ordered.length - 1) * fraction)]
}

function summarize(values: number[]): AgreementDistribution {
  return {
    min: values.length ? Math.min(...values) : null,
    median: quantileNearest(values, 0.5),
    p95: quantileNearest(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  }
}

export function compareMentonAnnotationSessions(
  a: MentonAnnotationSession,
  b: MentonAnnotationSession,
): MentonAgreementComparison {
  const first = parseMentonAnnotationSession(a)
  const second = parseMentonAnnotationSession(b)
  const aByHash = new Map(first.records.map((record) => [record.imageSha256, record]))
  const bByHash = new Map(second.records.map((record) => [record.imageSha256, record]))
  const allHashes = new Set([...aByHash.keys(), ...bByHash.keys()])
  const cases: AgreementCase[] = []
  let missingFromA = 0
  let missingFromB = 0
  let directionMismatches = 0
  for (const hash of [...allHashes].sort()) {
    const left = aByHash.get(hash)
    const right = bByHash.get(hash)
    if (!left) { missingFromA++; continue }
    if (!right) { missingFromB++; continue }
    if (left.direction !== right.direction) { directionMismatches++; continue }
    const disagreementNme = mentonDisagreementNme(left, right)
    cases.push({
      imageSha256: hash,
      direction: left.direction,
      disagreementNme,
      requiresAdjudication: disagreementNme > 0.02,
    })
  }
  const disagreement = summarize(cases.map((item) => item.disagreementNme))
  const byDirection = {
    left: cases.filter((item) => item.direction === 'left').length,
    right: cases.filter((item) => item.direction === 'right').length,
  }
  const distinctAnnotators = first.annotatorHash !== second.annotatorHash
  const gates = {
    atLeast120MatchedImages: cases.length >= 120,
    atLeast60PerDirection: byDirection.left >= 60 && byDirection.right >= 60,
    annotatorsAreDistinct: distinctAnnotators,
    noMissingOrDirectionMismatch: missingFromA === 0 && missingFromB === 0 && directionMismatches === 0,
    medianDisagreementAtMost2Percent: disagreement.median !== null && disagreement.median <= 0.02,
    p95DisagreementAtMost5Percent: disagreement.p95 !== null && disagreement.p95 <= 0.05,
  }
  return {
    cases,
    matched: cases.length,
    missingFromA,
    missingFromB,
    directionMismatches,
    distinctAnnotators,
    byDirection,
    disagreement,
    adjudicationRequired: cases.filter((item) => item.requiresAdjudication).length,
    gates,
    passesDevelopmentAgreementGate: Object.values(gates).every(Boolean),
  }
}

export function aggregateMentonAgreement(comparison: MentonAgreementComparison) {
  const { cases: _cases, ...aggregate } = comparison
  return {
    schemaVersion: 'headup.menton-agreement-aggregate.v1',
    generatedAt: new Date().toISOString(),
    ...aggregate,
    retention: {
      imagesIncluded: false,
      fileNamesIncluded: false,
      imageContentHashesIncluded: false,
      individualCoordinatesIncluded: false,
      individualDisagreementsIncluded: false,
      aggregateOnly: true,
    },
  }
}

function midpoint(a: NormalizedPoint, b: NormalizedPoint): NormalizedPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function pointDistancePixels(a: NormalizedPoint, b: NormalizedPoint, width: number, height: number) {
  return Math.hypot((a.x - b.x) * width, (a.y - b.y) * height)
}

function medoidSource(
  a: MentonAnnotationRecord,
  b: MentonAnnotationRecord,
  c: MentonAnnotationRecord,
): 'A' | 'B' | 'C' {
  const points = { A: a.menton, B: b.menton, C: c.menton }
  const labels = ['A', 'B', 'C'] as const
  const scores = labels.map((label) => ({
    label,
    score: labels.reduce((sum, other) => sum + pointDistancePixels(
      points[label], points[other], a.width, a.height,
    ), 0),
  }))
  scores.sort((left, right) => left.score - right.score || (left.label === 'C' ? -1 : right.label === 'C' ? 1 : left.label.localeCompare(right.label)))
  return scores[0].label
}

export function buildCanonicalMentonSession(
  a: MentonAnnotationSession,
  b: MentonAnnotationSession,
  adjudicator: MentonAnnotationSession | null,
  generatedAt = new Date().toISOString(),
): MentonCanonicalSession {
  const first = parseMentonAnnotationSession(a)
  const second = parseMentonAnnotationSession(b)
  const comparison = compareMentonAnnotationSessions(first, second)
  const needsAdjudication = comparison.adjudicationRequired > 0
  const third = adjudicator ? parseMentonAnnotationSession(adjudicator) : null
  if (needsAdjudication && !third) throw new Error('存在超过2%的分歧，必须提供第三方盲裁决')
  const annotatorHashes = third
    ? [first.annotatorHash, second.annotatorHash, third.annotatorHash] as [string, string, string]
    : [first.annotatorHash, second.annotatorHash] as [string, string]
  if (new Set(annotatorHashes).size !== annotatorHashes.length) {
    throw new Error('A、B、裁决者必须使用不同匿名标注者')
  }
  const aByHash = new Map(first.records.map((record) => [record.imageSha256, record]))
  const bByHash = new Map(second.records.map((record) => [record.imageSha256, record]))
  const cByHash = new Map((third?.records ?? []).map((record) => [record.imageSha256, record]))
  const records: CanonicalMentonRecord[] = []
  for (const item of comparison.cases) {
    const left = aByHash.get(item.imageSha256)!
    const right = bByHash.get(item.imageSha256)!
    if (!item.requiresAdjudication) {
      records.push({
        ...structuredClone(left),
        faceBox: {
          x: (left.faceBox.x + right.faceBox.x) / 2,
          y: (left.faceBox.y + right.faceBox.y) / 2,
          width: (left.faceBox.width + right.faceBox.width) / 2,
          height: (left.faceBox.height + right.faceBox.height) / 2,
        },
        menton: midpoint(left.menton, right.menton),
        resolution: 'ab_midpoint_within_2_percent',
        sourceAnnotator: 'A+B',
        initialDisagreementNme: item.disagreementNme,
      })
      continue
    }
    const thirdRecord = cByHash.get(item.imageSha256)
    if (!thirdRecord || thirdRecord.direction !== left.direction) {
      throw new Error('所有超过2%的分歧图必须完成同方向第三方盲裁决')
    }
    const source = medoidSource(left, right, thirdRecord)
    const selected = source === 'A' ? left : source === 'B' ? right : thirdRecord
    records.push({
      ...structuredClone(selected),
      resolution: 'three_annotator_medoid',
      sourceAnnotator: source,
      initialDisagreementNme: item.disagreementNme,
    })
  }
  const { cases: _cases, ...agreement } = comparison
  return {
    schemaVersion: MENTON_CANONICAL_SCHEMA,
    policyVersion: 'HEADUP-MENTON-CANONICAL-ADJUDICATION-1.0',
    generatedAt,
    annotatorHashes,
    records,
    agreement,
    retention: {
      imagesIncluded: false,
      fileNamesIncluded: false,
      sourceCoordinatesIncluded: false,
      canonicalCoordinatesIncluded: true,
      imageContentHashesIncluded: true,
    },
  }
}
