import * as ort from 'onnxruntime-web/wasm'
import { retryableLoad } from './retryableLoad'
import { preflightImageFile } from './imageInputPreflight'

export type WideHeadPose = {
  yaw: number
  roll: number
  pitch: number
}

const MODEL_PATH = '/models/whenet_1x3x224x224_prepost.onnx'
const INPUT_SIZE = 224
const getSession = retryableLoad(async ():Promise<ort.InferenceSession> => {
    ort.env.wasm.numThreads = 1
    return ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
})

function roundAngle(value: number): number {
  return Math.round(value * 10) / 10
}

function makeInput(bitmap: ImageBitmap): ort.Tensor {
  const canvas = document.createElement('canvas')
  canvas.width = INPUT_SIZE
  canvas.height = INPUT_SIZE
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to create image preprocessing context')

  const cropSize = Math.min(bitmap.width, bitmap.height)
  const sourceX = (bitmap.width - cropSize) / 2
  const sourceY = (bitmap.height - cropSize) / 2
  context.drawImage(bitmap, sourceX, sourceY, cropSize, cropSize, 0, 0, INPUT_SIZE, INPUT_SIZE)
  const pixels = context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data
  const channelSize = INPUT_SIZE * INPUT_SIZE
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    const rgbaIndex = index * 4
    input[index] = pixels[rgbaIndex]
    input[channelSize + index] = pixels[rgbaIndex + 1]
    input[channelSize * 2 + index] = pixels[rgbaIndex + 2]
  }
  return new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE])
}

export async function estimateWideHeadPoseFromBitmap(bitmap: ImageBitmap): Promise<WideHeadPose> {
  const session = await getSession()
  const tensor = makeInput(bitmap)
  const outputs = await session.run({ [session.inputNames[0]]: tensor })
  const values = Array.from(outputs[session.outputNames[0]].data as Float32Array)
  if (values.length < 3 || values.slice(0, 3).some((value) => !Number.isFinite(value))) {
    throw new Error('Wide head-pose model returned an invalid result')
  }
  return { yaw: roundAngle(values[0]), roll: roundAngle(values[1]), pitch: roundAngle(values[2]) }
}

export async function estimateWideHeadPose(file: File): Promise<WideHeadPose> {
  await preflightImageFile(file)
  const bitmap = await createImageBitmap(file)
  try { return await estimateWideHeadPoseFromBitmap(bitmap) } finally { bitmap.close() }
}
