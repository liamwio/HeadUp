export const IMAGE_INPUT_LIMITS = {
  maximumBytes: 30 * 1024 * 1024,
  maximumPixels: 80_000_000,
  maximumDimension: 20_000,
  minimumDimension: 16,
  headerBytes: 1024 * 1024,
} as const

export type SupportedImageFormat = 'jpeg' | 'png' | 'webp' | 'avif'
export type ImageInputContract = {
  format: SupportedImageFormat
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'
  width: number
  height: number
  bytes: number
  pixels: number
}

const preflightCache = new WeakMap<File, Promise<ImageInputContract>>()
const MIME_BY_FORMAT = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' } as const

function u16be(bytes: Uint8Array, offset: number) { return bytes[offset] * 256 + bytes[offset + 1] }
function u24le(bytes: Uint8Array, offset: number) { return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65_536 }
function u32be(bytes: Uint8Array, offset: number) { return bytes[offset] * 16_777_216 + bytes[offset + 1] * 65_536 + bytes[offset + 2] * 256 + bytes[offset + 3] }
function ascii(bytes: Uint8Array, offset: number, length: number) { return String.fromCharCode(...bytes.slice(offset, offset + length)) }

type IsoKind = 'avif' | 'heic' | null
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'])
function isoKind(bytes: Uint8Array): IsoKind {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null
  const boxSize = u32be(bytes, 0)
  if (boxSize < 16 || boxSize > bytes.length) return null
  const brands = [ascii(bytes, 8, 4)]
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(ascii(bytes, offset, 4))
  if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return 'avif'
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return 'heic'
  return null
}

function isoBox(bytes: Uint8Array, offset: number, end: number) {
  if (offset + 8 > end) return null
  const size32 = u32be(bytes, offset)
  const type = ascii(bytes, offset + 4, 4)
  let header = 8
  let size = size32
  if (size32 === 1) {
    if (offset + 16 > end) return null
    const high = u32be(bytes, offset + 8)
    const low = u32be(bytes, offset + 12)
    size = high * 4_294_967_296 + low
    header = 16
  } else if (size32 === 0) size = end - offset
  if (!Number.isSafeInteger(size) || size < header || offset + size > end) return null
  return { type, start: offset, content: offset + header, end: offset + size }
}

const ISO_CONTAINERS = new Set(['meta', 'iprp', 'ipco', 'moov', 'trak', 'mdia', 'minf', 'stbl'])
function findIspeDimensions(bytes: Uint8Array, start: number, end: number, depth = 0): { width: number; height: number } | null {
  if (depth > 8) return null
  let offset = start
  while (offset + 8 <= end) {
    const box = isoBox(bytes, offset, end)
    if (!box) return null
    if (box.type === 'ispe' && box.content + 12 <= box.end) return { width: u32be(bytes, box.content + 4), height: u32be(bytes, box.content + 8) }
    if (ISO_CONTAINERS.has(box.type)) {
      const childStart = box.content + (box.type === 'meta' ? 4 : 0)
      if (childStart <= box.end) {
        const dimensions = findIspeDimensions(bytes, childStart, box.end, depth + 1)
        if (dimensions) return dimensions
      }
    }
    offset = box.end
  }
  return null
}

function avifDimensions(bytes: Uint8Array) {
  if (isoKind(bytes) !== 'avif') return null
  return findIspeDimensions(bytes, 0, bytes.length)
}

function jpegDimensions(bytes: Uint8Array) {
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xda) break
    if (offset + 1 >= bytes.length) break
    const length = u16be(bytes, offset)
    if (length < 2 || offset + length > bytes.length) break
    if (sof.has(marker) && length >= 7) return { width: u16be(bytes, offset + 5), height: u16be(bytes, offset + 3) }
    offset += length
  }
  return null
}

function webpDimensions(bytes: Uint8Array) {
  const chunk = String.fromCharCode(...bytes.slice(12, 16))
  if (chunk === 'VP8X' && bytes.length >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: (bytes[26] + bytes[27] * 256) & 0x3fff, height: (bytes[28] + bytes[29] * 256) & 0x3fff }
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24]
    return { width: 1 + b0 + ((b1 & 0x3f) << 8), height: 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10) }
  }
  return null
}

export function parseImageHeader(bytes: Uint8Array): Omit<ImageInputContract, 'bytes' | 'pixels'> | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG'
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    return { format: 'png', mimeType: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dimensions = jpegDimensions(bytes)
    return dimensions ? { format: 'jpeg', mimeType: 'image/jpeg', ...dimensions } : null
  }
  if (bytes.length >= 25 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const dimensions = webpDimensions(bytes)
    return dimensions ? { format: 'webp', mimeType: 'image/webp', ...dimensions } : null
  }
  if (isoKind(bytes) === 'avif') {
    const dimensions = avifDimensions(bytes)
    return dimensions ? { format: 'avif', mimeType: 'image/avif', ...dimensions } : null
  }
  return null
}

async function inspect(file: File): Promise<ImageInputContract> {
  if (file.size <= 0) throw new Error('图片文件为空')
  if (file.size > IMAGE_INPUT_LIMITS.maximumBytes) throw new Error('图片文件过大，请使用30 MB以内的原始照片')
  const header = new Uint8Array(await file.slice(0, Math.min(file.size, IMAGE_INPUT_LIMITS.headerBytes)).arrayBuffer())
  if (isoKind(header) === 'heic' || file.type === 'image/heic' || file.type === 'image/heif') {
    throw new Error('暂不支持HEIC/HEIF，请在手机相册中导出为JPEG、PNG、WebP或AVIF后重试')
  }
  const parsed = parseImageHeader(header)
  if (!parsed) throw new Error('图片格式损坏或不受支持，请使用有效的JPEG、PNG、WebP或AVIF')
  if (file.type && file.type !== parsed.mimeType) throw new Error('图片扩展类型与实际内容不一致')
  if (!Number.isInteger(parsed.width) || !Number.isInteger(parsed.height)
    || parsed.width < IMAGE_INPUT_LIMITS.minimumDimension || parsed.height < IMAGE_INPUT_LIMITS.minimumDimension) {
    throw new Error('图片尺寸无效或过小')
  }
  const pixels = parsed.width * parsed.height
  if (parsed.width > IMAGE_INPUT_LIMITS.maximumDimension || parsed.height > IMAGE_INPUT_LIMITS.maximumDimension
    || !Number.isSafeInteger(pixels) || pixels > IMAGE_INPUT_LIMITS.maximumPixels) {
    throw new Error('图片像素尺寸过大，请使用不超过8000万像素且单边不超过20000像素的照片')
  }
  return { ...parsed, bytes: file.size, pixels }
}

export function preflightImageFile(file: File): Promise<ImageInputContract> {
  let promise = preflightCache.get(file)
  if (!promise) { promise = inspect(file); preflightCache.set(file, promise) }
  return promise
}
