import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'wflw-groundtruth-scale-audit')
const archivePath = join(stagingDir, 'WFLW_annotations.tar.gz')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'wflw-groundtruth-scale-audit.json')
const sourceUrl = 'https://wywu.github.io/projects/LAB/support/WFLW_annotations.tar.gz'
const expectedSha256 = '1459ae3bf24f12384da0a4caf16c16312b499abdafbd5cac2d965ebf855c8712'
const attributes = ['pose', 'expression', 'illumination', 'makeup', 'occlusion', 'blur']
const rank = (token) => createHash('sha256').update(`headup-wflw-front-v1/${token}`).digest('hex')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function parse(line) {
  const values = line.trim().split(/\s+/)
  if (values.length !== 207) throw new Error('Unexpected WFLW annotation width')
  const numeric = values.slice(0, 206).map(Number)
  const points = Array.from({ length: 98 }, (_, index) => ({ x: numeric[index * 2], y: numeric[index * 2 + 1] }))
  return {
    file: values[206], points,
    attributes: Object.fromEntries(attributes.map((name, index) => [name, numeric[200 + index] === 1])),
    rankToken: `${values[206]}:${numeric.slice(196, 200).join(',')}`,
  }
}

function inCategory(record, category) { return category === 'baseline' ? attributes.every((name) => !record.attributes[name]) : record.attributes[category] }
function selectQuotaSample(available, target, quotas) {
  const selected = new Map()
  for (const [category, quota] of Object.entries(quotas)) {
    const candidates = available.filter((record) => inCategory(record, category)).sort((left, right) => rank(left.rankToken).localeCompare(rank(right.rankToken)))
    let covered = [...selected.values()].filter((record) => inCategory(record, category)).length
    for (const record of candidates) {
      if (covered >= quota) break
      if (!selected.has(record.rankToken)) { selected.set(record.rankToken, record); covered += 1 }
    }
    if (covered < quota) throw new Error(`Unable to satisfy ${category} quota`)
  }
  for (const record of [...available].sort((left, right) => rank(left.rankToken).localeCompare(rank(right.rankToken)))) {
    if (selected.size >= target) break
    selected.set(record.rankToken, record)
  }
  if (selected.size !== target) throw new Error('Unexpected WFLW scale-audit sample size')
  return [...selected.values()]
}

function distance(left, right) { return Math.hypot(left.x - right.x, left.y - right.y) }
function quantiles(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction) => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(4))
  return { min: at(0), p05: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) }
}

function summarize(records) {
  const scales = { faceWidth: [], jawWidth: [], pupilDistance: [], mouthWidth: [] }
  for (const record of records) {
    const xs = record.points.map((point) => point.x); const ys = record.points.map((point) => point.y)
    const diagonal = Math.max(1, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)))
    scales.faceWidth.push(100 * distance(record.points[2], record.points[30]) / diagonal)
    scales.jawWidth.push(100 * distance(record.points[8], record.points[24]) / diagonal)
    scales.pupilDistance.push(100 * distance(record.points[96], record.points[97]) / diagonal)
    scales.mouthWidth.push(100 * distance(record.points[76], record.points[82]) / diagonal)
  }
  return {
    faces: records.length,
    percentOfLandmarkBoxDiagonal: Object.fromEntries(Object.entries(scales).map(([name, values]) => [name, quantiles(values)])),
    belowThresholdCounts: Object.fromEntries(Object.entries(scales).map(([name, values]) => [name, { below1Percent: values.filter((value) => value < 1).length, below2Percent: values.filter((value) => value < 2).length, below5Percent: values.filter((value) => value < 5).length }])),
  }
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe staging path')
await readFile(resultPath).then(() => { throw new Error(`Refusing to overwrite existing result: ${resultPath}`) }, () => undefined)
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })
try {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '300', '--output', archivePath, sourceUrl])
  if (digest(await readFile(archivePath)) !== expectedSha256) throw new Error('WFLW annotation checksum mismatch')
  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 5 * 1024 * 1024 })
  const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', stagingDir])
  const base = join(stagingDir, 'WFLW_annotations', 'list_98pt_rect_attr_train_test')
  const train = (await readFile(join(base, 'list_98pt_rect_attr_train.txt'), 'utf8')).trim().split(/\r?\n/).map(parse)
  const test = (await readFile(join(base, 'list_98pt_rect_attr_test.txt'), 'utf8')).trim().split(/\r?\n/).map(parse)
  const engineeringPool = train.filter((record) => createHash('sha256').update(`wflw-contour-split/${record.file}`).digest()[0] < 179)
  const holdoutPool = train.filter((record) => createHash('sha256').update(`wflw-contour-split/${record.file}`).digest()[0] >= 179)
  const engineering = selectQuotaSample(engineeringPool, 1000, { baseline: 250, pose: 100, expression: 80, illumination: 120, makeup: 40, occlusion: 120, blur: 120 })
  const holdout = selectQuotaSample(holdoutPool, 700, { baseline: 175, pose: 60, expression: 40, illumination: 90, makeup: 20, occlusion: 90, blur: 90 })
  const externalTest = selectQuotaSample(test, 1200, { baseline: 300, pose: 150, expression: 150, illumination: 150, makeup: 150, occlusion: 150, blur: 150 })
  const result = {
    testedAt: new Date().toISOString(), analysisPolicyVersion: 'HEADUP-WFLW-GT-SCALE-AUDIT-1.0', source: { officialAnnotationSha256: expectedSha256 },
    mapping: { faceWidth: [2, 30], jawWidth: [8, 24], pupilDistance: [96, 97], mouthWidth: [76, 82] },
    note: 'Annotation-only denominator audit of the exact contour-calibration samples; no images or predictions are downloaded.',
    bySplit: { mappingEngineering: summarize(engineering), mappingHoldout: summarize(holdout), externalTest: summarize(externalTest) },
    retention: { imagesDownloaded: false, annotationsRetainedAfterCleanup: false, originalIdentifiersRetained: false, aggregateOnly: true },
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally { await rm(stagingDir, { recursive: true, force: true }) }
