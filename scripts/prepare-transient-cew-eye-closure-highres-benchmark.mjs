import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'cew-eye-closure-highres')
const sourceDir = join(stagingDir, 'source')
const imageDir = join(stagingDir, 'images')
const cewHighPath = join(stagingDir, 'cew-closed-highres.rar')
const cewIndexPath = join(stagingDir, 'cew-warped-index.rar')
const lfwPath = join(stagingDir, 'lfw-funneled.tgz')
const manifestPath = join(stagingDir, 'manifest.json')
const realResearchDir = join(projectDir, 'data', 'face-db-real-research')
const realManifestPath = join(realResearchDir, 'manifest.jsonl')

const sourcePage = 'https://parnec.nuaa.edu.cn/_upload/tpl/02/db/731/template731/pages/xtan/ClosedEyeDatabases.html'
const cewHigh = {
  url: 'https://drive.usercontent.google.com/download?id=12DB4kwdeikxyQcK4gA7hL0QbzF6iOAZ2&export=download&confirm=t',
  bytes: 21758060,
  sha256: '25c1eb8572a8755b87106a4bfea7f2dd89c1abaab95196eee51d43de9f8c6b48',
}
const cewIndex = {
  url: 'https://drive.usercontent.google.com/download?id=1FcRw251WxGKwT6Dt9ncP-1TbW6h445W5&export=download&confirm=t',
  bytes: 8787214,
  sha256: '0d02c9eb8810cd945b65e6a2e22aca24298e37439b655fc291602cbcf3be7e4a',
}
const lfwMirror = {
  page: 'https://huggingface.co/datasets/DerrickUnleashed/LFW',
  commit: 'f7571fa9dd5a5c31ab781de5227c6f1b6171c0c5',
  url: 'https://huggingface.co/datasets/DerrickUnleashed/LFW/resolve/f7571fa9dd5a5c31ab781de5227c6f1b6171c0c5/lfwfunneled.tgz?download=true',
  bytes: 243346528,
  sha256: 'b47c8422c8cded889dc5a13418c4bc2abbda121092b3533a83306f90d900100a',
}
const engineeringPerClass = 300

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function safe(entry) {
  return Boolean(entry) && !entry.includes('\\') && !entry.startsWith('/') && !/^[a-z]:/i.test(entry)
    && !entry.split('/').some((part) => part === '..')
}
async function download(target, spec) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '8', '--retry-all-errors',
    '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '900',
    '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', target, spec.url,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const bytes = await readFile(target)
  const digest = sha256(bytes)
  if (bytes.length !== spec.bytes || digest !== spec.sha256) {
    throw new Error(`Integrity mismatch for ${basename(target)}: bytes=${bytes.length}, sha256=${digest}`)
  }
}
async function list(target) {
  const { stdout } = await execFileAsync('tar.exe', ['-tf', target], { maxBuffer: 8 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  if (!entries.every(safe)) throw new Error(`Unsafe archive path in ${basename(target)}`)
  return entries
}
function selectSplits(records) {
  const output = []
  for (const label of ['closed', 'open']) {
    const sorted = records.filter((record) => record.label === label)
      .sort((left, right) => sha256(`${cewIndex.sha256}:${left.sourcePath}`).localeCompare(sha256(`${cewIndex.sha256}:${right.sourcePath}`)))
    output.push(...sorted.map((record, index) => ({ ...record, split: index < engineeringPerClass ? 'engineering' : 'holdout' })))
  }
  return output.sort((left, right) => sha256(left.sourcePath).localeCompare(sha256(right.sourcePath)))
}
async function transform(record, index) {
  const sampleId = `${record.split === 'engineering' ? 'eng' : 'hold'}-${String(index + 1).padStart(4, '0')}`
  const sourcePath = join(sourceDir, ...record.sourcePath.split('/'))
  const outputName = `${sampleId}.jpg`
  const outputPath = join(imageDir, outputName)
  const metadata = await sharp(sourcePath).metadata()
  if (!metadata.width || !metadata.height) {
    throw new Error(`Unexpected source dimensions for ${sampleId}: ${metadata.width}x${metadata.height}`)
  }
  await sharp(sourcePath).resize(512, 512, {
    fit: 'contain', background: { r: 0, g: 0, b: 0 }, kernel: 'lanczos3',
  }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(outputPath)
  return {
    sampleId,
    subjectId: `${record.split}-subject-${String(index + 1).padStart(4, '0')}`,
    split: record.split,
    relativePath: `images/${outputName}`,
    label: { bothEyesClosed: record.label === 'closed' },
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

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe high-resolution CEW staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })
await mkdir(sourceDir, { recursive: true })

try {
  await download(cewIndexPath, cewIndex)
  const indexEntries = await list(cewIndexPath)
  const openNames = indexEntries.filter((entry) => entry.includes('/OpenFace/') && /\.jpg$/i.test(entry)).map((entry) => basename(entry))
  if (openNames.length !== 1231 || new Set(openNames).size !== 1231) throw new Error(`Unexpected CEW open index count: ${openNames.length}`)

  await Promise.all([download(cewHighPath, cewHigh), download(lfwPath, lfwMirror)])
  const [closedEntries, lfwEntries] = await Promise.all([list(cewHighPath), list(lfwPath)])
  const closedPaths = closedEntries.filter((entry) => /\/closed_eye_.*\.jpg$/i.test(`/${entry}`))
  if (closedPaths.length !== 1192) throw new Error(`Unexpected high-resolution CEW closed count: ${closedPaths.length}`)
  const lfwByName = new Map(lfwEntries.filter((entry) => /\.jpg$/i.test(entry)).map((entry) => [basename(entry), entry]))
  const missingOpen = openNames.filter((name) => !lfwByName.has(name))
  if (missingOpen.length) throw new Error(`LFW mirror is missing ${missingOpen.length} CEW open controls`)

  await execFileAsync('tar.exe', ['-xf', cewHighPath, '-C', sourceDir], { maxBuffer: 4 * 1024 * 1024 })
  await execFileAsync('tar.exe', ['-xf', lfwPath, '-C', sourceDir], { maxBuffer: 8 * 1024 * 1024 })
  const selected = selectSplits([
    ...closedPaths.map((sourcePath) => ({ sourcePath, label: 'closed' })),
    ...openNames.map((name) => ({ sourcePath: lfwByName.get(name), label: 'open' })),
  ])
  const records = await mapConcurrent(selected, 8, transform)
  const engineering = records.filter((record) => record.split === 'engineering')
  const holdout = records.filter((record) => record.split === 'holdout')
  if (engineering.length !== 600 || holdout.length !== 1823) throw new Error('Unexpected high-resolution CEW split sizes')

  const authorizedOpenRecords = (await readFile(realManifestPath, 'utf8')).trim().split(/\r?\n/)
    .map((line) => JSON.parse(line)).filter((record) => record.view === 'front')
    .map((record, index) => ({
      sampleId: `authorized-open-${String(index + 1).padStart(4, '0')}`,
      subjectId: `authorized-${record.partition}-${String(index + 1).padStart(4, '0')}`,
      split: record.partition === 'holdout' ? 'authorized_holdout' : 'authorized_engineering',
      assetUrl: `/@fs/${join(realResearchDir, record.relativePath).replaceAll('\\', '/')}`,
      label: { bothEyesClosed: false },
    }))
  if (authorizedOpenRecords.length !== 102) throw new Error('Unexpected authorized open controls')

  await Promise.all([
    rm(cewHighPath, { force: true }), rm(cewIndexPath, { force: true }), rm(lfwPath, { force: true }),
    rm(sourceDir, { recursive: true, force: true }),
  ])
  const manifest = {
    policyVersion: 'HEADUP-CEW-EYE-CLOSURE-HIGHRES-PREPARE-1.0',
    source: 'CEW original-resolution closed faces + CEW-selected LFW funneled open faces',
    publisher: 'Nanjing University of Aeronautics and Astronautics / LFW',
    sourcePage,
    lfwMirror: { page: lfwMirror.page, commit: lfwMirror.commit, bytes: lfwMirror.bytes, sha256: lfwMirror.sha256 },
    archive: { cewHighResolution: { bytes: cewHigh.bytes, sha256: cewHigh.sha256 }, cewOpenIndex: { bytes: cewIndex.bytes, sha256: cewIndex.sha256 } },
    licenseBoundary: 'CEW/LFW research evaluation only; mirror is transport only and does not replace original dataset terms.',
    selection: {
      variant: 'higher-resolution source probe', downloadedImages: records.length, uniqueSubjects: records.length,
      engineeringImages: engineering.length, engineeringClosed: 300, engineeringOpen: 300,
      holdoutImages: holdout.length, holdoutClosed: 892, holdoutOpen: 931,
      authorizedOpenControls: authorizedOpenRecords.length,
      sourceResolution: 'CEW original-resolution closed faces and 250x250 LFW funneled open faces',
      inferenceResolution: '512x512 aspect-preserving contain resize with black padding',
    },
    records, authorizedOpenRecords,
    retention: {
      archivesDeletedBeforeInference: true, extractedNamedSourceFilesDeletedBeforeInference: true,
      sourceNamesRetainedInFinalResult: false, individualPredictionsRetainedInFinalResult: false,
    },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${records.length} higher-resolution anonymous CEW/LFW faces plus ${authorizedOpenRecords.length} controls.\n`)
} catch (error) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  await rm(stagingDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  throw error
}
