import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const benchmarkRoot = join(projectDir, 'data', 'face-benchmark')
const stagingRoot = join(benchmarkRoot, '.staging')
const stagingDir = join(stagingRoot, 'active-challenge')
const londonDir = join(projectDir, 'data', 'face-db-real-research', 'images', 'face-research-lab-london-v5')
const replayManifestPath = join(stagingRoot, 'physical-replay', 'manifest.json')

if (!resolve(stagingDir).startsWith(`${resolve(stagingRoot)}\\`)) throw new Error('Unsafe active-challenge staging path')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })

try {
  try {
    await access(replayManifestPath)
    process.stdout.write('Reusing the existing verified physical replay staging set.\n')
  } catch {
    await import('./prepare-transient-physical-replay-benchmark.mjs')
  }
  const bonaFideRecords = []
  const subjectIds = (await readdir(londonDir))
    .map((name) => /^(\d+)_front\.jpg$/i.exec(name)?.[1])
    .filter((value) => value !== undefined)
    .sort((left, right) => Number(left) - Number(right))
  if (subjectIds.length !== 102 || new Set(subjectIds).size !== subjectIds.length) {
    throw new Error(`Expected 102 unique London subjects, found ${subjectIds.length}`)
  }
  for (const subjectId of subjectIds) {
    const paths = {
      center: join(londonDir, `${subjectId}_front.jpg`),
      positive_yaw: join(londonDir, `${subjectId}_left_profile.jpg`),
      negative_yaw: join(londonDir, `${subjectId}_right_profile.jpg`),
    }
    await Promise.all(Object.values(paths).map((path) => access(path)))
    bonaFideRecords.push({ subjectId, paths })
  }
  const replayManifest = JSON.parse(await readFile(replayManifestPath, 'utf8'))
  const replayRecords = replayManifest.samples.map((sample) => ({
    ...sample,
    path: join(stagingRoot, 'physical-replay', sample.relativePath),
  }))
  await writeFile(join(stagingDir, 'manifest.json'), `${JSON.stringify({
    policyVersion: 'HEADUP-ACTIVE-CHALLENGE-INPUT-1.0',
    bonaFideSource: 'Face Research Lab London Set, authorized local research copy',
    bonaFideLicense: 'CC BY-NC-SA 4.0',
    bonaFideRecords,
    replaySource: replayManifest.source,
    replaySourceCommit: replayManifest.sourceCommit,
    replayLicense: replayManifest.license,
    replayAttackType: replayManifest.attackType,
    replayRecords,
    samplingIntervalMs: 300,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Prepared active-challenge manifest for ${bonaFideRecords.length} subjects and ${replayRecords.length} verified replay videos.\n`)
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true })
  throw error
}
