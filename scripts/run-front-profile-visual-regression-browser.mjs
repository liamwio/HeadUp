import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'front-profile-visual-result.json')
const screenshotPath = join(projectDir, 'docs', 'assets', 'front-profile-aesthetic-regression.png')
const port = 5218
const pageFile = 'front-profile-visual-regression.html'
const pageUrl = `http://127.0.0.1:${port}/${pageFile}`
const chromeCandidates = [process.env.HEADUP_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)

async function findChrome() { for (const path of chromeCandidates) { try { await access(path, constants.X_OK); return path } catch { /* next */ } } throw new Error('No Chromium browser found; set HEADUP_CHROME') }
async function waitFor(check, timeoutMs, label) { const started = Date.now(); let lastError; while (Date.now() - started < timeoutMs) { try { const value = await check(); if (value) return value } catch (error) { lastError = error } await new Promise((resolve) => setTimeout(resolve, 250)) } throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`) }
function connectCdp(url) { const socket = new WebSocket(url); let nextId = 1; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (!message.id || !pending.has(message.id)) return; const handlers = pending.get(message.id); pending.delete(message.id); if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result) }); const ready = new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) }); return { ready, send(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) }) }, close() { socket.close() } } }
async function evaluate(cdp, expression) { const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed'); return response.result.value }

const profileDir = await mkdtemp(join(tmpdir(), 'headup-front-profile-visual-'))
const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let viteError = ''; vite.stderr.on('data', (chunk) => { viteError += chunk.toString() })
let chrome; let cdp
try {
  await waitFor(() => fetch(pageUrl).then((response) => response.ok), 30_000, 'Vite')
  chrome = spawn(await findChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1440,1600', pageUrl], { stdio: 'ignore', windowsHide: true })
  const activePort = await waitFor(async () => Number((await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)[0]) || undefined, 30_000, 'Chromium DevTools port')
  const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json())).find((item) => item.type === 'page' && item.url.includes(pageFile)), 30_000, 'visual regression page')
  cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.ready
  let lastStatus = ''
  await waitFor(async () => { const status = await evaluate(cdp, `document.querySelector('#status')?.textContent || ''`); if (status && status !== lastStatus) { process.stdout.write(`${status}\n`); lastStatus = status } return status.startsWith('分析完成') }, 8 * 60_000, 'front/profile visual regression completion')
  const result = await evaluate(cdp, 'window.__HEADUP_FRONT_PROFILE_VISUAL_RESULT__')
  if (result?.policyVersion !== 'HEADUP-FRONT-PROFILE-VISUAL-RESULT-1.9' || result?.summary?.total !== 24 || result?.byView?.front?.frontReferenceMapped9 !== 8 || result?.byView?.right_profile?.nativeConfidenceSummaries8of9 !== 8 || Object.keys(result?.cases?.find(item => item.view === 'right_profile')?.nativeConfidenceByCode || {}).length !== 9 || result?.byView?.right_profile?.nativeAestheticRegions5 !== 8 || result?.byView?.right_profile?.nativeProfileNeckPaths1 !== 8 || result?.frontReferenceContract?.midfaceExclusion?.includes('point 168') !== true || result?.frontReferenceContract?.lipHeightExclusion?.includes('double median') !== true || result?.visualContract?.neckContourRendered !== true || result?.visualContract?.neckAestheticDirectionEnabled !== false || result?.visualContract?.researchPointOrderContourRendered !== false || result?.visualContract?.repeatabilityBandsRendered !== true || result?.visualContract?.repeatabilityBandsAreManualTruth !== false || result?.visualContract?.repeatabilityBandsAreConfidenceIntervals !== false) throw new Error('Unexpected front/profile visual result')
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  await cdp.send('Runtime.evaluate', { expression: `document.querySelector('[data-filter="profile"]')?.click();window.scrollTo(0,300)` })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  process.stdout.write(`${JSON.stringify({ resultPath, screenshotPath, summary: result.summary, byView: result.byView }, null, 2)}\n`)
} catch (error) { if (vite.exitCode !== null && vite.exitCode !== 0) process.stderr.write(viteError); throw error }
finally { if (cdp) { try { await cdp.send('Browser.close') } catch { /* closed */ } cdp.close() } if (chrome?.exitCode === null) chrome.kill(); if (vite.exitCode === null) vite.kill(); await new Promise((resolve) => setTimeout(resolve, 400)); await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
