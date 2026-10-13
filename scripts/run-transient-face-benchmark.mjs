import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProductionQualityHarness } from './lib/headup-quality-harness.mjs'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingDir = join(benchmarkDir, '.staging')
const resultPath = join(benchmarkDir, 'transient-benchmark-result.json')
const config = JSON.parse(await readFile(join(benchmarkDir, 'sources.json'), 'utf8'))
const source = config.sources.find((item) => item.id === 'cmu-face-images-uci-kdd')
const harness = await createProductionQualityHarness(projectDir)

function download(url, outputPath) {
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    "Invoke-WebRequest -Uri $env:HEADUP_DOWNLOAD_URL -OutFile $env:HEADUP_DOWNLOAD_PATH",
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
    env: { ...process.env, HEADUP_DOWNLOAD_URL: url, HEADUP_DOWNLOAD_PATH: outputPath },
  })
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))]
}

function summarize(items) {
  const scores = items.map((item) => item.score)
  return {
    images: items.length,
    accepted: items.filter((item) => item.accepted).length,
    score: {
      min: Math.min(...scores),
      p05: percentile(scores, 0.05),
      median: percentile(scores, 0.5),
      p95: percentile(scores, 0.95),
      max: Math.max(...scores),
    },
  }
}

function groupedSummary(items, key) {
  return Object.fromEntries(Object.entries(Object.groupBy(items, (item) => item[key])).map(([name, rows]) => [name, summarize(rows)]))
}

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await walk(child))
    else files.push(child)
  }
  return files
}

function decodePgm(buffer) {
  let offset = 0
  const nextToken = () => {
    while (offset < buffer.length) {
      const byte = buffer[offset]
      if (byte === 35) {
        while (offset < buffer.length && buffer[offset] !== 10 && buffer[offset] !== 13) offset++
      } else if (byte <= 32) offset++
      else break
    }
    const start = offset
    while (offset < buffer.length && buffer[offset] > 32 && buffer[offset] !== 35) offset++
    return buffer.subarray(start, offset).toString('ascii')
  }
  const magic = nextToken()
  const width = Number(nextToken())
  const height = Number(nextToken())
  const maxValue = Number(nextToken())
  if (!['P2', 'P5'].includes(magic) || !width || !height || !maxValue || maxValue > 255) {
    throw new Error(`Unsupported PGM header: magic=${magic}, size=${width}x${height}, max=${maxValue}`)
  }
  let pixels
  if (magic === 'P2') {
    pixels = Buffer.allocUnsafe(width * height)
    for (let index = 0; index < pixels.length; index++) {
      const value = Number(nextToken())
      if (!Number.isFinite(value)) throw new Error(`Truncated ASCII PGM at pixel ${index}`)
      pixels[index] = Math.round((value / maxValue) * 255)
    }
  } else {
    if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2
    else if (buffer[offset] <= 32) offset++
    const sourcePixels = buffer.subarray(offset, offset + width * height)
    if (sourcePixels.length !== width * height) throw new Error(`Truncated PGM: expected ${width * height}, received ${sourcePixels.length}`)
    pixels = maxValue === 255
      ? sourcePixels
      : Buffer.from(Uint8Array.from(sourcePixels, (value) => Math.round((value / maxValue) * 255)))
  }
  return { pixels, width, height }
}

await mkdir(stagingDir, { recursive: true })
const archivePath = resolve(stagingDir, 'cmu-faces.tar.gz')
const extractDir = await mkdtemp(join(stagingDir, 'extract-'))
const allowedRoot = resolve(stagingDir) + sep
let result

try {
  try { await stat(archivePath) } catch { download(source.downloadUrl, archivePath) }
  const archive = await readFile(archivePath)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  if (sha256 !== source.sha256) throw new Error(`CMU archive SHA-256 mismatch: ${sha256}`)
  if (archive.length !== source.archiveBytes) throw new Error(`CMU archive size mismatch: ${archive.length}`)

  const entries = execFileSync('tar.exe', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    .split(/\r?\n/).filter(Boolean)
  for (const original of entries) {
    const entry = original.replaceAll('\\', '/')
    const segments = entry.split('/').filter(Boolean)
    if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry) || segments.includes('..')) {
      throw new Error(`Unsafe archive entry: ${original}`)
    }
  }
  execFileSync('tar.exe', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' })

  const cases = []
  const pgmFiles = (await walk(extractDir)).filter((path) => path.toLowerCase().endsWith('.pgm'))
  for (const path of pgmFiles) {
    const match = basename(path).match(/^.+?_(straight|left|right|up)_(neutral|happy|sad|angry)_(open|sunglasses)\.pgm$/i)
    if (!match) continue // Excludes duplicate half/quarter variants; the full-resolution set has no suffix.
    const pgm = decodePgm(await readFile(path))
    const inspected = await harness.inspect(pgm.pixels, { raw: { width: pgm.width, height: pgm.height, channels: 1 } })
    cases.push({
      pose: match[1].toLowerCase(),
      expression: match[2].toLowerCase(),
      eyeCondition: match[3].toLowerCase(),
      resolution: `${inspected.dimensions.width}x${inspected.dimensions.height}`,
      score: inspected.quality.score,
      accepted: inspected.accepted,
      flags: inspected.quality.flags,
    })
  }

  const flagCounts = {}
  for (const item of cases) for (const flag of item.flags) flagCounts[flag] = (flagCounts[flag] || 0) + 1
  result = {
    testedAt: new Date().toISOString(),
    policyVersion: config.policyVersion,
    source: { id: source.id, name: source.name, publisher: source.publisher, sourcePage: source.sourcePage, sha256 },
    retention: { imagesRetained: false, identifiersRetained: false, aggregateOnly: true },
    total: summarize(cases),
    flags: flagCounts,
    byPose: groupedSummary(cases, 'pose'),
    byExpression: groupedSummary(cases, 'expression'),
    byEyeCondition: groupedSummary(cases, 'eyeCondition'),
    byResolution: groupedSummary(cases, 'resolution'),
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
} finally {
  for (const target of [extractDir, archivePath]) {
    const resolved = resolve(target)
    if (!resolved.startsWith(allowedRoot)) throw new Error(`Refusing cleanup outside staging: ${resolved}`)
    await rm(resolved, { recursive: true, force: true })
  }
}

process.stdout.write(JSON.stringify({ ...result, resultPath }, null, 2) + '\n')
