import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const v2 = process.argv.includes('--v2')
const resultPath = join(projectDir, 'data', 'face-benchmark', v2 ? 'celeba-expression-v2-result.json' : 'celeba-expression-result.json')
const manifestPath = join(projectDir, 'data', 'face-benchmark', '.staging', 'celeba-expression', 'manifest.json')
const port = 5190
const pageFile = 'benchmark-celeba-expression.html'
const pageUrl = `http://127.0.0.1:${port}/${pageFile}${v2 ? '?policy=v2' : ''}`
const chromeCandidates = [
  process.env.HEADUP_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

async function findChrome() {
  for (const path of chromeCandidates) {
    try {
      await access(path, constants.X_OK)
      return path
    } catch { /* try next browser */ }
  }
  throw new Error('No Chromium browser found; set HEADUP_CHROME to an executable path')
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
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
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { socket.close() },
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed')
  return response.result.value
}

await access(manifestPath)
await access(resultPath).then(
  () => { throw new Error(`Refusing to overwrite existing result: ${resultPath}`) },
  () => undefined,
)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const expectedInputs = manifest.records.length + manifest.authorizedNeutralRecords.length
const chromePath = await findChrome()
const profileDir = await mkdtemp(join(tmpdir(), 'headup-celeba-expression-'))
const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: projectDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let viteError = ''
vite.stderr.on('data', (chunk) => { viteError += chunk.toString() })
let chrome
let cdp

try {
  await waitFor(async () => fetch(pageUrl).then((response) => response.ok), 30_000, `Vite at ${pageUrl}`)
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1280,900', pageUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const devToolsPortPath = join(profileDir, 'DevToolsActivePort')
  const activePort = await waitFor(async () => {
    const content = await readFile(devToolsPortPath, 'utf8')
    return Number(content.trim().split(/\r?\n/)[0]) || undefined
  }, 30_000, 'Chromium DevTools port')
  const page = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json())
    return targets.find((target) => target.type === 'page' && target.url.includes(pageFile))
  }, 30_000, 'benchmark browser page')
  cdp = connectCdp(page.webSocketDebuggerUrl)
  await cdp.ready
  let previousStatus = ''
  const finalStatus = await waitFor(async () => {
    const pageError = await evaluate(cdp, `document.querySelector('#result')?.dataset.error || ''`)
    if (pageError) throw new Error(pageError)
    const pageStatus = await evaluate(cdp, `document.querySelector('#status')?.textContent || ''`)
    if (pageStatus !== previousStatus && (/\d+ \/ \d+/.test(pageStatus) || pageStatus.startsWith('完成'))) {
      process.stdout.write(`${pageStatus}\n`)
      previousStatus = pageStatus
    }
    return pageStatus.startsWith('完成') ? pageStatus : undefined
  }, 12 * 60_000, 'CelebA expression benchmark completion')
  if (!finalStatus.startsWith('完成')) throw new Error(`Unexpected final status: ${finalStatus}`)
  const serialized = await evaluate(cdp, `document.querySelector('#result')?.textContent || ''`)
  const result = JSON.parse(serialized)
  const expectedPolicy = v2 ? 'HEADUP-CELEBA-EXPRESSION-AUDIT-2.0' : 'HEADUP-CELEBA-EXPRESSION-AUDIT-1.0'
  if (result.policyVersion !== expectedPolicy) throw new Error('Unexpected result policy version')
  const evaluatedInputs = result.evaluation.celebaEngineering.images + result.evaluation.celebaHoldout.images
    + result.evaluation.authorizedNeutralEngineering.images + result.evaluation.authorizedNeutralHoldout.images
  if (evaluatedInputs !== expectedInputs) throw new Error(`Unexpected evaluated input count: ${evaluatedInputs}/${expectedInputs}`)
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({
    resultPath,
    inputs: evaluatedInputs,
    thresholds: result.method.thresholds,
    holdout: result.evaluation.celebaHoldout,
    authorizedNeutralHoldout: result.evaluation.authorizedNeutralHoldout,
  }, null, 2)}\n`)
} catch (error) {
  if (vite.exitCode !== null && vite.exitCode !== 0) process.stderr.write(viteError)
  throw error
} finally {
  if (cdp) {
    try { await cdp.send('Browser.close') } catch { /* browser may already be closed */ }
    cdp.close()
  }
  if (chrome && chrome.exitCode === null) chrome.kill()
  if (vite.exitCode === null) vite.kill()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}
