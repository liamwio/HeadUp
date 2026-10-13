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
const stagingDir = join(stagingRoot, 'openimages-sunglasses')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
const config = JSON.parse(await readFile(join(benchmarkDir, 'sources.json'), 'utf8'))
const source = config.sources.find((item) => item.id === 'openimages-v7-real-sunglasses')
const probeOnly = process.argv.includes('--probe')
const HUMAN_FACE = '/m/0dzct'
const SUNGLASSES = '/m/017ftj'
const DOWNLOAD_CANDIDATES = 92
const TARGET_IMAGES = 92
const MIN_IMAGES = 60
const MIN_SHORT_EDGE = 640

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

function stableOrder(value) {
  return createHash('sha256').update(`${source.annotations.map((item) => item.md5).join(':')}:${value}`).digest('hex')
}

function parseBox(row) {
  return {
    label: row[2],
    xMin: Number(row[4]),
    xMax: Number(row[5]),
    yMin: Number(row[6]),
    yMax: Number(row[7]),
    occluded: row[8] === '1',
    truncated: row[9] === '1',
    groupOf: row[10] === '1',
    depiction: row[11] === '1',
    inside: row[12] === '1',
  }
}

function overlapFraction(inner, outer) {
  const width = Math.max(0, Math.min(inner.xMax, outer.xMax) - Math.max(inner.xMin, outer.xMin))
  const height = Math.max(0, Math.min(inner.yMax, outer.yMax) - Math.max(inner.yMin, outer.yMin))
  const area = (inner.xMax - inner.xMin) * (inner.yMax - inner.yMin)
  return area > 0 ? width * height / area : 0
}

function selectCandidates(csv, annotation) {
  const groups = new Map()
  const lines = csv.split(/\r?\n/)
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index]) continue
    const row = lines[index].split(',')
    if (row[2] !== HUMAN_FACE && row[2] !== SUNGLASSES) continue
    const group = groups.get(row[0]) ?? { faces: [], sunglasses: [] }
    const box = parseBox(row)
    if (box.label === HUMAN_FACE) group.faces.push(box)
    else group.sunglasses.push(box)
    groups.set(row[0], group)
  }

  const candidates = []
  for (const [imageId, group] of groups) {
    if (group.faces.length !== 1) continue
    const face = group.faces[0]
    if (face.groupOf || face.depiction || face.inside) continue
    const sunglasses = group.sunglasses.filter((box) => !box.groupOf && !box.depiction && overlapFraction(box, face) >= 0.8)
    if (sunglasses.length === 0) continue
    const faceArea = (face.xMax - face.xMin) * (face.yMax - face.yMin)
    const faceCenterDistance = Math.hypot((face.xMin + face.xMax) / 2 - 0.5, (face.yMin + face.yMax) / 2 - 0.5)
    if (faceArea < 0.04 || faceCenterDistance > 0.32) continue
    const sizeBand = faceArea >= 0.18 ? 'close' : faceArea >= 0.08 ? 'standard' : 'context'
    const positionBand = faceCenterDistance <= 0.18 ? 'centered' : 'off_center'
    const annotationOcclusion = face.occluded || sunglasses.some((box) => box.occluded) ? 'occluded' : 'clear'
    candidates.push({
      imageId,
      split: annotation.split,
      imageBaseUrl: annotation.imageBaseUrl,
      faceArea,
      faceCenterDistance,
      sizeBand,
      positionBand,
      annotationOcclusion,
      stratum: `${sizeBand}_${positionBand}_${annotationOcclusion}`,
      order: stableOrder(`${annotation.split}:${imageId}`),
    })
  }
  return candidates.sort((left, right) => left.order.localeCompare(right.order))
}

function roundRobinStrata(candidates, limit) {
  const groups = Object.groupBy(candidates, (item) => item.stratum)
  const keys = Object.keys(groups).sort()
  const selected = []
  for (let offset = 0; selected.length < limit; offset++) {
    let added = false
    for (const key of keys) {
      const candidate = groups[key]?.[offset]
      if (!candidate) continue
      selected.push(candidate)
      added = true
      if (selected.length === limit) break
    }
    if (!added) break
  }
  return selected
}

function counts(values) {
  const output = {}
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

async function download(url, path) {
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', '120', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
    '--output', path, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
}

if (!source) throw new Error('Open Images sunglasses source configuration is missing')
if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe Open Images sunglasses staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })

