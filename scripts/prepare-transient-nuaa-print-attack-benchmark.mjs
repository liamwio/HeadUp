import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkRoot = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkRoot, '.staging')
const stagingDir = join(stagingRoot, 'nuaa-print-attack')
const extractedRoot = join(stagingDir, 'selected')
const modelDir = join(stagingDir, 'model')
const manifestPath = join(stagingDir, 'manifest.json')
const probeZipPath = join(stagingRoot, 'nuaa-probe.zip')
const probeMetaPath = join(stagingRoot, 'nuaa-probe-meta')
const zipPath = join(stagingDir, 'Detectedface.zip')
const modelPath = join(modelDir, 'anti-spoof-mn3.onnx')
const source = {
  name: 'NUAA Photograph Imposter Database, detected-face format',
  officialPage: 'https://parnec.nuaa.edu.cn/_upload/tpl/02/db/731/template731/pages/xtan/NUAAImposterDB_download.html',
  officialDriveFileId: '1oE6yv-RYV5_4HDjUo6F8mJofzrW_tdTo',
  downloadUrl: 'https://drive.usercontent.google.com/download?id=1oE6yv-RYV5_4HDjUo6F8mJofzrW_tdTo&export=download&confirm=t',
  licenseBoundary: 'Research use only; no commercial use or redistribution',
  bytes: 74708430,
  sha256: 'a95d1130edebe31e002c19c0dfac1c2fc5cf52a82c11019928d414fdbffa5e83',
  checksumNote: 'Transport fingerprint recorded by HeadUp on 2026-08-15; not a publisher-supplied checksum',
}
const model = {
  name: 'Open Model Zoo anti-spoof-mn3',
  sourceCommit: '7cc29a91472b4cb1289a11e655ba3e188e1d4a31',
  url: 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/anti-spoof-mn3/anti-spoof-mn3.onnx',
  bytes: 12270179,
  sha256: 'c4c99af04603b62d7e44f6f4daeb33e0daeccc696008c0b1d62f6f5cebbb3262',
  sha384: '6de4534964b723397b3e8c995cadcf43bc007cc2f9930b95ae25f76adccece5d1d4d058d0b15117b9e4a9f758424f92a',
  license: 'MIT original model; Apache-2.0 Open Model Zoo packaging',
}
const listSpecs = [
  { archiveName: 'Detectedface/client_train_face.txt', split: 'engineering', kind: 'bona_fide', expected: 1743, selected: 360, imageRoot: 'ClientFace' },
  { archiveName: 'Detectedface/imposter_train_face.txt', split: 'engineering', kind: 'print_attack', expected: 1748, selected: 360, imageRoot: 'ImposterFace' },
  { archiveName: 'Detectedface/client_test_face.txt', split: 'holdout', kind: 'bona_fide', expected: 3362, selected: 600, imageRoot: 'ClientFace' },
  { archiveName: 'Detectedface/imposter_test_face.txt', split: 'holdout', kind: 'print_attack', expected: 5761, selected: 600, imageRoot: 'ImposterFace' },
]

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe NUAA staging path')
if (!resolve(probeZipPath).startsWith(`${resolve(stagingRoot)}\\`) || !resolve(probeMetaPath).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe NUAA probe path')

async function digestFile(algorithm, path) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, outputPath) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', outputPath, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

function parseList(text, spec) {
  const records = text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const relativePath = line.trim().split(/\s+/)[0].replaceAll('\\', '/')
    const match = /^(\d{4})\/(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d+)\.jpg$/i.exec(relativePath)
    if (!match || match[1] !== match[2]) throw new Error(`Unexpected NUAA record path: ${relativePath}`)
    return {
      subjectId: match[1], glasses: match[3], position: match[4], session: match[5], frameNumber: Number(match[6]),
      archivePath: `Detectedface/${spec.imageRoot}/${relativePath}`,
      split: spec.split, kind: spec.kind,
    }
  })
  if (records.length !== spec.expected) throw new Error(`${spec.archiveName} expected ${spec.expected}, found ${records.length}`)
  return records
}

function evenlySpaced(items, count) {
  if (count >= items.length) return [...items]
  return Array.from({ length: count }, (_value, index) => items[Math.min(items.length - 1, Math.floor((index + 0.5) * items.length / count))])
}

