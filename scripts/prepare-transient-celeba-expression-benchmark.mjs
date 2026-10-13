import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkDir = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkDir, '.staging')
const stagingDir = join(stagingRoot, 'celeba-expression')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
const realResearchDir = join(projectDir, 'data', 'face-db-real-research')
const realManifestPath = join(realResearchDir, 'manifest.jsonl')
const v2 = process.argv.includes('--v2')
const feiDir = join(stagingDir, 'fei-neutral')
const feiArchives = [
  { name: 'originalimages_part1.zip', bytes: 86_857_988, sha256: '1d0b0ebe94278a5677edc450251f91450dadb821d9774edc111ad1be0e7475ed' },
  { name: 'originalimages_part2.zip', bytes: 89_176_109, sha256: '993c2a48ac38c64824c619cbcdb0700598786aa2fa20a76f4b199457c8662e69' },
  { name: 'originalimages_part3.zip', bytes: 88_206_682, sha256: '65d282b338001e4ece78944b751d5d78d94eddfacf2c734cf8530bcd6435e252' },
  { name: 'originalimages_part4.zip', bytes: 89_251_729, sha256: 'dd82ed2b475781dd4e829fb964923eb3a69e6f413f0e05ae694e65fce9fbe44f' },
].map((item) => ({ ...item, url: `https://fei.edu.br/~cet/${item.name}` }))

const dataset = 'Aleksandar/Celeba-Identity-Aligned-512'
const datasetCommit = '6d771f25291e854076ea284e2757844703148ab7'
const datasetPage = `https://huggingface.co/datasets/${dataset}`
const datasetApi = 'https://datasets-server.huggingface.co/rows'
const splitSizes = { train: 3072, test: 470 }
const engineeringPerStratum = 20
const metadataPageSize = 100

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isPositive(value) {
  return value === true || value === 1
}

function stratumOf(row) {
  return `${isPositive(row.Smiling) ? 1 : 0}${isPositive(row.Mouth_Slightly_Open) ? 1 : 0}${isPositive(row.Narrow_Eyes) ? 1 : 0}`
}

function presentationBucket(row) {
  return [row.Male, row.Young, row.Eyeglasses, row.Heavy_Makeup].map((value) => isPositive(value) ? 1 : 0).join('')
}

async function curlJson(url) {
  const { stdout } = await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '8', '--retry-all-errors',
    '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '180',
    '--user-agent', 'HeadUp-Research-Benchmark/1.0', url,
  ], { maxBuffer: 25 * 1024 * 1024 })
  return JSON.parse(stdout)
}

async function loadSplit(split, total) {
  const offsets = Array.from({ length: Math.ceil(total / metadataPageSize) }, (_, index) => index * metadataPageSize)
  const pages = new Array(offsets.length)
  let cursor = 0
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < offsets.length) {
      const index = cursor++
      const offset = offsets[index]
      process.stdout.write(`Reading ${split} metadata ${offset + 1}/${total}\n`)
      const length = Math.min(metadataPageSize, total - offset)
      const url = `${datasetApi}?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}&offset=${offset}&length=${length}`
      const payload = await curlJson(url)
      pages[index] = payload.rows.map((record) => ({ rowIndex: record.row_idx, ...record.row }))
    }
  }))
  const rows = pages.flat().sort((left, right) => left.rowIndex - right.rowIndex)
  if (rows.length !== total) throw new Error(`Unexpected ${split} metadata count: ${rows.length}`)
  return rows
}

