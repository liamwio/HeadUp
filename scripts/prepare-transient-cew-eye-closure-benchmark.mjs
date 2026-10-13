import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'cew-eye-closure')
const sourceDir = join(stagingDir, 'source')
const imageDir = join(stagingDir, 'images')
const archivePath = join(stagingDir, 'cew-faces-100.rar')
const manifestPath = join(stagingDir, 'manifest.json')
const realResearchDir = join(projectDir, 'data', 'face-db-real-research')
const realManifestPath = join(realResearchDir, 'manifest.jsonl')

const sourcePage = 'https://parnec.nuaa.edu.cn/_upload/tpl/02/db/731/template731/pages/xtan/ClosedEyeDatabases.html'
const downloadUrl = 'https://drive.usercontent.google.com/download?id=1FcRw251WxGKwT6Dt9ncP-1TbW6h445W5&export=download&confirm=t'
const expectedBytes = 8787214
const expectedSha256 = '0d02c9eb8810cd945b65e6a2e22aca24298e37439b655fc291602cbcf3be7e4a'
const engineeringPerClass = 300

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function archiveEntryIsSafe(entry) {
  if (!entry || entry.includes('\\') || entry.startsWith('/') || /^[a-z]:/i.test(entry)) return false
  return !entry.split('/').some((part) => part === '..')
}

function labelFor(entry) {
  if (entry.includes('/ClosedFace/') && /\.(jpg|jpeg)$/i.test(entry)) return 'closed'
  if (entry.includes('/OpenFace/') && /\.(jpg|jpeg)$/i.test(entry)) return 'open'
  return undefined
}

async function listArchive() {
  const { stdout } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 4 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  if (!entries.every(archiveEntryIsSafe)) throw new Error('CEW archive contains an unsafe path')
  const images = entries.flatMap((entry) => {
    const label = labelFor(entry)
    return label ? [{ entry, label }] : []
  })
  const closed = images.filter((image) => image.label === 'closed').length
  const open = images.filter((image) => image.label === 'open').length
  if (closed !== 1192 || open !== 1231) throw new Error(`Unexpected CEW counts: closed=${closed}, open=${open}`)
  return images
}

function selectSplits(images) {
  const selected = []
  for (const label of ['closed', 'open']) {
    const sorted = images.filter((image) => image.label === label)
      .sort((left, right) => sha256(`${expectedSha256}:${left.entry}`).localeCompare(sha256(`${expectedSha256}:${right.entry}`)))
    selected.push(...sorted.map((image, index) => ({
      ...image,
      split: index < engineeringPerClass ? 'engineering' : 'holdout',
    })))
  }
  return selected.sort((left, right) => sha256(left.entry).localeCompare(sha256(right.entry)))
}

async function transformRecord(record, index) {
  const sampleId = `${record.split === 'engineering' ? 'eng' : 'hold'}-${String(index + 1).padStart(4, '0')}`
  const sourcePath = join(sourceDir, ...record.entry.split('/'))
  const outputName = `${sampleId}.jpg`
  const outputPath = join(imageDir, outputName)
  const inputMetadata = await sharp(sourcePath).metadata()
  if (inputMetadata.width !== 100 || inputMetadata.height !== 100) {
    throw new Error(`Unexpected CEW source dimensions: ${inputMetadata.width}x${inputMetadata.height}`)
  }
  await sharp(sourcePath).resize(512, 512, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(outputPath)
  const bytes = await readFile(outputPath)
  return {
    sampleId,
    subjectId: `${record.split}-subject-${String(index + 1).padStart(4, '0')}`,
    split: record.split,
    relativePath: `images/${outputName}`,
    label: { bothEyesClosed: record.label === 'closed' },
    sourceResolution: '100x100',
    inferenceResolution: '512x512 deterministic Lanczos upscale',
    sha256: sha256(bytes),
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await mapper(items[index], index)
      if ((index + 1) % 100 === 0 || index + 1 === items.length) process.stdout.write(`Prepared ${index + 1}/${items.length}\n`)
    }
  }))
  return output
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe CEW staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })
await mkdir(sourceDir, { recursive: true })

try {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '8', '--retry-all-errors',
    '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '300',
    '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', archivePath, downloadUrl,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const archive = await readFile(archivePath)
  if (archive.length !== expectedBytes || sha256(archive) !== expectedSha256) {
    throw new Error(`CEW archive integrity mismatch: bytes=${archive.length}, sha256=${sha256(archive)}`)
  }
  const archiveImages = await listArchive()
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', sourceDir], { maxBuffer: 4 * 1024 * 1024 })
  const records = await mapConcurrent(selectSplits(archiveImages), 8, transformRecord)
  const engineering = records.filter((record) => record.split === 'engineering')
  const holdout = records.filter((record) => record.split === 'holdout')
  if (engineering.length !== 600 || holdout.length !== 1823) throw new Error('Unexpected CEW split sizes')

  const authorizedOpenRecords = (await readFile(realManifestPath, 'utf8')).trim().split(/\r?\n/)
    .map((line) => JSON.parse(line)).filter((record) => record.view === 'front')
    .map((record, index) => ({
      sampleId: `authorized-open-${String(index + 1).padStart(4, '0')}`,
      subjectId: `authorized-${record.partition}-${String(index + 1).padStart(4, '0')}`,
      split: record.partition === 'holdout' ? 'authorized_holdout' : 'authorized_engineering',
      assetUrl: `/@fs/${join(realResearchDir, record.relativePath).replaceAll('\\', '/')}`,
      label: { bothEyesClosed: false },
    }))
  if (authorizedOpenRecords.length !== 102) throw new Error(`Unexpected authorized control count: ${authorizedOpenRecords.length}`)

  await rm(archivePath, { force: true })
  await rm(sourceDir, { recursive: true, force: true })
  const manifest = {
    policyVersion: 'HEADUP-CEW-EYE-CLOSURE-PREPARE-1.0',
    source: 'Closed Eyes in the Wild (CEW), warped full-face version',
    publisher: 'Nanjing University of Aeronautics and Astronautics',
    sourcePage,
    archive: { bytes: expectedBytes, sha256: expectedSha256 },
    licenseBoundary: 'Research use only; not for commercial use or redistribution.',
    selection: {
      downloadedImages: records.length,
      uniqueSubjects: records.length,
      engineeringImages: engineering.length,
      engineeringClosed: engineering.filter((record) => record.label.bothEyesClosed).length,
      engineeringOpen: engineering.filter((record) => !record.label.bothEyesClosed).length,
      holdoutImages: holdout.length,
      holdoutClosed: holdout.filter((record) => record.label.bothEyesClosed).length,
      holdoutOpen: holdout.filter((record) => !record.label.bothEyesClosed).length,
      authorizedOpenControls: authorizedOpenRecords.length,
      sourceResolution: '100x100 warped full-face crops',
      inferenceResolution: '512x512 deterministic Lanczos upscale; no new visual information added',
    },
    records,
    authorizedOpenRecords,
    retention: {
      archiveDeletedBeforeInference: true,
      extractedNamedSourceFilesDeletedBeforeInference: true,
      sourceNamesRetainedInFinalResult: false,
      individualPredictionsRetainedInFinalResult: false,
    },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${records.length} anonymous CEW faces plus ${authorizedOpenRecords.length} authorized open-eye controls.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
