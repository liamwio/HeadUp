import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
if (outIndex !== args.lastIndexOf('--out')) throw new Error('--out may only be specified once')
const outputPath = outIndex >= 0 ? args[outIndex + 1] : undefined
const inputPaths = outIndex >= 0
  ? args.filter((_value, index) => index !== outIndex && index !== outIndex + 1)
  : args

if (outIndex >= 0 && !outputPath) throw new Error('--out requires a JSON path')
if (inputPaths.length === 0) {
  throw new Error('Usage: pnpm research:occlusion:aggregate [--out aggregate.json] session-1.json session-2.json ...')
}

const conditions = ['open', 'mask', 'sunglasses']
const deviceClasses = new Set(['smartphone_rear', 'smartphone_front', 'desktop_webcam', 'digital_camera'])
const lightingClasses = new Set(['indirect_daylight', 'indoor_even', 'mixed', 'other'])

function finiteCount(value, path) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`)
  return value
}

function validateSession(value, sourcePath) {
  if (!value || typeof value !== 'object') throw new Error(`${sourcePath}: root must be an object`)
  if (value.policyVersion !== 'HEADUP-LOCAL-OCCLUSION-PAIR-1.0') throw new Error(`${sourcePath}: unsupported policyVersion`)
  if (value.protocol?.protocolComplete !== true) throw new Error(`${sourcePath}: incomplete protocol`)
  if (typeof value.session?.sessionId !== 'string' || value.session.sessionId.length < 8) throw new Error(`${sourcePath}: invalid anonymous sessionId`)
  if (!deviceClasses.has(value.session.deviceClass)) throw new Error(`${sourcePath}: invalid deviceClass`)
  if (!lightingClasses.has(value.session.lighting)) throw new Error(`${sourcePath}: invalid lighting`)
  if (value.retention?.imagesIncluded !== false || value.retention?.fileNamesIncluded !== false
    || value.retention?.imageHashesIncluded !== false || value.retention?.landmarksIncluded !== false
    || value.retention?.demographicAttributesIncluded !== false || value.retention?.aggregateOnly !== true) {
    throw new Error(`${sourcePath}: retention boundary is not aggregate-only`)
  }
  for (const condition of conditions) {
    const summary = value.byCondition?.[condition]
    if (!summary) throw new Error(`${sourcePath}: missing byCondition.${condition}`)
    if (finiteCount(summary.samples, `${sourcePath}: ${condition}.samples`) !== 3) throw new Error(`${sourcePath}: ${condition} must contain three repeats`)
    for (const key of ['qualityPassed', 'posePassed', 'combinedPassed', 'explicitEyeOcclusionFlags', 'explicitMouthNoseOcclusionFlags']) {
      if (finiteCount(summary[key], `${sourcePath}: ${condition}.${key}`) > 3) throw new Error(`${sourcePath}: ${condition}.${key} exceeds repeats`)
    }
  }
  for (const condition of ['mask', 'sunglasses']) {
    const transition = value.pairedTransitions?.[condition]
    if (!transition) throw new Error(`${sourcePath}: missing pairedTransitions.${condition}`)
    for (const key of ['pairs', 'baselinePoseEligible', 'blockedByPoseGateAfterBaselinePosePass', 'baselineCombinedEligible', 'blockedByCombinedGateAfterBaselineCombinedPass']) {
      if (finiteCount(transition[key], `${sourcePath}: ${condition}.${key}`) > 3) throw new Error(`${sourcePath}: ${condition}.${key} exceeds repeats`)
    }
    if (transition.pairs !== 3) throw new Error(`${sourcePath}: ${condition} must contain three pairs`)
    if (transition.blockedByPoseGateAfterBaselinePosePass > transition.baselinePoseEligible
      || transition.blockedByCombinedGateAfterBaselineCombinedPass > transition.baselineCombinedEligible) {
      throw new Error(`${sourcePath}: ${condition} blocked count exceeds eligible baseline`)
    }
  }
  return value
}

function sumFlags(target, source) {
  for (const [flag, count] of Object.entries(source ?? {})) {
    target[flag] = (target[flag] ?? 0) + finiteCount(count, `flag ${flag}`)
  }
}

function emptyCondition() {
  return {
    samples: 0,
    qualityPassed: 0,
    posePassed: 0,
    combinedPassed: 0,
    explicitEyeOcclusionFlags: 0,
    explicitMouthNoseOcclusionFlags: 0,
    qualityFlags: {},
    poseFlags: {},
  }
}

function emptyTransition() {
  return {
    pairs: 0,
    baselinePoseEligible: 0,
    blockedByPoseGateAfterBaselinePosePass: 0,
    baselineCombinedEligible: 0,
    blockedByCombinedGateAfterBaselineCombinedPass: 0,
  }
}

const sessions = []
const seenSessionIds = new Set()
for (const inputPath of inputPaths) {
  const absolutePath = resolve(inputPath)
  const session = validateSession(JSON.parse(await readFile(absolutePath, 'utf8')), absolutePath)
  if (seenSessionIds.has(session.session.sessionId)) throw new Error(`${absolutePath}: duplicate anonymous sessionId`)
  seenSessionIds.add(session.session.sessionId)
  sessions.push(session)
}

const byCondition = Object.fromEntries(conditions.map((condition) => [condition, emptyCondition()]))
const pairedTransitions = { mask: emptyTransition(), sunglasses: emptyTransition() }
const byDeviceClass = {}
const byLighting = {}
for (const session of sessions) {
  byDeviceClass[session.session.deviceClass] = (byDeviceClass[session.session.deviceClass] ?? 0) + 1
  byLighting[session.session.lighting] = (byLighting[session.session.lighting] ?? 0) + 1
  for (const condition of conditions) {
    const source = session.byCondition[condition]
    const target = byCondition[condition]
    for (const key of ['samples', 'qualityPassed', 'posePassed', 'combinedPassed', 'explicitEyeOcclusionFlags', 'explicitMouthNoseOcclusionFlags']) target[key] += source[key]
    sumFlags(target.qualityFlags, source.qualityFlags)
    sumFlags(target.poseFlags, source.poseFlags)
  }
  for (const condition of ['mask', 'sunglasses']) {
    const source = session.pairedTransitions[condition]
    const target = pairedTransitions[condition]
    for (const key of Object.keys(target)) target[key] += source[key]
  }
}

for (const transition of Object.values(pairedTransitions)) {
  transition.poseBlockingRateAfterEligibleBaseline = transition.baselinePoseEligible
    ? Number((transition.blockedByPoseGateAfterBaselinePosePass / transition.baselinePoseEligible).toFixed(4))
    : null
  transition.combinedBlockingRateAfterEligibleBaseline = transition.baselineCombinedEligible
    ? Number((transition.blockedByCombinedGateAfterBaselineCombinedPass / transition.baselineCombinedEligible).toFixed(4))
    : null
}

const aggregate = {
  policyVersion: 'HEADUP-LOCAL-OCCLUSION-CROSS-SESSION-1.0',
  aggregatedAt: new Date().toISOString(),
  sessions: sessions.length,
  coverage: { byDeviceClass, byLighting },
  byCondition,
  pairedTransitions,
  retention: {
    sessionIdsIncluded: false,
    inputPathsIncluded: false,
    imagesIncluded: false,
    individualPredictionsIncluded: false,
    aggregateOnly: true,
  },
  interpretation: 'Diagnostic cross-session aggregation only. Anonymous session IDs prevent duplicate files but cannot verify independent subjects. Population accuracy claims require a pre-registered, consented and subject-isolated study.',
}

const serialized = `${JSON.stringify(aggregate, null, 2)}\n`
if (outputPath) {
  await writeFile(resolve(outputPath), serialized, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ sessions: sessions.length, output: resolve(outputPath) }, null, 2)}\n`)
} else {
  process.stdout.write(serialized)
}
