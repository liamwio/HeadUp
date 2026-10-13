import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'physical-replay')
const videoDir = join(stagingDir, 'videos')
const manifestPath = join(stagingDir, 'manifest.json')
const sourceCommit = 'd9cfc94dcb213dac8c3429c4bda8a87a502aae5d'
const sourceBase = `https://huggingface.co/datasets/AxonData/replay-attack-dataset/resolve/${sourceCommit}`

const samples = [
  {
    id: 'pc_display_01',
    captureGroup: 'pc_display',
    sourcePath: 'Replay dataset sample/Replay_PC/20240823_194131.mp4',
    expectedBytes: 30815705,
    expectedSha256: '6ae0a2c17dfca287c552fc830c2bea9d167d17c014550ad01fd5f14ef79dab8b',
  },
  {
    id: 'pc_display_02',
    captureGroup: 'pc_display',
    sourcePath: 'Replay dataset sample/Replay_PC/20240823_194241.mp4',
    expectedBytes: 32350707,
    expectedSha256: '4f614c8e32436a60fbae6c9f46f20509030d68af04f2d5c7a79e735c4451a4d1',
  },
  {
    id: 'galaxy_a54_to_honor70',
    captureGroup: 'mobile_display',
    sourcePath: 'Replay dataset sample/Replay_mobile /Galaxy_a54-Honor70/20241126_024625.mp4',
    expectedBytes: 69824825,
    expectedSha256: '6ba549ca7860f4d4e8d7ce15211c76bae759c7bc2c4076da82781003b4f415e1',
  },
  {
    id: 'galaxy_a54_to_pixel7',
    captureGroup: 'mobile_display',
    sourcePath: 'Replay dataset sample/Replay_mobile /Galaxy_a54-Pixel7/20241126_030523.mp4',
    expectedBytes: 61118060,
    expectedSha256: '16f9adbf37a0cf99e85dc1740b196393df200dfa240f7fe44a0d5f7411aceeb2',
  },
  {
    id: 'honor70_to_pixel7',
    captureGroup: 'mobile_display',
    sourcePath: 'Replay dataset sample/Replay_mobile /Honor70-pixel7/VID_20241126_025628.mp4',
    expectedBytes: 74870326,
    expectedSha256: '04c7aed89431a37a4215a7bd4e0fe330c6cafac45a1e92684548e44fd21db60c',
  },
  {
    id: 'pixel7_to_honor70',
    captureGroup: 'mobile_display',
    sourcePath: 'Replay dataset sample/Replay_mobile /Pixel7-Honor70/PXL_20230324_183349660.mp4',
    expectedBytes: 59629006,
    expectedSha256: '56bde718f503a8763d558963ec301bc3878fc0d5b76a52e175e3a4f2d495feea',
  },
]

function encodeSourcePath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) {
  throw new Error('Unsafe physical-replay staging path')
}

await rm(stagingDir, { recursive: true, force: true })
await mkdir(videoDir, { recursive: true })

try {
  const manifestSamples = []
  for (const [index, sample] of samples.entries()) {
    const fileName = `${sample.id}.mp4`
    const outputPath = join(videoDir, fileName)
    const sourceUrl = `${sourceBase}/${encodeSourcePath(sample.sourcePath)}?download=true`
    process.stdout.write(`Downloading replay sample ${index + 1}/${samples.length}: ${sample.id}\n`)
    await execFileAsync('curl.exe', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '5', '--retry-all-errors',
      '--connect-timeout', '20', '--max-time', '1200', '--user-agent', 'HeadUp-Research-Benchmark/1.0',
      '--output', outputPath, sourceUrl,
    ], { maxBuffer: 2 * 1024 * 1024 })

    const fileStat = await stat(outputPath)
    if (fileStat.size !== sample.expectedBytes) {
      throw new Error(`${sample.id} size mismatch: ${fileStat.size}`)
    }
    const sha256 = await sha256File(outputPath)
    if (sha256 !== sample.expectedSha256) {
      throw new Error(`${sample.id} checksum mismatch: ${sha256}`)
    }
    manifestSamples.push({
      id: sample.id,
      captureGroup: sample.captureGroup,
      relativePath: `videos/${fileName}`,
      bytes: fileStat.size,
      sha256,
    })
  }

  await writeFile(manifestPath, `${JSON.stringify({
    source: 'AxonData replay-attack-dataset public sample',
    sourceCommit,
    license: 'CC BY-NC 4.0',
    attackType: 'physical screen replay',
    samples: manifestSamples,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared ${manifestSamples.length} verified physical replay videos (${manifestSamples.reduce((sum, item) => sum + item.bytes, 0)} bytes).\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
