import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'aizoo-mask-detector')
const maskedDir = join(stagingDir, 'masked')
const cewDir = join(stagingDir, 'unmasked-cew')
const sourceDir = join(stagingDir, 'source')
const modelDir = join(stagingDir, 'model')
const runtimeDir = join(stagingDir, 'python-runtime')
const manifestPath = join(stagingDir, 'manifest.json')
const realDir = join(projectDir, 'data', 'face-db-real-research')
const realManifestPath = join(realDir, 'manifest.jsonl')

const aizooCommit = '256dc65f726cb78d82936b2c61c55a5adc2cf05d'
const aizooBase = `https://raw.githubusercontent.com/AIZOOTech/FaceMaskDetection/${aizooCommit}`
const modelFiles = {
  caffemodel: { path: 'models/face_mask_detection.caffemodel', bytes: 4053526, gitBlobSha1: 'e6062a10521c2b7704193fdd22685f6ce4141df1', sha256: '3c2e89cffdc9459a69dd5c2e4c1ca263e6488a56a5a37d81ca2ff32344fbf740' },
  prototxt: { path: 'models/face_mask_detection.prototxt', bytes: 13490, gitBlobSha1: '0fcdbcaaef2afcb380beb91a29580dadc839e2f8', sha256: '8de363802d3557f3d9ff7e72dd61eead60f5e9e145bb962d7979b99ff85d4212' },
}
const rmfdCommit = 'b6772855cc581f42b851dc53b78d4ba852cc3860'
const rmfdTreeUrl = `https://api.github.com/repos/X-zhangyang/Real-World-Masked-Face-Dataset/git/trees/${rmfdCommit}?recursive=1`
const rmfdRawBase = `https://raw.githubusercontent.com/X-zhangyang/Real-World-Masked-Face-Dataset/${rmfdCommit}`
const cew = { url: 'https://drive.usercontent.google.com/download?id=1FcRw251WxGKwT6Dt9ncP-1TbW6h445W5&export=download&confirm=t', bytes: 8787214, sha256: '0d02c9eb8810cd945b65e6a2e22aca24298e37439b655fc291602cbcf3be7e4a' }

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function gitBlobSha1(buffer) { return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') }
function safeArchiveEntry(entry) { return Boolean(entry) && !entry.includes('\\') && !entry.startsWith('/') && !/^[a-z]:/i.test(entry) && !entry.split('/').some((part) => part === '..') }
async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'HeadUp-Research-Benchmark/1.0', Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`Metadata request failed: ${response.status}`)
  return response.json()
}
async function download(url, output, expected) {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '8', '--retry-all-errors', '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', output, url], { maxBuffer: 2 * 1024 * 1024 })
  const bytes = await readFile(output)
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`Integrity mismatch: ${basename(output)}`)
  if (expected.gitBlobSha1 && gitBlobSha1(bytes) !== expected.gitBlobSha1) throw new Error(`Git blob mismatch: ${basename(output)}`)
  return bytes
}
async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length); let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => { while (cursor < items.length) { const index = cursor++; output[index] = await worker(items[index], index) } }))
  return output
}
function pythonCommand() { return process.env.HEADUP_PYTHON ? { command: process.env.HEADUP_PYTHON, prefix: [] } : { command: 'py', prefix: ['-3.11'] } }

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe AIZOO staging path')
await rm(stagingDir, { recursive: true, force: true })
await Promise.all([mkdir(maskedDir, { recursive: true }), mkdir(cewDir, { recursive: true }), mkdir(sourceDir, { recursive: true }), mkdir(modelDir, { recursive: true }), mkdir(runtimeDir, { recursive: true })])

