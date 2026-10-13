import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkRoot = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkRoot, '.staging')
const stagingDir = join(stagingRoot, 'angle-challenge')
const selectedDir = join(stagingDir, 'images')
const probeArchivePath = join(stagingRoot, 'pointing-sample.tar.gz')
const sourceConfig = JSON.parse(await readFile(join(benchmarkRoot, 'sources.json'), 'utf8'))
const source = sourceConfig.sources.find((item) => item.id === 'pointing04-figshare-v2')
if (!source) throw new Error('Pointing04 source configuration is missing')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe angle-challenge staging path')
if (!resolve(probeArchivePath).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe probe archive path')

async function download(url, outputPath) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '180', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', outputPath, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else files.push(path)
  }
  return files
}

await rm(stagingDir, { recursive: true, force: true })
await rm(probeArchivePath, { force: true })
await mkdir(selectedDir, { recursive: true })

try {
  const metadataPath = join(stagingDir, 'figshare-article.json')
  await download(source.metadataApi, metadataPath)
  const article = JSON.parse(await readFile(metadataPath, 'utf8'))
  await rm(metadataPath, { force: true })
  const archives = article.files
    .filter((file) => /^Person(?:0[1-9]|1[0-5])-2\.tar\.gz$/.test(file.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  if (archives.length !== 15) throw new Error(`Expected 15 Pointing04 archives, found ${archives.length}`)

  const verifiedArchives = []
  const records = []
  for (const [index, archive] of archives.entries()) {
    const subjectId = String(index + 1).padStart(2, '0')
    const archivePath = join(stagingDir, archive.name)
    const extractDir = join(stagingDir, `extract-${subjectId}`)
    try {
      process.stdout.write(`Downloading verified multi-angle subject ${index + 1}/${archives.length}\n`)
      await download(archive.download_url, archivePath)
      const archiveStat = await stat(archivePath)
      if (archiveStat.size !== archive.size) throw new Error(`${archive.name} size mismatch`)
      const bytes = await readFile(archivePath)
      const md5 = createHash('md5').update(bytes).digest('hex')
      if (md5 !== archive.supplied_md5) throw new Error(`${archive.name} MD5 mismatch`)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const { stdout: listing } = await execFileAsync('tar.exe', ['-tzf', archivePath], { maxBuffer: 5 * 1024 * 1024 })
      const unsafe = listing.split(/\r?\n/).filter(Boolean).find((entry) => entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..'))
      if (unsafe) throw new Error(`Unsafe archive entry: ${unsafe}`)
      await mkdir(extractDir, { recursive: true })
      await execFileAsync('tar.exe', ['-xzf', archivePath, '-C', extractDir])
      const selected = (await listFiles(extractDir)).filter((path) => /\+0[+-](?:0|15|30|45|60|75|90)\.jpe?g$/i.test(path))
      if (selected.length !== 13) throw new Error(`Expected 13 horizontal views in ${archive.name}, found ${selected.length}`)
      const subjectDir = join(selectedDir, `subject-${subjectId}`)
      await mkdir(subjectDir, { recursive: true })
      const angles = {}
      for (const inputPath of selected) {
        const match = /\+0([+-](?:0|15|30|45|60|75|90))\.jpe?g$/i.exec(inputPath)
        if (!match) throw new Error(`Unable to parse horizontal angle: ${inputPath}`)
        const angle = Number(match[1])
        const outputPath = join(subjectDir, `angle-${angle < 0 ? 'neg' : 'pos'}-${Math.abs(angle)}.jpg`)
        await copyFile(inputPath, outputPath)
        angles[String(angle)] = outputPath
      }
      if (Object.keys(angles).length !== 13) throw new Error(`Duplicate or missing angles in ${archive.name}`)
      records.push({ subjectId, angles })
      verifiedArchives.push({ name: archive.name, bytes: archive.size, md5, sha256 })
    } finally {
      await rm(archivePath, { force: true })
      await rm(extractDir, { recursive: true, force: true })
    }
  }
  for (const record of records) await Promise.all(Object.values(record.angles).map((path) => access(path)))
  await writeFile(join(stagingDir, 'manifest.json'), `${JSON.stringify({
    policyVersion: 'HEADUP-ANGLE-CHALLENGE-INPUT-1.0',
    source: { id: source.id, name: source.name, doi: source.doi, license: source.license },
    records,
    verifiedArchives,
    expectedImages: records.length * 13,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${records.length * 13} verified real multi-angle portraits from ${records.length} subjects.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