function selectBalanced(rows, split) {
  const target = engineeringPerStratum
  const selected = []
  const usedIdentities = new Set()
  const strata = ['000', '001', '010', '011', '100', '101', '110', '111']
    .sort((left, right) => rows.filter((row) => stratumOf(row) === left).length - rows.filter((row) => stratumOf(row) === right).length)
  for (const stratum of strata) {
    const candidates = rows
      .filter((row) => stratumOf(row) === stratum && !isPositive(row.Blurry))
      .sort((left, right) => sha256(`${datasetCommit}:${split}:${left.rowIndex}`).localeCompare(sha256(`${datasetCommit}:${split}:${right.rowIndex}`)))
    const buckets = new Map()
    for (const candidate of candidates) {
      const key = presentationBucket(candidate)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(candidate)
    }
    const keys = [...buckets.keys()].sort((left, right) => sha256(`${stratum}:${left}`).localeCompare(sha256(`${stratum}:${right}`)))
    const stratumSelected = []
    while (stratumSelected.length < target && keys.some((key) => buckets.get(key).length > 0)) {
      for (const key of keys) {
        let next
        do next = buckets.get(key).shift()
        while (next && usedIdentities.has(next.identity_id))
        if (next) {
          stratumSelected.push(next)
          usedIdentities.add(next.identity_id)
        }
        if (stratumSelected.length === target) break
      }
    }
    if (stratumSelected.length !== target) {
      throw new Error(`Insufficient ${split} samples for expression stratum ${stratum}: ${stratumSelected.length}/${target}`)
    }
    selected.push(...stratumSelected)
  }
  return selected
}

function selectNaturalHoldout(rows) {
  const selected = rows
    .filter((row) => !isPositive(row.Blurry))
    .sort((left, right) => sha256(`${datasetCommit}:test:${left.rowIndex}`).localeCompare(sha256(`${datasetCommit}:test:${right.rowIndex}`)))
  const coverage = {
    neutral: selected.filter((row) => !isPositive(row.Smiling) && !isPositive(row.Mouth_Slightly_Open)).length,
    smiling: selected.filter((row) => isPositive(row.Smiling)).length,
    mouthSlightlyOpen: selected.filter((row) => isPositive(row.Mouth_Slightly_Open)).length,
    narrowEyesSafetyControl: selected.filter((row) => isPositive(row.Narrow_Eyes)).length,
  }
  if (selected.length < 400 || coverage.neutral < 30 || coverage.smiling < 30 || coverage.mouthSlightlyOpen < 30) {
    throw new Error(`Insufficient natural holdout marginal coverage: ${JSON.stringify({ selected: selected.length, ...coverage })}`)
  }
  return selected
}

function counts(records, getter) {
  const output = {}
  for (const record of records) {
    const key = getter(record)
    output[key] = (output[key] ?? 0) + 1
  }
  return output
}

async function downloadRecord(record, index) {
  const splitCode = record.split === 'train' ? 'eng' : 'hold'
  const sampleId = `${splitCode}-${String(index + 1).padStart(4, '0')}`
  const fileName = `${sampleId}.jpg`
  const outputPath = join(imageDir, fileName)
  const imageUrl = record.img?.src
  if (!imageUrl || !imageUrl.includes(datasetCommit)) throw new Error(`Unexpected image URL for ${sampleId}`)
  await execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '8', '--retry-all-errors',
    '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '180',
    '--user-agent', 'HeadUp-Research-Benchmark/1.0', '--output', outputPath, imageUrl,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const image = await readFile(outputPath)
  const metadata = await sharp(image).metadata()
  if (metadata.width !== 512 || metadata.height !== 512) throw new Error(`Unexpected ${sampleId} dimensions: ${metadata.width}x${metadata.height}`)
  return {
    sampleId,
    subjectId: record.transientSubjectId,
    split: record.split === 'train' ? 'engineering' : 'holdout',
    relativePath: `images/${fileName}`,
    width: metadata.width,
    height: metadata.height,
    sha256: sha256(image),
    labels: {
      smiling: isPositive(record.Smiling),
      mouthSlightlyOpen: isPositive(record.Mouth_Slightly_Open),
      narrowEyes: isPositive(record.Narrow_Eyes),
    },
    coverage: {
      masculinePresentationProxy: isPositive(record.Male),
      youngAppearanceProxy: isPositive(record.Young),
      eyeglasses: isPositive(record.Eyeglasses),
      heavyMakeup: isPositive(record.Heavy_Makeup),
    },
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await mapper(items[index], index)
      if ((index + 1) % 25 === 0 || index + 1 === items.length) process.stdout.write(`Downloaded ${index + 1}/${items.length}\n`)
    }
  }))
  return output
}

