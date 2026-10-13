import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'icc-color-encoding')
const extractDir = join(stagingDir, 'source')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}${sep}`)) throw new Error('Unsafe ICC staging path')

const source = {
  name: 'Face Research Lab London Set neutral front',
  url: 'https://ndownloader.figshare.com/files/8541961',
  bytes: 33_860_607,
  md5: '236c1c94defbb34a79074b195841cfd6',
  license: 'CC BY 4.0 research control',
}
const variants = [
  { id: 'srgb_baseline_444', profile: 'srgb', attach: true, progressive: false, chromaSubsampling: '4:4:4' },
  { id: 'untagged_srgb_444', profile: 'srgb', attach: false, progressive: false, chromaSubsampling: '4:4:4' },
  { id: 'p3_tagged_444', profile: 'p3', attach: true, progressive: false, chromaSubsampling: '4:4:4' },
  { id: 'srgb_progressive_420', profile: 'srgb', attach: true, progressive: true, chromaSubsampling: '4:2:0' },
  { id: 'p3_progressive_420', profile: 'p3', attach: true, progressive: true, chromaSubsampling: '4:2:0' },
]
const digest = (algorithm, value) => createHash(algorithm).update(value).digest('hex')
async function recursiveFiles(dir) {
  const output = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) output.push(...await recursiveFiles(path)); else output.push(path)
  }
  return output
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
await mkdir(imageDir, { recursive: true })
try {
  const archivePath = join(stagingDir, 'neutral_front.zip')
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-ICC-Audit/1.0', '--output', archivePath, source.url], { maxBuffer: 2 * 1024 * 1024 })
  const archive = await readFile(archivePath)
  if (archive.length !== source.bytes || digest('md5', archive) !== source.md5) throw new Error('London ICC source integrity mismatch')
  const { stdout } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 5 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe London ICC entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir])
  await rm(archivePath, { force: true })
  const candidates = (await recursiveFiles(extractDir)).filter((path) => /^\d{3}_\d{2}\.jpg$/i.test(basename(path)))
    .sort((left, right) => digest('sha256', basename(left)).localeCompare(digest('sha256', basename(right))))
    .slice(0, 20)
  if (candidates.length !== 20) throw new Error(`Insufficient ICC source images: ${candidates.length}`)
  const records = []
  for (const [index, sourcePath] of candidates.entries()) {
    const group = `group-${String(index + 1).padStart(3, '0')}`
    for (const variant of variants) {
      const sampleId = `${group}-${variant.id}`
      const outputPath = join(imageDir, `${sampleId}.jpg`)
      await sharp(sourcePath)
        .resize(1080, 1350, { fit: 'fill' })
        .removeAlpha()
        .withIccProfile(variant.profile, { attach: variant.attach })
        .jpeg({ quality: 95, chromaSubsampling: variant.chromaSubsampling, progressive: variant.progressive })
        .toFile(outputPath)
      const bytes = await readFile(outputPath)
      const metadata = await sharp(bytes).metadata()
      const iccBytes = metadata.icc?.length ?? 0
      if (metadata.width !== 1080 || metadata.height !== 1350 || metadata.format !== 'jpeg') throw new Error(`ICC geometry mismatch: ${sampleId}`)
      if (variant.attach !== (iccBytes > 0) || metadata.isProgressive !== variant.progressive || metadata.chromaSubsampling !== variant.chromaSubsampling) throw new Error(`ICC encoding contract mismatch: ${sampleId}`)
      records.push({
        sampleId, group, variant: variant.id,
        relativePath: relative(stagingDir, outputPath).replaceAll('\\', '/'),
        width: metadata.width, height: metadata.height,
        iccAttached: iccBytes > 0,
        iccSha256: metadata.icc ? digest('sha256', metadata.icc) : null,
        isProgressive: metadata.isProgressive,
        chromaSubsampling: metadata.chromaSubsampling,
        bytes: bytes.length,
        sha256: digest('sha256', bytes),
      })
    }
  }
  const byVariant = Object.fromEntries(variants.map((variant) => {
    const items = records.filter((record) => record.variant === variant.id)
    return [variant.id, {
      files: items.length,
      iccAttached: items.every((item) => item.iccAttached),
      iccSha256: [...new Set(items.map((item) => item.iccSha256))],
      progressive: items.every((item) => item.isProgressive),
      chromaSubsampling: [...new Set(items.map((item) => item.chromaSubsampling))],
    }]
  }))
  const manifest = {
    policyVersion: 'HEADUP-ICC-COLOR-PREPARE-1.0',
    source,
    protocol: { groups: 20, variants: variants.map((item) => item.id), totalImages: records.length, jpegQuality: 95, dimensions: '1080x1350' },
    encodingAudit: byVariant,
    records,
    retention: { sourceNamesRetainedInFinal: false, individualPredictionsRetainedInFinal: false, imagesRetainedInFinal: false },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(extractDir, { recursive: true, force: true })
  process.stdout.write(`Prepared ${records.length} transient ICC/color-encoding variants from 20 real front images.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
