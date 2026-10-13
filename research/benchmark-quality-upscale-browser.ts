import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'

const status = document.querySelector<HTMLElement>('#status')!
const resultElement = document.querySelector<HTMLElement>('#result')!

function blobFromCanvas(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.96) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('canvas encoding failed')), type, quality))
}

function deterministicPixels(canvas: HTMLCanvasElement, seed: number) {
  const context = canvas.getContext('2d')!
  const image = context.createImageData(canvas.width, canvas.height)
  let state = seed >>> 0
  for (let index = 0; index < canvas.width * canvas.height; index++) {
    state = (state * 1664525 + 1013904223) >>> 0
    const noise = (state >>> 24) - 128
    const x = index % canvas.width
    const y = Math.floor(index / canvas.width)
    const base = 128 + 35 * Math.sin(x / 17) + 28 * Math.cos(y / 23) + noise * 0.32
    const offset = index * 4
    image.data[offset] = Math.max(0, Math.min(255, base + 12))
    image.data[offset + 1] = Math.max(0, Math.min(255, base))
    image.data[offset + 2] = Math.max(0, Math.min(255, base - 8))
    image.data[offset + 3] = 255
  }
  context.putImageData(image, 0, 0)
}

async function main() {
  const low = document.createElement('canvas')
  low.width = 120; low.height = 120
  deterministicPixels(low, 17)
  const nearest = document.createElement('canvas')
  nearest.width = 1080; nearest.height = 1080
  const nearestContext = nearest.getContext('2d')!
  nearestContext.imageSmoothingEnabled = false
  nearestContext.drawImage(low, 0, 0, 1080, 1080)
  const native = document.createElement('canvas')
  native.width = 1080; native.height = 1080
  deterministicPixels(native, 29)
  const [nearestBlob, nativeBlob] = await Promise.all([blobFromCanvas(nearest), blobFromCanvas(native)])
  const [nearestQuality, nativeQuality] = await Promise.all([
    inspectImage(new File([nearestBlob], 'nearest-memory.jpg', { type: nearestBlob.type })),
    inspectImage(new File([nativeBlob], 'native-memory.jpg', { type: nativeBlob.type })),
  ])
  const gates = {
    nearestUpscaleHasExplicitFlag: nearestQuality.flags.includes('疑似低清放大'),
    nearestUpscaleIsBlocked: !isPhotoQualityAcceptable(nearestQuality),
    nativeDetailDoesNotHaveUpscaleFlag: !nativeQuality.flags.includes('疑似低清放大'),
    nativeDetailIsAccepted: isPhotoQualityAcceptable(nativeQuality),
  }
  const result = {
    testedAt: new Date().toISOString(),
    policyVersion: 'HEADUP-QUALITY-UPSCALE-BROWSER-PARITY-1.0',
    runtime: navigator.userAgent,
    inputs: { generatedInMemory: true, imagesOrFilesRetained: false },
    nearestQuality,
    nativeQuality,
    gates,
    passes: Object.values(gates).every(Boolean),
  }
  resultElement.textContent = JSON.stringify(result, null, 2)
  status.textContent = '完成'
}

main().catch((error) => {
  resultElement.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error)
  resultElement.textContent = resultElement.dataset.error
  status.textContent = '失败'
})
