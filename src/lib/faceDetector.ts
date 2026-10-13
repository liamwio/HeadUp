import * as ort from 'onnxruntime-web/wasm'
import { retryableLoad } from './retryableLoad'
import { preflightImageFile } from './imageInputPreflight'

export type FaceDetection = {
  score: number
  x: number
  y: number
  width: number
  height: number
  areaRatio: number
  centerDistance: number
}

export type FaceDetectionSummary = {
  detections: FaceDetection[]
  inputWidth: number
  inputHeight: number
  /** Actual image content before padding the model input to multiples of 32. */
  contentWidth?: number
  contentHeight?: number
}

type YuNetOutputs = Record<string, { data: ArrayLike<number> }>

const MODEL_PATH = '/models/face_detection_yunet_2026may.onnx'
const MAX_INPUT_EDGE = 320
const SCORE_FLOOR = 0.3
const NMS_THRESHOLD = 0.3
const getSession = retryableLoad(async ():Promise<ort.InferenceSession> => {
    ort.env.wasm.numThreads = 1
    return ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
})

function intersectionOverUnion(left: FaceDetection, right: FaceDetection): number {
  const intersectionWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const intersectionHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  const intersection = intersectionWidth * intersectionHeight
  const union = left.width * left.height + right.width * right.height - intersection
  return union > 0 ? intersection / union : 0
}

export function nonMaximumSuppression(detections: FaceDetection[], threshold = NMS_THRESHOLD): FaceDetection[] {
  const retained: FaceDetection[] = []
  for (const candidate of [...detections].sort((left, right) => right.score - left.score)) {
    if (retained.every((current) => intersectionOverUnion(candidate, current) < threshold)) retained.push(candidate)
  }
  return retained
}

export function decodeYuNetDetections(outputs: YuNetOutputs, inputWidth: number, inputHeight: number, contentWidth = inputWidth, contentHeight = inputHeight): FaceDetection[] {
  const detections: FaceDetection[] = []
  for (const stride of [8, 16, 32]) {
    const classifications = outputs[`cls_${stride}`]?.data
    const objectness = outputs[`obj_${stride}`]?.data
    const boxes = outputs[`bbox_${stride}`]?.data
    if (!classifications || !objectness || !boxes) throw new Error(`YuNet output for stride ${stride} is missing`)
    const columns = inputWidth / stride
    for (let index = 0; index < classifications.length; index += 1) {
      const score = Math.sqrt(
        Math.min(1, Math.max(0, classifications[index])) * Math.min(1, Math.max(0, objectness[index])),
      )
      if (score < SCORE_FLOOR) continue
      const row = Math.floor(index / columns)
      const column = index % columns
      const width = Math.exp(boxes[index * 4 + 2]) * stride
      const height = Math.exp(boxes[index * 4 + 3]) * stride
      const centerX = (column + boxes[index * 4]) * stride
      const centerY = (row + boxes[index * 4 + 1]) * stride
      detections.push({
        score,
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
        // Grid decoding uses padded dimensions; framing uses the actual image.
        areaRatio: (width * height) / (contentWidth * contentHeight),
        centerDistance: Math.hypot(centerX / contentWidth - 0.5, centerY / contentHeight - 0.5),
      })
    }
  }
  return nonMaximumSuppression(detections)
}

function makeInput(bitmap: ImageBitmap): { tensor: ort.Tensor; width: number; height: number; scaledWidth: number; scaledHeight: number } {
  const scale = MAX_INPUT_EDGE / Math.max(bitmap.width, bitmap.height)
  const scaledWidth = Math.max(1, Math.round(bitmap.width * scale))
  const scaledHeight = Math.max(1, Math.round(bitmap.height * scale))
  const width = Math.ceil(scaledWidth / 32) * 32
  const height = Math.ceil(scaledHeight / 32) * 32
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to create face-detector preprocessing context')
  context.drawImage(bitmap, 0, 0, scaledWidth, scaledHeight)
  const pixels = context.getImageData(0, 0, width, height).data
  const channelSize = width * height
  const input = new Float32Array(channelSize * 3)
  for (let index = 0; index < channelSize; index += 1) {
    const rgbaIndex = index * 4
    input[index] = pixels[rgbaIndex + 2]
    input[channelSize + index] = pixels[rgbaIndex + 1]
    input[channelSize * 2 + index] = pixels[rgbaIndex]
  }
  return { tensor: new ort.Tensor('float32', input, [1, 3, height, width]), width, height, scaledWidth, scaledHeight }
}

export async function detectFacesFromBitmap(bitmap: ImageBitmap): Promise<FaceDetectionSummary> {
  const session = await getSession()
  const { tensor, width, height, scaledWidth, scaledHeight } = makeInput(bitmap)
  const outputs = await session.run({ [session.inputNames[0]]: tensor })
  return {
    detections: decodeYuNetDetections(outputs as YuNetOutputs, width, height, scaledWidth, scaledHeight),
    inputWidth: width,
    inputHeight: height,
    contentWidth: scaledWidth,
    contentHeight: scaledHeight,
  }
}

export async function detectFaces(file: File): Promise<FaceDetectionSummary> {
  await preflightImageFile(file)
  const bitmap = await createImageBitmap(file)
  try { return await detectFacesFromBitmap(bitmap) } finally { bitmap.close() }
}
