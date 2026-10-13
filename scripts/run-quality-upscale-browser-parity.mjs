import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'quality-upscale-browser-parity-result.json')
const pageFile = 'benchmark-quality-upscale-browser.html'
const port = 5193
const pageUrl = `http://127.0.0.1:${port}/${pageFile}`
const chromeCandidates = [
  process.env.HEADUP_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

async function findChrome() {
  for (const path of chromeCandidates) { try { await access(path); return path } catch { /* next */ } }
  throw new Error('No Chromium browser found')
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try { const value = await check(); if (value) return value } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function connectCdp(url) {
  const socket = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id || !pending.has(message.id)) return
    const item = pending.get(message.id); pending.delete(message.id)
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true })
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
    },
    close() { socket.close() },
  }
}

const chromePath = await findChrome()
const profileDir = await mkdtemp(join(tmpdir(), 'headup-upscale-browser-'))
const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: 'ignore', windowsHide: true })
let chrome
let cdp
try {
  await waitFor(() => fetch(pageUrl).then((response) => response.ok), 30_000, 'Vite page')
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, pageUrl], { stdio: 'ignore', windowsHide: true })
  const portFile = join(profileDir, 'DevToolsActivePort')
  const activePort = await waitFor(async () => Number((await readFile(portFile, 'utf8')).split(/\r?\n/)[0]) || undefined, 30_000, 'DevTools port')
  const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json())).find((item) => item.type === 'page' && item.url.includes(pageFile)), 30_000, 'benchmark tab')
  cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.ready
  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'browser evaluation failed')
    return response.result.value
  }
  await waitFor(async () => {
    const error = await evaluate(`document.querySelector('#result')?.dataset.error || ''`)
    if (error) throw new Error(error)
    return (await evaluate(`document.querySelector('#status')?.textContent || ''`)) === '完成'
  }, 60_000, 'browser parity completion')
  const result = JSON.parse(await evaluate(`document.querySelector('#result').textContent`))
  if (result.policyVersion !== 'HEADUP-QUALITY-UPSCALE-BROWSER-PARITY-1.0' || !result.passes) throw new Error(`Browser parity gates failed: ${JSON.stringify(result.gates)}`)
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ resultPath, gates: result.gates, nearestQuality: result.nearestQuality, nativeQuality: result.nativeQuality }, null, 2)}\n`)
} finally {
  if (cdp) { try { await cdp.send('Browser.close') } catch { /* closed */ }; cdp.close() }
  if (chrome?.exitCode === null) chrome.kill()
  if (vite.exitCode === null) vite.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}
