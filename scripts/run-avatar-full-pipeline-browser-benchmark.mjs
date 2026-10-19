import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const datasetId = process.argv.find((argument) => argument.startsWith('--dataset='))?.split('=')[1] || 'nasa-highres'
if (!/^[a-z0-9-]+$/.test(datasetId)) throw new Error(`Invalid dataset id: ${datasetId}`)
const avatarRoot = join(projectDir, 'data', 'face-db-real-research', 'avatar-smoke', datasetId)
const imageDir = join(avatarRoot, 'images')
const resultPath = join(avatarRoot, `avatar-full-pipeline-${datasetId}.json`)
const screenshotPath = join(projectDir, 'docs', 'assets', `avatar-smoke-${datasetId}-full-pipeline.png`)
const pageFile = 'research/pages/benchmark-avatar-full-pipeline.html'
const port = 5210
const pageUrl = `http://127.0.0.1:${port}/${pageFile}?dataset=${encodeURIComponent(datasetId)}`
const chromeCandidates = [process.env.HEADUP_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)

async function findChrome() { for (const path of chromeCandidates) { try { await access(path, constants.X_OK); return path } catch { /* next */ } } throw new Error('No Chromium browser found; set HEADUP_CHROME') }
async function waitFor(check, timeoutMs, label) { const start = Date.now(); let last; while (Date.now() - start < timeoutMs) { try { const value = await check(); if (value) return value } catch (error) { last = error } await new Promise((resolveWait) => setTimeout(resolveWait, 250)) } throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`) }
function connectCdp(url) { const socket = new WebSocket(url); let id = 1; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (!message.id || !pending.has(message.id)) return; const handlers = pending.get(message.id); pending.delete(message.id); message.error ? handlers.reject(new Error(message.error.message)) : handlers.resolve(message.result) }); const ready = new Promise((resolveReady, reject) => { socket.addEventListener('open', resolveReady, { once: true }); socket.addEventListener('error', reject, { once: true }) }); return { ready, send(method, params = {}) { const current = id++; return new Promise((resolveSend, reject) => { pending.set(current, { resolve: resolveSend, reject }); socket.send(JSON.stringify({ id: current, method, params })) }) }, close() { socket.close() } } }
async function evaluate(cdp, expression) { const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed'); return response.result.value }

const cleanupRelativePath = relative(resolve(avatarRoot), resolve(imageDir))
if (cleanupRelativePath !== 'images' || cleanupRelativePath.startsWith('..') || isAbsolute(cleanupRelativePath)) throw new Error(`Unsafe image cleanup path: ${imageDir}`)
await access(join(avatarRoot, 'manifest.jsonl'))
await access(imageDir)
const expectedCases = (await readFile(join(avatarRoot, 'manifest.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).length
const profileDir = await mkdtemp(join(tmpdir(), 'headup-avatar-full-'))
const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let viteError = ''; vite.stderr.on('data', (chunk) => { viteError += chunk.toString() })
let chrome; let cdp; let completed = false
try {
  await waitFor(() => fetch(pageUrl).then((response) => response.ok), 30_000, 'Vite')
  chrome = spawn(await findChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1440,1900', pageUrl], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const activePort = await waitFor(async () => Number((await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)[0]) || undefined, 30_000, 'Chromium DevTools port')
  const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json())).find((target) => target.type === 'page' && target.url.includes(pageFile)), 30_000, 'benchmark page')
  cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.ready
  let last = ''
  await waitFor(async () => { const pageStatus = await evaluate(cdp, `document.querySelector('#status')?.textContent || ''`); if (pageStatus && pageStatus !== last) { process.stdout.write(`${pageStatus}\n`); last = pageStatus } return pageStatus.startsWith('完成') ? true : undefined }, 8 * 60_000, 'avatar full pipeline')
  const result = await evaluate(cdp, 'window.__HEADUP_AVATAR_FULL_PIPELINE__')
  if (result?.policyVersion !== 'HEADUP-AVATAR-FULL-PIPELINE-1.1' || result.datasetId !== datasetId || result.caseCount !== expectedCases || !Array.isArray(result.cases) || result.cases.length !== expectedCases) throw new Error('Unexpected avatar full-pipeline result')
  await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  await rm(imageDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  try { await access(imageDir); throw new Error('Raw image cleanup verification failed') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  result.retention = { rawImagesPersistedAfterRun: false, cleanupPending: false, cleanupVerified: true, screenshotContainsSourcePhotos: true }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  completed = true
  process.stdout.write(`${JSON.stringify({ resultPath, screenshotPath, qualityPassed: result.qualityPassed, fullPipelinePassed: result.fullPipelinePassed, fullPipelineRejected: result.fullPipelineRejected, measured: result.measured, interpretation: result.interpretation, cleanupVerified: true }, null, 2)}\n`)
} catch (error) { if (vite.exitCode !== null && vite.exitCode !== 0) process.stderr.write(viteError); throw error }
finally { if (cdp) { try { await cdp.send('Browser.close') } catch { /* closed */ } cdp.close() } if (chrome?.exitCode === null) chrome.kill(); if (vite.exitCode === null) vite.kill(); await new Promise((resolveWait) => setTimeout(resolveWait, 400)); await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); if (!completed) process.stderr.write('原图未自动清理：测试未完成，请复核后运行清理。\n') }
