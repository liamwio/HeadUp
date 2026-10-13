import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'openimages-glasses')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
const config = JSON.parse(await readFile(join(benchmarkDir, 'sources.json'), 'utf8'))
const source = config.sources.find((item) => item.id === 'openimages-v7-real-sunglasses')
const HUMAN_FACE = '/m/0dzct'
const GLASSES = '/m/0jyfg'
const SUNGLASSES = '/m/017ftj'
const DOWNLOAD_CANDIDATES = 220
const TARGET_IMAGES = 180
const MIN_IMAGES = 140
const MIN_SHORT_EDGE = 640

const hash = (algorithm, value) => createHash(algorithm).update(value).digest('hex')
const stableOrder = (value) => hash('sha256', `${source.annotations.map((item) => item.md5).join(':')}:glasses:${value}`)

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

function selectCandidates(csv, annotation) {
  const groups = new Map()
  for (const line of csv.split(/\r?\n/).slice(1)) {
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
  const candidates = []
  for (const [imageId, group] of groups) {
    if (group.faces.length !== 1) continue
    const face = group.faces[0]
    if (face.groupOf || face.depiction || face.inside) continue
    const glasses = group.glasses.filter((box) => !box.groupOf && !box.depiction && overlapFraction(box, face) >= 0.8)
    const sunglasses = group.sunglasses.filter((box) => !box.groupOf && !box.depiction && overlapFraction(box, face) >= 0.8)
    if (glasses.length === 0 || sunglasses.length > 0) continue
    const faceArea = (face.xMax - face.xMin) * (face.yMax - face.yMin)
    const faceCenterDistance = Math.hypot((face.xMin + face.xMax) / 2 - 0.5, (face.yMin + face.yMax) / 2 - 0.5)
    if (faceArea < 0.04 || faceCenterDistance > 0.32) continue
    const sizeBand = faceArea >= 0.18 ? 'close' : faceArea >= 0.08 ? 'standard' : 'context'
    const positionBand = faceCenterDistance <= 0.18 ? 'centered' : 'off_center'
    const annotationOcclusion = face.occluded || glasses.some((box) => box.occluded) ? 'occluded' : 'clear'
    const stratum = `${sizeBand}_${positionBand}_${annotationOcclusion}`
    candidates.push({
      imageId, split: annotation.split, imageBaseUrl: annotation.imageBaseUrl,
      faceArea, faceCenterDistance, sizeBand, positionBand, annotationOcclusion, stratum,
      samplingStratum: `${annotation.split}_${stratum}`,
      order: stableOrder(`${annotation.split}:${imageId}`),
    })
  }
  return candidates.sort((left, right) => left.order.localeCompare(right.order))
}

function roundRobin(candidates, limit) {
  const groups = Object.groupBy(candidates, (item) => item.samplingStratum)
  const keys = Object.keys(groups).sort()
  const selected = []
  for (let offset = 0; selected.length < limit; offset++) {
    let added = false
    for (const key of keys) {
      const item = groups[key]?.[offset]
      if (!item) continue
      selected.push(item)
      added = true
      if (selected.length === limit) break
    }
    if (!added) break
  }
  return selected
}

async function download(url, path, maxTime = '600') {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', maxTime, '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', path, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

if (!source) throw new Error('Open Images source configuration is missing')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe Open Images glasses staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })

