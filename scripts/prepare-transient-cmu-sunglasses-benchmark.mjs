import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'cmu-sunglasses')
const archivePath = join(stagingDir, 'cmu-faces.tar.gz')
const extractDir = join(stagingDir, 'extracted')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
const config = JSON.parse(await readFile(join(benchmarkDir, 'sources.json'), 'utf8'))
const source = config.sources.find((item) => item.id === 'cmu-face-images-uci-kdd')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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
    throw new Error(`Unsupported PGM header: ${magic} ${width}x${height} max=${maxValue}`)
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
    if (sourcePixels.length !== width * height) throw new Error('Truncated binary PGM')
    pixels = maxValue === 255
      ? Buffer.from(sourcePixels)
      : Buffer.from(Uint8Array.from(sourcePixels, (value) => Math.round((value / maxValue) * 255)))
  }
  return { pixels, width, height }
}

if (!source) throw new Error('CMU source configuration is missing')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe CMU sunglasses staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })
await mkdir(extractDir, { recursive: true })

try {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', archivePath, source.downloadUrl,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const archive = await readFile(archivePath)
  if (archive.length !== source.archiveBytes) throw new Error(`CMU archive size mismatch: ${archive.length}`)
  const archiveSha256 = sha256(archive)
  if (archiveSha256 !== source.sha256) throw new Error(`CMU archive checksum mismatch: ${archiveSha256}`)

  const { stdout: listing } = await execFileAsync('tar.exe', ['-tzf', archivePath], { maxBuffer: 20 * 1024 * 1024 })
  for (const original of listing.split(/\r?\n/).filter(Boolean)) {
    const entry = original.replaceAll('\\', '/')
    const segments = entry.split('/').filter(Boolean)
    if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry) || segments.includes('..')) {
      throw new Error(`Unsafe CMU archive entry: ${original}`)
    }
  }
  await execFileAsync('tar.exe', ['-xzf', archivePath, '-C', extractDir], { maxBuffer: 2 * 1024 * 1024 })

  const parsed = []
  for (const path of (await walk(extractDir)).filter((item) => item.toLowerCase().endsWith('.pgm'))) {
    const match = basename(path).match(/^(.+?)_(straight|left|right|up)_(neutral|happy|sad|angry)_(open|sunglasses)\.pgm$/i)
    if (!match) continue
    parsed.push({
      path,
      sourceSubject: match[1].toLowerCase(),
      pose: match[2].toLowerCase(),
      expression: match[3].toLowerCase(),
      eyeCondition: match[4].toLowerCase(),
    })
  }
  const subjects = [...new Set(parsed.map((record) => record.sourceSubject))]
    .sort((a, b) => sha256(`${source.sha256}:${a}`).localeCompare(sha256(`${source.sha256}:${b}`)))
  const subjectIds = new Map(subjects.map((subject, index) => [subject, `s${String(index + 1).padStart(3, '0')}`]))
  const records = []
  for (const [index, record] of parsed.entries()) {
    if (index % 100 === 0) process.stdout.write(`Converting CMU image ${index + 1}/${parsed.length}\n`)
    const pgm = decodePgm(await readFile(record.path))
    const subjectId = subjectIds.get(record.sourceSubject)
    const fileName = `${subjectId}_${record.pose}_${record.expression}_${record.eyeCondition}.png`
    const output = await sharp(pgm.pixels, { raw: { width: pgm.width, height: pgm.height, channels: 1 } }).png().toBuffer()
    await writeFile(join(imageDir, fileName), output)
    records.push({
      subjectId,
      pose: record.pose,
      expression: record.expression,
      eyeCondition: record.eyeCondition,
      relativePath: `images/${fileName}`,
      width: pgm.width,
      height: pgm.height,
      bytes: output.length,
      sha256: sha256(output),
    })
  }
  if (records.length !== 624) throw new Error(`Unexpected CMU full-resolution image count: ${records.length}`)

  await rm(archivePath, { force: true })
  await rm(extractDir, { recursive: true, force: true })
  await writeFile(manifestPath, `${JSON.stringify({
    source: source.name,
    publisher: source.publisher,
    sourcePage: source.sourcePage,
    sourceArchiveSha256: archiveSha256,
    subjects: subjects.length,
    images: records.length,
    resolution: '128x120 grayscale',
    records,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${records.length} CMU open/sunglasses images from ${subjects.length} pseudonymized subjects; removed archive and extracted PGM files.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
