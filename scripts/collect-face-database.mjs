import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const SOURCES_PATH = new URL('../data/face-db/sources.json', import.meta.url)
const MANIFEST_PATH = new URL('../data/face-db/manifest.jsonl', import.meta.url)
const execFileAsync = promisify(execFile)

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function weakPose(text = '') {
  const value = text.toLowerCase()
  if (/side profile|profile view|90.degree|from the side/.test(value)) return 'profile'
  if (/three.quarter|3\/4 view|45.degree/.test(value)) return 'three_quarter'
  if (/front.facing|frontal|facing the camera|looking at the camera/.test(value)) return 'frontal'
  return 'unknown'
}

function weakExpression(text = '') {
  const value = text.toLowerCase()
  for (const expression of ['neutral', 'serious', 'smile', 'pensive', 'surprised', 'angry', 'calm']) {
    if (value.includes(expression)) return expression
  }
  return 'unknown'
}

function resolutionTier(width, height) {
  const edge = Math.min(width, height)
  if (edge >= 1024) return 'high'
  if (edge >= 768) return 'medium'
  return 'low'
}

async function fetchJson(url) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ProgressPreference='SilentlyContinue'; Invoke-RestMethod -Uri $env:HEADUP_FETCH_URL -Method Get -Headers @{'User-Agent'='HeadUpDataBuilder/1.0'} | ConvertTo-Json -Depth 100 -Compress",
  ], { env: { ...process.env, HEADUP_FETCH_URL: url }, maxBuffer: 30 * 1024 * 1024 })
  return JSON.parse(stdout)
}

async function download(url, target) {
  const temp = `${target}.part`
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:HEADUP_FETCH_URL -OutFile $env:HEADUP_FETCH_PATH -UseBasicParsing -Headers @{'User-Agent'='HeadUpDataBuilder/1.0'}",
  ], { env: { ...process.env, HEADUP_FETCH_URL: url, HEADUP_FETCH_PATH: temp }, maxBuffer: 2 * 1024 * 1024 })
  const bytes = await readFile(temp)
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  const contentType = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : ''
  if (!contentType) {
    await unlink(temp).catch(() => undefined)
    throw new Error('Downloaded content is not a supported image')
  }
  await rename(temp, target)
  return { bytes, contentType }
}

async function main() {
  const sourceId = argument('source', 'realistic-face-portrait-1024')
  const limit = Math.max(1, Math.min(100, Number(argument('limit', '12'))))
  const offset = Math.max(0, Number(argument('offset', '0')))
  const catalog = JSON.parse(await readFile(SOURCES_PATH, 'utf8'))
  const source = catalog.sources.find((item) => item.id === sourceId)
  if (!source) throw new Error(`Unknown source: ${sourceId}`)
  if (!source.downloadEnabled || source.commercialDecision === 'blocked') {
    throw new Error(`License gate blocked source: ${sourceId}`)
  }
  if (source.subjectType !== 'synthetic') throw new Error('Only synthetic subjects are allowed in this collector')
  if (!source.usageScope.includes('engineering_qa')) throw new Error('Source lacks engineering_qa scope')

  const params = new URLSearchParams({
    dataset: source.dataset,
    config: source.config,
    split: source.split,
    offset: String(offset),
    length: String(limit),
  })
  const payload = await fetchJson(`https://datasets-server.huggingface.co/rows?${params}`)
  const imageDir = new URL(`../data/face-db/images/${source.id}/`, import.meta.url)
  await mkdir(imageDir, { recursive: true })

  const existingText = await readFile(MANIFEST_PATH, 'utf8').catch(() => '')
  const existing = existingText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const hashes = new Set(existing.map((record) => record.sha256))
  const records = []

  for (const item of payload.rows || []) {
    const image = item.row?.image
    if (!image?.src) continue
    const extension = image.src.match(/\.(png|jpe?g|webp)(?:\?|$)/i)?.[1]?.toLowerCase() || 'jpg'
    const fileName = `${source.id}-${String(item.row_idx).padStart(6, '0')}.${extension === 'jpeg' ? 'jpg' : extension}`
    const fileUrl = new URL(`../data/face-db/images/${source.id}/${fileName}`, import.meta.url)
    const target = fileUrl.pathname.replace(/^\/(.:\/)/, '$1')
    const { bytes, contentType } = await download(image.src, target)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (hashes.has(sha256)) {
      await unlink(target).catch(() => undefined)
      continue
    }
    hashes.add(sha256)
    const prompt = item.row?.prompt || item.row?.source_prompt || ''
    const width = Number(image.width || item.row?.image_width || 0)
    const height = Number(image.height || item.row?.image_height || 0)
    records.push({
      recordVersion: 'HEADUP-FACE-RECORD-1.0',
      id: sha256.slice(0, 20),
      relativePath: `images/${source.id}/${fileName}`,
      sha256,
      bytes: bytes.length,
      mimeType: contentType.split(';')[0],
      width,
      height,
      sourceId: source.id,
      sourceDataset: source.dataset,
      sourceRevision: source.revision,
      sourceRowIndex: item.row_idx,
      subjectType: 'synthetic',
      consentBasis: 'not_applicable_synthetic',
      licenseDecision: source.commercialDecision,
      permittedUse: [...source.usageScope],
      poseWeakLabel: weakPose(prompt),
      expressionWeakLabel: weakExpression(prompt),
      weakLabelBasis: prompt ? 'generation_prompt_not_ground_truth' : 'none',
      resolutionTier: resolutionTier(width, height),
      qualityStatus: Math.min(width, height) >= 768 ? 'pass' : 'review',
      partition: item.row_idx % 5 === 0 ? 'engineering_holdout' : 'engineering_qa',
      collectedAt: new Date().toISOString(),
      policyVersion: catalog.policyVersion,
    })
  }

  const combined = [...existing, ...records]
  const text = combined.map((record) => JSON.stringify(record)).join('\n') + (combined.length ? '\n' : '')
  await writeFile(MANIFEST_PATH, text)
  process.stdout.write(JSON.stringify({ source: source.id, requested: limit, added: records.length, total: combined.length }, null, 2) + '\n')
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
