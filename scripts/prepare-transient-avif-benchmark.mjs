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
const stagingDir = join(stagingRoot, 'avif-format')
const extractDir = join(stagingDir, 'source')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}${sep}`)) throw new Error('Unsafe AVIF staging path')
const source = { name: 'Face Research Lab London Set neutral front', url: 'https://ndownloader.figshare.com/files/8541961', bytes: 33_860_607, md5: '236c1c94defbb34a79074b195841cfd6', license: 'CC BY 4.0 research control' }
const digest = (algorithm, value) => createHash(algorithm).update(value).digest('hex')
async function recursiveFiles(dir) { const output = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) output.push(...await recursiveFiles(path)); else output.push(path) } return output }

await rm(stagingDir, { recursive: true, force: true }); await mkdir(extractDir, { recursive: true }); await mkdir(imageDir, { recursive: true })
try {
  const archivePath = join(stagingDir, 'neutral_front.zip')
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-AVIF-Audit/1.0', '--output', archivePath, source.url], { maxBuffer: 2 * 1024 * 1024 })
  const archive = await readFile(archivePath)
  if (archive.length !== source.bytes || digest('md5', archive) !== source.md5) throw new Error('London AVIF source integrity mismatch')
  const { stdout } = await execFileAsync('tar.exe', ['-tf', archivePath], { maxBuffer: 5 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe) throw new Error(`Unsafe London AVIF entry: ${unsafe}`)
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir]); await rm(archivePath, { force: true })
  const candidates = (await recursiveFiles(extractDir)).filter((path) => /^\d{3}_\d{2}\.jpg$/i.test(basename(path))).sort((left, right) => digest('sha256', basename(left)).localeCompare(digest('sha256', basename(right)))).slice(0, 20)
  if (candidates.length !== 20) throw new Error(`Insufficient AVIF source images: ${candidates.length}`)
  const records = []
  for (const [index, sourcePath] of candidates.entries()) {
    const group = `group-${String(index + 1).padStart(3, '0')}`
    const base = sharp(sourcePath).resize(1080, 1350, { fit: 'fill' }).removeAlpha().withIccProfile('srgb')
    const jpegPath = join(imageDir, `${group}-jpeg.jpg`); const avifPath = join(imageDir, `${group}-avif.avif`)
    await Promise.all([
      base.clone().jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(jpegPath),
      base.clone().avif({ quality: 90, effort: 4, chromaSubsampling: '4:4:4' }).toFile(avifPath),
    ])
    for (const [variant, path, mimeType] of [['jpeg95', jpegPath, 'image/jpeg'], ['avif90', avifPath, 'image/avif']]) {
      const bytes = await readFile(path); const metadata = await sharp(bytes).metadata()
      if (metadata.width !== 1080 || metadata.height !== 1350 || metadata.format !== (variant === 'avif90' ? 'heif' : 'jpeg')) throw new Error(`AVIF encoding mismatch: ${group}/${variant}/${metadata.format}`)
      records.push({ group, variant, mimeType, relativePath: relative(stagingDir, path).replaceAll('\\', '/'), width: metadata.width, height: metadata.height, bytes: bytes.length, sha256: digest('sha256', bytes) })
    }
  }
  const manifest = { policyVersion: 'HEADUP-AVIF-PREPARE-1.0', source, protocol: { groups: 20, baseline: 'JPEG95 4:4:4 sRGB', variant: 'AVIF90 effort4 4:4:4 sRGB', dimensions: '1080x1350', images: records.length }, records, retention: { sourceNamesRetainedInFinal: false, individualPredictionsRetainedInFinal: false } }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); await rm(extractDir, { recursive: true, force: true })
  process.stdout.write('Prepared 20 JPEG/AVIF real-face pairs.\n')
} catch (error) { await rm(stagingDir, { recursive: true, force: true }); throw error }
