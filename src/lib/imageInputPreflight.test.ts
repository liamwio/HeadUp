import { describe, expect, it } from 'vitest'
import { IMAGE_INPUT_LIMITS, parseImageHeader, preflightImageFile } from './imageInputPreflight'

function png(width: number, height: number) {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9])
}

function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}

function box(type: string, payload: Uint8Array) {
  const output = new Uint8Array(8 + payload.length)
  new DataView(output.buffer).setUint32(0, output.length)
  output.set(new TextEncoder().encode(type), 4); output.set(payload, 8)
  return output
}

function isoImage(brand: 'avif' | 'heic', width = 1080, height = 1350) {
  const ftypPayload = new Uint8Array(12)
  ftypPayload.set(new TextEncoder().encode(brand), 0)
  ftypPayload.set(new TextEncoder().encode('mif1'), 8)
  const ispePayload = new Uint8Array(12)
  new DataView(ispePayload.buffer).setUint32(4, width); new DataView(ispePayload.buffer).setUint32(8, height)
  const metaPayload = concat(new Uint8Array(4), box('iprp', box('ipco', box('ispe', ispePayload))))
  return concat(box('ftyp', ftypPayload), box('meta', metaPayload))
}

describe('image input preflight', () => {
  it('parses JPEG, PNG, extended WebP and AVIF dimensions without decoding pixels', () => {
    expect(parseImageHeader(jpeg(1080, 1350))).toMatchObject({ format: 'jpeg', width: 1080, height: 1350 })
    expect(parseImageHeader(png(2048, 1536))).toMatchObject({ format: 'png', width: 2048, height: 1536 })
    const webp = new Uint8Array(30); webp.set(new TextEncoder().encode('RIFF'), 0); webp.set(new TextEncoder().encode('WEBPVP8X'), 8)
    const width = 639, height = 479; webp.set([width & 255, width >> 8, 0, height & 255, height >> 8, 0], 24)
    expect(parseImageHeader(webp)).toMatchObject({ format: 'webp', width: 640, height: 480 })
    expect(parseImageHeader(isoImage('avif', 1080, 1350))).toMatchObject({ format: 'avif', mimeType: 'image/avif', width: 1080, height: 1350 })
  })

  it('rejects HEIC with an actionable conversion message and malformed AVIF boxes', async () => {
    await expect(preflightImageFile(new File([isoImage('heic')], 'iphone.heic', { type: 'image/heic' }))).rejects.toThrow(/导出为JPEG、PNG、WebP或AVIF/)
    const malformed = isoImage('avif'); new DataView(malformed.buffer).setUint32(32, 0x7fffffff)
    expect(parseImageHeader(malformed)).toBeNull()
  })

  it('rejects spoofed MIME, corrupt headers and decompression-bomb dimensions', async () => {
    await expect(preflightImageFile(new File([jpeg(1080, 1350)], 'spoof.png', { type: 'image/png' }))).rejects.toThrow(/内容不一致/)
    await expect(preflightImageFile(new File([new Uint8Array([1, 2, 3])], 'broken.jpg', { type: 'image/jpeg' }))).rejects.toThrow(/损坏或不受支持/)
    await expect(preflightImageFile(new File([png(20_000, 20_000)], 'huge.png', { type: 'image/png' }))).rejects.toThrow(/像素尺寸过大/)
  })

  it('accepts a valid image contract and reports exact byte/pixel counts', async () => {
    const bytes = png(1200, 1600)
    const result = await preflightImageFile(new File([bytes], 'valid.png', { type: 'image/png' }))
    expect(result).toMatchObject({ format: 'png', width: 1200, height: 1600, pixels: 1_920_000, bytes: bytes.length })
    expect(IMAGE_INPUT_LIMITS.maximumBytes).toBe(30 * 1024 * 1024)
  })

  it('accepts an AVIF contract with exact byte and pixel counts', async () => {
    const bytes = isoImage('avif', 1200, 1600)
    await expect(preflightImageFile(new File([bytes], 'valid.avif', { type: 'image/avif' }))).resolves.toMatchObject({ format: 'avif', width: 1200, height: 1600, pixels: 1_920_000, bytes: bytes.length })
  })
})
