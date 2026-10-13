import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'muct')
const archiveDir = join(stagingDir, 'archives')
const extractDir = join(stagingDir, 'extract')
const sampleDir = join(stagingDir, 'sample')
const manifestPath = join(stagingDir, 'sample-manifest.json')
const repository = 'StephenMilborrow/muct'
const githubApi = `https://api.github.com/repos/${repository}`
const subjectTarget = 120
const expectedRows = 3755
const expectedArchives = new Map([
  ['muct-a-jpg-v1.tar.gz', 56704046],
  ['muct-b-jpg-v1.tar.gz', 51240304],
  ['muct-c-jpg-v1.tar.gz', 54510112],
  ['muct-d-jpg-v1.tar.gz', 54694283],
  ['muct-e-jpg-v1.tar.gz', 57668862],
  ['muct-landmarks-v1.tar.gz', 7289792],
])

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe MUCT staging path')

async function githubJson(path) {
  const response = await fetch(`${githubApi}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HeadUp-Research-Benchmark/1.0' },
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}`)
  return response.json()
}

async function download(url, path) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', path, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function safeExtract(path) {
  const { stdout } = await execFileAsync('tar.exe', ['-tzf', path], { maxBuffer: 20 * 1024 * 1024 })
  const unsafe = stdout.split(/\r?\n/).filter(Boolean).find((entry) =>
    entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe archive entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xzf', path, '-C', extractDir], { maxBuffer: 2 * 1024 * 1024 })
}

async function findImage(name) {
  const candidates = [
    join(extractDir, 'jpg', `${name}.jpg`),
    join(extractDir, `${name}.jpg`),
  ]
  for (const path of candidates) {
    try {
      await readFile(path)
      return path
    } catch { /* try next canonical archive layout */ }
  }
  throw new Error(`Image missing after extraction: ${name}`)
}

function parseLandmarks(csv) {
  const lines = csv.trim().split(/\r?\n/)
  const header = lines[0].split(',')
  if (header.length !== 154 || header[0] !== 'name' || header[1] !== 'tag') {
    throw new Error(`Unexpected MUCT landmark header (${header.length} columns)`)
  }
  const rows = lines.slice(1).flatMap((line) => {
    const fields = line.split(',')
    if (fields.length !== header.length) throw new Error(`Malformed landmark row: ${fields[0]}`)
    if (/^ir\d{3}/i.test(fields[0])) return []
    const match = /^i(\d{3})([a-z])([abcde])-(.+)$/i.exec(fields[0])
    if (!match) throw new Error(`Unexpected MUCT image name: ${fields[0]}`)
    const points = Array.from({ length: 76 }, (_, index) => ({
      x: Number(fields[2 + index * 2]),
      y: Number(fields[3 + index * 2]),
    }))
    return [{
      name: fields[0], subject: match[1], light: match[2], camera: match[3].toLowerCase(), points,
    }]
  })
  if (rows.length * 2 !== lines.length - 1) throw new Error(`Expected one mirrored landmark row per original; found ${rows.length} originals in ${lines.length - 1} rows`)
  return rows
}

function pointSubset(points) {
  return {
    chin: points[7],
    viewerLeftEyeCenter: points[31],
    viewerRightEyeCenter: points[36],
    viewerLeftMouthCorner: points[48],
    viewerRightMouthCorner: points[54],
    noseTip: points[67],
  }
}

function subjectOrder(subject) {
  return createHash('sha256').update(`headup-muct-v1:${subject}`).digest('hex')
}

await rm(stagingDir, { recursive: true, force: true })
await Promise.all([mkdir(archiveDir, { recursive: true }), mkdir(extractDir, { recursive: true }), mkdir(sampleDir, { recursive: true })])

