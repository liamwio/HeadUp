import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'demographic-coverage')
const imageDir = join(stagingDir, 'images')
const manifestPath = join(stagingDir, 'manifest.json')
const allowedRoot = `${resolve(stagingRoot)}${sep}`
if (!resolve(stagingDir).startsWith(allowedRoot)) throw new Error('Unsafe demographic staging path')

const source = {
  name: 'FFHQ-Aging / Flickr-Faces-HQ',
  labelsCommit: '2ecdcd2511c7e0da7f2a7cf0d839a9f6faafa645',
  labelsUrl: 'https://raw.githubusercontent.com/royorel/FFHQ-Aging-Dataset/2ecdcd2511c7e0da7f2a7cf0d839a9f6faafa645/ffhq_aging_labels.csv',
  labelsBytes: 4_975_668,
  labelsSha256: 'b99585b0ab9720a0ea55b71d677126b4a1fb1c6b7e362a48e6f00ac835cabc04',
  metadataUrl: 'https://drive.google.com/uc?id=16N0RV4fHI6joBuKbQAoG34V_cQk7vxSA',
  metadataBytes: 267_793_842,
  metadataMd5: '425ae20f06a4da1d4dc0f46d40ba5fd6',
  license: 'CC BY-NC-SA 4.0 dataset metadata; individual Flickr image licenses recorded by FFHQ',
  purpose: 'non-commercial transient algorithm coverage audit',
}

const ageGroups = ['0-2', '3-6', '7-9', '10-14', '15-19', '20-29', '30-39', '40-49', '50-69', '70-120']
const genders = ['female', 'male']
const digest = (algorithm, value) => createHash(algorithm).update(value).digest('hex')

async function download(url, output, maxTime = '1800') {
  const invoke = (target) => execFileAsync('curl.exe', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
    '--connect-timeout', '20', '--max-time', maxTime, '--user-agent', 'HeadUp-Demographic-Coverage/1.0',
    '--output', output, target,
  ], { maxBuffer: 2 * 1024 * 1024 })
  await invoke(url)
  const initial = await readFile(output)
  if (initial.length < 8192) {
    const html = initial.toString('utf8')
    const links = html.split('"')
      .filter((value) => value.includes('export=download'))
      .map((value) => value.replaceAll('&amp;', '&'))
    if (links.length === 1) {
      await invoke(new URL(links[0], url).href)
    } else {
      const action = html.match(/<form[^>]+action="([^"]+)"[^>]*>/i)?.[1]
      const fields = [...html.matchAll(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"[^>]*>/gi)]
      if (action && fields.length) {
        const target = new URL(action)
        for (const field of fields) target.searchParams.set(field[1], field[2].replaceAll('&amp;', '&'))
        await invoke(target.href)
      }
    }
  }
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  const headers = lines.shift().split(',')
  return lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])))
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(imageDir, { recursive: true })
try {
  const labelsPath = join(stagingDir, 'ffhq_aging_labels.csv')
  const metadataPath = join(stagingDir, 'ffhq-dataset-v2.json')
  await download(source.labelsUrl, labelsPath, '300')
  const labelsBytes = await readFile(labelsPath)
  const labelsHash = digest('sha256', labelsBytes)
  if (labelsBytes.length !== source.labelsBytes || labelsHash !== source.labelsSha256) {
    throw new Error(`FFHQ-Aging labels integrity mismatch: ${labelsBytes.length} bytes, ${labelsHash}`)
  }
  const labels = parseCsv(labelsBytes.toString('utf8'))
  const eligible = labels.filter((row) =>
    Number(row.age_group_confidence) >= 0.8 &&
    Number(row.gender_confidence) >= 0.95 &&
    row.glasses === 'None' &&
    Math.abs(Number(row.head_yaw)) <= 12 &&
    Math.abs(Number(row.head_pitch)) <= 9 &&
    Math.abs(Number(row.head_roll)) <= 12,
  )
  const selected = []
  for (const ageGroup of ageGroups) {
    for (const gender of genders) {
      const candidates = eligible
        .filter((row) => row.age_group === ageGroup && row.gender === gender)
        .sort((left, right) => digest('sha256', `HEADUP-DEMOGRAPHIC-1.0:${left.image_number}`).localeCompare(digest('sha256', `HEADUP-DEMOGRAPHIC-1.0:${right.image_number}`)))
      if (candidates.length < 10) throw new Error(`Insufficient eligible FFHQ-Aging records for ${ageGroup}/${gender}: ${candidates.length}`)
      selected.push(...candidates.slice(0, 10))
    }
  }
  if (selected.length !== 200) throw new Error(`Unexpected demographic selection: ${selected.length}`)

  await download(source.metadataUrl, metadataPath)
  const metadataBytes = await readFile(metadataPath)
  if (metadataBytes.length !== source.metadataBytes || digest('md5', metadataBytes) !== source.metadataMd5) {
    throw new Error(`FFHQ metadata integrity mismatch: ${metadataBytes.length} bytes, ${digest('md5', metadataBytes)}`)
  }
  const metadata = JSON.parse(metadataBytes.toString('utf8'))
  const records = new Array(selected.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= selected.length) return
      const row = selected[index]
      const item = metadata[String(Number(row.image_number))]
      const spec = item?.image
      if (!spec?.file_url || !spec?.file_md5 || !spec?.file_size) throw new Error(`Missing FFHQ image spec at selected index ${index}`)
      const sampleId = `sample-${String(index + 1).padStart(3, '0')}`
      const outputPath = join(imageDir, `${sampleId}.png`)
      await download(spec.file_url, outputPath, '300')
      const bytes = await readFile(outputPath)
      if (bytes.length !== spec.file_size || digest('md5', bytes) !== spec.file_md5) throw new Error(`FFHQ image integrity mismatch: ${sampleId}`)
      const image = await sharp(bytes).metadata()
      if (image.width !== 1024 || image.height !== 1024 || image.format !== 'png') throw new Error(`Unexpected FFHQ image geometry: ${sampleId}`)
      records[index] = {
        sampleId,
        relativePath: relative(stagingDir, outputPath).replaceAll('\\', '/'),
        ageGroup: row.age_group,
        gender: row.gender,
        publisherPose: {
          yaw: Number(row.head_yaw), pitch: Number(row.head_pitch), roll: Number(row.head_roll),
        },
        bytes: (await stat(outputPath)).size,
        sha256: digest('sha256', bytes),
      }
      process.stdout.write(`\rDownloaded ${records.filter(Boolean).length} / ${selected.length}`)
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()))
  process.stdout.write('\n')
  const manifest = {
    policyVersion: 'HEADUP-DEMOGRAPHIC-COVERAGE-PREPARE-1.0',
    source,
    protocol: {
      ageGroups,
      genders,
      samplesPerCell: 10,
      totalImages: 200,
      eligibility: 'age confidence >=0.8; gender confidence >=0.95; glasses=None; publisher |yaw|<=12, |pitch|<=9, |roll|<=12',
      selection: 'SHA-256 ordering within each age x gender cell; no production output used for selection',
    },
    records,
    retention: { manifestTransient: true, sourceIdentifiersRetainedInFinal: false, imagesRetainedInFinal: false },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(labelsPath, { force: true })
  await rm(metadataPath, { force: true })
  process.stdout.write('Prepared 200 anonymous FFHQ-Aging images across 20 age x gender cells.\n')
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
