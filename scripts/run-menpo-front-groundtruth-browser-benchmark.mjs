import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'menpo-front-groundtruth')
const archivePath = join(stagingDir, 'menpo_challenge_trainset.zip')
const extractDir = join(stagingDir, 'extract')
const manifestPath = join(stagingDir, 'sample-manifest.json')
const resultArgument = process.argv.find((argument) => argument.startsWith('--result='))?.slice('--result='.length)
const cleanupOnly = process.argv.includes('--cleanup')
const defaultResultPath = join(projectDir, 'data', 'face-benchmark', 'menpo-front-groundtruth-result.json')
const resultPath = resultArgument ? resolve(projectDir, resultArgument) : defaultResultPath
const menpoUrl = 'https://drive.usercontent.google.com/download?id=1CUqs0n135lye6J6RM5FQXT_DIT45dKvP&export=download&confirm=t'
const expectedArchiveSha256 = '2b702bc178e88e1802506e1e7c4c5b78a07b86a4854b7918de3e040532723ea4'
const sampleTargets = { engineering: 800, holdout: 400 }
const port = 5203
const pageFile = 'research/pages/benchmark-menpo-front.html'
const pageUrl = `http://127.0.0.1:${port}/${pageFile}`
const chromeCandidates = [process.env.HEADUP_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const splitFor = (token) => createHash('sha256').update(token).digest()[0] < 205 ? 'engineering' : 'holdout'
const sampleRank = (token) => createHash('sha256').update(`headup-menpo-front-v1/${token}`).digest('hex')
const average = (points) => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length })
async function download(url, path) { await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', path, url], { maxBuffer: 2 * 1024 * 1024 }) }
async function findChrome() { for (const path of chromeCandidates) { try { await access(path, constants.X_OK); return path } catch { /* next */ } } throw new Error('No Chromium browser found; set HEADUP_CHROME') }
async function waitFor(check, timeoutMs, label) { const started = Date.now(); let lastError; while (Date.now() - started < timeoutMs) { try { const value = await check(); if (value) return value } catch (error) { lastError = error } await new Promise((resolve) => setTimeout(resolve, 250)) } throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`) }
function connectCdp(url) { const socket = new WebSocket(url); let nextId = 1; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (!message.id || !pending.has(message.id)) return; const handlers = pending.get(message.id); pending.delete(message.id); if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result) }); const ready = new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) }); return { ready, send(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) }) }, close() { socket.close() } } }
async function evaluate(cdp, expression) { const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed'); return response.result.value }
async function walk(root) { const output = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) output.push(...await walk(path)); else output.push(path) } return output }

function parsePts(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const countLine = lines.find((line) => line.startsWith('n_points'))
  if (!countLine) throw new Error('PTS annotation missing n_points')
  const expected = Number(countLine.split(':')[1])
  const start = lines.indexOf('{') + 1
  const end = lines.indexOf('}')
  const points = lines.slice(start, end).filter(Boolean).map((line) => {
    const [x, y] = line.split(/\s+/).map(Number)
    return { x: x - 1, y: y - 1 }
  })
  if (points.length !== expected || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error(`Invalid PTS annotation: expected ${expected}, got ${points.length}`)
  return points
}

function manualAnchors(points) {
  const [viewerLeftEyeCenter, viewerRightEyeCenter] = [average(points.slice(36, 42)), average(points.slice(42, 48))].sort((left, right) => left.x - right.x)
  const [viewerLeftMouthCorner, viewerRightMouthCorner] = [points[48], points[54]].sort((left, right) => left.x - right.x)
  const [viewerLeftCheek, viewerRightCheek] = [points[2], points[14]].sort((left, right) => left.x - right.x)
  const minimumX = Math.min(...points.map((point) => point.x)); const maximumX = Math.max(...points.map((point) => point.x))
  const minimumY = Math.min(...points.map((point) => point.y)); const maximumY = Math.max(...points.map((point) => point.y))
  return {
    bboxDiagonal: Math.max(1, Math.hypot(maximumX - minimumX, maximumY - minimumY)),
    interEyeDistance: Math.max(1, Math.hypot(viewerLeftEyeCenter.x - viewerRightEyeCenter.x, viewerLeftEyeCenter.y - viewerRightEyeCenter.y)),
    manual: { chin: points[8], viewerLeftEyeCenter, viewerRightEyeCenter, viewerLeftMouthCorner, viewerRightMouthCorner, noseTip: points[30], viewerLeftCheek, viewerRightCheek },
  }
}

async function prepareManifest(archiveSha256) {
  const files = await walk(extractDir)
  const imagesByStem = new Map()
  for (const path of files.filter((path) => ['.jpg', '.jpeg'].includes(extname(path).toLowerCase()))) {
    const stem = basename(path, extname(path)).toLowerCase()
    const existing = imagesByStem.get(stem) || []
    existing.push(path); imagesByStem.set(stem, existing)
  }
  const availableRecords = []
  const annotationCounts = {}
  for (const ptsPath of files.filter((path) => extname(path).toLowerCase() === '.pts').sort()) {
    const points = parsePts(await readFile(ptsPath, 'utf8'))
    annotationCounts[points.length] = (annotationCounts[points.length] || 0) + 1
    if (points.length !== 68) continue
    const stem = basename(ptsPath, extname(ptsPath)).toLowerCase()
    const candidates = (imagesByStem.get(stem) || []).filter((path) => path.toLowerCase().includes('semifrontal'))
    if (candidates.length !== 1) throw new Error(`Expected exactly one semi-frontal image match for a 68-point annotation; got ${candidates.length}`)
    const file = relative(extractDir, candidates[0]).replaceAll('\\', '/')
    const anchors = manualAnchors(points)
    availableRecords.push({ file, partition: splitFor(file.toLowerCase()), ...anchors })
  }
  if (availableRecords.length !== 6655 || annotationCounts[68] !== 6655 || annotationCounts[39] !== 2290) throw new Error(`Unexpected Menpo coverage: ${JSON.stringify({ records: availableRecords.length, annotationCounts })}`)
  const records = Object.entries(sampleTargets).flatMap(([partition, target]) => availableRecords
    .filter((record) => record.partition === partition)
    .sort((left, right) => sampleRank(left.file).localeCompare(sampleRank(right.file)))
    .slice(0, target))
  const partitionCounts = Object.fromEntries(Object.entries(Object.groupBy(records, (record) => record.partition)).map(([key, items]) => [key, items.length]))
  const manifest = {
    policyVersion: 'HEADUP-TRANSIENT-RESEARCH-DATA-1.0',
    source: { dataset: 'Menpo 2D Landmark Challenge training set', annotation: '68-point semi-frontal landmarks; official fixed package', archiveSha256, licenseScope: 'non-commercial research only' },
    selection: 'A predeclared deterministic SHA-256 rank selects 800 engineering and 400 holdout images from all 6,655 68-point semi-frontal annotations. No image content, result, or identifier semantics are used to choose samples or mappings.',
    availableImageCount: availableRecords.length,
    imageCount: records.length,
    partitionCounts,
    records,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
  return manifest
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe staging path')
if (!resultPath.startsWith(`${resolve(projectDir, 'data', 'face-benchmark')}\\`)) throw new Error('Result path must remain under data/face-benchmark')
if (cleanupOnly) {
  await rm(stagingDir, { recursive: true, force: true })
  process.stdout.write(`Removed transient benchmark staging: ${stagingDir}\n`)
  process.exit(0)
}
await access(resultPath).then(() => { throw new Error(`Refusing to overwrite existing result: ${resultPath}`) }, () => undefined)
await rm(stagingDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
const profileDir = await mkdtemp(join(tmpdir(), 'headup-menpo-front-'))
let vite; let chrome; let cdp; let viteError = ''
try {
  process.stdout.write('Downloading the fixed Menpo2D research archive...\n')
  await download(menpoUrl, archivePath)
  const archiveSha256 = digest(await readFile(archivePath))
  if (archiveSha256 !== expectedArchiveSha256) throw new Error(`Menpo archive checksum mismatch: ${archiveSha256}`)
  process.stdout.write(`Verified Menpo archive transport hash: ${archiveSha256}\n`)
  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 50 * 1024 * 1024 })
  const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe Menpo archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir], { maxBuffer: 5 * 1024 * 1024 })
  await rm(archivePath, { force: true })
  const manifest = await prepareManifest(archiveSha256)
  process.stdout.write(`Prepared ${manifest.imageCount} transient semi-frontal annotations: ${JSON.stringify(manifest.partitionCounts)}\n`)

  vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  vite.stderr.on('data', (chunk) => { viteError += chunk.toString() })
  await waitFor(async () => fetch(pageUrl).then((response) => response.ok), 30_000, `Vite at ${pageUrl}`)
  chrome = spawn(await findChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1280,900', pageUrl], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const activePort = await waitFor(async () => { const content = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8'); return Number(content.trim().split(/\r?\n/)[0]) || undefined }, 30_000, 'Chromium DevTools port')
  const page = await waitFor(async () => { const targets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json()); return targets.find((target) => target.type === 'page' && target.url.includes(pageFile)) }, 30_000, 'Menpo front benchmark page')
  cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.ready
  let previousStatus = ''
  await waitFor(async () => {
    const pageError = await evaluate(cdp, `document.querySelector('#result')?.dataset.error || ''`); if (pageError) throw new Error(pageError)
    const pageStatus = await evaluate(cdp, `document.querySelector('#status')?.textContent || ''`)
    const processed = /^处理 (\d+) \/ (\d+)$/.exec(pageStatus)
    if (pageStatus !== previousStatus && (pageStatus === '完成' || (processed && (Number(processed[1]) === 1 || Number(processed[1]) % 100 === 0 || processed[1] === processed[2])))) { process.stdout.write(`${pageStatus}\n`); previousStatus = pageStatus }
    return pageStatus === '完成' ? true : undefined
  }, 90 * 60_000, 'Menpo front ground-truth benchmark completion')
  const result = JSON.parse(await evaluate(cdp, `document.querySelector('#result')?.textContent || ''`))
  if (result.analysisPolicyVersion !== 'HEADUP-MENPO-FRONT-GROUNDTRUTH-1.0' || result.images !== 1200) throw new Error('Unexpected Menpo front benchmark result')
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ resultPath, images: result.images, partitions: result.partitions, captureGate: result.overall.captureGate, holdoutLandmarkError: result.byPartition.holdout.landmarkError }, null, 2)}\n`)
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