try {
  const commit = await githubJson('/commits/master')
  const contents = await githubJson(`/contents?ref=${commit.sha}`)
  const sources = contents.filter((item) => expectedArchives.has(item.name))
  if (sources.length !== expectedArchives.size) throw new Error(`Expected ${expectedArchives.size} MUCT archives, found ${sources.length}`)

  const verifiedArchives = []
  for (const [index, item] of sources.sort((a, b) => a.name.localeCompare(b.name, 'en')).entries()) {
    const expectedSize = expectedArchives.get(item.name)
    if (item.size !== expectedSize) throw new Error(`Unexpected size for ${item.name}: ${item.size}`)
    const archivePath = join(archiveDir, item.name)
    await download(`https://raw.githubusercontent.com/${repository}/${commit.sha}/${item.name}`, archivePath)
    const bytes = (await readFile(archivePath)).byteLength
    if (bytes !== expectedSize) throw new Error(`Downloaded size mismatch for ${item.name}: ${bytes}`)
    const digest = await sha256(archivePath)
    await safeExtract(archivePath)
    verifiedArchives.push({ name: item.name, bytes, gitBlobSha: item.sha, sha256: digest })
    await rm(archivePath, { force: true })
    process.stdout.write(`Verified and extracted ${index + 1}/${sources.length}: ${item.name}\n`)
  }

  const landmarkPath = join(extractDir, 'muct-landmarks', 'muct76-opencv.csv')
  const rows = parseLandmarks(await readFile(landmarkPath, 'utf8'))
  if (rows.length !== expectedRows) throw new Error(`Expected ${expectedRows} landmark rows, found ${rows.length}`)
  const bySubject = Object.groupBy(rows, (row) => row.subject)
  const eligible = Object.entries(bySubject).flatMap(([subject, subjectRows]) => {
    const byLight = Object.groupBy(subjectRows, (row) => row.light)
    const completeLights = Object.entries(byLight)
      .filter(([, lightRows]) => new Set(lightRows.map((row) => row.camera)).size === 5)
      .map(([light]) => light)
      .sort()
    return completeLights.length ? [{ subject, subjectRows, baseLight: completeLights[0] }] : []
  }).sort((left, right) => subjectOrder(left.subject).localeCompare(subjectOrder(right.subject)))
  if (eligible.length < subjectTarget) throw new Error(`Only ${eligible.length} subjects have a complete five-camera set`)

  const selectedSubjects = eligible.slice(0, subjectTarget)
  const selectedRows = selectedSubjects.flatMap(({ subject, subjectRows, baseLight }, subjectIndex) => {
    const baseRows = subjectRows.filter((row) => row.light === baseLight).sort((a, b) => a.camera.localeCompare(b.camera))
    const additionalFront = subjectRows.filter((row) => row.camera === 'a' && row.light !== baseLight).sort((a, b) => a.light.localeCompare(b.light))
    return [...baseRows, ...additionalFront].map((row) => ({
      ...row,
      subjectToken: `subject-${String(subjectIndex + 1).padStart(3, '0')}`,
      baseLight,
    }))
  })

  const records = []
  for (const [index, row] of selectedRows.entries()) {
    const extension = '.jpg'
    const file = `sample-${String(index + 1).padStart(4, '0')}${extension}`
    await copyFile(await findImage(row.name), join(sampleDir, file))
    records.push({
      file,
      subjectToken: row.subjectToken,
      camera: row.camera,
      light: row.light,
      baseLight: row.baseLight,
      manual: pointSubset(row.points),
    })
  }

  const cameraCounts = Object.fromEntries(Object.entries(Object.groupBy(records, (record) => record.camera)).map(([camera, items]) => [camera, items.length]))
  const manifest = {
    policyVersion: 'HEADUP-TRANSIENT-MUCT-1.0',
    source: {
      name: 'MUCT Landmarked Face Database',
      repository: `https://github.com/${repository}`,
      commit: commit.sha,
      paper: 'https://www.dip.ee.uct.ac.za/~nicolls/publish/sm10-prasa.pdf',
      use: 'Academic research; images must not be reproduced on public web pages',
    },
    selection: 'Deterministic SHA-256 subject order; 120 subjects with one complete five-camera lighting set, plus other available camera-a lighting sets',
    subjectCount: selectedSubjects.length,
    imageCount: records.length,
    cameraCounts,
    sourceArchives: verifiedArchives,
    records,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const extractedEntries = await readdir(extractDir)
  if (!extractedEntries.length) throw new Error('MUCT extraction unexpectedly empty')
  await rm(extractDir, { recursive: true, force: true })
  await rm(archiveDir, { recursive: true, force: true })
  process.stdout.write(`${JSON.stringify({ subjects: selectedSubjects.length, images: records.length, cameraCounts, manifest: manifestPath }, null, 2)}\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
