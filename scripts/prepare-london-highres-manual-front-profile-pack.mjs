import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = join(projectDir, 'data', 'face-db-real-research')
const packageDir = join(projectDir, 'data', 'manual-test', 'london-highres-front-profile-v1')
const imageDir = join(packageDir, 'images')
const allowedRoot = `${resolve(packageDir)}${sep}`
if (!resolve(imageDir).startsWith(allowedRoot)) throw new Error('Unsafe London manual package path')

const records = (await readFile(join(sourceRoot, 'manifest.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse)
const requiredViews = ['front', 'left_profile', 'right_profile']
const groups = Object.values(Object.groupBy(records.filter((record) => record.sourceId === 'face-research-lab-london-v5' && record.resolutionTier === 'high' && record.qualityStatus === 'pass'), (record) => record.pseudonymousSubjectId))
  .filter((group) => requiredViews.every((view) => group.some((record) => record.view === view && record.width >= 1080 && record.height >= 1080)))
  .sort((left, right) => left[0].pseudonymousSubjectId.localeCompare(right[0].pseudonymousSubjectId))
  .slice(0, 10)
if (groups.length !== 10) throw new Error(`Expected 10 high-resolution London triplets, found ${groups.length}`)

await mkdir(imageDir, { recursive: true })
const cases = []
for (const [index, group] of groups.entries()) {
  const anonymousSubject = `london_manual_${String(index + 1).padStart(2, '0')}`
  for (const view of requiredViews) {
    const record = group.find((candidate) => candidate.view === view)
    const targetName = `${anonymousSubject}_${view}.jpg`
    await copyFile(join(sourceRoot, record.relativePath), join(imageDir, targetName))
    cases.push({ anonymousSubject, view, image: `images/${targetName}`, width: record.width, height: record.height, qualityStatus: record.qualityStatus, sourceRecordId: record.id })
  }
}
const manifest = {
  generatedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-LONDON-HIGHRES-MANUAL-FRONT-PROFILE-1.0',
  source: { name: 'Face Research Lab London Set', attribution: 'Lisa DeBruine and Benedict Jones, CC BY 4.0', localSourceAlreadyDownloaded: true, sourceResolution: '1350x1350' },
  purpose: 'Local developer manual testing of high-resolution front and bilateral profile capture paths. Not bundled with the app or publicly distributed.',
  selectedSubjects: groups.length,
  selectedImages: cases.length,
  cases,
  retention: { selectedImagesRetained: true, automaticCleanupPaused: true },
}
await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(join(packageDir, 'README.md'), '# London 高分辨率正面/侧面手测包\n\n- 10 位匿名编号受试者，每人正面、左侧面、右侧面，共 30 张 1350×1350 JPEG。\n- 由本地已下载的授权研究集重新筛选，避免重复下载同一批高质量原图。\n- 仅限本机开发人工测试，不进入 public、APP 构建或公开分发；当前不自动清理。\n')
process.stdout.write(`${JSON.stringify({ packageDir, subjects: groups.length, images: cases.length, resolution: '1350x1350', automaticCleanupPaused: true }, null, 2)}\n`)
