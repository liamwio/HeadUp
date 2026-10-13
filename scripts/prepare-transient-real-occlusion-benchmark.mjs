import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'real-occlusion')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
const sourceRepository = 'https://github.com/X-zhangyang/Real-World-Masked-Face-Dataset'
const sourceCommit = 'b6772855cc581f42b851dc53b78d4ba852cc3860'
const treeApi = `https://api.github.com/repos/X-zhangyang/Real-World-Masked-Face-Dataset/git/trees/${sourceCommit}?recursive=1`
const rawBase = `https://raw.githubusercontent.com/X-zhangyang/Real-World-Masked-Face-Dataset/${sourceCommit}`
const imagesPerSubject = 4
const sourcePathPattern = /^RWMFD_part_1\/([^/]+)\/[^/]+\.(?:jpg|jpeg|png)$/i

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function gitBlobSha1(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'HeadUp-Research-Benchmark/1.0', Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub metadata request failed: ${response.status}`)
  return response.json()
}

async function downloadVerifiedImage(record) {
  const response = await fetch(`${rawBase}/${record.path.split('/').map(encodeURIComponent).join('/')}`, {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'HeadUp-Research-Benchmark/1.0', Accept: 'image/*' },
  })
  if (!response.ok) throw new Error(`Image request failed (${response.status}): ${record.path}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length !== record.size) throw new Error(`Image size mismatch: ${record.path}`)
  const blobSha = gitBlobSha1(buffer)
  if (blobSha !== record.sha) throw new Error(`Git blob checksum mismatch: ${record.path}`)
  const metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: 20_000_000 }).metadata()
  if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new Error(`Unsupported image payload: ${record.path}`)
  }
  return { buffer, width: metadata.width, height: metadata.height, sha256: sha256(buffer) }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length)
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return output
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe real-occlusion staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })

try {
  const tree = await fetchJson(treeApi)
  if (tree.truncated) throw new Error('GitHub tree response was truncated')
  const bySubject = new Map()
  for (const item of tree.tree) {
    const match = item.type === 'blob' && item.path.match(sourcePathPattern)
    if (!match || !Number.isInteger(item.size) || !/^[0-9a-f]{40}$/.test(item.sha)) continue
    const subject = match[1]
    if (!bySubject.has(subject)) bySubject.set(subject, [])
    bySubject.get(subject).push({ path: item.path, size: item.size, sha: item.sha })
  }
  if (bySubject.size < 20) throw new Error(`Unexpected RMFD subject count: ${bySubject.size}`)

  const subjects = [...bySubject.entries()].sort(([a], [b]) => sha256(`${sourceCommit}:${a}`).localeCompare(sha256(`${sourceCommit}:${b}`)))
  const eligibleSubjects = subjects.filter(([, images]) => images.length >= imagesPerSubject)
  if (eligibleSubjects.length < 20) throw new Error(`Only ${eligibleSubjects.length} RMFD identities have at least ${imagesPerSubject} images`)
  const selected = eligibleSubjects.flatMap(([subject, images]) => images
    .sort((a, b) => sha256(`${sourceCommit}:${subject}:${a.path}`).localeCompare(sha256(`${sourceCommit}:${subject}:${b.path}`)))
    .slice(0, imagesPerSubject)
    .map((image) => ({ ...image, subject })))
  if (selected.length !== eligibleSubjects.length * imagesPerSubject) throw new Error('RMFD stratified selection is incomplete')

  const downloaded = await mapWithConcurrency(selected, 8, async (record, index) => {
    if (index % 20 === 0) process.stdout.write(`Downloading verified RMFD image ${index + 1}/${selected.length}\n`)
    return { record, image: await downloadVerifiedImage(record) }
  })

  const subjectOrder = new Map(eligibleSubjects.map(([subject], index) => [subject, `s${String(index + 1).padStart(3, '0')}`]))
  const perSubjectImageIndex = new Map()
  const manifestRecords = []
  for (const { record, image } of downloaded) {
    const subjectId = subjectOrder.get(record.subject)
    const imageIndex = (perSubjectImageIndex.get(subjectId) ?? 0) + 1
    perSubjectImageIndex.set(subjectId, imageIndex)
    const fileName = `${subjectId}_${String(imageIndex).padStart(2, '0')}.jpg`
    await writeFile(join(imageDir, fileName), image.buffer)
    manifestRecords.push({
      subjectId,
      category: 'masked',
      relativePath: `images/${fileName}`,
      width: image.width,
      height: image.height,
      bytes: image.buffer.length,
      sha256: image.sha256,
    })
  }

  await writeFile(manifestPath, `${JSON.stringify({
    source: 'Real-World Masked Face Dataset (RMFD), RWMFD_part_1',
    sourceRepository,
    sourceCommit,
    sourceImagesAvailable: [...bySubject.values()].reduce((sum, images) => sum + images.length, 0),
    selection: 'All identities in RWMFD_part_1; five images per identity by deterministic SHA-256 ordering',
    selectedSubjects: eligibleSubjects.length,
    imagesPerSubject,
    selectedImages: manifestRecords.length,
    verification: 'GitHub tree size and Git blob SHA-1 verified for every file; downloaded bytes also hashed with SHA-256',
    records: manifestRecords,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${eligibleSubjects.length} RMFD identities and ${manifestRecords.length} verified transient real-mask images.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