try {
  const candidates = []
  const verifiedAnnotations = []
  for (const annotation of source.annotations) {
    const path = join(stagingDir, `${annotation.split}-annotations-bbox.csv`)
    await download(annotation.url, path)
    const bytes = await readFile(path)
    const digest = hash('md5', bytes)
    if (bytes.length !== annotation.bytes || digest !== annotation.md5) throw new Error(`${annotation.split} annotation verification failed`)
    candidates.push(...selectCandidates(bytes.toString('utf8'), annotation))
    verifiedAnnotations.push({ split: annotation.split, bytes: bytes.length, md5: digest })
    await rm(path, { force: true })
  }
  candidates.sort((left, right) => left.order.localeCompare(right.order))
  const candidateSummary = {
    candidates: candidates.length,
    bySplit: counts(candidates.map((item) => item.split)),
    byStratum: counts(candidates.map((item) => item.stratum)),
    bySizeBand: counts(candidates.map((item) => item.sizeBand)),
    byPositionBand: counts(candidates.map((item) => item.positionBand)),
    byAnnotationOcclusion: counts(candidates.map((item) => item.annotationOcclusion)),
  }
  const downloadSelection = roundRobin(candidates, DOWNLOAD_CANDIDATES)
  const usable = []
  let failedDownloads = 0
  let belowResolution = 0
  for (const [index, candidate] of downloadSelection.entries()) {
    if (usable.length >= TARGET_IMAGES) break
    if (index % 20 === 0) process.stdout.write(`Downloading ordinary-glasses candidate ${index + 1}/${downloadSelection.length}; retained ${usable.length}\n`)
    const temporaryPath = join(stagingDir, `download-${String(index + 1).padStart(4, '0')}.jpg`)
    try {
      await download(`${candidate.imageBaseUrl}/${candidate.imageId}.jpg`, temporaryPath, '120')
      const metadata = await sharp(temporaryPath, { limitInputPixels: 80_000_000 }).metadata()
      const width = metadata.autoOrient?.width ?? metadata.width
      const height = metadata.autoOrient?.height ?? metadata.height
      if (!width || !height) throw new Error('Image dimensions unavailable')
      if (Math.min(width, height) < MIN_SHORT_EDGE) {
        belowResolution++
        continue
      }
      const sampleId = `glasses-${String(usable.length + 1).padStart(4, '0')}`
      const fileName = `${sampleId}.jpg`
      const outputPath = join(imageDir, fileName)
      await sharp(temporaryPath, { limitInputPixels: 80_000_000 }).rotate().jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toFile(outputPath)
      const outputMetadata = await sharp(outputPath).metadata()
      usable.push({
        sampleId, split: candidate.split, relativePath: `images/${fileName}`,
        width: outputMetadata.width, height: outputMetadata.height,
        faceArea: Number(candidate.faceArea.toFixed(5)), faceCenterDistance: Number(candidate.faceCenterDistance.toFixed(5)),
        sizeBand: candidate.sizeBand, positionBand: candidate.positionBand,
        annotationOcclusion: candidate.annotationOcclusion, stratum: candidate.stratum,
      })
    } catch (error) {
      failedDownloads++
      process.stderr.write(`Skipped ordinary-glasses candidate ${index + 1}: ${error instanceof Error ? error.message : error}\n`)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
  if (usable.length < MIN_IMAGES) throw new Error(`Only ${usable.length} ordinary-glasses controls met the minimum; need ${MIN_IMAGES}`)
  await writeFile(manifestPath, `${JSON.stringify({
    source: 'Open Images V7 validation/test, Human face + Glasses boxes without a spatially overlapping Sunglasses box',
    publisher: source.publisher, sourcePage: source.sourcePage, annotations: verifiedAnnotations,
    selection: {
      candidateCriteria: 'exactly one non-depiction Human face; >=80%-contained Glasses box; no >=80%-contained Sunglasses box; face area >=4%; center distance <=0.32',
      labelLimitation: 'Absence of a Sunglasses box is not exhaustive proof of clear lenses; this is a nominal ordinary-glasses hard-negative proxy.',
      minimumShortEdgePixels: MIN_SHORT_EDGE, candidatesBeforeImageDownload: candidates.length,
      downloadCandidates: downloadSelection.length, failedDownloads, belowResolution,
      selectedImages: usable.length, candidateSummary,
    },
    records: usable,
    privacy: { sourceImageIdsRetained: false, sourceUrlsRetained: false, imageHashesRetained: false, originalMetadataRetained: false },
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${usable.length} anonymous ordinary-glasses controls; removed annotation CSVs and download temporaries.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
