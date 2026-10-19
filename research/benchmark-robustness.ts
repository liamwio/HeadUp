import { inspectCapturePose } from '../src/lib/facePose'
import { inspectImage, isPhotoQualityAcceptable } from '../src/lib/imageQuality'
import { FRONT_CAPTURE_THRESHOLDS } from '../src/lib/poseRules'

type ManifestRecord = { relativePath: string; view: string }
type Variant = { name: string; make: (image: HTMLImageElement) => HTMLCanvasElement }

const status = document.querySelector<HTMLParagraphElement>('#status')!
const resultElement = document.querySelector<HTMLPreElement>('#result')!
const databaseRoot = '/data/face-db-real-research'
const manifest = await fetch(`${databaseRoot}/manifest.jsonl`).then((response) => response.text())
const frontRecords = manifest.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ManifestRecord).filter((record) => record.view === 'front')

function canvas(size = 1080) {
  const element = document.createElement('canvas')
  element.width = size
  element.height = size
  const context = element.getContext('2d')!
  context.fillStyle = '#000'
  context.fillRect(0, 0, size, size)
  return { element, context }
}

function drawBase(image: HTMLImageElement, size = 1080) {
  const target = canvas(size)
  target.context.drawImage(image, 0, 0, size, size)
  return target
}

function filtered(image: HTMLImageElement, filter: string) {
  const target = canvas()
  target.context.filter = filter
  target.context.drawImage(image, 0, 0, 1080, 1080)
  return target.element
}