async function prepareFeiNeutralControls() {
  await mkdir(feiDir, { recursive: true })
  const sourceArchives = []
  for (const archive of feiArchives) {
    const path = join(stagingDir, archive.name)
    process.stdout.write(`Downloading V2 FEI neutral source ${archive.name}\n`)
    await execFileAsync('curl.exe', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
      '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Expression-V2/1.0',
      '--output', path, archive.url,
    ], { maxBuffer: 2 * 1024 * 1024 })
    const bytes = await readFile(path)
    const hash = sha256(bytes)
    if (bytes.length !== archive.bytes || hash !== archive.sha256) throw new Error(`FEI archive mismatch: ${archive.name}`)
    const { stdout } = await execFileAsync('tar.exe', ['-tf', path], { maxBuffer: 2 * 1024 * 1024 })
    const entries = stdout.split(/\r?\n/).filter(Boolean)
    const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\')
      || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
    if (unsafe || entries.length !== 700 || entries.some((entry) => !/^\d{1,3}-\d{2}\.jpg$/i.test(entry))) {
      throw new Error(`Unsafe or unexpected FEI archive: ${archive.name}`)
    }
    await execFileAsync('tar.exe', ['-xf', path, '-C', feiDir])
    sourceArchives.push({ name: archive.name, bytes: bytes.length, sha256: hash, jpegEntries: entries.length })
    await rm(path, { force: true })
  }
  const names = (await readdir(feiDir)).filter((name) => /^\d{1,3}-11\.jpg$/i.test(name))
  if (names.length !== 200) throw new Error(`Unexpected FEI view-11 neutral count: ${names.length}`)
  const ordered = names.map((name) => ({ name, subject: Number(name.split('-')[0]) }))
    .sort((left, right) => sha256(`HeadUp-Expression-V2-FEI/${left.subject}`).localeCompare(sha256(`HeadUp-Expression-V2-FEI/${right.subject}`)))
  const records = []
  for (const [index, item] of ordered.entries()) {
    const path = join(feiDir, item.name)
    const metadata = await sharp(path).metadata()
    if (metadata.width !== 640 || metadata.height !== 480) throw new Error(`Unexpected FEI neutral dimensions: ${item.name}`)
    records.push({
      sampleId: `fei-neutral-${String(index + 1).padStart(4, '0')}`,
      split: index < 100 ? 'neutral_engineering' : 'neutral_holdout',
      assetUrl: `/@fs/${path.replaceAll('\\', '/')}`,
      labels: { smiling: false, mouthSlightlyOpen: false, narrowEyes: false },
    })
  }
  return { records, sourceArchives }
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe CelebA expression staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })

