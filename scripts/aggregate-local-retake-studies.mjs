import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildRetakeAggregate } from './lib/local-retake-aggregate.mjs'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
if (outIndex !== args.lastIndexOf('--out')) throw new Error('--out may only be specified once')
const outputPath = outIndex >= 0 ? args[outIndex + 1] : undefined
const inputPaths = outIndex >= 0
  ? args.filter((_value, index) => index !== outIndex && index !== outIndex + 1)
  : args

if (outIndex >= 0 && !outputPath) throw new Error('--out requires a JSON path')
if (inputPaths.length === 0) throw new Error('Usage: pnpm research:retake:aggregate [--out aggregate.json] session-A.json session-B.json ...')

const sessions = []
for (const inputPath of inputPaths) {
  const absolutePath = resolve(inputPath)
  sessions.push(JSON.parse(await readFile(absolutePath, 'utf8')))
}
const aggregate = buildRetakeAggregate(sessions)
const serialized = `${JSON.stringify(aggregate, null, 2)}\n`
if (outputPath) {
  await writeFile(resolve(outputPath), serialized, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ sessions: aggregate.sessions, eligiblePairs: aggregate.pairing.eligiblePairs, output: resolve(outputPath) }, null, 2)}\n`)
} else {
  process.stdout.write(serialized)
}