const allVariants: Variant[] = [
  { name: 'original_1080', make: (image) => drawBase(image).element },
  { name: 'brightness_50_percent', make: (image) => filtered(image, 'brightness(50%)') },
  { name: 'brightness_70_percent', make: (image) => filtered(image, 'brightness(70%)') },
  { name: 'brightness_130_percent', make: (image) => filtered(image, 'brightness(130%)') },
  { name: 'brightness_150_percent', make: (image) => filtered(image, 'brightness(150%)') },
  { name: 'gaussian_blur_2px', make: (image) => filtered(image, 'blur(2px)') },
  { name: 'gaussian_blur_4px', make: (image) => filtered(image, 'blur(4px)') },
  { name: 'resolution_480', make: (image) => drawBase(image, 480).element },
  { name: 'resolution_720', make: (image) => drawBase(image, 720).element },
  { name: 'eye_band_occlusion', make: (image) => { const target = drawBase(image); target.context.fillStyle = '#050505'; target.context.fillRect(235, 420, 610, 180); return target.element } },
  { name: 'lower_face_mask_occlusion', make: (image) => { const target = drawBase(image); target.context.fillStyle = '#a7cbd3'; target.context.beginPath(); target.context.moveTo(250, 570); target.context.lineTo(830, 570); target.context.lineTo(750, 870); target.context.lineTo(330, 870); target.context.closePath(); target.context.fill(); return target.element } },
  { name: 'left_half_occlusion', make: (image) => { const target = drawBase(image); target.context.fillStyle = '#111'; target.context.fillRect(0, 0, 540, 1080); return target.element } },
  { name: 'screen_replay_proxy', make: (image) => { const target = canvas(); target.context.drawImage(image, 60, 60, 960, 960); target.context.fillStyle = 'rgba(255,255,255,0.08)'; for (let y = 62; y < 1018; y += 4) target.context.fillRect(60, y, 960, 1); const glare = target.context.createLinearGradient(100, 950, 950, 100); glare.addColorStop(0.35, 'rgba(255,255,255,0)'); glare.addColorStop(0.5, 'rgba(255,255,255,0.18)'); glare.addColorStop(0.65, 'rgba(255,255,255,0)'); target.context.fillStyle = glare; target.context.fillRect(60, 60, 960, 960); return target.element } },
  { name: 'print_replay_proxy', make: (image) => { const target = canvas(); target.context.fillStyle = '#d7d5cf'; target.context.fillRect(0, 0, 1080, 1080); target.context.save(); target.context.translate(540, 540); target.context.rotate(1.5 * Math.PI / 180); target.context.shadowColor = 'rgba(0,0,0,.35)'; target.context.shadowBlur = 20; target.context.fillStyle = '#fff'; target.context.fillRect(-455, -455, 910, 910); target.context.shadowColor = 'transparent'; target.context.drawImage(image, -425, -425, 850, 850); target.context.restore(); return target.element } },
  { name: 'two_faces_side_by_side', make: (image) => { const target = canvas(); target.context.drawImage(image, 0, 270, 540, 540); target.context.drawImage(image, 540, 270, 540, 540); return target.element } },
]
const focusNames = new URLSearchParams(location.search).get('focus')?.split(',').filter(Boolean)
const variants = focusNames?.length ? allVariants.filter((variant) => focusNames.includes(variant.name)) : allVariants

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Unable to load ${url}`))
    image.src = url
  })
}

function toBlob(source: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => source.toBlob((value) => value ? resolve(value) : reject(new Error('Image encoding failed')), 'image/jpeg', 0.9))
}

function counts(values: string[]) {
  return Object.fromEntries(Object.entries(Object.groupBy(values, (value) => value)).map(([key, items]) => [key, items.length]))
}

const results = Object.fromEntries(variants.map((variant) => [variant.name, [] as { qualityPass: boolean; posePass: boolean; qualityFlags: string[]; poseFlags: string[] }[]]))

for (const [recordIndex, record] of frontRecords.entries()) {
  const image = await loadImage(`${databaseRoot}/${record.relativePath.replaceAll('\\', '/')}`)
  for (const [variantIndex, variant] of variants.entries()) {
    status.textContent = `处理 ${recordIndex + 1} / ${frontRecords.length}，扰动 ${variantIndex + 1} / ${variants.length}`
    const blob = await toBlob(variant.make(image))
    const file = new File([blob], `${variant.name}.jpg`, { type: 'image/jpeg' })
    const [quality, pose] = await Promise.all([inspectImage(file), inspectCapturePose('front', file)])
    results[variant.name].push({
      qualityPass: isPhotoQualityAcceptable(quality),
      posePass: pose.status === 'pass',
      qualityFlags: quality.flags,
      poseFlags: pose.flags,
    })
  }
}

const summary = Object.fromEntries(Object.entries(results).map(([name, items]) => {
  const qualityPassed = items.filter((item) => item.qualityPass).length
  const posePassed = items.filter((item) => item.posePass).length
  const combinedPassed = items.filter((item) => item.qualityPass && item.posePass).length
  return [name, {
    images: items.length,
    qualityPassed,
    posePassed,
    combinedPassed,
    combinedPassRate: Number((combinedPassed / items.length).toFixed(4)),
    qualityFlags: counts(items.flatMap((item) => item.qualityFlags.length ? item.qualityFlags : ['none'])),
    poseFlags: counts(items.flatMap((item) => item.poseFlags.length ? item.poseFlags : ['none'])),
  }]
}))

const result = {
  testedAt: new Date().toISOString(),
  policyVersion: 'HEADUP-ROBUSTNESS-PROXY-1.0',
  source: 'Face Research Lab London Set, 102 consented adult front images',
  transformations: 'Generated and evaluated in browser memory; no transformed image was written.',
  warning: 'Screen and print cases are synthetic artifact proxies, not physical presentation-attack captures; acceptance proves the current gate is not liveness detection.',
  productionFrontThresholds: FRONT_CAPTURE_THRESHOLDS,
  variants: summary,
  retention: { transformedImagesWritten: false, individualPredictionsRetained: false, identifiersRetained: false, aggregateOnly: true },
}

resultElement.textContent = JSON.stringify(result, null, 2)
status.textContent = '完成'
