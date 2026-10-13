import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'
import sharp from 'sharp'

const projectDir = fileURLToPath(new URL('../', import.meta.url))
const dbDir = join(projectDir, 'data', 'face-db-real-research')
const resultPath = join(dbDir, 'wide-head-pose-benchmark.json')
const modelPath = join(projectDir, 'public', 'models', 'whenet_1x3x224x224_prepost.onnx')
const records = (await readFile(join(dbDir, 'manifest.jsonl'), 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))].toFixed(2))
}

function distribution(values) {
  return {
    min: percentile(values, 0),
    p05: percentile(values, 0.05),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
  }
}

async function makeTensor(path) {
  const { data, info } = await sharp(path)
    .resize(224, 224, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channelSize = info.width * info.height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    input[index] = data[index * 3]
    input[channelSize + index] = data[index * 3 + 1]
    input[channelSize * 2 + index] = data[index * 3 + 2]
  }
  return new ort.Tensor('float32', input, [1, 3, 224, 224])
}

const model = await readFile(modelPath)
const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
const cases = []
for (const record of records) {
  const tensor = await makeTensor(join(dbDir, record.relativePath))
  const outputs = await session.run({ [session.inputNames[0]]: tensor })
  const values = Array.from(outputs[session.outputNames[0]].data)
  cases.push({
    view: record.view,
    partition: record.partition,
    yaw: Number(values[0].toFixed(2)),
    roll: Number(values[1].toFixed(2)),
    pitch: Number(values[2].toFixed(2)),
  })
}

const views = Object.fromEntries(Object.entries(Object.groupBy(cases, (item) => item.view)).map(([view, items]) => [view, {
  images: items.length,
  yaw: distribution(items.map((item) => item.yaw)),
  absoluteYaw: distribution(items.map((item) => Math.abs(item.yaw))),
  roll: distribution(items.map((item) => item.roll)),
  pitch: distribution(items.map((item) => item.pitch)),
}]))
const classify = (item) => Math.abs(item.yaw) <= 12 ? 'front' : Math.abs(item.yaw) >= 35 ? 'profile' : 'oblique'
const frontPassesRules = (item) => classify(item) === 'front' && Math.abs(item.roll) <= 12
const profilePassesRules = (item) => classify(item) === 'profile' && Math.abs(item.roll) <= 18
const frontPitchGateSweep = [3, 5, 7, 8, 9, 10, 12, 15].map((threshold) => ({
  threshold,
  all: {
    accepted: cases.filter((item) => item.view === 'front' && frontPassesRules(item) && Math.abs(item.pitch) <= threshold).length,
    currentProductionAccepted: cases.filter((item) => item.view === 'front' && frontPassesRules(item)).length,
    total: cases.filter((item) => item.view === 'front').length,
  },
  byPartition: Object.fromEntries(['engineering_qa', 'holdout'].map((partition) => {
    const items = cases.filter((item) => item.view === 'front' && item.partition === partition)
    return [partition, {
      accepted: items.filter((item) => frontPassesRules(item) && Math.abs(item.pitch) <= threshold).length,
      currentProductionAccepted: items.filter(frontPassesRules).length,
      total: items.length,
    }]
  })),
}))
const result = {
  benchmarkedAt: new Date().toISOString(),
  model: 'WHENet v1.0.4 prepost ONNX',
  modelSha256: '28345f49bd38a3e74f5d6b028469fe27b6bf5b09405ffdfa0be4b28db6c2be0e',
  images: cases.length,
  views,
  frontPitchGateSweep,
  thresholdEvaluation: {
    frontAccepted: cases.filter((item) => item.view === 'front' && classify(item) === 'front').length,
    frontTotal: cases.filter((item) => item.view === 'front').length,
    profilesAccepted: cases.filter((item) => item.view !== 'front' && classify(item) === 'profile').length,
    profilesTotal: cases.filter((item) => item.view !== 'front').length,
    frontAcceptedWithRollGate: cases.filter((item) => item.view === 'front' && frontPassesRules(item)).length,
    frontAcceptedWithProductionPitchGate: cases.filter((item) => item.view === 'front' && frontPassesRules(item) && Math.abs(item.pitch) <= 9).length,
    profilesAcceptedWithRollGate: cases.filter((item) => item.view !== 'front' && profilePassesRules(item)).length,
    requiredRightProfilesAccepted: cases.filter((item) => item.view === 'right_profile' && item.yaw <= -35 && Math.abs(item.roll) <= 18).length,
    requiredRightProfilesTotal: cases.filter((item) => item.view === 'right_profile').length,
    oppositeLeftProfilesRejectedFromRightSlot: cases.filter((item) => item.view === 'left_profile' && item.yaw > 0).length,
    oppositeLeftProfilesTotal: cases.filter((item) => item.view === 'left_profile').length,
  },
  rawImagesRetainedByBenchmark: false,
  individualPredictionsRetained: false,
}

await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ...result, resultPath }, null, 2) + '\n')
