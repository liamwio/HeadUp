import { inspectCaptureFile } from '../src/lib/captureAnalysis'

type RecordEntry = { sampleId: string; orientation: number; relativePath: string }
const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!
const stagingRoot = '/@fs/D:/AICodex/HeadUp/data/face-benchmark/.staging/exif-orientation'
function round(value: number, digits = 3) { return Number(value.toFixed(digits)) }
function percentile(values: number[], fraction: number) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.round((ordered.length - 1) * fraction)] }
function distribution(values: number[]) { return { min: round(Math.min(...values)), median: round(percentile(values, .5)), p95: round(percentile(values, .95)), max: round(Math.max(...values)) } }

async function main() {
  const manifest = await fetch(`${stagingRoot}/manifest.json`).then((response) => response.json()) as { policyVersion: string; source: unknown; records: RecordEntry[] }
  const records = manifest.records.filter((record) => record.orientation === 1)
  if (manifest.policyVersion !== 'HEADUP-EXIF-ORIENTATION-PREPARE-1.0' || records.length !== 20) throw new Error('Unexpected performance manifest')
  const longTasks: number[] = []
  let observerSupported = false
  try {
    const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
    observer.observe({ type: 'longtask', buffered: true })
    observerSupported = true
  } catch { /* Long Tasks API unavailable */ }
  const nativeCreateImageBitmap = globalThis.createImageBitmap.bind(globalThis)
  let bitmapDecodeCalls = 0
  globalThis.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => { bitmapDecodeCalls++; return nativeCreateImageBitmap(...args) }) as typeof createImageBitmap
  const cases = []
  for (const [index, record] of records.entries()) {
    status.textContent = `分析性能 ${index + 1} / ${records.length}`
    const blob = await fetch(`${stagingRoot}/${record.relativePath}`).then((response) => response.blob())
    const file = new File([blob], `${record.sampleId}.jpg`, { type: 'image/jpeg' })
    const beforeDecode = bitmapDecodeCalls
    const beforeTasks = longTasks.length
    const started = performance.now()
    const inspected = await inspectCaptureFile('front', file)
    const elapsedMs = performance.now() - started
    await new Promise((resolve) => setTimeout(resolve, 0))
    cases.push({
      elapsedMs,
      bitmapDecodeCalls: bitmapDecodeCalls - beforeDecode,
      longTasks: longTasks.slice(beforeTasks),
      qualityScore: inspected.quality.score,
      poseStatus: inspected.pose.status,
      landmarks: inspected.pose.landmarks?.length ?? 0,
    })
  }
  const warm = cases.slice(1)
  const warmTimes = warm.map((item) => item.elapsedMs)
  const allLongTasks = cases.flatMap((item) => item.longTasks)
  const gates = {
    evaluatedExactly20RealImages: cases.length === 20,
    everyFileDecodedExactlyOnce: bitmapDecodeCalls === 20 && cases.every((item) => item.bitmapDecodeCalls === 1),
    coldStartAtMost8Seconds: cases[0].elapsedMs <= 8_000,
    warmMedianAtMost3Seconds: percentile(warmTimes, .5) <= 3_000,
    warmP95AtMost5Seconds: percentile(warmTimes, .95) <= 5_000,
    longTaskApiAvailable: observerSupported,
    longTaskP95AtMost250Milliseconds: observerSupported && (allLongTasks.length === 0 || percentile(allLongTasks, .95) <= 250),
  }
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-CAPTURE-PERFORMANCE-AUDIT-1.0',
    source: manifest.source,
    runtime: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, longTaskApiAvailable: observerSupported },
    protocol: { images: 20, firstImageRole: 'cold model/WASM initialization', warmImages: 19, pipeline: 'preflight + one ImageBitmap + pixel quality + MediaPipe + WHENet + YuNet' },
    evaluation: {
      bitmapDecodeCalls,
      coldStartMs: round(cases[0].elapsedMs),
      warmLatencyMs: distribution(warmTimes),
      allLatencyMs: distribution(cases.map((item) => item.elapsedMs)),
      longTaskCount: allLongTasks.length,
      longTaskDurationMs: allLongTasks.length ? distribution(allLongTasks) : null,
      posePassed: cases.filter((item) => item.poseStatus === 'pass').length,
      landmarkOutputs: cases.filter((item) => item.landmarks === 478).length,
    },
    predeclaredGates: gates,
    passesDesktopPerformanceGates: Object.values(gates).every(Boolean),
    productionDecision: Object.values(gates).every(Boolean) ? 'desktop_pipeline_performance_passes; mobile_matrix_still_required' : 'worker_or_pipeline_optimization_required_before_device_matrix',
    limitations: ['Desktop headless Chromium is not iOS/Android hardware.', 'Wall time includes local model initialization and inference but not camera capture.', 'Long Task entries are browser scheduling evidence, not peak-memory measurements.'],
    retention: { imagesDeletedAfterRun: false, individualTimingsRetained: false, identifiersRetained: false, aggregateOnly: true },
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  status.textContent = '完成'
}

main().catch((error) => { resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error); resultElement.textContent = resultElement.dataset.error; status.textContent = '失败' })