try {
  const modelPaths = { caffemodel: join(modelDir, 'face_mask_detection.caffemodel'), prototxt: join(modelDir, 'face_mask_detection.prototxt') }
  await Promise.all(Object.entries(modelFiles).map(([key, spec]) => download(`${aizooBase}/${spec.path}`, modelPaths[key], spec)))

  const rmfdTree = await fetchJson(rmfdTreeUrl)
  if (rmfdTree.truncated) throw new Error('RMFD Git tree was truncated')
  const rmfdItems = rmfdTree.tree.flatMap((item) => {
    const match = item.type === 'blob' && /^RWMFD_part_1\/([^/]+)\/[^/]+\.(?:jpg|jpeg|png)$/i.exec(item.path)
    return match && Number.isInteger(item.size) ? [{ sourceSubject: match[1], path: item.path, bytes: item.size, gitBlobSha1: item.sha }] : []
  })
  if (rmfdItems.length !== 1194) throw new Error(`Unexpected RMFD image count: ${rmfdItems.length}`)
  const sourceSubjects = [...new Set(rmfdItems.map((item) => item.sourceSubject))].sort((a, b) => sha256(`${rmfdCommit}:${a}`).localeCompare(sha256(`${rmfdCommit}:${b}`)))
  if (sourceSubjects.length !== 23) throw new Error(`Unexpected RMFD subject count: ${sourceSubjects.length}`)
  const subjects = new Map(sourceSubjects.map((subject, index) => [subject, { id: `masked-subject-${String(index + 1).padStart(2, '0')}`, split: 'external_evaluation' }]))
  const maskedRecords = await mapConcurrent(rmfdItems.sort((a, b) => sha256(a.path).localeCompare(sha256(b.path))), 12, async (item, index) => {
    const response = await fetch(`${rmfdRawBase}/${item.path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'HeadUp-Research-Benchmark/1.0' } })
    if (!response.ok) throw new Error(`RMFD image request failed: ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length !== item.bytes || gitBlobSha1(buffer) !== item.gitBlobSha1) throw new Error(`RMFD verification failed: ${item.path}`)
    const metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: 30_000_000 }).metadata()
    if (!metadata.width || !metadata.height) throw new Error(`RMFD image decode failed: ${item.path}`)
    const sampleId = `masked-${String(index + 1).padStart(4, '0')}`; const absolutePath = join(maskedDir, `${sampleId}.jpg`)
    await writeFile(absolutePath, buffer)
    if ((index + 1) % 100 === 0 || index + 1 === rmfdItems.length) process.stdout.write(`Downloaded verified RMFD ${index + 1}/${rmfdItems.length}\n`)
    return { sampleId, subjectId: subjects.get(item.sourceSubject).id, split: subjects.get(item.sourceSubject).split, label: 'masked', absolutePath, sourceWidth: metadata.width, sourceHeight: metadata.height }
  })

  const cewArchive = join(stagingDir, 'cew-faces-100.rar')
  await download(cew.url, cewArchive, cew)
  const { stdout: archiveList } = await execFileAsync('tar.exe', ['-tf', cewArchive], { maxBuffer: 4 * 1024 * 1024 })
  const entries = archiveList.split(/\r?\n/).filter(Boolean)
  if (!entries.every(safeArchiveEntry)) throw new Error('CEW archive contains an unsafe path')
  const openEntries = entries.filter((entry) => entry.includes('/OpenFace/') && /\.jpg$/i.test(entry)).sort((a, b) => sha256(`${cew.sha256}:${a}`).localeCompare(sha256(`${cew.sha256}:${b}`)))
  if (openEntries.length !== 1231) throw new Error(`Unexpected CEW open count: ${openEntries.length}`)
  await execFileAsync('tar.exe', ['-xf', cewArchive, '-C', sourceDir], { maxBuffer: 4 * 1024 * 1024 })
  const cewRecords = await mapConcurrent(openEntries, 8, async (entry, index) => {
    const sampleId = `cew-open-${String(index + 1).padStart(4, '0')}`; const absolutePath = join(cewDir, `${sampleId}.jpg`)
    const sourcePath = join(sourceDir, ...entry.split('/'))
    await sharp(sourcePath).rotate().jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(absolutePath)
    return { sampleId, subjectId: `cew-subject-${String(index + 1).padStart(4, '0')}`, split: index < 300 ? 'engineering' : 'holdout', label: 'unmasked_cew', absolutePath }
  })
  await Promise.all([rm(cewArchive, { force: true }), rm(sourceDir, { recursive: true, force: true })])

  const londonRecords = (await readFile(realManifestPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line)).filter((record) => record.view === 'front').map((record, index) => ({
    sampleId: `authorized-open-${String(index + 1).padStart(4, '0')}`,
    subjectId: `authorized-${record.partition}-${String(index + 1).padStart(4, '0')}`,
    split: record.partition === 'holdout' ? 'holdout' : 'engineering',
    label: 'unmasked_authorized', absolutePath: join(realDir, record.relativePath),
  }))
  if (londonRecords.length !== 102) throw new Error(`Unexpected London control count: ${londonRecords.length}`)

  const python = pythonCommand()
  await execFileAsync(python.command, [...python.prefix, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--target', runtimeDir, 'opencv-python-headless==4.12.0.88'], { maxBuffer: 8 * 1024 * 1024, timeout: 600_000 })
  const manifest = {
    policyVersion: 'HEADUP-AIZOO-MASK-PREPARE-1.0',
    model: { repository: 'https://github.com/AIZOOTech/FaceMaskDetection', commit: aizooCommit, license: 'MIT', files: modelFiles, paths: modelPaths, officialInput: '260x260 RGB scaled by 1/255', officialClasses: ['Mask', 'NoMask'] },
    datasets: { rmfd: { repository: 'https://github.com/X-zhangyang/Real-World-Masked-Face-Dataset', commit: rmfdCommit, images: 1194, subjects: 23, role: 'external positive evaluation; no masked image or identity participates in threshold selection' }, cewOpen: { sourcePage: 'https://parnec.nuaa.edu.cn/_upload/tpl/02/db/731/template731/pages/xtan/ClosedEyeDatabases.html', archive: cew, images: 1231, uniqueSubjects: 1231, engineering: 300, holdout: 931 }, authorizedOpen: { images: 102, engineering: londonRecords.filter((record) => record.split === 'engineering').length, holdout: londonRecords.filter((record) => record.split === 'holdout').length } },
    records: [...maskedRecords, ...cewRecords, ...londonRecords],
    runtime: { python: '3.11', package: 'opencv-python-headless==4.12.0.88', path: runtimeDir },
    retention: { archivesDeletedBeforeInference: true, originalCewNamesDeletedBeforeInference: true, individualPredictionsDeleteAfterAggregation: true, allTransientAssetsDeleteAfterAudit: true },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${manifest.records.length} images: 1,194 masked, 1,231 CEW unmasked, 102 authorized unmasked.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
