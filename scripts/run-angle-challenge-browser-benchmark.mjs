import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'angle-challenge-result.json')
const manifestPath = join(projectDir, 'data', 'face-benchmark', '.staging', 'angle-challenge', 'manifest.json')
const port = 5197
const pageFile = 'research/pages/benchmark-angle-challenge.html'
const pageUrl = `http://127.0.0.1:${port}/${pageFile}`
const chromeCandidates = [process.env.HEADUP_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)
async function findChrome() { for (const path of chromeCandidates) { try { await access(path, constants.X_OK); return path } catch { /* next */ } } throw new Error('No Chromium browser found; set HEADUP_CHROME') }
async function waitFor(check, timeoutMs, label) { const started = Date.now(); let lastError; while (Date.now() - started < timeoutMs) { try { const value = await check(); if (value) return value } catch (error) { lastError = error } await new Promise((resolve) => setTimeout(resolve, 250)) } throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`) }
function connectCdp(url) { const socket = new WebSocket(url); let nextId = 1; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (!message.id || !pending.has(message.id)) return; const handlers = pending.get(message.id); pending.delete(message.id); if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result) }); const ready = new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) }); return { ready, send(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) }) }, close() { socket.close() } } }
async function evaluate(cdp, expression) { const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed'); return response.result.value }

await access(manifestPath)
await access(resultPath).then(() => { throw new Error(`Refusing to overwrite existing result: ${resultPath}`) }, () => undefined)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const profileDir = await mkdtemp(join(tmpdir(), 'headup-angle-challenge-'))
const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let viteError = ''; vite.stderr.on('data', (chunk) => { viteError += chunk.toString() })
let chrome; let cdp
try {
  await waitFor(async () => fetch(pageUrl).then((response) => response.ok), 30_000, `Vite at ${pageUrl}`)
  chrome = spawn(await findChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1280,900', pageUrl], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const activePort = await waitFor(async () => { const content = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8'); return Number(content.trim().split(/\r?\n/)[0]) || undefined }, 30_000, 'Chromium DevTools port')
  const page = await waitFor(async () => { const targets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json()); return targets.find((target) => target.type === 'page' && target.url.includes(pageFile)) }, 30_000, 'benchmark page')
  cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.ready
  let previousStatus = ''
  const finalStatus = await waitFor(async () => {
    const pageError = await evaluate(cdp, `document.querySelector('#result')?.dataset.error || ''`); if (pageError) throw new Error(pageError)
    const pageStatus = await evaluate(cdp, `document.querySelector('#status')?.textContent || ''`)
    if (pageStatus !== previousStatus && (/\d+ \/ \d+/.test(pageStatus) || pageStatus.startsWith('完成'))) { process.stdout.write(`${pageStatus}\n`); previousStatus = pageStatus }
    return pageStatus.startsWith('完成') ? pageStatus : undefined
  }, 20 * 60_000, 'angle-challenge benchmark completion')
  const result = JSON.parse(await evaluate(cdp, `document.querySelector('#result')?.textContent || ''`))
  if (result.policyVersion !== 'HEADUP-ANGLE-CHALLENGE-AUDIT-1.0') throw new Error('Unexpected result policy')
  if (result.selection.realPortraits !== manifest.expectedImages || result.selection.subjects !== 15) throw new Error('Unexpected evaluated coverage')
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ resultPath, current: result.currentTwoOrderChallengeAdaptiveInjection, candidate: { specs: result.higherEntropyAngleCandidate.specs, smoothTrials: result.higherEntropyAngleCandidate.smoothTrials, smoothPassed: result.higherEntropyAngleCandidate.smoothPassed, smoothAttackFalseAcceptRate: result.higherEntropyAngleCandidate.smoothAttackFalseAcceptRate, abruptTrials: result.higherEntropyAngleCandidate.abruptTrials, abruptPassed: result.higherEntropyAngleCandidate.abruptPassed, abruptAttackFalseAcceptRate: result.higherEntropyAngleCandidate.abruptAttackFalseAcceptRate, smoothFailures: result.higherEntropyAngleCandidate.smoothFailures } }, null, 2)}\n`)
} catch (error) { if (vite.exitCode !== null && vite.exitCode !== 0) process.stderr.write(viteError); throw error }
finally { if (cdp) { try { await cdp.send('Browser.close') } catch { /* closed */ } cdp.close() } if (chrome && chrome.exitCode === null) chrome.kill(); if (vite.exitCode === null) vite.kill(); await new Promise((resolve) => setTimeout(resolve, 500)); await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) }