function stratifiedSample(records, count) {
  const groups = Object.groupBy(records, (record) => `${record.subjectId}|${record.glasses}|${record.position}|${record.session}`)
  const groupEntries = Object.entries(groups).sort(([left], [right]) => left.localeCompare(right, 'en'))
  const allocations = new Map(groupEntries.map(([key]) => [key, Math.floor(count / groupEntries.length)]))
  let remainder = count - [...allocations.values()].reduce((sum, value) => sum + value, 0)
  for (const [key] of groupEntries) { if (remainder-- <= 0) break; allocations.set(key, allocations.get(key) + 1) }
  const selected = groupEntries.flatMap(([key, items]) => evenlySpaced([...items].sort((left, right) => left.frameNumber - right.frameNumber), Math.min(items.length, allocations.get(key))))
  if (selected.length !== count) throw new Error(`Unable to produce ${count} stratified NUAA records; selected ${selected.length}`)
  return selected
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(modelDir, { recursive: true })
await mkdir(extractedRoot, { recursive: true })

try {
  let reusedProbe = false
  try {
    const probeStat = await stat(probeZipPath)
    if (probeStat.size === source.bytes && await digestFile('sha256', probeZipPath) === source.sha256) {
      await rename(probeZipPath, zipPath)
      reusedProbe = true
    }
  } catch { /* download a clean copy */ }
  await rm(probeMetaPath, { recursive: true, force: true })
  if (!reusedProbe) await download(source.downloadUrl, zipPath)
  const zipStat = await stat(zipPath)
  const zipSha256 = await digestFile('sha256', zipPath)
  if (zipStat.size !== source.bytes || zipSha256 !== source.sha256) throw new Error('NUAA Detectedface.zip integrity mismatch')

  const { stdout: listing } = await execFileAsync('tar.exe', ['-tf', zipPath], { maxBuffer: 20 * 1024 * 1024 })
  const archiveEntries = listing.split(/\r?\n/).filter(Boolean)
  const unsafe = archiveEntries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe NUAA archive entry: ${unsafe}`)

  const selectedRecords = []
  for (const spec of listSpecs) {
    const { stdout } = await execFileAsync('tar.exe', ['-xOf', zipPath, spec.archiveName], { maxBuffer: 2 * 1024 * 1024 })
    selectedRecords.push(...stratifiedSample(parseList(stdout, spec), spec.selected))
  }
  const uniquePaths = [...new Set(selectedRecords.map((record) => record.archivePath))]
  if (uniquePaths.length !== selectedRecords.length) throw new Error('Duplicate NUAA source image selected across splits')
  const archiveEntrySet = new Set(archiveEntries)
  const missing = uniquePaths.find((path) => !archiveEntrySet.has(path))
  if (missing) throw new Error(`Selected NUAA image missing from archive: ${missing}`)
  for (let index = 0; index < uniquePaths.length; index += 80) {
    await execFileAsync('tar.exe', ['-xf', zipPath, '-C', extractedRoot, ...uniquePaths.slice(index, index + 80)], { maxBuffer: 2 * 1024 * 1024 })
  }
  await Promise.all(selectedRecords.map((record) => access(join(extractedRoot, record.archivePath))))
  await rm(zipPath, { force: true })

  await download(model.url, modelPath)
  const [modelStat, modelSha256, modelSha384] = await Promise.all([stat(modelPath), digestFile('sha256', modelPath), digestFile('sha384', modelPath)])
  if (modelStat.size !== model.bytes || modelSha256 !== model.sha256 || modelSha384 !== model.sha384) throw new Error('anti-spoof-mn3 integrity mismatch')

  const publicRecords = selectedRecords.map((record) => ({
    split: record.split, kind: record.kind, subjectGroup: record.subjectId,
    glasses: record.glasses, position: record.position, session: record.session,
    path: join(extractedRoot, record.archivePath),
  }))
  await writeFile(manifestPath, `${JSON.stringify({
    policyVersion: 'HEADUP-NUAA-PRINT-PREPARE-1.0', source: { ...source, sha256: zipSha256 }, model,
    population: { bonaFide: 5105, printAttack: 7509, sessions: 3, officialSplit: 'sessions 1/2 engineering, session 3 holdout; identities overlap' },
    selection: Object.fromEntries(listSpecs.map((spec) => [`${spec.split}_${spec.kind}`, { available: spec.expected, selected: spec.selected }])),
    records: publicRecords,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${publicRecords.length} stratified NUAA real/print-attack portraits and verified anti-spoof-mn3.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
