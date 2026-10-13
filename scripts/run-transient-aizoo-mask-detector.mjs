import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingDir = join(projectDir, 'data', 'face-benchmark', '.staging', 'aizoo-mask-detector')
const manifestPath = join(stagingDir, 'manifest.json')
const scoresPath = join(stagingDir, 'scores.jsonl')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'aizoo-mask-detector-result.json')
const auditScript = join(projectDir, 'scripts', 'audit-aizoo-mask-detector.py')
function pythonCommand() { return process.env.HEADUP_PYTHON ? { command: process.env.HEADUP_PYTHON, prefix: [] } : { command: 'py', prefix: ['-3.11'] } }
function rate(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(4)) : null }
function quantile(values, probability) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * probability; const lower = Math.floor(position); const remainder = position - lower; return Number((sorted[lower] + (sorted[lower + 1] === undefined ? 0 : remainder * (sorted[lower + 1] - sorted[lower]))).toFixed(6)) }
function distribution(records) { const values = records.map((record) => record.maskScore); return { min: quantile(values, 0), p05: quantile(values, 0.05), median: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) } }
function summarize(records, threshold, positive) { const blocked = records.filter((record) => record.maskScore >= threshold).length; return { images: records.length, detections: records.filter((record) => record.detectionCount > 0).length, blocked, rate: rate(blocked, records.length), desiredMetric: positive ? 'maskRecall' : 'unmaskedFalseRejectRate', maskScore: distribution(records) } }
function subjectMacro(records, threshold) { const groups = Object.values(Object.groupBy(records, (record) => record.subjectId)); return Number((groups.reduce((sum, group) => sum + group.filter((record) => record.maskScore >= threshold).length / group.length, 0) / groups.length).toFixed(4)) }

await readFile(resultPath).then(() => { throw new Error(`Refusing to overwrite existing result: ${resultPath}`) }, () => undefined)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const python = pythonCommand()
try {
  await execFileAsync(python.command, [...python.prefix, auditScript, '--manifest', manifestPath, '--model', manifest.model.paths.caffemodel, '--prototxt', manifest.model.paths.prototxt, '--output', scoresPath], { env: { ...process.env, PYTHONPATH: manifest.runtime.path }, maxBuffer: 8 * 1024 * 1024, timeout: 1_200_000 })
  const scores = (await readFile(scoresPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line))
  if (scores.length !== manifest.records.length) throw new Error(`Score count mismatch: ${scores.length}`)
  const byId = new Map(scores.map((record) => [record.sampleId, record]))
  const records = manifest.records.map((record) => ({ ...record, ...byId.get(record.sampleId) }))
  if (records.some((record) => !Number.isFinite(record.maskScore))) throw new Error('Missing or invalid mask score')
  const groups = {
    maskedEvaluation: records.filter((record) => record.label === 'masked'),
    cewEngineering: records.filter((record) => record.label === 'unmasked_cew' && record.split === 'engineering'),
    cewHoldout: records.filter((record) => record.label === 'unmasked_cew' && record.split === 'holdout'),
    authorizedEngineering: records.filter((record) => record.label === 'unmasked_authorized' && record.split === 'engineering'),
    authorizedHoldout: records.filter((record) => record.label === 'unmasked_authorized' && record.split === 'holdout'),
  }
  const engineeringUnmasked = [...groups.cewEngineering, ...groups.authorizedEngineering]
  const allowedFalseRejects = Math.floor(engineeringUnmasked.length * 0.01)
  const candidates = [0, ...new Set(engineeringUnmasked.map((record) => Number(Math.min(1.000001, record.maskScore + 1e-7).toFixed(7)))), 1.000001].sort((a, b) => a - b)
  const threshold = candidates.find((candidate) => engineeringUnmasked.filter((record) => record.maskScore >= candidate).length <= allowedFalseRejects)
  if (threshold === undefined) throw new Error('Unable to select threshold')
  const officialThreshold = 0.5
  const summarizeAt = (selectedThreshold) => ({
    threshold: selectedThreshold,
    engineeringUnmasked: { cew: summarize(groups.cewEngineering, selectedThreshold, false), authorized: summarize(groups.authorizedEngineering, selectedThreshold, false) },
    externalMaskedEvaluation: { masked: summarize(groups.maskedEvaluation, selectedThreshold, true), maskedSubjectMacroRecall: subjectMacro(groups.maskedEvaluation, selectedThreshold) },
    holdoutUnmasked: { cew: summarize(groups.cewHoldout, selectedThreshold, false), authorized: summarize(groups.authorizedHoldout, selectedThreshold, false) },
  })
  const selected = summarizeAt(threshold); const official = summarizeAt(officialThreshold)
  const gates = {
    externalMaskedImageRecallAtLeast95Percent: selected.externalMaskedEvaluation.masked.rate >= 0.95,
    externalMaskedSubjectMacroRecallAtLeast90Percent: selected.externalMaskedEvaluation.maskedSubjectMacroRecall >= 0.9,
    holdoutCewFalseRejectAtMost1Percent: selected.holdoutUnmasked.cew.rate <= 0.01,
    authorizedHoldoutFalseRejectsZero: selected.holdoutUnmasked.authorized.blocked === 0,
    productProtocolMobilePairedEvidenceAvailable: false,
  }
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-AIZOO-MASK-AUDIT-1.0',
    model: { ...manifest.model, paths: undefined }, datasets: manifest.datasets,
    thresholdSelection: { partition: '385 engineering unmasked identities only; no RMFD masked image participates', rule: 'lowest threshold satisfying the constraint, which maximizes possible mask recall without inspecting positive scores', constraint: 'combined CEW + authorized unmasked false reject rate <= 1%', engineeringUnmaskedImages: engineeringUnmasked.length, allowedFalseRejects },
    officialThreshold: official, selectedThreshold: selected, gates,
    numericalGatesPassed: Object.entries(gates).filter(([key]) => key !== 'productProtocolMobilePairedEvidenceAvailable').every(([, passed]) => passed),
    productionGatePassed: Object.values(gates).every(Boolean),
    decision: 'not_integrated_failed_external_mask_recall_and_missing_product_protocol_mobile_paired_validation',
    limitations: ['RMFD contains many correlated web images from only 23 identities and is not a HeadUp capture session.', 'CEW open controls are 100x100 warped face crops; London controls are studio photographs, not fresh mobile camera sessions.', 'The audit validates mask blocking only and does not establish sunglasses, general occlusion, PAD or sensor provenance performance.'],
    retention: { downloadedImagesDeletedAfterAudit: true, modelDeletedAfterAudit: true, pythonRuntimeDeletedAfterAudit: true, individualPredictionsDeleted: true, identifiersRetained: false, aggregateOnly: true },
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ resultPath, threshold, selected: result.selectedThreshold, gates, productionGatePassed: result.productionGatePassed }, null, 2)}\n`)
} finally {
  await rm(scoresPath, { force: true })
}