try {
  const verifiedAnnotations = []
  const candidates = []
  for (const annotation of source.annotations) {
    const annotationsPath = join(stagingDir, `${annotation.split}-annotations-bbox.csv`)
    await download(annotation.url, annotationsPath)
    const annotationBytes = await readFile(annotationsPath)
    if (annotationBytes.length !== annotation.bytes) throw new Error(`${annotation.split} annotation size mismatch: ${annotationBytes.length}`)
    const annotationMd5 = md5(annotationBytes)
    if (annotationMd5 !== annotation.md5) throw new Error(`${annotation.split} annotation checksum mismatch: ${annotationMd5}`)
    candidates.push(...selectCandidates(annotationBytes.toString('utf8'), annotation))
    verifiedAnnotations.push({ split: annotation.split, md5: annotationMd5, bytes: annotationBytes.length })
    await rm(annotationsPath, { force: true })
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
  if (probeOnly) {
    process.stdout.write(`${JSON.stringify(candidateSummary, null, 2)}\n`)
    await rm(stagingDir, { recursive: true, force: true })
    process.exit(0)
  }

  const downloadSelection = roundRobinStrata(candidates, DOWNLOAD_CANDIDATES)
  const usable = []
  let failedDownloads = 0
  let belowResolution = 0
  for (const [index, candidate] of downloadSelection.entries()) {
    if (usable.length >= TARGET_IMAGES) break
    if (index % 20 === 0) process.stdout.write(`Downloading Open Images sunglasses candidate ${index + 1}/${downloadSelection.length}; retained ${usable.length}\n`)
    const temporaryPath = join(stagingDir, `download-${String(index + 1).padStart(4, '0')}.jpg`)
    try {
      await download(`${candidate.imageBaseUrl}/${candidate.imageId}.jpg`, temporaryPath)
      const metadata = await sharp(temporaryPath, { limitInputPixels: 80_000_000 }).metadata()
      const width = metadata.autoOrient?.width ?? metadata.width
      const height = metadata.autoOrient?.height ?? metadata.height
      if (!width || !height) throw new Error('Image dimensions unavailable')
      if (Math.min(width, height) < MIN_SHORT_EDGE) {
        belowResolution++
        continue
      }
      const sampleId = `sample-${String(usable.length + 1).padStart(4, '0')}`
      const fileName = `${sampleId}.jpg`
      const outputPath = join(imageDir, fileName)
      await sharp(temporaryPath, { limitInputPixels: 80_000_000 }).rotate().jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toFile(outputPath)
      const outputMetadata = await sharp(outputPath).metadata()
      usable.push({
        sampleId,
        split: candidate.split,
        relativePath: `images/${fileName}`,
        width: outputMetadata.width,
        height: outputMetadata.height,
        faceArea: Number(candidate.faceArea.toFixed(5)),
        faceCenterDistance: Number(candidate.faceCenterDistance.toFixed(5)),
        sizeBand: candidate.sizeBand,
        positionBand: candidate.positionBand,
        annotationOcclusion: candidate.annotationOcclusion,
        stratum: candidate.stratum,
      })
    } catch (error) {
      failedDownloads++
      process.stderr.write(`Skipped candidate ${index + 1}: ${error instanceof Error ? error.message : error}\n`)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
  if (usable.length < MIN_IMAGES) throw new Error(`Only ${usable.length} usable sunglasses images met the minimum resolution; need ${MIN_IMAGES}`)
  await writeFile(manifestPath, `${JSON.stringify({
    source: source.name,
    publisher: source.publisher,
    sourcePage: source.sourcePage,
    annotations: verifiedAnnotations,
    annotationVersion: source.annotationVersion,
    selection: {
      candidateCriteria: 'exactly one non-depiction Human face box; at least one non-depiction Sunglasses box with >=80% of its area inside the face box; face area >=4%; face center distance <=0.32',
      minimumShortEdgePixels: MIN_SHORT_EDGE,
      candidatesBeforeImageDownload: candidates.length,
      downloadCandidates: downloadSelection.length,
      failedDownloads,
      belowResolution,
      selectedImages: usable.length,
      candidateSummary,
    },
    records: usable,
    privacy: { sourceImageIdsRetained: false, sourceUrlsRetained: false, imageHashesRetained: false, originalMetadataRetained: false },
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${usable.length} anonymous real-sunglasses images; removed annotation CSV and download temporaries.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
