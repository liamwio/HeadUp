import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'exif-orientation')
const extractDir = join(stagingDir, 'source')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
const allowedRoot = resolve(stagingRoot) + sep
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe EXIF staging path')

const source = {
  name: 'Face Research Lab London Set neutral front',
  url: 'https://ndownloader.figshare.com/files/8541961',
  bytes: 33_860_607,
  md5: '236c1c94defbb34a79074b195841cfd6',
  license: 'CC BY 4.0 research control',
}

function digest(algorithm, value) { return createHash(algorithm).update(value).digest('hex') }
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
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-EXIF-Audit/1.0', '--output', archivePath, source.url], { maxBuffer: 2 * 1024 * 1024 })
  const archive = await readFile(archivePath)
  if (archive.length !== source.bytes || digest('md5', archive) !== source.md5) throw new Error('London EXIF source integrity mismatch')
  const { stdout } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 5 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe London EXIF entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir])
  await rm(archivePath, { force: true })
  const candidates = (await recursiveFiles(extractDir)).filter((path) => /^\d{3}_\d{2}\.jpg$/i.test(basename(path)))
    .sort((left, right) => digest('sha256', basename(left)).localeCompare(digest('sha256', basename(right))))
    .slice(0, 20)
  if (candidates.length !== 20) throw new Error(`Insufficient EXIF source images: ${candidates.length}`)
  const records = []
  for (const [index, path] of candidates.entries()) {
    const { data } = await sharp(path).resize(1080, 1350, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const raw = { width: 1080, height: 1350, channels: 3 }
    const variants = [
      { orientation: 1, rotation: 0, encodedWidth: 1080, encodedHeight: 1350 },
      { orientation: 3, rotation: 180, encodedWidth: 1080, encodedHeight: 1350 },
      { orientation: 6, rotation: 270, encodedWidth: 1350, encodedHeight: 1080 },
      { orientation: 8, rotation: 90, encodedWidth: 1350, encodedHeight: 1080 },
    ]
    for (const variant of variants) {
      const sampleId = `exif-${String(index + 1).padStart(3, '0')}-o${variant.orientation}`
      const outputPath = join(imageDir, `${sampleId}.jpg`)
      let pipeline = sharp(data, { raw })
      if (variant.rotation) pipeline = pipeline.rotate(variant.rotation)
      await pipeline.withMetadata({ orientation: variant.orientation }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(outputPath)
      const metadata = await sharp(outputPath).metadata()
      if (metadata.width !== variant.encodedWidth || metadata.height !== variant.encodedHeight || metadata.orientation !== variant.orientation) {
        throw new Error(`EXIF encoded contract mismatch: ${sampleId}`)
      }
      const bytes = await readFile(outputPath)
      records.push({
        sampleId,
        group: `group-${String(index + 1).padStart(3, '0')}`,
        orientation: variant.orientation,
        relativePath: relative(stagingDir, outputPath).replaceAll('\\', '/'),
        encodedWidth: variant.encodedWidth,
        encodedHeight: variant.encodedHeight,
        expectedDisplayWidth: 1080,
        expectedDisplayHeight: 1350,
        bytes: (await stat(outputPath)).size,
        sha256: digest('sha256', bytes),
      })
    }
  }
  const manifest = {
    policyVersion: 'HEADUP-EXIF-ORIENTATION-PREPARE-1.0',
    source,
    selection: { sourceImages: 20, variantsPerImage: 4, encodedImages: records.length, rule: 'filename SHA-256 first 20; source identifiers replaced by sequential groups' },
    protocol: { orientations: [1, 3, 6, 8], expectedDisplay: '1080x1350', jpegQuality: 95 },
    records,
    retention: { sourceNamesRetainedInFinal: false, individualPredictionsRetainedInFinal: false },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(extractDir, { recursive: true, force: true })
  process.stdout.write(`Prepared ${records.length} transient EXIF variants from 20 real front images.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
