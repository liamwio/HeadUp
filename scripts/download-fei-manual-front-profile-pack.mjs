import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const packageDir = join(projectDir, 'data', 'manual-test', 'fei-front-profile-v1')
const archiveDir = join(packageDir, 'source-archives')
const extractDir = join(packageDir, 'extracted-source')
const imageDir = join(packageDir, 'images')
const allowedRoot = `${resolve(packageDir)}${sep}`
const subjects = Array.from({ length: 10 }, (_, index) => index + 1)
const selectedViews = [
  { view: 1, label: 'left_profile', description: 'FEI view 01; positive-yaw extreme profile' },
  { view: 10, label: 'right_profile', description: 'FEI view 10; negative-yaw extreme profile' },
  { view: 11, label: 'front_control', description: 'FEI view 11; frontal control (exact publisher sub-label is not encoded)' },
]
const archives = [
  { name: 'originalimages_part1.zip', bytes: 86_857_988, sha256: '1d0b0ebe94278a5677edc450251f91450dadb821d9774edc111ad1be0e7475ed' },
  { name: 'originalimages_part2.zip', bytes: 89_176_109, sha256: '993c2a48ac38c64824c619cbcdb0700598786aa2fa20a76f4b199457c8662e69' },
  { name: 'originalimages_part3.zip', bytes: 88_206_682, sha256: '65d282b338001e4ece78944b751d5d78d94eddfacf2c734cf8530bcd6435e252' },
  { name: 'originalimages_part4.zip', bytes: 89_251_729, sha256: 'dd82ed2b475781dd4e829fb964923eb3a69e6f413f0e05ae694e65fce9fbe44f' },
].map((item) => ({ ...item, url: `https://fei.edu.br/~cet/${item.name}` }))

if (!resolve(archiveDir).startsWith(allowedRoot) || !resolve(extractDir).startsWith(allowedRoot) || !resolve(imageDir).startsWith(allowedRoot)) throw new Error('Unsafe FEI manual package path')

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function download(url, destination) {
  await execFileAsync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '900', '--user-agent', 'HeadUp-Manual-Test-Pack/1.0', '--output', destination, url], { maxBuffer: 2 * 1024 * 1024 })
}
async function verifiedArchive(archive) {
  const destination = join(archiveDir, archive.name)
  let valid = false
  try {
    const bytes = await readFile(destination)
    valid = bytes.length === archive.bytes && digest(bytes) === archive.sha256
  } catch { /* download below */ }
  if (!valid) {
    process.stdout.write(`Downloading ${archive.name}\n`)
    await download(archive.url, destination)
    const bytes = await readFile(destination)
    if (bytes.length !== archive.bytes || digest(bytes) !== archive.sha256) throw new Error(`FEI archive verification failed: ${archive.name}`)
  }
  const { stdout } = await execFileAsync('tar.exe', ['-tf', destination], { maxBuffer: 2 * 1024 * 1024 })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).includes('..'))
  if (unsafe || entries.length !== 700 || entries.some((entry) => !/^\d{1,3}-\d{2}\.jpg$/i.test(entry))) throw new Error(`Unexpected FEI archive layout: ${archive.name}`)
  return destination
}

await mkdir(archiveDir, { recursive: true })
await mkdir(extractDir, { recursive: true })
await mkdir(imageDir, { recursive: true })
const verifiedArchives = []
for (const archive of archives) {
  const path = await verifiedArchive(archive)
  verifiedArchives.push({ name: archive.name, bytes: (await stat(path)).size, sha256: archive.sha256 })
  await execFileAsync('tar.exe', ['-xf', path, '-C', extractDir])
}

const cases = []
for (const subject of subjects) for (const selection of selectedViews) {
  const sourceName = `${subject}-${String(selection.view).padStart(2, '0')}.jpg`
  const source = join(extractDir, sourceName)
  const targetName = `fei_${String(subject).padStart(3, '0')}_${selection.label}.jpg`
  const target = join(imageDir, targetName)
  const bytes = await readFile(source)
  await copyFile(source, target)
  cases.push({ anonymousSubject: `fei_${String(subject).padStart(3, '0')}`, view: selection.label, image: `images/${targetName}`, sha256: digest(bytes), sourceViewIndex: selection.view, description: selection.description })
}
const manifest = {
  generatedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-FEI-MANUAL-FRONT-PROFILE-1.0',
  source: { name: 'FEI Face Database original images', url: 'https://fei.edu.br/~cet/facedatabase.html', publisher: 'Artificial Intelligence Laboratory of FEI, Brazil', researchOnly: true, archivesRetained: true, archives: verifiedArchives },
  purpose: 'Local developer manual testing of front and bilateral profile capture paths. Not bundled with the app or publicly distributed.',
  selectedSubjects: subjects.length,
  selectedImages: cases.length,
  cases,
  retention: { selectedImagesRetained: true, sourceArchivesRetained: true, extractedSourceRetained: true, automaticCleanupPaused: true },
}
await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(join(packageDir, 'README.md'), `# FEI 本地正面/侧面手测包\n\n- 10 名匿名编号受试者，每人左侧、右侧和正面控制图，共 30 张。\n- 原始 FEI 分卷与解包源图按当前人工测试策略保留；不会进入 public、APP 构建或公开分发。\n- 清理需人工确认后执行；本脚本不会自动删除任何已下载内容。\n`)
process.stdout.write(`${JSON.stringify({ packageDir, subjects: subjects.length, images: cases.length, archivesRetained: verifiedArchives.length, automaticCleanupPaused: true }, null, 2)}\n`)
