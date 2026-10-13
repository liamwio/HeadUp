import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dbDir = fileURLToPath(new URL('../data/face-db-real-research/', import.meta.url))
const stagingDir = join(dbDir, '.staging')
const imageRoot = join(dbDir, 'images', 'face-research-lab-london-v5')
const sourceConfig = JSON.parse(await readFile(join(dbDir, 'sources.json'), 'utf8'))
const source = sourceConfig.sources[0]
const manifestPath = join(dbDir, 'manifest.jsonl')
const allowedArchiveRoot = resolve(stagingDir) + sep
const archivePaths = []

function powershellDownload(url, outputPath) {
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    "Invoke-WebRequest -Uri $env:HEADUP_DOWNLOAD_URL -OutFile $env:HEADUP_DOWNLOAD_PATH",
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
    env: { ...process.env, HEADUP_DOWNLOAD_URL: url, HEADUP_DOWNLOAD_PATH: outputPath },
  })
}

async function hashFile(path, algorithm) {
  const buffer = await readFile(path)
  return createHash(algorithm).update(buffer).digest('hex')
}

function assertSafeArchiveEntries(entries, archiveName) {
  for (const original of entries) {
    const entry = original.replaceAll('\\', '/')
    const segments = entry.split('/').filter(Boolean)
    if (
      entry.startsWith('/') ||
      entry.startsWith('\\') ||
      /^[a-zA-Z]:/.test(entry) ||
      segments.includes('..')
    ) {
      throw new Error(`Unsafe ZIP entry in ${archiveName}: ${original}`)
    }
  }
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

function partitionFor(subjectId) {
  const digest = createHash('sha256').update(`${source.id}:${subjectId}`).digest()
  return digest[0] % 5 === 0 ? 'holdout' : 'engineering_qa'
}

await mkdir(stagingDir, { recursive: true })
await mkdir(imageRoot, { recursive: true })
const runExtractDir = await mkdtemp(join(stagingDir, 'extract-'))
const collectedAt = new Date().toISOString()
const records = []

try {
  for (const selected of source.selectedFiles) {
    const archivePath = resolve(stagingDir, selected.name)
    if (!archivePath.startsWith(allowedArchiveRoot)) throw new Error(`Archive path escaped staging: ${archivePath}`)
    archivePaths.push(archivePath)

    let archiveExists = true
    try { await stat(archivePath) } catch { archiveExists = false }
    if (!archiveExists) powershellDownload(selected.downloadUrl, archivePath)

    const actualMd5 = await hashFile(archivePath, 'md5')
    if (actualMd5 !== selected.md5) {
      throw new Error(`MD5 mismatch for ${selected.name}: expected ${selected.md5}, received ${actualMd5}`)
    }

    const entries = execFileSync('tar.exe', ['-tf', archivePath], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean)
    assertSafeArchiveEntries(entries, selected.name)

    const extractDir = join(runExtractDir, selected.view)
    await mkdir(extractDir, { recursive: true })
    execFileSync('tar.exe', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' })

    const jpgs = (await walk(extractDir)).filter((path) => extname(path).toLowerCase() === '.jpg')
    for (const inputPath of jpgs) {
      const match = basename(inputPath).match(/^(\d{3})_\d{2}\.jpg$/i)
      if (!match) continue
      const subjectId = match[1]
      const outputName = `${subjectId}_${selected.view}.jpg`
      const outputPath = join(imageRoot, outputName)
      await copyFile(inputPath, outputPath)
      const imageStat = await stat(outputPath)
      const sha256 = await hashFile(outputPath, 'sha256')
      records.push({
        id: `london-v5-${subjectId}-${selected.view}`,
        pseudonymousSubjectId: `london-v5-${subjectId}`,
        relativePath: relative(dbDir, outputPath).replaceAll('\\', '/'),
        sha256,
        bytes: imageStat.size,
        mimeType: 'image/jpeg',
        width: null,
        height: null,
        sourceId: source.id,
        sourceFileId: selected.id,
        sourceFileName: selected.name,
        subjectType: source.subjectType,
        consentBasis: source.consentBasis,
        license: source.license,
        attribution: source.attribution,
        permittedUse: source.allowedUse,
        prohibitedUse: source.prohibitedUse,
        view: selected.view,
        expression: selected.expression,
        partition: partitionFor(subjectId),
        qualityStatus: 'unclassified',
        collectedAt,
        expiresAt: sourceConfig.expiresAt,
        policyVersion: sourceConfig.policyVersion,
      })
    }
  }

  records.sort((a, b) => a.id.localeCompare(b.id))
  const subjectViews = new Map()
  for (const record of records) {
    const views = subjectViews.get(record.pseudonymousSubjectId) || new Set()
    views.add(record.view)
    subjectViews.set(record.pseudonymousSubjectId, views)
  }
  const expectedViews = source.selectedFiles.length
  const incomplete = [...subjectViews].filter(([, views]) => views.size !== expectedViews)
  if (subjectViews.size !== 102 || records.length !== 102 * expectedViews || incomplete.length) {
    throw new Error(`Unexpected corpus shape: subjects=${subjectViews.size}, records=${records.length}, incomplete=${incomplete.length}`)
  }

  const tempManifest = `${manifestPath}.tmp`
  await writeFile(tempManifest, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  await rename(tempManifest, manifestPath)
  if (!process.argv.includes('--keep-archives')) {
    for (const archivePath of archivePaths) await rm(archivePath, { force: true })
  }
} finally {
  const resolvedExtract = resolve(runExtractDir)
  if (resolvedExtract.startsWith(allowedArchiveRoot)) await rm(resolvedExtract, { recursive: true, force: true })
}

const subjects = new Set(records.map((record) => record.pseudonymousSubjectId))
const partitions = Object.groupBy(records, (record) => record.partition)
process.stdout.write(JSON.stringify({
  source: source.name,
  subjects: subjects.size,
  images: records.length,
  views: Object.fromEntries(Object.entries(Object.groupBy(records, (record) => record.view)).map(([key, value]) => [key, value.length])),
  partitions: Object.fromEntries(Object.entries(partitions).map(([key, value]) => [key, value.length])),
  manifestPath,
}, null, 2) + '\n')
