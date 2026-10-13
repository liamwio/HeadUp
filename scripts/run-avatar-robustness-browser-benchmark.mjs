import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const sourceName = process.argv.find((argument) => argument.startsWith('--source='))?.split('=')[1] || 'ffhq'
if (!['ffhq', 'london'].includes(sourceName)) throw new Error(`Unsupported source: ${sourceName}`)
const isFfhq = sourceName === 'ffhq'
const avatarRoot = join(projectDir, 'data', 'face-db-real-research', 'avatar-smoke', 'ffhq-highres')
const imageDir = join(avatarRoot, 'images')
const resultPath = isFfhq
  ? join(avatarRoot, 'avatar-robustness-result.json')
  : join(projectDir, 'data', 'face-db-real-research', 'avatar-smoke', 'london-independent-lip-confirmation.json')
const screenshotPath = join(projectDir, 'docs', 'assets', isFfhq ? 'avatar-smoke-ffhq-robustness.png' : 'avatar-smoke-london-lip-confirmation.png')
const pageFile = 'benchmark-avatar-robustness.html'
const port = isFfhq ? 5211 : 5212
const pageUrl = `http://127.0.0.1:${port}/${pageFile}?source=${sourceName}`
const expectedCandidates = isFfhq ? 60 : 102
const chromeCandidates = [process.env.HEADUP_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)

async function findChrome() {
  for (const path of chromeCandidates) { try { await access(path, constants.X_OK); return path } catch { /* next */ } }
  throw new Error('No Chromium browser found')
}
async function waitFor(check, timeoutMs, label) {
  const started = Date.now(); let lastError
  while (Date.now() - started < timeoutMs) {
    try { const value = await check(); if (value) return value } catch (error) { lastError = error }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}
function connectCdp(url) {
  const socket = new WebSocket(url); let nextId = 1; const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)); if (!message.id || !pending.has(message.id)) return
    const handlers = pending.get(message.id); pending.delete(message.id)
    message.error ? handlers.reject(new Error(message.error.message)) : handlers.resolve(message.result)
  })
  const ready = new Promise((resolveReady, reject) => { socket.addEventListener('open', resolveReady, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  return { ready, send(method, params = {}) { const id = nextId++; return new Promise((resolveSend, reject) => { pending.set(id, { resolve: resolveSend, reject }); socket.send(JSON.stringify({ id, method, params })) }) }, close() { socket.close() } }
}
async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed')
  return response.result.value
}

if (isFfhq) {
  const cleanupRelative = relative(resolve(avatarRoot), resolve(imageDir))
  if (cleanupRelative !== 'images' || cleanupRelative.startsWith('..') || isAbsolute(cleanupRelative)) throw new Error(`Unsafe cleanup path: ${imageDir}`)
  await access(join(avatarRoot, 'manifest.jsonl')); await access(imageDir)
} else {
  await access(join(projectDir, 'data', 'face-db-real-research', 'manifest.jsonl'))
}
await mkdir(join(projectDir, 'data', 'face-db-real-research', 'avatar-smoke'), { recursive: true })
const profileDir = await mkdtemp(join(tmpdir(), `headup-${sourceName}-robustness-`))
const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let chrome; let cdp; let complete = false
try {
  await waitFor(() => fetch(pageUrl).then((response) => response.ok), 30_000, 'Vite')
  chrome = spawn(await findChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1440,2400', pageUrl], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const activePort = await waitFor(async () => Number((await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)[0]) || undefined, 30_000, 'DevTools')
  const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json())).find((target) => target.type === 'page' && target.url.includes(pageFile)), 30_000, 'page')
  cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.ready
  let lastStatus = ''
  await waitFor(async () => {
    const error = await evaluate(cdp, `document.querySelector('#result')?.dataset.error || ''`); if (error) throw new Error(error)
    const status = await evaluate(cdp, `document.querySelector('#status')?.textContent || ''`)
    if (status && status !== lastStatus) { process.stdout.write(`${status}\n`); lastStatus = status }
    return status.startsWith('完成') ? true : undefined
  }, 30 * 60_000, `${sourceName} robustness completion`)
  const result = await evaluate(cdp, 'window.__HEADUP_AVATAR_ROBUSTNESS__')
  if (result?.policyVersion !== 'HEADUP-AVATAR-ROBUSTNESS-1.2' || result.sourceName !== sourceName || result.sourceCandidates !== expectedCandidates) throw new Error('Unexpected robustness result')
  await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  if (isFfhq) {
    await rm(imageDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
    try { await access(imageDir); throw new Error('Cleanup failed') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    result.retention = { rawImagesPersistedAfterRun: false, cleanupPending: false, cleanupVerified: true, transformedImagesWritten: false, screenshotContainsSourcePhotos: true }
  } else {
    result.retention = { sourceImagesPreexistingAuthorizedDatabase: true, newImagesDownloaded: false, transformedImagesWritten: false, cleanupPending: false, screenshotContainsSourcePhotos: true }
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  complete = true
  process.stdout.write(`${JSON.stringify({ resultPath, screenshotPath, sourceName, baselineSelected: result.baselineSelected, overall: result.overall, recommendedLipCandidate: result.recommendedLipCandidate, independentConfirmation: result.independentConfirmation, ensembleRuntimeMs: result.ensembleRuntimeMs, cleanupVerified: isFfhq ? true : 'not_applicable' }, null, 2)}\n`)
} finally {
  if (cdp) { try { await cdp.send('Browser.close') } catch { /* closed */ }; cdp.close() }
  if (chrome?.exitCode === null) chrome.kill(); if (vite.exitCode === null) vite.kill()
  await new Promise((resolveWait) => setTimeout(resolveWait, 400)); await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  if (!complete && isFfhq) process.stderr.write('测试未完成，FFHQ原图保留供诊断；完成后运行 pnpm data:avatar:cleanup。\n')
}
