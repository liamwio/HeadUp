import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'wflw-groundtruth')
const officialArchivePath = join(stagingDir, 'WFLW_annotations.tar.gz')
const mirrorArchivePath = join(stagingDir, 'kaggle-wflw.zip')
const mirrorExtractDir = join(stagingDir, 'mirror-extract')
const officialAnnotationDir = join(stagingDir, 'WFLW_annotations')
const mirrorAnnotationDir = join(mirrorExtractDir, 'WFLW_annotations')
const imageDir = join(mirrorExtractDir, 'WFLW_images')
const manifestPath = join(stagingDir, 'sample-manifest.json')
const contourMode = process.argv.includes('--contour-calibration')
const resultArgument = process.argv.find((argument) => argument.startsWith('--result='))?.slice('--result='.length)
const cleanupOnly = process.argv.includes('--cleanup')
const defaultResultPath = join(projectDir, 'data', 'face-benchmark', contourMode ? 'wflw-contour-calibration-result.json' : 'wflw-front-groundtruth-result.json')
const resultPath = resultArgument ? resolve(projectDir, resultArgument) : defaultResultPath
const officialAnnotationUrl = 'https://wywu.github.io/projects/LAB/support/WFLW_annotations.tar.gz'
const mirrorUrl = 'https://www.kaggle.com/api/v1/datasets/download/mrriandmstique/wflw-wider-facial-landmarks-in-the-wild'
const expectedOfficialSha256 = '1459ae3bf24f12384da0a4caf16c16312b499abdafbd5cac2d965ebf855c8712'
const expectedMirrorSha256 = 'f520dfbc0c36065586b7409d5845f167180f5db5e8fe6731acdf3f135dd50348'
const expectedOfficialBytes = 16_329_835
const expectedMirrorBytes = 760_637_521
const attributeNames = ['pose', 'expression', 'illumination', 'makeup', 'occlusion', 'blur']
const categoryQuotas = { baseline: 300, pose: 150, expression: 150, illumination: 150, makeup: 150, occlusion: 150, blur: 150 }
const sampleTarget = 1200
const port = 5205
const pageFile = contourMode ? 'benchmark-wflw-contour-calibration.html' : 'benchmark-wflw-front.html'
const pageUrl = `http://127.0.0.1:${port}/${pageFile}`
const chromeCandidates = [process.env.HEADUP_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const rank = (token) => createHash('sha256').update(`headup-wflw-front-v1/${token}`).digest('hex')
async function hashFile(path) { return digest(await readFile(path)) }
async function download(url, path, maximumSeconds = '1200') { await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', maximumSeconds, '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', path, url], { maxBuffer: 2 * 1024 * 1024 }) }
async function exists(path) { try { await access(path); return true } catch { return false } }
async function findChrome() { for (const path of chromeCandidates) { try { await access(path, constants.X_OK); return path } catch { /* next */ } } throw new Error('No Chromium browser found; set HEADUP_CHROME') }
async function waitFor(check, timeoutMs, label) { const started = Date.now(); let lastError; while (Date.now() - started < timeoutMs) { try { const value = await check(); if (value) return value } catch (error) { lastError = error } await new Promise((resolve) => setTimeout(resolve, 250)) } throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`) }
function connectCdp(url) { const socket = new WebSocket(url); let nextId = 1; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (!message.id || !pending.has(message.id)) return; const handlers = pending.get(message.id); pending.delete(message.id); if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result) }); const ready = new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) }); return { ready, send(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) }) }, close() { socket.close() } } }
async function evaluate(cdp, expression) { const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed'); return response.result.value }

async function sourceReady() {
  if (!await exists(officialArchivePath) || !await exists(mirrorArchivePath)) return false
  const [officialStat, mirrorStat, officialHash, mirrorHash] = await Promise.all([stat(officialArchivePath), stat(mirrorArchivePath), hashFile(officialArchivePath), hashFile(mirrorArchivePath)])
  return officialStat.size === expectedOfficialBytes && mirrorStat.size === expectedMirrorBytes && officialHash === expectedOfficialSha256 && mirrorHash === expectedMirrorSha256
}

async function safeExtract(archive, destination) {
  const { stdout } = await execFileAsync('tar.exe', ['-tf', archive], { maxBuffer: 50 * 1024 * 1024 })
  const unsafe = stdout.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe WFLW archive entry: ${unsafe}`)
  await mkdir(destination, { recursive: true })
  await execFileAsync('tar.exe', ['-xf', archive, '-C', destination], { maxBuffer: 5 * 1024 * 1024 })
}

function parseRow(line) {
  const values = line.trim().split(/\s+/)
  if (values.length !== 207) throw new Error(`Unexpected WFLW annotation width: ${values.length}`)
  const numeric = values.slice(0, 206).map(Number)
  if (numeric.some((value) => !Number.isFinite(value))) throw new Error('Non-finite WFLW annotation value')
  const points = Array.from({ length: 98 }, (_, index) => ({ x: numeric[index * 2], y: numeric[index * 2 + 1] }))
  const pointXs = points.map((point) => point.x); const pointYs = points.map((point) => point.y)
  const ordered = (indices) => indices.map((index) => points[index]).sort((left, right) => left.x - right.x)
  const eyes = ordered([96, 97]); const corners = ordered([60, 64, 68, 72]); const mouth = ordered([76, 82]); const wings = ordered([55, 59]); const cheeks = ordered([4, 28]); const jaw = ordered([8, 24])
  const attributes = Object.fromEntries(attributeNames.map((name, index) => [name, numeric[200 + index] === 1]))
  return {
    file: values[206],
    bbox: { left: numeric[196], top: numeric[197], right: numeric[198], bottom: numeric[199] },
    landmarkBox: { left: Math.min(...pointXs), top: Math.min(...pointYs), right: Math.max(...pointXs), bottom: Math.max(...pointYs) },
    attributes,
    manual: {
      chin: points[16], viewerLeftEyeCenter: eyes[0], viewerRightEyeCenter: eyes[1],
      viewerLeftEyeOuter: corners[0], viewerLeftEyeInner: corners[1], viewerRightEyeInner: corners[2], viewerRightEyeOuter: corners[3],
      viewerLeftMouthCorner: mouth[0], viewerRightMouthCorner: mouth[1], noseRoot: points[51], noseTip: points[54], noseBase: points[57],
      viewerLeftNoseWing: wings[0], viewerRightNoseWing: wings[1], upperLip: points[79], lowerLip: points[85],
      viewerLeftCheek: cheeks[0], viewerRightCheek: cheeks[1], viewerLeftJaw: jaw[0], viewerRightJaw: jaw[1],
    },
    contour: points.slice(0, 33),
    rankToken: `${values[206]}:${numeric.slice(196, 200).join(',')}`,
  }
}

function inCategory(record, category) {
  return category === 'baseline' ? attributeNames.every((name) => !record.attributes[name]) : record.attributes[category]
}

async function prepareManifest() {
  const relativeFiles = [
    'list_98pt_rect_attr_train_test/list_98pt_rect_attr_test.txt', 'list_98pt_rect_attr_train_test/list_98pt_rect_attr_train.txt',
    'list_98pt_test/list_98pt_test.txt', 'list_98pt_test/list_98pt_test_largepose.txt', 'list_98pt_test/list_98pt_test_expression.txt',
    'list_98pt_test/list_98pt_test_illumination.txt', 'list_98pt_test/list_98pt_test_makeup.txt', 'list_98pt_test/list_98pt_test_occlusion.txt', 'list_98pt_test/list_98pt_test_blur.txt',
  ]
  const fileHashes = {}
  for (const relativeFile of relativeFiles) {
    const official = await readFile(join(officialAnnotationDir, relativeFile))
    const mirror = await readFile(join(mirrorAnnotationDir, relativeFile))
    if (!official.equals(mirror)) throw new Error(`Mirror annotation differs from official: ${relativeFile}`)
    fileHashes[relativeFile] = digest(official)
  }
  const rows = (await readFile(join(officialAnnotationDir, relativeFiles[0]), 'utf8')).trim().split(/\r?\n/)
  if (rows.length !== 2500) throw new Error(`Unexpected WFLW test rows: ${rows.length}`)
  const available = rows.map(parseRow)
  for (const record of available) if (!await exists(join(imageDir, ...record.file.split('/')))) throw new Error('Official WFLW test image missing from transport mirror')
  const selected = new Map()
  for (const [category, quota] of Object.entries(categoryQuotas)) {
    const candidates = available.filter((record) => inCategory(record, category)).sort((left, right) => rank(left.rankToken).localeCompare(rank(right.rankToken)))
    let covered = [...selected.values()].filter((record) => inCategory(record, category)).length
    for (const record of candidates) {
      if (covered >= quota) break
      if (!selected.has(record.rankToken)) { selected.set(record.rankToken, record); covered += 1 }
    }
    if (covered < quota) throw new Error(`Unable to satisfy WFLW ${category} quota: ${covered}/${quota}`)
  }
  for (const record of [...available].sort((left, right) => rank(left.rankToken).localeCompare(rank(right.rankToken)))) {
    if (selected.size >= sampleTarget) break
    selected.set(record.rankToken, record)
  }
  if (selected.size !== sampleTarget) throw new Error(`Unexpected WFLW sample size: ${selected.size}`)
  const records = [...selected.values()].map(({ rankToken, ...record }) => record)
  const countCategories = (items) => Object.fromEntries([['baseline', items.filter((record) => inCategory(record, 'baseline')).length], ...attributeNames.map((name) => [name, items.filter((record) => record.attributes[name]).length])])
  const manifest = {
    policyVersion: 'HEADUP-TRANSIENT-RESEARCH-DATA-1.0',
    source: {
      dataset: 'WFLW official test partition', officialProject: 'https://wywu.github.io/projects/LAB/WFLW.html',
      officialAnnotationSha256: expectedOfficialSha256, transportMirror: 'Kaggle mrriandmstique/wflw-wider-facial-landmarks-in-the-wild',
      transportMirrorSha256: expectedMirrorSha256, annotationFilesVerifiedByteIdentical: true, annotationFileSha256: fileHashes,
    },
    selection: 'Official 2,500-face test partition only. Predeclared SHA-256 ranking enforces minimum quotas for baseline and six overlapping challenge attributes, then fills to 1,200 faces without reading image content or predictions.',
    availableFaces: available.length,
    availableUniqueImages: new Set(available.map((record) => record.file)).size,
    sampleFaces: records.length,
    availableAttributeCounts: countCategories(available),
    sampleAttributeCounts: countCategories(records),
    records,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
  return manifest
}

function selectQuotaSample(available, target, quotas) {
  const selected = new Map()
  for (const [category, quota] of Object.entries(quotas)) {
    const candidates = available.filter((record) => inCategory(record, category)).sort((left, right) => rank(left.rankToken).localeCompare(rank(right.rankToken)))
    let covered = [...selected.values()].filter((record) => inCategory(record, category)).length
    for (const record of candidates) {
      if (covered >= quota) break
      if (!selected.has(record.rankToken)) { selected.set(record.rankToken, record); covered += 1 }
    }
    if (covered < quota) throw new Error(`Unable to satisfy WFLW contour ${category} quota: ${covered}/${quota}`)
  }
  for (const record of [...available].sort((left, right) => rank(left.rankToken).localeCompare(rank(right.rankToken)))) {
    if (selected.size >= target) break
    selected.set(record.rankToken, record)
  }
  if (selected.size !== target) throw new Error(`Unexpected WFLW contour sample size: ${selected.size}/${target}`)
  return [...selected.values()]
}

async function prepareContourManifest() {
  const trainPath = join(officialAnnotationDir, 'list_98pt_rect_attr_train_test', 'list_98pt_rect_attr_train.txt')
  const testPath = join(officialAnnotationDir, 'list_98pt_rect_attr_train_test', 'list_98pt_rect_attr_test.txt')
  const trainRows = (await readFile(trainPath, 'utf8')).trim().split(/\r?\n/)
  const testRows = (await readFile(testPath, 'utf8')).trim().split(/\r?\n/)
  if (trainRows.length !== 7500 || testRows.length !== 2500) throw new Error(`Unexpected WFLW train/test rows: ${trainRows.length}/${testRows.length}`)
  const train = trainRows.map(parseRow)
  const test = testRows.map(parseRow)
  const engineeringPool = train.filter((record) => createHash('sha256').update(`wflw-contour-split/${record.file}`).digest()[0] < 179)
  const holdoutPool = train.filter((record) => createHash('sha256').update(`wflw-contour-split/${record.file}`).digest()[0] >= 179)
  const engineering = selectQuotaSample(engineeringPool, 1000, { baseline: 250, pose: 100, expression: 80, illumination: 120, makeup: 40, occlusion: 120, blur: 120 })
  const holdout = selectQuotaSample(holdoutPool, 700, { baseline: 175, pose: 60, expression: 40, illumination: 90, makeup: 20, occlusion: 90, blur: 90 })
  const externalTest = selectQuotaSample(test, 1200, categoryQuotas)
  const engineeringFiles = new Set(engineering.map((record) => record.file))
  if (holdout.some((record) => engineeringFiles.has(record.file))) throw new Error('WFLW contour engineering/holdout image leakage')
  const withSplit = (records, split) => records.map(({ rankToken, ...record }) => ({ ...record, split }))
  const records = [...withSplit(engineering, 'mappingEngineering'), ...withSplit(holdout, 'mappingHoldout'), ...withSplit(externalTest, 'externalTest')]
  for (const record of records) if (!await exists(join(imageDir, ...record.file.split('/')))) throw new Error('Selected WFLW contour image missing')
  const manifest = {
    policyVersion: 'HEADUP-TRANSIENT-RESEARCH-DATA-1.0',
    source: { dataset: 'WFLW official train/test partitions', officialProject: 'https://wywu.github.io/projects/LAB/WFLW.html', officialAnnotationSha256: expectedOfficialSha256, transportMirrorSha256: expectedMirrorSha256, mirrorAnnotationsVerifiedByteIdentical: true },
    selection: 'MediaPipe cheek/jaw to WFLW symmetric contour mapping is selected only on 1,000 official-train faces. A path-hash-disjoint 700-face official-train holdout is untouched until mapping freeze; 1,200 official-test faces are a secondary external reanalysis.',
    records,
    counts: { mappingEngineering: engineering.length, mappingHoldout: holdout.length, externalTest: externalTest.length },
    imageLeakageAcrossEngineeringHoldout: false,
    faceContourCandidates: Array.from({ length: 11 }, (_, index) => index),
    jawContourCandidates: Array.from({ length: 11 }, (_, index) => index + 5),
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
  return manifest
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe WFLW staging path')
if (!resultPath.startsWith(`${resolve(projectDir, 'data', 'face-benchmark')}\\`)) throw new Error('Result path must remain under data/face-benchmark')
if (cleanupOnly) {
  await rm(stagingDir, { recursive: true, force: true })
  process.stdout.write(`Removed transient WFLW staging: ${stagingDir}\n`)
  process.exit(0)
}
await access(resultPath).then(() => { throw new Error(`Refusing to overwrite existing result: ${resultPath}`) }, () => undefined)
if (!await sourceReady()) {
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  process.stdout.write('Downloading official WFLW annotations and a public image transport mirror...\n')
  await Promise.all([download(officialAnnotationUrl, officialArchivePath, '300'), download(mirrorUrl, mirrorArchivePath)])
}
if (await hashFile(officialArchivePath) !== expectedOfficialSha256 || (await stat(officialArchivePath)).size !== expectedOfficialBytes) throw new Error('Official WFLW annotation archive mismatch')
if (await hashFile(mirrorArchivePath) !== expectedMirrorSha256 || (await stat(mirrorArchivePath)).size !== expectedMirrorBytes) throw new Error('WFLW transport mirror archive mismatch')
if (!await exists(join(imageDir, '0--Parade')) || !await exists(join(officialAnnotationDir, 'list_98pt_rect_attr_train_test'))) {
  await rm(mirrorExtractDir, { recursive: true, force: true })
  await rm(officialAnnotationDir, { recursive: true, force: true })
  await safeExtract(officialArchivePath, stagingDir)
  await safeExtract(mirrorArchivePath, mirrorExtractDir)
}

const profileDir = await mkdtemp(join(tmpdir(), 'headup-wflw-front-'))
let vite; let chrome; let cdp; let viteError = ''
try {
  const manifest = contourMode ? await prepareContourManifest() : await prepareManifest()
  process.stdout.write(contourMode
    ? `Verified WFLW mapping isolation and prepared ${JSON.stringify(manifest.counts)} faces\n`
    : `Verified official WFLW annotations and prepared ${manifest.sampleFaces}/${manifest.availableFaces} faces: ${JSON.stringify(manifest.sampleAttributeCounts)}\n`)
  vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  vite.stderr.on('data', (chunk) => { viteError += chunk.toString() })
  await waitFor(async () => fetch(pageUrl).then((response) => response.ok), 30_000, `Vite at ${pageUrl}`)
  chrome = spawn(await findChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1280,900', pageUrl], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const activePort = await waitFor(async () => { const content = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8'); return Number(content.trim().split(/\r?\n/)[0]) || undefined }, 30_000, 'Chromium DevTools port')
  const page = await waitFor(async () => { const targets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json()); return targets.find((target) => target.type === 'page' && target.url.includes(pageFile)) }, 30_000, 'WFLW benchmark page')
  cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.ready
  let previousStatus = ''
  await waitFor(async () => {
    const pageError = await evaluate(cdp, `document.querySelector('#result')?.dataset.error || ''`); if (pageError) throw new Error(pageError)
    const pageStatus = await evaluate(cdp, `document.querySelector('#status')?.textContent || ''`)
    const processed = /^处理 (\d+) \/ (\d+)$/.exec(pageStatus)
    if (pageStatus !== previousStatus && (pageStatus === '完成' || (processed && (Number(processed[1]) === 1 || Number(processed[1]) % 100 === 0 || processed[1] === processed[2])))) { process.stdout.write(`${pageStatus}\n`); previousStatus = pageStatus }
    return pageStatus === '完成' ? true : undefined
  }, 120 * 60_000, 'WFLW front benchmark completion')
  const result = JSON.parse(await evaluate(cdp, `document.querySelector('#result')?.textContent || ''`))
  const expectedPolicy = contourMode ? 'HEADUP-WFLW-CONTOUR-CALIBRATION-1.0' : 'HEADUP-WFLW-FRONT-GROUNDTRUTH-1.0'
  if (result.analysisPolicyVersion !== expectedPolicy || (contourMode ? result.faces !== 2900 : result.sampleFaces !== sampleTarget)) throw new Error('Unexpected WFLW benchmark result')
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify(contourMode
    ? { resultPath, faces: result.faces, selectedMapping: result.selectedMapping, evaluation: result.evaluation, holdout: result.bySplit.mappingHoldout, externalTest: result.bySplit.externalTest }
    : { resultPath, sampleFaces: result.sampleFaces, sampleAttributeCounts: result.sampleAttributeCounts, evaluation: result.evaluation, all: result.byCategory.all }, null, 2)}\n`)
} catch (error) {
  if (vite?.exitCode !== null && vite?.exitCode !== 0) process.stderr.write(viteError)
  throw error
} finally {
  if (cdp) { try { await cdp.send('Browser.close') } catch { /* closed */ } cdp.close() }
  if (chrome && chrome.exitCode === null) chrome.kill()
  if (vite && vite.exitCode === null) vite.kill()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  await rm(stagingDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}
