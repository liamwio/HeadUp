import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'openimages-glasses-probe')
const config = JSON.parse(await readFile(join(benchmarkDir, 'sources.json'), 'utf8'))
const source = config.sources.find((item) => item.id === 'openimages-v7-real-sunglasses')
const HUMAN_FACE = '/m/0dzct'
const GLASSES = '/m/0jyfg'
const SUNGLASSES = '/m/017ftj'

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

function parseBox(row) {
  return {
    label: row[2],
    xMin: Number(row[4]), xMax: Number(row[5]), yMin: Number(row[6]), yMax: Number(row[7]),
    occluded: row[8] === '1', groupOf: row[10] === '1', depiction: row[11] === '1', inside: row[12] === '1',
  }
}

function overlapFraction(inner, outer) {
  const width = Math.max(0, Math.min(inner.xMax, outer.xMax) - Math.max(inner.xMin, outer.xMin))
  const height = Math.max(0, Math.min(inner.yMax, outer.yMax) - Math.max(inner.yMin, outer.yMin))
  const area = (inner.xMax - inner.xMin) * (inner.yMax - inner.yMin)
  return area > 0 ? width * height / area : 0
}

function counts(values) {
  const output = {}
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

async function download(url, path) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '600', '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', path, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

if (!source) throw new Error('Open Images source configuration is missing')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe glasses-probe staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })

try {
  const candidates = []
  for (const annotation of source.annotations) {
    const path = join(stagingDir, `${annotation.split}-annotations-bbox.csv`)
    await download(annotation.url, path)
    const bytes = await readFile(path)
    if (bytes.length !== annotation.bytes || md5(bytes) !== annotation.md5) throw new Error(`${annotation.split} annotation verification failed`)
    const groups = new Map()
    for (const line of bytes.toString('utf8').split(/\r?\n/).slice(1)) {
      if (!line) continue
      const row = line.split(',')
      if (![HUMAN_FACE, GLASSES, SUNGLASSES].includes(row[2])) continue
      const group = groups.get(row[0]) ?? { faces: [], glasses: [], sunglasses: [] }
      const box = parseBox(row)
      if (box.label === HUMAN_FACE) group.faces.push(box)
      else if (box.label === GLASSES) group.glasses.push(box)
      else group.sunglasses.push(box)
      groups.set(row[0], group)
    }
    for (const group of groups.values()) {
      if (group.faces.length !== 1) continue
      const face = group.faces[0]
      if (face.groupOf || face.depiction || face.inside) continue
      const glasses = group.glasses.filter((box) => !box.groupOf && !box.depiction && overlapFraction(box, face) >= 0.8)
      const sunglasses = group.sunglasses.filter((box) => !box.groupOf && !box.depiction && overlapFraction(box, face) >= 0.8)
      if (glasses.length === 0 || sunglasses.length > 0) continue
      const faceArea = (face.xMax - face.xMin) * (face.yMax - face.yMin)
      const center = Math.hypot((face.xMin + face.xMax) / 2 - 0.5, (face.yMin + face.yMax) / 2 - 0.5)
      if (faceArea < 0.04 || center > 0.32) continue
      const sizeBand = faceArea >= 0.18 ? 'close' : faceArea >= 0.08 ? 'standard' : 'context'
      const positionBand = center <= 0.18 ? 'centered' : 'off_center'
      const annotationOcclusion = face.occluded || glasses.some((box) => box.occluded) ? 'occluded' : 'clear'
      candidates.push({ split: annotation.split, sizeBand, positionBand, annotationOcclusion, stratum: `${sizeBand}_${positionBand}_${annotationOcclusion}` })
    }
    await rm(path, { force: true })
  }
  process.stdout.write(`${JSON.stringify({
    candidates: candidates.length,
    bySplit: counts(candidates.map((item) => item.split)),
    byStratum: counts(candidates.map((item) => item.stratum)),
    bySizeBand: counts(candidates.map((item) => item.sizeBand)),
    byPositionBand: counts(candidates.map((item) => item.positionBand)),
    byAnnotationOcclusion: counts(candidates.map((item) => item.annotationOcclusion)),
  }, null, 2)}\n`)
  await rm(stagingDir, { recursive: true, force: true })
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
