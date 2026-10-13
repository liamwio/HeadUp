import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const vitePath = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'active-challenge-fake-camera-result.json')
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'active-challenge-fake-camera')
const londonDir = join(projectDir, 'data', 'face-db-real-research', 'images', 'face-research-lab-london-v5')
const port = 5199
const pageUrl = `http://127.0.0.1:${port}/research-active-challenge.html`
const chromeCandidates = [process.env.HEADUP_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)
const width = 640; const height = 480; const fps = 10; const framesPerPose = 10

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe fake-camera staging path')

async function findChrome() { for (const path of chromeCandidates) { try { await access(path, constants.X_OK); return path } catch { /* next */ } } throw new Error('No Chromium browser found; set HEADUP_CHROME') }
async function waitFor(check, timeoutMs, label) { const started = Date.now(); let lastError; while (Date.now() - started < timeoutMs) { try { const value = await check(); if (value) return value } catch (error) { lastError = error } await new Promise((resolve) => setTimeout(resolve, 100)) } throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`) }
function connectCdp(url, onEvent = () => undefined) { const socket = new WebSocket(url); let nextId = 1; const pending = new Map(); socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (!message.id) { onEvent(message); return } if (!pending.has(message.id)) return; const handlers = pending.get(message.id); pending.delete(message.id); if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result) }); const ready = new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) }); return { ready, send(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) }) }, close() { socket.close() } } }
async function evaluate(cdp, expression) { const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Browser evaluation failed'); return response.result.value }

function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))) }

async function imageToYuv420(path) {
  const { data, info } = await sharp(path).resize(width, height, { fit: 'cover', position: 'centre' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== width || info.height !== height || info.channels !== 3) throw new Error(`Unexpected RGB frame shape for ${path}`)
  const y = Buffer.alloc(width * height); const u = Buffer.alloc(width * height / 4); const v = Buffer.alloc(width * height / 4)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const source = (row * width + column) * 3; const r = data[source]; const g = data[source + 1]; const b = data[source + 2]
      y[row * width + column] = clampByte(0.257 * r + 0.504 * g + 0.098 * b + 16)
    }
  }
  for (let row = 0; row < height; row += 2) {
    for (let column = 0; column < width; column += 2) {
      let uSum = 0; let vSum = 0
      for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
        const source = ((row + dy) * width + column + dx) * 3; const r = data[source]; const g = data[source + 1]; const b = data[source + 2]
        uSum += -0.148 * r - 0.291 * g + 0.439 * b + 128; vSum += 0.439 * r - 0.368 * g - 0.071 * b + 128
      }
      const index = row / 2 * (width / 2) + column / 2; u[index] = clampByte(uSum / 4); v[index] = clampByte(vSum / 4)
    }
  }
  return Buffer.concat([y, u, v])
}

async function makeFakeCameraVideo(subjectId, outputPath) {
  const frames = {
    center: await imageToYuv420(join(londonDir, `${subjectId}_front.jpg`)),
    positive: await imageToYuv420(join(londonDir, `${subjectId}_left_profile.jpg`)),
    negative: await imageToYuv420(join(londonDir, `${subjectId}_right_profile.jpg`)),
  }
  const sequence = ['center', 'positive', 'center', 'negative', 'center', 'positive', 'center', 'negative', 'center']
  const handle = await open(outputPath, 'w')
  try {
    await handle.write(Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`, 'ascii'))
    for (const pose of sequence) for (let repeat = 0; repeat < framesPerPose; repeat += 1) {
      await handle.write(Buffer.from('FRAME\n', 'ascii')); await handle.write(frames[pose])
    }
  } finally { await handle.close() }
}

function normalizeFailure(text) {
  if (text.includes('无法启动摄像头')) return 'fake_camera_start_failed'
  if (text.includes('当前动作没有在规定时间内完成')) return 'step_timeout'
  if (text.includes('20 秒')) return 'overall_timeout'
  if (text.includes('设备分析速度不足')) return 'frame_gap_or_device_slow'
  if (text.includes('摄像头时间戳异常')) return 'frame_time_error'
  if (text.includes('本地分析失败')) return 'local_analysis_error'
  return 'other_failure'
}