try {
  const [trainRows, testRows] = await Promise.all([
    loadSplit('train', splitSizes.train),
    loadSplit('test', splitSizes.test),
  ])
  const trainIdentities = new Set(trainRows.map((row) => row.identity_id))
  const testIdentities = new Set(testRows.map((row) => row.identity_id))
  const identityOverlap = [...testIdentities].filter((identity) => trainIdentities.has(identity))
  if (identityOverlap.length > 0) throw new Error(`CelebA train/test identity overlap: ${identityOverlap.length}`)

  const selectedSourceRows = [
    ...selectBalanced(trainRows, 'train').map((row) => ({ ...row, split: 'train' })),
    ...selectNaturalHoldout(testRows).map((row) => ({ ...row, split: 'test' })),
  ]
  const engineeringRows = selectedSourceRows.filter((row) => row.split === 'train')
  const holdoutRows = selectedSourceRows.filter((row) => row.split === 'test')
  if (new Set(engineeringRows.map((row) => row.identity_id)).size !== engineeringRows.length) throw new Error('Engineering CelebA identities are not unique')
  const identityMap = new Map()
  for (const [prefix, rows] of [['eng', engineeringRows], ['hold', holdoutRows]]) {
    const identities = [...new Set(rows.map((row) => row.identity_id))]
      .sort((left, right) => sha256(`${datasetCommit}:${prefix}:${left}`).localeCompare(sha256(`${datasetCommit}:${prefix}:${right}`)))
    identities.forEach((identity, index) => identityMap.set(`${prefix}:${identity}`, `${prefix}-subject-${String(index + 1).padStart(4, '0')}`))
  }
  const pseudonymizedRows = selectedSourceRows.map((row) => ({
    ...row,
    transientSubjectId: identityMap.get(`${row.split === 'train' ? 'eng' : 'hold'}:${row.identity_id}`),
  }))
  const records = await mapConcurrent(pseudonymizedRows, 6, downloadRecord)

  let realRecords
  let neutralControlSource
  if (v2) {
    const fei = await prepareFeiNeutralControls()
    realRecords = fei.records
    neutralControlSource = {
      name: 'FEI Face Database view 11 frontal neutral proxy',
      engineeringIdentities: 100,
      holdoutIdentities: 100,
      sourceArchives: fei.sourceArchives,
      limitation: 'Publisher archive does not encode the exact front-control semantic name; view 11 is treated as a neutral proxy, not phone-capture truth.',
    }
  } else {
    realRecords = (await readFile(realManifestPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line))
      .filter((record) => record.view === 'front')
      .map((record, index) => ({
        sampleId: `neutral-${String(index + 1).padStart(4, '0')}`,
        split: record.partition === 'holdout' ? 'neutral_holdout' : 'neutral_engineering',
        assetUrl: `/@fs/${join(realResearchDir, record.relativePath).replaceAll('\\', '/')}`,
        labels: { smiling: false, mouthSlightlyOpen: false, narrowEyes: false },
      }))
    if (realRecords.length !== 102) throw new Error(`Unexpected authorized neutral control count: ${realRecords.length}`)
    neutralControlSource = { name: 'authorized London neutral controls', images: 102 }
  }

  const manifest = {
    policyVersion: 'HEADUP-CELEBA-EXPRESSION-PREPARE-1.0',
    source: 'CelebA identity-aligned 512 research mirror',
    publisher: 'CelebA / community research mirror',
    sourcePage: datasetPage,
    originalSourcePage: 'https://mmlab.ie.cuhk.edu.hk/projects/CelebA.html',
    sourceCommit: datasetCommit,
    licenseBoundary: 'CelebA is non-commercial research only; no images or derived per-image data may enter the commercial product.',
    selection: {
      downloadedImages: records.length,
      uniqueIdentities: new Set(records.map((record) => record.subjectId)).size,
      engineeringIdentities: new Set(records.filter((record) => record.split === 'engineering').map((record) => record.subjectId)).size,
      holdoutIdentities: new Set(records.filter((record) => record.split === 'holdout').map((record) => record.subjectId)).size,
      engineeringImages: records.filter((record) => record.split === 'engineering').length,
      holdoutImages: records.filter((record) => record.split === 'holdout').length,
      authorizedNeutralControls: realRecords.length,
      neutralControlSource,
      sourceImageResolution: '512x512 identity-aligned crops derived from real CelebA photographs',
      bySplitAndExpressionStratum: counts(records, (record) => `${record.split}:${Number(record.labels.smiling)}${Number(record.labels.mouthSlightlyOpen)}${Number(record.labels.narrowEyes)}`),
      coverage: {
        masculinePresentationProxy: counts(records, (record) => String(record.coverage.masculinePresentationProxy)),
        youngAppearanceProxy: counts(records, (record) => String(record.coverage.youngAppearanceProxy)),
        eyeglasses: counts(records, (record) => String(record.coverage.eyeglasses)),
        heavyMakeup: counts(records, (record) => String(record.coverage.heavyMakeup)),
      },
    },
    records,
    authorizedNeutralRecords: realRecords,
    retention: {
      sourceNamesRetained: false,
      sourceImageIdsRetained: false,
      sourceUrlsRetainedInFinalResult: false,
      individualPredictionsRetainedInFinalResult: false,
    },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${records.length} transient CelebA expression images plus ${realRecords.length} authorized neutral controls.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
