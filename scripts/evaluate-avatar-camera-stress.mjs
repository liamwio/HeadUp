import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const root = join(projectDir, 'data', 'face-db-real-research', 'avatar-smoke', 'ffhq-highres')
const inputPath = join(root, 'avatar-robustness-result.json')
const outputPath = join(root, 'avatar-camera-stress-evaluation.json')
const source = JSON.parse(await readFile(inputPath, 'utf8'))
const coreVariants = ['jpeg_quality_75','brightness_85_percent','brightness_115_percent','rotate_minus_2_degrees','rotate_plus_2_degrees','shift_right_3_percent','shift_down_3_percent','center_zoom_5_percent']
const extendedVariants = source.variants
const stableMetrics = new Set(['pupilDistanceFaceWidthRatio', 'jawWidthRatio'])

function evaluate(variants) {
  const retained = variants.reduce((sum, name) => sum + source.byVariant[name].retained, 0)
  const attempts = source.baselineSelected * variants.length
  const metricGates = Object.fromEntries(Object.keys(source.perMetricGates).map((metric) => {
    const values = variants.map((name) => source.byVariant[name].metrics[metric])
    const worstP95 = Math.max(...values.map((value) => metric === 'mirrorResidual' || metric === 'eyeCanthalTiltDegrees' ? value.absoluteDifference.p95 : value.relativeDifference.p95))
    const threshold = metric === 'mirrorResidual' ? 0.03 : metric === 'eyeCanthalTiltDegrees' ? 1 : stableMetrics.has(metric) ? 0.03 : 0.08
    return [metric, { worstP95, threshold, pass: worstP95 <= threshold }]
  }))
  const gates = {
    everyVariantRetainsAtLeast80Percent: variants.every((name) => source.byVariant[name].retentionRate >= 0.8),
    overallRetentionAtLeast85Percent: retained / attempts >= 0.85,
    everyMetricPassesP95Threshold: Object.values(metricGates).every((value) => value.pass),
  }
  return { variants, attempts, retained, rejected: attempts - retained, retentionRate: retained / attempts, metricGates, gates, pass: Object.values(gates).every(Boolean) }
}

const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-AVATAR-CAMERA-STRESS-GATE-1.0',
  sourceResult: 'avatar-robustness-result.json',
  sourcePolicyVersion: source.policyVersion,
  baselineSelected: source.baselineSelected,
  recommendedCaptureContract: evaluate(coreVariants),
  extendedCameraStressContract: evaluate(extendedVariants),
  decision: 'retain_recommended_capture_contract_and_document_affine_shear_limit',
  productionChange: false,
}
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ outputPath, recommendedPass: result.recommendedCaptureContract.pass, extendedPass: result.extendedCameraStressContract.pass, extendedFailedMetrics: Object.entries(result.extendedCameraStressContract.metricGates).filter(([, value]) => !value.pass).map(([metric]) => metric) }, null, 2)}\n`)