await access(resultPath).then(() => { throw new Error(`Refusing to overwrite existing result: ${resultPath}`) }, () => undefined)
await rm(stagingDir, { recursive: true, force: true }); await (await import('node:fs/promises')).mkdir(stagingDir, { recursive: true })
const londonSubjects = (await readdir(londonDir)).map((name) => /^(\d+)_front\.jpg$/i.exec(name)?.[1]).filter(Boolean).sort((a, b) => Number(a) - Number(b)).slice(0, 5)
if (londonSubjects.length !== 5) throw new Error('Unable to select five authorized London subjects')
const chromePath = await findChrome(); const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let viteError = ''; vite.stderr.on('data', (chunk) => { viteError += chunk.toString() })
const trials = []; let temporaryBytes = 0
try {
  await waitFor(async () => fetch(pageUrl).then((response) => response.ok), 30_000, `Vite at ${pageUrl}`)
  for (const [subjectIndex, subjectId] of londonSubjects.entries()) {
    const videoPath = join(stagingDir, `virtual-camera-${subjectIndex + 1}.y4m`)
    const profileDir = await mkdtemp(join(tmpdir(), `headup-fake-camera-${subjectIndex + 1}-`))
    await makeFakeCameraVideo(subjectId, videoPath); temporaryBytes += (await (await import('node:fs/promises')).stat(videoPath)).size
    let chrome; let cdp; let chromeError = ''
    try {
      chrome = spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${videoPath}`,
        '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=800,900', pageUrl,
      ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      chrome.stderr.on('data', (chunk) => { chromeError += chunk.toString() })
      const activePort = await waitFor(async () => { const content = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8'); return Number(content.trim().split(/\r?\n/)[0]) || undefined }, 30_000, 'Chromium DevTools port')
      const page = await waitFor(async () => { const targets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json()); return targets.find((target) => target.type === 'page' && target.url.includes('research-active-challenge.html')) }, 30_000, 'fake-camera research page')
      cdp = connectCdp(page.webSocketDebuggerUrl, (message) => {
        if (message.method === 'Runtime.exceptionThrown') process.stderr.write(`Browser exception: ${JSON.stringify(message.params.exceptionDetails)}\n`)
        if (message.method === 'Runtime.consoleAPICalled') process.stderr.write(`Browser console ${message.params.type}: ${message.params.args.map((item) => item.value ?? item.description ?? '').join(' ')}\n`)
      }); await cdp.ready
      await cdp.send('Runtime.enable')
      await waitFor(async () => evaluate(cdp, `document.querySelector('#start')?.dataset.challengeReady === 'true'`), 30_000, 'active-challenge script initialization')
      for (let repeat = 0; repeat < 3; repeat += 1) {
        await evaluate(cdp, `document.querySelector('#start').click(); true`)
        let observedOrder = null
        let lastStatus = ''
        const outcome = await waitFor(async () => {
          const state = await evaluate(cdp, `({prompt:document.querySelector('#prompt')?.textContent||'',status:document.querySelector('#status')?.textContent||'',className:document.querySelector('#status')?.className||''})`)
          if (state.status !== lastStatus) { process.stdout.write(`  page: ${state.status.replaceAll('\n', ' | ')}\n`); lastStatus = state.status }
          if (!observedOrder && state.prompt.startsWith('2 / 5')) observedOrder = state.prompt.includes('屏幕左侧') ? 'positive_first' : state.prompt.includes('屏幕右侧') ? 'negative_first' : null
          if (state.className.includes('pass')) return { passed: true, status: state.status }
          if (state.className.includes('reject')) return { passed: false, status: state.status }
          if (state.status.includes('无法启动摄像头')) return { passed: false, status: state.status }
          return undefined
        }, 35_000, `fake-camera trial ${subjectIndex + 1}.${repeat + 1}`)
        trials.push({ passed: outcome.passed, observedOrder, failure: outcome.passed ? null : normalizeFailure(outcome.status) })
        process.stdout.write(`Virtual-camera trial ${trials.length}/15: ${outcome.passed ? 'attack accepted' : `blocked (${trials.at(-1).failure})`}\n`)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    } finally {
      if (chromeError) process.stderr.write(`Chromium stderr (subject ${subjectId}):\n${chromeError}\n`)
      if (cdp) { try { await cdp.send('Browser.close') } catch { /* closed */ } cdp.close() }
      if (chrome && chrome.exitCode === null) chrome.kill()
      await new Promise((resolve) => setTimeout(resolve, 300)); await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); await rm(videoPath, { force: true })
    }
  }
  const failures = Object.fromEntries(Object.entries(Object.groupBy(trials.filter((trial) => !trial.passed), (trial) => trial.failure)).map(([key, values]) => [key, values.length]))
  const orders = Object.fromEntries(Object.entries(Object.groupBy(trials, (trial) => trial.observedOrder ?? 'not_observed')).map(([key, values]) => [key, values.length]))
  const passed = trials.filter((trial) => trial.passed).length
  const result = {
    testedAt: new Date().toISOString(), policyVersion: 'HEADUP-ACTIVE-CHALLENGE-FAKE-CAMERA-AUDIT-1.0',
    attack: 'Chromium virtual camera fed by generated Y4M sequence of authorized real front/left/right portraits',
    source: { authorizedSubjects: londonSubjects.length, sourceImagesChanged: false, demographicAttributesUsed: false },
    stream: { width, height, fps, secondsPerPose: framesPerPose / fps, sequence: 'center, positive, center, negative, center, positive, center, negative, center', temporaryY4mBytes: temporaryBytes },
    trials: trials.length, passedAttacks: passed, blockedAttacks: trials.length - passed,
    attackFalseAcceptRate: Number((passed / trials.length).toFixed(4)), observedOrders: orders, failureReasons: failures,
    interpretation: 'Every pass is a virtual-camera injection false accept. Browser getUserMedia and a randomized pose order do not establish sensor provenance.',
    limitations: ['Chromium fake-device injection is a controlled browser test, not every OS-level virtual camera or native mobile injection path.', 'Only five authorized studio subjects and a repeated abrupt-pose sequence were used.'],
    retention: { y4mDeletedAfterEachSubject: true, sourceImagesChanged: false, framesRetained: false, perTrialSubjectMappingRetained: false, aggregateOnly: true },
    decision: 'active_challenge_not_production_pad',
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ resultPath, trials: result.trials, passedAttacks: result.passedAttacks, attackFalseAcceptRate: result.attackFalseAcceptRate, observedOrders: result.observedOrders, failureReasons: result.failureReasons }, null, 2)}\n`)
} catch (error) { if (vite.exitCode !== null && vite.exitCode !== 0) process.stderr.write(viteError); throw error }
finally { if (vite.exitCode === null) vite.kill(); await rm(stagingDir, { recursive: true, force: true }) }
